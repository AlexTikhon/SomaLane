import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  MEAL_DRAFT_CLARIFICATION_REASONS,
  MEAL_DRAFT_UNSUPPORTED_REASONS,
  MEAL_NUTRITION_FIELDS,
  mealDraftProposalRequestSchema,
  mealTypeSchema,
  type MealNutritionField,
} from '@running-tracker/contracts';
import { z } from 'zod';

import type { Clock } from '../clock.js';
import { LlmProviderError, type LlmProvider } from '../insights/llm-provider.js';
import { groundMealDraft, UngroundedOutputError, type GroundedProposal, type GroundingAudit } from '../meals/drafts/meal-draft-grounding.js';
import { buildMealDraftMessages, MEAL_DRAFT_PROMPT_VERSION, mealDraftPromptDigest } from '../meals/drafts/meal-draft-prompt.js';
import { mealDraftWireJsonSchema, mealDraftWireSchema } from '../meals/drafts/meal-draft-wire.js';
import type { ReproducibilityMetadata } from './meal-draft-metadata.js';
import type { MealDraftExecutionProfile, ProfileCheck } from './meal-draft-profile.js';

// The evaluation of "Draft from text" (ADR-0092; docs/runbooks/meal-drafts.md). Two FROZEN synthetic sets, development
// and held-out, English and Russian, in explicit dataset versions (a pinned registry below; version 1 by default). A run makes at most one provider call per case, never retries, and goes through the
// same prompt, wire schema and grounding as the service, so what is measured is what a person would be shown. Extraction
// quality, incorrectly accepted fields, abstentions and latency are reported separately. A run with the fake provider
// verifies this harness and nothing else: it is never evidence about a model.

/** The most provider calls one evaluation run may make (the brief's budget for real-model evaluation). */
export const MEAL_DRAFT_EVALUATION_MAX_CALLS = 40;
/** Identical systemic failures in a row after which a run stops spending calls. */
export const MEAL_DRAFT_EVALUATION_FAILURE_STREAK = 3;

export const MEAL_DRAFT_EVALUATION_SETS = ['development', 'heldout'] as const;
export type MealDraftEvaluationSet = (typeof MEAL_DRAFT_EVALUATION_SETS)[number];

/**
 * The dataset versions an evaluation can be asked for, by `--dataset-version v1|v2`. Version 1 (2026-11-14) is the
 * default and keeps its files, digests and meaning; it has been examined, so runs of it are regression measurements.
 * Version 2 (2026-11-18) is a NEW pair of synthetic sets written and frozen before any call was made on them; they are
 * authored and examined by the same engineer, so they are not independent blind held-out evidence either.
 */
export const MEAL_DRAFT_DATASET_VERSIONS = ['1', '2'] as const;
export type MealDraftDatasetVersion = (typeof MEAL_DRAFT_DATASET_VERSIONS)[number];
export const MEAL_DRAFT_DEFAULT_DATASET_VERSION: MealDraftDatasetVersion = '1';

export interface PinnedMealDraftDataset {
  caseCount: number;
  /** SHA-256 of the parsed, re-serialised JSON (so line endings do not matter). */
  digest: string;
  /** File name in apps/api/evaluation/. */
  file: string;
}

/**
 * The pinned registry: every set of every version, with its file, digest and case count. A set whose content changed
 * is refused; a new set is a new version with a new file, never an edit of a pinned one.
 */
export const MEAL_DRAFT_DATASET_REGISTRY: Readonly<Record<MealDraftDatasetVersion, Readonly<Record<MealDraftEvaluationSet, PinnedMealDraftDataset>>>> = Object.freeze({
  '1': Object.freeze({
    development: Object.freeze({ caseCount: 20, digest: '7081d147294698185b8ba87c3ef98f4770c51a9aa72e2ecf22ff98f0cf9e2951', file: 'meal-draft.development.v1.json' }),
    heldout: Object.freeze({ caseCount: 20, digest: 'be55bcaf7c6b1707818a1137eddc7f0d160bc077c5ede7842a3c952e04863b85', file: 'meal-draft.heldout.v1.json' }),
  }),
  '2': Object.freeze({
    // Frozen 2026-11-18 before any inference call on version 2.
    development: Object.freeze({ caseCount: 20, digest: 'ecfb74b45fba8870d509f72b6650154a27de31aff5406343013e20613c2c7559', file: 'meal-draft.development.v2.json' }),
    heldout: Object.freeze({ caseCount: 20, digest: '7248ab7f5c2694818b6f7dcca7becb08fc72870b786b344b1838bac54dfd14c0', file: 'meal-draft.heldout.v2.json' }),
  }),
});

/** The digests of one version's sets (version 1 by default). */
export function mealDraftDatasetDigests(version: MealDraftDatasetVersion = MEAL_DRAFT_DEFAULT_DATASET_VERSION): Readonly<Record<MealDraftEvaluationSet, string>> {
  const pinned = MEAL_DRAFT_DATASET_REGISTRY[version];
  return { development: pinned.development.digest, heldout: pinned.heldout.digest };
}

/** The version 1 digests, under their historical name. */
export const MEAL_DRAFT_DATASET_DIGESTS: Readonly<Record<MealDraftEvaluationSet, string>> = mealDraftDatasetDigests('1');

/**
 * Reads `v1`/`v2` (the command-line spelling) into a registered version; refuses anything else. Undefined means the
 * default, version 1, so every earlier command keeps its meaning.
 */
export function parseMealDraftDatasetVersion(value: string | undefined): MealDraftDatasetVersion {
  if (value === undefined) return MEAL_DRAFT_DEFAULT_DATASET_VERSION;
  const match = /^v(\d+)$/u.exec(value);
  const version = match?.[1];
  if (version === undefined || !(MEAL_DRAFT_DATASET_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(`--dataset-version must be ${MEAL_DRAFT_DATASET_VERSIONS.map((entry) => `v${entry}`).join(' or ')} (got ${value.slice(0, 20)})`);
  }
  return version as MealDraftDatasetVersion;
}

const nutritionExpectation = z.number().finite().nonnegative().nullable();

const expectedSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    mealType: mealTypeSchema.nullable(),
    nutrition: z.strictObject({ carbohydrateG: nutritionExpectation, energyKcal: nutritionExpectation, fatG: nutritionExpectation, proteinG: nutritionExpectation }),
    outcome: z.literal('draft'),
    titleIncludes: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({ outcome: z.literal('clarify'), reason: z.enum(MEAL_DRAFT_CLARIFICATION_REASONS) }),
  z.strictObject({ outcome: z.literal('unsupported'), reason: z.enum(MEAL_DRAFT_UNSUPPORTED_REASONS) }),
]);

export const mealDraftEvaluationCaseSchema = z.strictObject({
  category: z.string().regex(/^[a-z][a-z-]{2,40}$/u),
  expected: expectedSchema,
  id: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/u),
  language: z.enum(['en', 'ru']),
  /** The documented rule the expectation follows (version 2 onwards); never read by scoring. */
  rationale: z.string().min(1).max(400).optional(),
  // Exactly what the public request contract accepts (code points, no control characters, well-formed), so a case can
  // never measure a text the product would refuse.
  text: mealDraftProposalRequestSchema.shape.text,
});

export const mealDraftEvaluationDatasetSchema = z.strictObject({
  cases: z.array(mealDraftEvaluationCaseSchema).min(1).max(100),
  datasetVersion: z.string().regex(/^\d+$/u),
  description: z.string().min(1),
  set: z.enum(MEAL_DRAFT_EVALUATION_SETS),
});

export type MealDraftEvaluationCase = z.infer<typeof mealDraftEvaluationCaseSchema>;
export type MealDraftEvaluationDataset = z.infer<typeof mealDraftEvaluationDatasetSchema>;

export function mealDraftDatasetDigest(dataset: MealDraftEvaluationDataset): string {
  return createHash('sha256').update(JSON.stringify(dataset), 'utf8').digest('hex');
}

const datasetUrl = (file: string) => new URL(`../../evaluation/${file}`, import.meta.url);

/**
 * Checks a parsed set against its registry entry: the set and version it claims, the pinned digest and case count, and
 * unique ids and texts. Throws with the reason; never repairs.
 */
export function verifyMealDraftDataset(
  dataset: MealDraftEvaluationDataset,
  set: MealDraftEvaluationSet,
  version: MealDraftDatasetVersion,
  pinned: Pick<PinnedMealDraftDataset, 'caseCount' | 'digest'>,
): string {
  const label = `The v${version} ${set}`;
  if (dataset.set !== set) throw new Error(`${label} file holds the ${dataset.set} set`);
  if (dataset.datasetVersion !== version) throw new Error(`${label} file holds dataset version ${dataset.datasetVersion}`);
  const digest = mealDraftDatasetDigest(dataset);
  if (digest !== pinned.digest) throw new Error(`${label} set is not the frozen one (digest ${digest.slice(0, 12)}…)`);
  if (dataset.cases.length !== pinned.caseCount) throw new Error(`${label} set has ${dataset.cases.length} cases, ${pinned.caseCount} are pinned`);
  if (new Set(dataset.cases.map((entry) => entry.id)).size !== dataset.cases.length) throw new Error(`${label} set has duplicate case ids`);
  if (new Set(dataset.cases.map((entry) => entry.text)).size !== dataset.cases.length) throw new Error(`${label} set has duplicate texts`);
  return digest;
}

/**
 * Reads a frozen set of one version (version 1 by default) and refuses it if its content is not the pinned one.
 * `digests` replaces the pinned digests, for tests only.
 */
export function loadMealDraftDataset(
  set: MealDraftEvaluationSet,
  version: MealDraftDatasetVersion = MEAL_DRAFT_DEFAULT_DATASET_VERSION,
  digests: Readonly<Record<MealDraftEvaluationSet, string>> = mealDraftDatasetDigests(version),
): { dataset: MealDraftEvaluationDataset; digest: string; version: MealDraftDatasetVersion } {
  const pinned = MEAL_DRAFT_DATASET_REGISTRY[version]?.[set];
  if (pinned === undefined) throw new Error(`No dataset version ${String(version)} is registered for the ${set} set`);
  const dataset = mealDraftEvaluationDatasetSchema.parse(JSON.parse(readFileSync(datasetUrl(pinned.file), 'utf8')));
  const digest = verifyMealDraftDataset(dataset, set, version, { caseCount: pinned.caseCount, digest: digests[set] });
  return { dataset, digest, version };
}

/** Both sets of one version, loaded and verified together, or an error. */
export function loadMealDraftDatasets(
  version: MealDraftDatasetVersion = MEAL_DRAFT_DEFAULT_DATASET_VERSION,
): Record<MealDraftEvaluationSet, { dataset: MealDraftEvaluationDataset; digest: string; version: MealDraftDatasetVersion }> {
  const loaded = { development: loadMealDraftDataset('development', version), heldout: loadMealDraftDataset('heldout', version) };
  const texts = new Set(loaded.development.dataset.cases.map((entry) => entry.text));
  if (loaded.heldout.dataset.cases.some((entry) => texts.has(entry.text))) throw new Error(`The v${version} sets share a text`);
  const ids = new Set(loaded.development.dataset.cases.map((entry) => entry.id));
  if (loaded.heldout.dataset.cases.some((entry) => ids.has(entry.id))) throw new Error(`The v${version} sets share a case id`);
  return loaded;
}

// ---------------------------------------------------------------------------------------------------------------
// Running.

export type CaseFailure = 'incomplete' | 'invalid_output' | 'oversized' | 'provider_error' | 'provider_unavailable' | 'timeout' | 'ungrounded_output';

export interface MealDraftCaseResult {
  audit: GroundingAudit | null;
  case: MealDraftEvaluationCase;
  durationMs: number;
  failure: CaseFailure | null;
  proposal: GroundedProposal | null;
}

const SYSTEMIC: ReadonlySet<CaseFailure> = new Set(['incomplete', 'oversized', 'provider_error', 'provider_unavailable', 'timeout']);

function failureOf(error: unknown): CaseFailure {
  if (error instanceof UngroundedOutputError) return 'ungrounded_output';
  if (!(error instanceof LlmProviderError)) return 'provider_error';
  switch (error.reason) {
    case 'timeout':
    case 'aborted':
      return 'timeout';
    case 'incomplete':
      return 'incomplete';
    case 'invalid_response':
      return 'invalid_output';
    case 'oversized':
      return 'oversized';
    case 'unavailable':
      return 'provider_unavailable';
    case 'provider_error':
      return 'provider_error';
  }
}

export interface MealDraftEvaluationOptions {
  cases: readonly MealDraftEvaluationCase[];
  clock: Pick<Clock, 'monotonicNow'>;
  /** At most this many calls; never more than MEAL_DRAFT_EVALUATION_MAX_CALLS. */
  maxCalls: number;
  maxOutputTokens: number;
  onCase?: (progress: { done: number; id: string; total: number }) => void;
  provider: LlmProvider;
  timeoutMs: number;
}

export interface MealDraftEvaluationRun {
  calls: number;
  results: MealDraftCaseResult[];
  stopped: { afterCases: number; reason: CaseFailure } | null;
}

/** One call per case, in order, one at a time, no retries. Stops after three identical systemic failures in a row. */
export async function runMealDraftEvaluation(options: MealDraftEvaluationOptions): Promise<MealDraftEvaluationRun> {
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > MEAL_DRAFT_EVALUATION_MAX_CALLS) {
    throw new RangeError(`maxCalls must be 1..${MEAL_DRAFT_EVALUATION_MAX_CALLS}`);
  }
  const selected = options.cases.slice(0, options.maxCalls);
  const results: MealDraftCaseResult[] = [];
  let streak: { count: number; reason: CaseFailure | null } = { count: 0, reason: null };
  let calls = 0;
  for (const entry of selected) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAt = options.clock.monotonicNow();
    let result: MealDraftCaseResult;
    try {
      calls += 1;
      const answer = await options.provider.generateStructured(buildMealDraftMessages(entry.text), mealDraftWireJsonSchema, {
        maxOutputTokens: options.maxOutputTokens,
        signal: controller.signal,
        timeoutMs: options.timeoutMs,
      });
      const durationMs = Math.round(options.clock.monotonicNow() - startedAt);
      const wire = mealDraftWireSchema.safeParse(answer.value);
      if (!wire.success) {
        result = { audit: null, case: entry, durationMs, failure: 'invalid_output', proposal: null };
      } else {
        try {
          const grounded = groundMealDraft(entry.text.trim(), wire.data);
          result = { audit: grounded.audit, case: entry, durationMs, failure: null, proposal: grounded.proposal };
        } catch (error) {
          result = { audit: null, case: entry, durationMs, failure: failureOf(error), proposal: null };
        }
      }
    } catch (error) {
      result = { audit: null, case: entry, durationMs: Math.round(options.clock.monotonicNow() - startedAt), failure: failureOf(error), proposal: null };
    } finally {
      clearTimeout(timer);
    }
    results.push(result);
    options.onCase?.({ done: results.length, id: entry.id, total: selected.length });
    if (result.failure !== null && SYSTEMIC.has(result.failure)) {
      streak = streak.reason === result.failure ? { count: streak.count + 1, reason: result.failure } : { count: 1, reason: result.failure };
      if (streak.count >= MEAL_DRAFT_EVALUATION_FAILURE_STREAK) {
        return { calls, results, stopped: { afterCases: results.length, reason: result.failure } };
      }
    } else {
      streak = { count: 0, reason: null };
    }
  }
  return { calls, results, stopped: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring.

export interface Tally {
  correct: number;
  total: number;
}

/** Field-level counts over every executed case and every nutrition field. */
export interface FieldCounts {
  /** A value was proposed and it equals the expected value. */
  correctAccepted: number;
  /** Nothing was proposed and nothing was expected. */
  correctNull: number;
  /** Expected values (the recall denominator). */
  expectedValues: number;
  /** A value was proposed although none, or another, was expected: the safety metric. */
  incorrectAccepted: number;
  /** An expected value was not proposed because the model abstained or said it was not stated. */
  missedByModel: number;
  /** An expected value was not proposed because the outcome was not a draft (a clarification, a refusal or a failure). */
  missedByOutcome: number;
  /** An expected value was not proposed because the grounding withheld the model's claim. */
  missedByServer: number;
  /** The model claimed a value that was not expected and the grounding withheld it: a wrong field the server stopped. */
  stoppedByServer: number;
}

/**
 * What happened to every field that must NOT be proposed (a null expectation), split by WHO kept it out. Only
 * `verifierWithheld` involved the verifier at all: when the model did not claim a value, nothing was asked of the
 * grounding, so `modelDidNotClaim` and `nonDraft` are never evidence that the verifier rejects a wrong claim (the
 * deterministic safety corpus is that evidence).
 */
export interface NullExpectationCounts {
  /** A value was shown although none was expected (also counted in `fields.incorrectAccepted`). */
  accepted: number;
  /** The model abstained or said "not stated": no claim reached the verifier. */
  modelDidNotClaim: number;
  /** The outcome was not a draft (a clarification, a refusal or a failure). */
  nonDraft: number;
  total: number;
  /** The model claimed a value and the grounding withheld it. */
  verifierWithheld: number;
}

export interface MealDraftScore {
  extraction: { precision: number | null; recall: number | null };
  failures: { byReason: Record<string, number>; total: number };
  fields: FieldCounts;
  incorrectAccepted: Array<{ actual: number; expected: number | null; field: MealNutritionField; id: string }>;
  latencyMs: { max: number; mean: number; p50: number; p95: number } | null;
  mealType: Tally;
  multipleMealsOverrides: number;
  nullExpectations: NullExpectationCounts;
  outcome: Tally;
  reason: Tally;
  title: Tally;
}

const emptyFields = (): FieldCounts => ({
  correctAccepted: 0,
  correctNull: 0,
  expectedValues: 0,
  incorrectAccepted: 0,
  missedByModel: 0,
  missedByOutcome: 0,
  missedByServer: 0,
  stoppedByServer: 0,
});

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Math.round((numerator / denominator) * 1_000) / 1_000);

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function scoreMealDraftResults(results: readonly MealDraftCaseResult[]): MealDraftScore {
  const fields = emptyFields();
  const incorrectAccepted: MealDraftScore['incorrectAccepted'] = [];
  const outcome: Tally = { correct: 0, total: 0 };
  const reason: Tally = { correct: 0, total: 0 };
  const title: Tally = { correct: 0, total: 0 };
  const mealType: Tally = { correct: 0, total: 0 };
  const failures: Record<string, number> = {};
  const nullExpectations: NullExpectationCounts = { accepted: 0, modelDidNotClaim: 0, nonDraft: 0, total: 0, verifierWithheld: 0 };
  let multipleMealsOverrides = 0;

  for (const result of results) {
    const { expected } = result.case;
    const proposal = result.proposal;
    const actualOutcome = proposal?.outcome ?? 'failure';
    if (result.failure !== null) failures[result.failure] = (failures[result.failure] ?? 0) + 1;
    if (result.audit?.multipleMealsOverride) multipleMealsOverrides += 1;
    outcome.total += 1;
    if (actualOutcome === expected.outcome) outcome.correct += 1;

    if (expected.outcome !== 'draft') {
      reason.total += 1;
      if (proposal !== null && proposal.outcome === expected.outcome && proposal.reason === expected.reason) reason.correct += 1;
    }

    for (const field of MEAL_NUTRITION_FIELDS) {
      const wanted = expected.outcome === 'draft' ? expected.nutrition[field] : null;
      const shown = proposal?.outcome === 'draft' ? proposal.nutrition[field] : null;
      const value = shown?.status === 'proposed' ? shown.value : null;
      const disposition = proposal?.outcome === 'draft' ? result.audit?.fields?.[field] : undefined;
      if (wanted !== null) fields.expectedValues += 1;
      else {
        nullExpectations.total += 1;
        if (value !== null) nullExpectations.accepted += 1;
        else if (proposal?.outcome !== 'draft') nullExpectations.nonDraft += 1;
        else if (disposition === 'server_withheld') nullExpectations.verifierWithheld += 1;
        else nullExpectations.modelDidNotClaim += 1;
      }
      if (value !== null) {
        if (value === wanted) fields.correctAccepted += 1;
        else {
          fields.incorrectAccepted += 1;
          incorrectAccepted.push({ actual: value, expected: wanted, field, id: result.case.id });
        }
        continue;
      }
      if (wanted === null) {
        fields.correctNull += 1;
        if (disposition === 'server_withheld') fields.stoppedByServer += 1;
      } else if (proposal?.outcome !== 'draft') fields.missedByOutcome += 1;
      else if (disposition === 'server_withheld') fields.missedByServer += 1;
      else fields.missedByModel += 1;
    }

    if (expected.outcome === 'draft' && proposal?.outcome === 'draft') {
      title.total += 1;
      const lower = proposal.title.toLocaleLowerCase('ru');
      if (expected.titleIncludes.every((word) => lower.includes(word.toLocaleLowerCase('ru')))) title.correct += 1;
      mealType.total += 1;
      const actualType = proposal.mealType.status === 'proposed' ? proposal.mealType.value : null;
      if (actualType === expected.mealType) mealType.correct += 1;
    }
  }

  const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
  return {
    extraction: {
      precision: ratio(fields.correctAccepted, fields.correctAccepted + fields.incorrectAccepted),
      recall: ratio(fields.correctAccepted, fields.expectedValues),
    },
    failures: { byReason: failures, total: Object.values(failures).reduce((sum, count) => sum + count, 0) },
    fields,
    incorrectAccepted,
    latencyMs:
      durations.length === 0
        ? null
        : {
            max: durations.at(-1)!,
            mean: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
            p50: percentile(durations, 0.5),
            p95: percentile(durations, 0.95),
          },
    mealType,
    multipleMealsOverrides,
    nullExpectations,
    outcome,
    reason,
    title,
  };
}

/** A compact score per dataset category (the "failure category" of a case is its category plus its failure reason). */
export interface CategoryScore {
  cases: number;
  correctAccepted: number;
  expectedValues: number;
  failures: Record<string, number>;
  incorrectAccepted: number;
  outcomeCorrect: number;
}

export function scoreMealDraftByCategory(results: readonly MealDraftCaseResult[]): Record<string, CategoryScore> {
  const groups = new Map<string, MealDraftCaseResult[]>();
  for (const result of results) groups.set(result.case.category, [...(groups.get(result.case.category) ?? []), result]);
  const byCategory: Record<string, CategoryScore> = {};
  for (const [category, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const score = scoreMealDraftResults(group);
    byCategory[category] = {
      cases: group.length,
      correctAccepted: score.fields.correctAccepted,
      expectedValues: score.fields.expectedValues,
      failures: score.failures.byReason,
      incorrectAccepted: score.fields.incorrectAccepted,
      outcomeCorrect: score.outcome.correct,
    };
  }
  return byCategory;
}

/**
 * The report format. 2 added `metadata`, `byCategory`, per-case `audit` and `score.nullExpectations` to version 1; 3
 * replaces the two file digests with the verifier fingerprint (import closure, built contracts, adapter) and adds the
 * execution profile captured before the first call and the per-request profile check. Older reports are kept as they
 * were written; the model gate refuses them as evidence because they cannot establish either.
 */
export const MEAL_DRAFT_REPORT_VERSION = 3;

export interface MealDraftEvaluationReport {
  byCategory: Record<string, CategoryScore>;
  byLanguage: Record<'en' | 'ru', MealDraftScore>;
  calls: number;
  caseCount: number;
  cases: Array<{
    /** Bounded dispositions only (proposed, not stated, abstained, withheld): enough to re-score, never content. */
    audit: GroundingAudit | null;
    category: string;
    durationMs: number;
    expectedOutcome: string;
    failure: CaseFailure | null;
    id: string;
    language: string;
    proposal: GroundedProposal | null;
  }>;
  datasetDigest: string;
  datasetVersion: string;
  executedCount: number;
  /** The profile captured before the first call (null for the fake provider). */
  executionProfile: MealDraftExecutionProfile | null;
  generation: Record<string, unknown>;
  /** "fake" runs verify the harness only; they are never model-quality evidence. */
  kind: 'fake-harness-verification' | 'real-model';
  maxCalls: number;
  metadata: ReproducibilityMetadata | null;
  model: string;
  partial: boolean;
  /** Requests checked against the profile on their way out (null for the fake provider). */
  profileCheck: ProfileCheck | null;
  promptDigest: string;
  promptVersion: string;
  provider: string;
  reportVersion: typeof MEAL_DRAFT_REPORT_VERSION;
  runtimeVersion: string | null;
  score: MealDraftScore;
  set: MealDraftEvaluationSet;
  status: 'EXECUTED';
  stopped: MealDraftEvaluationRun['stopped'];
  timeoutMs: number;
}

/** Written instead of a report when no inference could be made (the runtime or the model was not available). */
export interface MealDraftNotRunReport {
  /** The dataset version the run was asked for (absent in reports written before versions were selectable: 1). */
  datasetVersion: MealDraftDatasetVersion;
  executionProfile: MealDraftExecutionProfile | null;
  kind: 'real-model';
  metadata: ReproducibilityMetadata | null;
  model: string;
  provider: 'ollama';
  reason: string;
  reportVersion: typeof MEAL_DRAFT_REPORT_VERSION;
  set: MealDraftEvaluationSet;
  status: 'NOT_RUN';
}

export function buildMealDraftReport(input: {
  dataset: MealDraftEvaluationDataset;
  digest: string;
  executionProfile?: MealDraftExecutionProfile | null;
  generation: Record<string, unknown>;
  maxCalls?: number;
  metadata?: ReproducibilityMetadata | null;
  model: string;
  profileCheck?: ProfileCheck | null;
  provider: 'fake' | 'ollama';
  run: MealDraftEvaluationRun;
  runtimeVersion: string | null;
  timeoutMs: number;
}): MealDraftEvaluationReport {
  const { dataset, run } = input;
  return {
    byCategory: scoreMealDraftByCategory(run.results),
    byLanguage: {
      en: scoreMealDraftResults(run.results.filter((result) => result.case.language === 'en')),
      ru: scoreMealDraftResults(run.results.filter((result) => result.case.language === 'ru')),
    },
    calls: run.calls,
    caseCount: dataset.cases.length,
    cases: run.results.map((result) => ({
      audit: result.audit,
      category: result.case.category,
      durationMs: result.durationMs,
      expectedOutcome: result.case.expected.outcome,
      failure: result.failure,
      id: result.case.id,
      language: result.case.language,
      proposal: result.proposal,
    })),
    datasetDigest: input.digest,
    datasetVersion: dataset.datasetVersion,
    executedCount: run.results.length,
    executionProfile: input.executionProfile ?? null,
    generation: input.generation,
    kind: input.provider === 'fake' ? 'fake-harness-verification' : 'real-model',
    maxCalls: input.maxCalls ?? Math.min(dataset.cases.length, MEAL_DRAFT_EVALUATION_MAX_CALLS),
    metadata: input.metadata ?? null,
    model: input.model,
    partial: run.results.length < dataset.cases.length || run.stopped !== null,
    profileCheck: input.profileCheck ?? null,
    promptDigest: mealDraftPromptDigest(),
    promptVersion: MEAL_DRAFT_PROMPT_VERSION,
    provider: input.provider,
    reportVersion: MEAL_DRAFT_REPORT_VERSION,
    runtimeVersion: input.runtimeVersion,
    score: scoreMealDraftResults(run.results),
    set: dataset.set,
    status: 'EXECUTED',
    stopped: run.stopped,
    timeoutMs: input.timeoutMs,
  };
}

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const tally = (value: Tally) => `${value.correct}/${value.total}`;

/** A short, human-readable summary. Bounded content: ids and numbers, never a model's words. */
export function formatMealDraftReport(report: MealDraftEvaluationReport): string {
  const { score } = report;
  const lines = [
    report.kind === 'fake-harness-verification'
      ? 'FAKE PROVIDER: harness verification only. This is NOT evidence about any model.'
      : `Real model: ${report.provider} ${report.model} (runtime ${report.runtimeVersion ?? 'unknown'})`,
    `Set: ${report.set} v${report.datasetVersion} (${report.executedCount}/${report.caseCount} cases, ${report.calls} calls)${report.partial ? ' PARTIAL' : ''}`,
    `Prompt: ${report.promptVersion} (${report.promptDigest.slice(0, 12)}…); deadline ${report.timeoutMs} ms`,
    `Outcome: ${tally(score.outcome)}; reason: ${tally(score.reason)}; title: ${tally(score.title)}; meal type: ${tally(score.mealType)}`,
    `Fields: ${score.fields.correctAccepted} correct, ${score.fields.incorrectAccepted} INCORRECTLY ACCEPTED, of ${score.fields.expectedValues} expected values`,
    `Extraction: precision ${pct(score.extraction.precision)}, recall ${pct(score.extraction.recall)}`,
    `Abstentions: ${score.fields.missedByModel} by the model, ${score.fields.missedByServer} withheld by grounding, ${score.fields.missedByOutcome} by a non-draft outcome; ${score.fields.stoppedByServer} wrong claims stopped by grounding`,
    `Fields that must not be shown (${score.nullExpectations.total}): ${score.nullExpectations.accepted} shown, ${score.nullExpectations.verifierWithheld} claimed and withheld by the verifier, ${score.nullExpectations.modelDidNotClaim} never claimed by the model, ${score.nullExpectations.nonDraft} no draft (model restraint is NOT verifier evidence)`,
    `Failures: ${score.failures.total} ${JSON.stringify(score.failures.byReason)}`,
    score.latencyMs === null
      ? 'Latency: n/a'
      : `Latency (ms): mean ${score.latencyMs.mean}, p50 ${score.latencyMs.p50}, p95 ${score.latencyMs.p95}, max ${score.latencyMs.max}`,
  ];
  if (report.stopped !== null) lines.push(`Stopped after ${report.stopped.afterCases} cases: ${report.stopped.reason} three times in a row`);
  for (const wrong of score.incorrectAccepted) lines.push(`  incorrect: ${wrong.id} ${wrong.field} proposed ${wrong.actual}, expected ${wrong.expected ?? 'nothing'}`);
  return lines.join('\n');
}
