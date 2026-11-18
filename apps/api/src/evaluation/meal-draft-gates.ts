import {
  MEAL_DRAFT_CLARIFICATION_REASONS,
  MEAL_DRAFT_UNSUPPORTED_REASONS,
  mealDraftMealTypeSchema,
  mealDraftNutritionSchema,
  mealTitleSchema,
} from '@running-tracker/contracts';
import { z } from 'zod';

import type { GroundedProposal, GroundingAudit } from '../meals/drafts/meal-draft-grounding.js';
import {
  MEAL_DRAFT_DATASET_REGISTRY,
  MEAL_DRAFT_DEFAULT_DATASET_VERSION,
  MEAL_DRAFT_EVALUATION_SETS,
  MEAL_DRAFT_REPORT_VERSION,
  scoreMealDraftByCategory,
  scoreMealDraftResults,
  type CaseFailure,
  type CategoryScore,
  type MealDraftCaseResult,
  type MealDraftDatasetVersion,
  type MealDraftEvaluationDataset,
  type MealDraftEvaluationSet,
} from './meal-draft-evaluation.js';
import { fingerprintChanges, type ReproducibilityMetadata, type VerifierDigests } from './meal-draft-metadata.js';
import { mealDraftExecutionProfileSchema, profileIssues, valueDifferences, type MealDraftExecutionProfile } from './meal-draft-profile.js';
import {
  MEAL_DRAFT_SAFETY_CORPUS_DIGEST,
  scoreMealDraftSafety,
  type MealDraftSafetyCorpus,
  type MealDraftSafetyScore,
  type SafetyCaseResult,
} from './meal-draft-safety.js';

// The two gates of the meal draft AI checkpoint (ADR-0092). Each is PASS, FAIL or NOT_RUN, and they are never merged
// into one number:
//
// - VERIFIER (deterministic): the frozen safety corpus of supplied claims through the production wire schema, grounding
//   and response contract. PASS needs every case run, no forbidden value accepted and every positive control proposed.
// - MODEL (real model): complete real-model runs of the frozen development and held-out sets of ONE dataset version
//   (`--dataset-version`, v1 by default; reports of another version are refused, never counted), re-scored here from
//   their per-case results against the pinned datasets, measured with the CURRENT verifier fingerprint (grounding,
//   wire, prompt, adapter and the built contracts they import) and prompt, and with ONE validated execution profile for
//   both sets. Fake providers, missing or partial runs, an unavailable runtime, legacy or inconsistent provenance and an
//   undefined precision can never PASS.
//
// A PASS on both permits further LOCAL EXPERIMENTATION ONLY. The thresholds below were fixed on 2026-11-16 before the
// first call of the baseline run; changing them is a new decision, recorded in ADR-0092, never a fix for a red result.

export type GateStatus = 'FAIL' | 'NOT_RUN' | 'PASS';

export const MEAL_DRAFT_MODEL_GATE = Object.freeze({
  frozenOn: '2026-11-16',
  /** Nutrition values shown that are not the expected ones (pooled over the required sets). */
  maxIncorrectAccepted: 0,
  /** Calls that ended without a grounded answer, any reason (timeout, runtime, shape, ungrounded title), per executed case. */
  maxTechnicalFailureRate: 0.1,
  minExtractionRecall: 0.85,
  minOutcomeAccuracy: 0.85,
  requiredSets: MEAL_DRAFT_EVALUATION_SETS,
});

export const MEAL_DRAFT_GATE_PERMITS =
  'A PASS on these synthetic checks permits further local experimentation only. It is not evidence of generalisation, of product quality or of safety on real text, and the feature stays off by default.';

const MAX_REASONS = 20;
const MAX_REASON_LENGTH = 300;
const bounded = (reasons: readonly string[]) => reasons.slice(0, MAX_REASONS).map((reason) => reason.slice(0, MAX_REASON_LENGTH));

// ---------------------------------------------------------------------------------------------------------------
// Verifier gate.

export interface VerifierGate {
  corpus: { caseCount: number; digest: string | null; version: string | null };
  gate: 'verifier';
  reasons: string[];
  score: MealDraftSafetyScore | null;
  status: GateStatus;
}

export function evaluateVerifierGate(input: { corpus: MealDraftSafetyCorpus; digest: string; results: readonly SafetyCaseResult[] } | null): VerifierGate {
  if (input === null) {
    return { corpus: { caseCount: 0, digest: null, version: null }, gate: 'verifier', reasons: ['The safety corpus was not run.'], score: null, status: 'NOT_RUN' };
  }
  const { corpus, digest, results } = input;
  const reasons: string[] = [];
  if (digest !== MEAL_DRAFT_SAFETY_CORPUS_DIGEST) reasons.push(`The safety corpus is not the frozen one (digest ${digest.slice(0, 12)}…).`);
  const expected = corpus.cases.map((entry) => entry.id);
  const seen = results.map((result) => result.id);
  if (seen.length !== expected.length || new Set(seen).size !== seen.length || expected.some((id) => !seen.includes(id))) {
    reasons.push(`Incomplete: ${new Set(seen).size} of ${expected.length} corpus cases were judged exactly once.`);
  }
  const score = scoreMealDraftSafety(results);
  const { total } = score;
  if (total.forbiddenAccepted > 0) {
    const ids = [...new Set(score.findings.filter((finding) => finding.kind === 'forbidden_accepted').map((finding) => finding.id))];
    reasons.push(`${total.forbiddenAccepted} forbidden value(s) accepted in ${ids.length} case(s): ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}.`);
  }
  if (total.controlsMissed > 0) {
    const ids = [...new Set(score.findings.filter((finding) => finding.kind === 'control_missed').map((finding) => finding.id))];
    reasons.push(`${total.controlsMissed} positive control value(s) not proposed in ${ids.length} case(s): ${ids.slice(0, 8).join(', ')}.`);
  }
  if (total.outcomeMismatches > 0) {
    reasons.push(`${total.outcomeMismatches} case(s) ended with another outcome than expected: ${score.outcomeMismatches.slice(0, 8).map((entry) => `${entry.id} (${entry.actual})`).join(', ')}.`);
  }
  if (total.controls === 0) reasons.push('The corpus has no positive control, so a verifier that withholds everything would pass.');
  if (total.mustWithhold === 0) reasons.push('The corpus has no value that must be withheld.');
  return {
    corpus: { caseCount: corpus.cases.length, digest, version: corpus.corpusVersion },
    gate: 'verifier',
    reasons: bounded(reasons),
    score,
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
  };
}

export interface MealDraftSafetyReport {
  caseCount: number;
  corpusDigest: string;
  corpusVersion: string;
  executedCount: number;
  gate: VerifierGate;
  kind: 'deterministic-verifier-safety';
  metadata: ReproducibilityMetadata | null;
  reportVersion: typeof MEAL_DRAFT_REPORT_VERSION;
  results: SafetyCaseResult[];
  set: 'safety';
  statement: string;
}

export function buildMealDraftSafetyReport(input: {
  corpus: MealDraftSafetyCorpus;
  digest: string;
  metadata: ReproducibilityMetadata | null;
  results: SafetyCaseResult[];
}): MealDraftSafetyReport {
  return {
    caseCount: input.corpus.cases.length,
    corpusDigest: input.digest,
    corpusVersion: input.corpus.corpusVersion,
    executedCount: input.results.length,
    gate: evaluateVerifierGate(input),
    kind: 'deterministic-verifier-safety',
    metadata: input.metadata,
    reportVersion: MEAL_DRAFT_REPORT_VERSION,
    results: input.results,
    set: 'safety',
    statement: 'Supplied claims, no model: a statement about the verifier only, never about a model.',
  };
}

export function formatVerifierGate(gate: VerifierGate): string {
  const lines = [`VERIFIER GATE: ${gate.status} (deterministic safety corpus v${gate.corpus.version ?? '?'}, ${gate.corpus.caseCount} cases, supplied claims, no model)`];
  if (gate.score !== null) {
    const { total } = gate.score;
    lines.push(
      `  forbidden values accepted: ${total.forbiddenAccepted} of ${total.mustWithhold} that must be withheld; positive controls: ${total.controls - total.controlsMissed}/${total.controls}; outcome mismatches: ${total.outcomeMismatches}`,
    );
    for (const language of ['en', 'ru'] as const) {
      const tally = gate.score.byLanguage[language];
      lines.push(`  ${language}: ${tally.cases} cases, ${tally.forbiddenAccepted} forbidden accepted, controls ${tally.controls - tally.controlsMissed}/${tally.controls}`);
    }
    for (const [category, tally] of Object.entries(gate.score.byCategory)) {
      if (tally.forbiddenAccepted + tally.controlsMissed + tally.outcomeMismatches > 0) {
        lines.push(`  category ${category}: ${tally.forbiddenAccepted} forbidden accepted, ${tally.controlsMissed} controls missed, ${tally.outcomeMismatches} outcome mismatches (${tally.cases} cases)`);
      }
    }
    for (const finding of gate.score.findings) {
      lines.push(`    ${finding.kind}: ${finding.id} ${finding.field} shown ${finding.actual ?? 'nothing'}, expected ${finding.expected}`);
    }
  }
  for (const reason of gate.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Model gate.

const proposalSchema: z.ZodType<GroundedProposal> = z.discriminatedUnion('outcome', [
  z.object({ mealType: mealDraftMealTypeSchema, nutrition: mealDraftNutritionSchema, outcome: z.literal('draft'), title: mealTitleSchema }),
  z.object({ outcome: z.literal('clarify'), reason: z.enum(MEAL_DRAFT_CLARIFICATION_REASONS) }),
  z.object({ outcome: z.literal('unsupported'), reason: z.enum(MEAL_DRAFT_UNSUPPORTED_REASONS) }),
]);

const disposition = z.enum(['model_abstained', 'not_stated', 'proposed', 'server_withheld']);
const auditSchema: z.ZodType<GroundingAudit> = z.object({
  fields: z.object({ carbohydrateG: disposition, energyKcal: disposition, fatG: disposition, proteinG: disposition }).nullable(),
  multipleMealsOverride: z.boolean(),
});

const failureSchema: z.ZodType<CaseFailure> = z.enum(['incomplete', 'invalid_output', 'oversized', 'provider_error', 'provider_unavailable', 'timeout', 'ungrounded_output']);

/** What every report version (1 to 3) carries: enough to say what it is and to re-score its cases. */
const reportCoreSchema = z.object({
  calls: z.number().int().nonnegative(),
  caseCount: z.number().int().nonnegative(),
  cases: z.array(
    z.object({ audit: auditSchema.nullable().optional(), durationMs: z.number().nonnegative(), failure: failureSchema.nullable(), id: z.string(), proposal: proposalSchema.nullable() }),
  ),
  datasetDigest: z.string(),
  /** Always written by the runner (every recorded report says "1"); a report without it is refused as evidence. */
  datasetVersion: z.string().optional(),
  executedCount: z.number().int().nonnegative(),
  kind: z.enum(['fake-harness-verification', 'real-model']),
  model: z.string(),
  partial: z.boolean(),
  provider: z.string(),
  /** Absent in version 1 (2026-11-14). */
  reportVersion: z.number().int().positive().optional(),
  set: z.enum(MEAL_DRAFT_EVALUATION_SETS),
  status: z.literal('EXECUTED').optional(),
  stopped: z.object({ afterCases: z.number(), reason: z.string() }).nullable(),
});

const hex64 = /^[0-9a-f]{64}$/u;

/**
 * The provenance only a version 3 report carries. The profile and the duplicated fields are only read here (a missing
 * one is reported by name by the profile and consistency checks below); the fingerprint and prompt digest must parse.
 */
const evidenceSchema = z.object({
  executionProfile: z.unknown().optional(),
  generation: z.unknown().optional(),
  metadata: z.object({
    datasetDigest: z.unknown().optional(),
    fingerprint: z.object({
      // From fingerprint version 2; read only to name what changed, the digest alone decides.
      contracts: z
        .object({
          bindings: z.array(z.object({ local: z.string(), module: z.string(), name: z.string() })),
          conditionPath: z.array(z.string()),
          entry: z.string(),
          manifest: z.string(),
          package: z.literal('@running-tracker/contracts'),
        })
        .optional()
        .catch(undefined),
      digest: z.string().regex(hex64),
      files: z.array(z.object({ path: z.string(), sha256: z.string() })),
      fingerprintVersion: z.number(),
      packages: z.array(z.object({ name: z.string(), version: z.string().nullable() })),
    }),
    generation: z.unknown().optional(),
    model: z.unknown().optional(),
    modelDigest: z.unknown().optional(),
    ollamaVersion: z.unknown().optional(),
    promptDigest: z.string(),
    timeoutMs: z.unknown().optional(),
  }),
  profileCheck: z.object({ mismatches: z.number().int().nonnegative(), requests: z.number().int().nonnegative() }).nullable().optional(),
  promptDigest: z.string(),
  runtimeVersion: z.unknown().optional(),
  timeoutMs: z.unknown().optional(),
});

const notRunReportSchema = z.object({
  /** Absent in NOT_RUN reports written before dataset versions were selectable, which were all version 1. */
  datasetVersion: z.string().optional(),
  reason: z.string(),
  reportVersion: z.number().int().positive(),
  set: z.enum(MEAL_DRAFT_EVALUATION_SETS),
  status: z.literal('NOT_RUN'),
});

type ReportCore = z.infer<typeof reportCoreSchema>;

/**
 * Why a gate is not PASS, typed so that a reader can tell apart evidence that cannot be judged (legacy or inconsistent
 * provenance), a run that is incomplete, and a measured quality failure. `note` never decides the status.
 */
export interface GateReason {
  code:
    | 'DATASET_MISMATCH'
    | 'DATASET_VERSION_MISMATCH'
    | 'DATASET_VERSION_MIXED'
    | 'DUPLICATE_REPORT'
    | 'EXTRACTION_RECALL'
    | 'FAILURE_RATE'
    | 'FAKE_IGNORED'
    | 'FINGERPRINT_MISMATCH'
    | 'INCORRECT_ACCEPTED'
    | 'LEGACY_REPORT'
    | 'METADATA_INVALID'
    | 'OUTCOME_ACCURACY'
    | 'PRECISION_UNDEFINED'
    | 'PROFILE_INCONSISTENT'
    | 'PROFILE_INVALID'
    | 'PROFILE_MISMATCH'
    | 'PROFILE_UNVERIFIED'
    | 'PROMPT_MISMATCH'
    | 'REPORT_INVALID'
    | 'SET_INCOMPLETE';
  kind: 'completeness' | 'evidence' | 'note' | 'quality';
  message: string;
}

const reason = (code: GateReason['code'], kind: GateReason['kind'], message: string): GateReason => ({ code, kind, message: message.slice(0, MAX_REASON_LENGTH) });

export type SetState = { detail: string; state: 'complete' | 'not_run' | 'partial' };

export interface ModelGateMetrics {
  byLanguage: Record<'en' | 'ru', { cases: number; failures: number; incorrectAccepted: number; outcomeAccuracy: number | null; recall: number | null }>;
  cases: number;
  extractionPrecision: number | null;
  extractionRecall: number | null;
  failuresByCategory: Record<string, CategoryScore>;
  failuresByReason: Record<string, number>;
  incorrectAccepted: number;
  incorrectAcceptedFields: Array<{ actual: number; expected: number | null; field: string; id: string }>;
  outcomeAccuracy: number | null;
  technicalFailureRate: number | null;
  technicalFailures: number;
}

export interface ModelGate {
  /** The dataset version judged; every report must have been measured on it. */
  datasetVersion: MealDraftDatasetVersion;
  /** True only when every real-model report carries current, complete and consistent provenance. */
  evidenceValid: boolean;
  fingerprint: { current: string; reports: Partial<Record<MealDraftEvaluationSet, string | null>> };
  gate: 'model';
  /** Re-scored from the per-case results of the real-model reports given, whatever their provenance. */
  metrics: ModelGateMetrics | null;
  /** The one execution profile both sets were measured with, when there is exactly one valid profile. */
  profile: MealDraftExecutionProfile | null;
  /** Whether the metrics meet the frozen thresholds; informative only, never a PASS on its own. */
  qualityThresholdsMet: boolean | null;
  reasons: GateReason[];
  sets: Record<MealDraftEvaluationSet, SetState>;
  status: GateStatus;
  thresholds: typeof MEAL_DRAFT_MODEL_GATE;
}

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : Math.round((numerator / denominator) * 1_000) / 1_000);

function metricsOf(results: readonly MealDraftCaseResult[]): ModelGateMetrics {
  const score = scoreMealDraftResults(results);
  const perLanguage = (language: 'en' | 'ru') => {
    const part = scoreMealDraftResults(results.filter((result) => result.case.language === language));
    return {
      cases: part.outcome.total,
      failures: part.failures.total,
      incorrectAccepted: part.fields.incorrectAccepted,
      outcomeAccuracy: ratio(part.outcome.correct, part.outcome.total),
      recall: part.extraction.recall,
    };
  };
  return {
    byLanguage: { en: perLanguage('en'), ru: perLanguage('ru') },
    cases: score.outcome.total,
    extractionPrecision: score.extraction.precision,
    extractionRecall: score.extraction.recall,
    failuresByCategory: scoreMealDraftByCategory(results),
    failuresByReason: score.failures.byReason,
    incorrectAccepted: score.fields.incorrectAccepted,
    incorrectAcceptedFields: score.incorrectAccepted,
    outcomeAccuracy: ratio(score.outcome.correct, score.outcome.total),
    technicalFailureRate: ratio(score.failures.total, score.outcome.total),
    technicalFailures: score.failures.total,
  };
}

function qualityReasons(metrics: ModelGateMetrics): GateReason[] {
  const thresholds = MEAL_DRAFT_MODEL_GATE;
  const found: GateReason[] = [];
  if (metrics.incorrectAccepted > thresholds.maxIncorrectAccepted) {
    found.push(reason('INCORRECT_ACCEPTED', 'quality', `${metrics.incorrectAccepted} nutrition value(s) incorrectly accepted (allowed ${thresholds.maxIncorrectAccepted}).`));
  }
  if (metrics.outcomeAccuracy === null || metrics.outcomeAccuracy < thresholds.minOutcomeAccuracy) {
    found.push(reason('OUTCOME_ACCURACY', 'quality', `Outcome accuracy ${metrics.outcomeAccuracy ?? 'undefined'} is below ${thresholds.minOutcomeAccuracy}.`));
  }
  if (metrics.extractionRecall === null || metrics.extractionRecall < thresholds.minExtractionRecall) {
    found.push(reason('EXTRACTION_RECALL', 'quality', `Extraction recall ${metrics.extractionRecall ?? 'undefined'} is below ${thresholds.minExtractionRecall}.`));
  }
  if (metrics.extractionPrecision === null) {
    found.push(reason('PRECISION_UNDEFINED', 'quality', 'Extraction precision is undefined (no value was accepted), so safety and usefulness cannot be judged.'));
  }
  if (metrics.technicalFailureRate === null || metrics.technicalFailureRate > thresholds.maxTechnicalFailureRate) {
    found.push(reason('FAILURE_RATE', 'quality', `Technical failure rate ${metrics.technicalFailureRate ?? 'undefined'} is above ${thresholds.maxTechnicalFailureRate}.`));
  }
  return found;
}

const RERUN = 'Re-run both sets with the current tool (40 calls).';

/** The provenance checks of one version 3 report; returns its valid profile, or null with the reasons why not. */
function judgeProvenance(set: MealDraftEvaluationSet, report: ReportCore, raw: unknown, context: ModelGateContext, reasons: GateReason[]): { fingerprint: string | null; profile: MealDraftExecutionProfile | null } {
  const parsed = evidenceSchema.safeParse(raw);
  if (!parsed.success) {
    reasons.push(reason('METADATA_INVALID', 'evidence', `The ${set} report has missing or invalid provenance: ${profileIssues(parsed.error).join('; ')}. ${RERUN}`));
    return { fingerprint: null, profile: null };
  }
  const evidence = parsed.data;
  const recorded = evidence.metadata.fingerprint;
  if (recorded.digest !== context.current.fingerprint.digest) {
    // As many changes as fit, so the re-run advice is never cut off by the reason length limit.
    const opening = `The ${set} report was measured with another verifier or adapter (`;
    const closing = `). ${RERUN}`;
    const changes = fingerprintChanges(recorded, context.current.fingerprint);
    let listed = '';
    let count = 0;
    for (const change of changes) {
      const next = listed === '' ? change : `${listed}, ${change}`;
      if (opening.length + next.length + ', …'.length + closing.length > MAX_REASON_LENGTH) break;
      listed = next;
      count += 1;
    }
    if (count === 0 && changes.length > 0) listed = changes[0]!.slice(0, MAX_REASON_LENGTH - opening.length - closing.length - ', …'.length);
    reasons.push(reason('FINGERPRINT_MISMATCH', 'evidence', `${opening}${listed || 'fingerprint format'}${changes.length > Math.max(count, 1) ? ', …' : ''}${closing}`));
  }
  if (evidence.promptDigest !== context.current.promptDigest || evidence.metadata.promptDigest !== evidence.promptDigest) {
    reasons.push(reason('PROMPT_MISMATCH', 'evidence', `The ${set} report was measured with another prompt or records two prompt digests. ${RERUN}`));
  }

  const profileResult = mealDraftExecutionProfileSchema.safeParse(evidence.executionProfile);
  if (!profileResult.success) {
    reasons.push(reason('PROFILE_INVALID', 'evidence', `The ${set} report has no valid execution profile: ${profileIssues(profileResult.error).join('; ')}. ${RERUN}`));
    return { fingerprint: recorded.digest, profile: null };
  }
  const profile = profileResult.data;
  const { metadata } = evidence;
  const duplicated: Array<[string, unknown, unknown]> = [
    ['provider', report.provider, profile.provider],
    ['model', report.model, profile.model],
    ['metadata.model', metadata.model, profile.model],
    ['metadata.modelDigest', metadata.modelDigest, profile.modelDigest],
    ['runtimeVersion', evidence.runtimeVersion, profile.ollamaVersion],
    ['metadata.ollamaVersion', metadata.ollamaVersion, profile.ollamaVersion],
    ['timeoutMs', evidence.timeoutMs, profile.timeoutMs],
    ['metadata.timeoutMs', metadata.timeoutMs, profile.timeoutMs],
    ['generation', evidence.generation, profile.generation],
    ['metadata.generation', metadata.generation, profile.generation],
    ['metadata.datasetDigest', metadata.datasetDigest, report.datasetDigest],
  ];
  const disagreements = duplicated.flatMap(([label, actual, expected]) => valueDifferences(actual, expected, label));
  if (disagreements.length > 0) {
    reasons.push(
      reason('PROFILE_INCONSISTENT', 'evidence', `The ${set} report disagrees with its own execution profile (missing or different): ${disagreements.slice(0, 6).join(', ')}${disagreements.length > 6 ? ', …' : ''}.`),
    );
  }
  const check = evidence.profileCheck ?? null;
  if (check === null || check.mismatches > 0 || check.requests !== report.calls) {
    reasons.push(
      reason(
        'PROFILE_UNVERIFIED',
        'evidence',
        check === null
          ? `The ${set} report did not check its requests against the profile.`
          : `The ${set} report checked ${check.requests} request(s) for ${report.calls} call(s), ${check.mismatches} not matching the profile.`,
      ),
    );
  }
  return { fingerprint: recorded.digest, profile };
}

export interface ModelGateContext {
  current: Pick<VerifierDigests, 'fingerprint' | 'promptDigest'>;
  /** The version judged (version 1 when absent); `datasets` must be that version's pinned sets. */
  datasetVersion?: MealDraftDatasetVersion;
  datasets: Readonly<Record<MealDraftEvaluationSet, { dataset: MealDraftEvaluationDataset; digest: string }>>;
}

/**
 * Pure and offline. `reports` are parsed JSON files as written by the evaluation runner (or anything else: what does
 * not parse is a reason, never ignored silently). Every number is recomputed from the per-case results and the pinned
 * datasets; provenance (report version, verifier fingerprint, prompt, one execution profile for both sets, its
 * duplicated fields and its per-request check) is judged before any quality number can count.
 */
export function evaluateModelGate(reports: readonly unknown[], context: ModelGateContext): ModelGate {
  const reasons: GateReason[] = [];
  const version = context.datasetVersion ?? MEAL_DRAFT_DEFAULT_DATASET_VERSION;
  const pinned = MEAL_DRAFT_DATASET_REGISTRY[version];
  const sets = Object.fromEntries(MEAL_DRAFT_EVALUATION_SETS.map((set) => [set, { detail: 'no report', state: 'not_run' }])) as Record<MealDraftEvaluationSet, SetState>;
  const executed = new Map<MealDraftEvaluationSet, { core: ReportCore; raw: unknown }>();
  /** The dataset versions the real-model and NOT_RUN reports given say they measured. */
  const versionsSeen = new Set<string>();
  /** A report of another version is refused and never counted: v1 evidence is never a v2 measurement, nor the reverse. */
  const otherVersion = (index: number, set: string, recorded: string | undefined): boolean => {
    versionsSeen.add(recorded ?? 'none');
    if (recorded === version) return false;
    reasons.push(
      reason(
        'DATASET_VERSION_MISMATCH',
        'evidence',
        recorded === undefined
          ? `Report ${index + 1} (${set}) records no dataset version, so it cannot be judged as a v${version} measurement.`
          : `Report ${index + 1} (${set}) was measured on dataset v${recorded}, not on the v${version} sets judged here (--dataset-version v${version}); it is not counted.`,
      ),
    );
    return true;
  };

  reports.forEach((raw, index) => {
    const notRun = notRunReportSchema.safeParse(raw);
    if (notRun.success) {
      // NOT_RUN reports written before versions were selectable were all version 1.
      if (otherVersion(index, notRun.data.set, notRun.data.datasetVersion ?? '1')) return;
      if (!executed.has(notRun.data.set)) sets[notRun.data.set] = { detail: `NOT_RUN: ${notRun.data.reason}`, state: 'not_run' };
      return;
    }
    const parsed = reportCoreSchema.safeParse(raw);
    if (!parsed.success) {
      reasons.push(reason('REPORT_INVALID', 'evidence', `Report ${index + 1} is not a meal draft evaluation report.`));
      return;
    }
    const core = parsed.data;
    if (core.kind !== 'real-model' || core.provider !== 'ollama') {
      reasons.push(reason('FAKE_IGNORED', 'note', `Report ${index + 1} (${core.set}) comes from the ${core.provider} provider: harness verification is not model evidence and is ignored.`));
      return;
    }
    if (otherVersion(index, core.set, core.datasetVersion)) return;
    if (executed.has(core.set)) {
      reasons.push(reason('DUPLICATE_REPORT', 'completeness', `More than one real-model report for the ${core.set} set; the selection is ambiguous.`));
      return;
    }
    executed.set(core.set, { core, raw });
  });

  const profiles = new Map<MealDraftEvaluationSet, MealDraftExecutionProfile>();
  const fingerprints: Partial<Record<MealDraftEvaluationSet, string | null>> = {};
  const pooled: MealDraftCaseResult[] = [];
  if (versionsSeen.size > 1) {
    const listed = [...versionsSeen].sort().map((entry) => (entry === 'none' ? 'none recorded' : `v${entry}`));
    reasons.push(reason('DATASET_VERSION_MIXED', 'evidence', `The reports given mix dataset versions (${listed.join(', ')}); one gate judges one version.`));
  }

  for (const [set, { core, raw }] of executed) {
    const { dataset, digest } = context.datasets[set];
    if (core.datasetDigest !== digest || digest !== pinned[set].digest || dataset.datasetVersion !== version) {
      reasons.push(reason('DATASET_MISMATCH', 'evidence', `The ${set} report was measured on another dataset than the frozen v${version} one.`));
    }
    const reportVersion = core.reportVersion ?? 1;
    if (reportVersion !== MEAL_DRAFT_REPORT_VERSION) {
      fingerprints[set] = null;
      reasons.push(
        reason(
          'LEGACY_REPORT',
          'evidence',
          `The ${set} report is report version ${reportVersion}: no verifier fingerprint over contracts and adapter, no execution profile; not judgeable as current evidence (its numbers stand as recorded). ${RERUN}`,
        ),
      );
    } else {
      const judged = judgeProvenance(set, core, raw, context, reasons);
      fingerprints[set] = judged.fingerprint;
      if (judged.profile !== null) profiles.set(set, judged.profile);
    }

    const byId = new Map(dataset.cases.map((entry) => [entry.id, entry]));
    const results: MealDraftCaseResult[] = [];
    let unknownIds = 0;
    for (const entry of core.cases) {
      const known = byId.get(entry.id);
      if (known === undefined) unknownIds += 1;
      else results.push({ audit: entry.audit ?? null, case: known, durationMs: entry.durationMs, failure: entry.failure, proposal: entry.proposal });
    }
    const ids = core.cases.map((entry) => entry.id);
    const answered = results.filter((result) => result.failure !== 'provider_unavailable').length;
    if (results.length > 0 && answered === 0) {
      sets[set] = { detail: 'the runtime was unavailable for every executed case (no model answer)', state: 'not_run' };
      continue;
    }
    const complete =
      !core.partial &&
      core.stopped === null &&
      unknownIds === 0 &&
      core.caseCount === dataset.cases.length &&
      core.executedCount === dataset.cases.length &&
      core.calls === core.executedCount &&
      ids.length === dataset.cases.length &&
      new Set(ids).size === ids.length;
    sets[set] = complete
      ? { detail: `${ids.length}/${dataset.cases.length} cases, ${core.calls} calls`, state: 'complete' }
      : {
          detail: `${new Set(ids).size}/${dataset.cases.length} distinct cases, ${core.calls} calls${core.stopped === null ? '' : `, stopped after ${core.stopped.afterCases} (${core.stopped.reason})`}`,
          state: 'partial',
        };
    pooled.push(...results);
  }

  // One profile for all the evidence.
  let profile: MealDraftExecutionProfile | null = null;
  const judgedProfiles = [...profiles];
  if (judgedProfiles.length > 0) {
    const [firstSet, first] = judgedProfiles[0]!;
    const differing = judgedProfiles.slice(1).flatMap(([set, other]) => valueDifferences(first, other).map((path) => `${path} (${firstSet} ${JSON.stringify(valueAt(first, path))}, ${set} ${JSON.stringify(valueAt(other, path))})`));
    if (differing.length > 0) {
      reasons.push(reason('PROFILE_MISMATCH', 'evidence', `The sets were measured with different execution profiles: ${differing.slice(0, 4).join('; ')}${differing.length > 4 ? '; …' : ''}. ${RERUN}`));
    } else if (judgedProfiles.length === executed.size) {
      profile = first;
    }
  }

  const states = MEAL_DRAFT_EVALUATION_SETS.map((set) => sets[set].state);
  const metrics = pooled.length === 0 ? null : metricsOf(pooled);
  const quality = metrics === null ? [] : qualityReasons(metrics);
  const deciding = () => reasons.filter((entry) => entry.kind !== 'note');
  const evidenceValid = executed.size > 0 && deciding().every((entry) => entry.kind !== 'evidence');
  const base = {
    datasetVersion: version,
    evidenceValid,
    fingerprint: { current: context.current.fingerprint.digest, reports: fingerprints },
    gate: 'model' as const,
    metrics,
    profile,
    qualityThresholdsMet: metrics === null ? null : quality.length === 0,
    sets,
    thresholds: MEAL_DRAFT_MODEL_GATE,
  };

  if (states.every((state) => state === 'not_run') && deciding().length === 0) {
    const detail = MEAL_DRAFT_EVALUATION_SETS.map((set) => reason('SET_INCOMPLETE', 'completeness', `${set}: ${sets[set].detail}.`));
    return { ...base, evidenceValid: false, reasons: [...detail, ...reasons].slice(0, MAX_REASONS), status: 'NOT_RUN' };
  }
  for (const set of MEAL_DRAFT_EVALUATION_SETS) {
    if (sets[set].state !== 'complete') {
      reasons.push(reason('SET_INCOMPLETE', 'completeness', `Incomplete execution: the ${set} set is ${sets[set].state === 'partial' ? 'partial' : 'not run'} (${sets[set].detail}).`));
    }
  }
  reasons.push(...quality);
  const ordered = [...deciding(), ...reasons.filter((entry) => entry.kind === 'note')];
  return { ...base, reasons: ordered.slice(0, MAX_REASONS), status: deciding().length === 0 ? 'PASS' : 'FAIL' };
}

function valueAt(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined), value);
}

const pct = (value: number | null) => (value === null ? 'undefined' : `${(value * 100).toFixed(1)}%`);

export function formatModelGate(gate: ModelGate): string {
  const lines = [`MODEL GATE: ${gate.status} (real model on the frozen v${gate.datasetVersion} development and held-out sets; thresholds frozen ${gate.thresholds.frozenOn})`];
  lines.push(`  evidence: ${gate.evidenceValid ? 'valid (current fingerprint, one consistent execution profile)' : 'NOT VALID for this gate (see the evidence reasons)'}`);
  if (gate.profile !== null) {
    const { generation } = gate.profile;
    lines.push(
      `  profile: ${gate.profile.model} (${gate.profile.modelDigest.slice(0, 12)}…), Ollama ${gate.profile.ollamaVersion}, deadline ${gate.profile.timeoutMs} ms, temperature ${generation.temperature}, think ${generation.think}, num_ctx ${generation.numCtx}, num_predict ${generation.numPredict}, response ≤ ${gate.profile.maxResponseBytes} B, retries ${gate.profile.retries}`,
    );
  }
  for (const set of MEAL_DRAFT_EVALUATION_SETS) lines.push(`  ${set}: ${gate.sets[set].state} (${gate.sets[set].detail})`);
  const { metrics } = gate;
  if (metrics !== null) {
    lines.push(
      `  measured on the reports given${gate.evidenceValid ? '' : ' (NOT validated evidence)'}: ${metrics.cases} cases, incorrectly accepted ${metrics.incorrectAccepted}; outcome ${pct(metrics.outcomeAccuracy)}; recall ${pct(metrics.extractionRecall)}; precision ${pct(metrics.extractionPrecision)}; failures ${metrics.technicalFailures} (${pct(metrics.technicalFailureRate)}) ${JSON.stringify(metrics.failuresByReason)}; thresholds ${gate.qualityThresholdsMet ? 'met' : 'not met'}`,
    );
    for (const language of ['en', 'ru'] as const) {
      const part = metrics.byLanguage[language];
      lines.push(`  ${language}: ${part.cases} cases, outcome ${pct(part.outcomeAccuracy)}, recall ${pct(part.recall)}, incorrect ${part.incorrectAccepted}, failures ${part.failures}`);
    }
  }
  for (const entry of gate.reasons) lines.push(`  - [${entry.kind} ${entry.code}] ${entry.message}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Both.

export interface MealDraftGateReport {
  exitCode: 0 | 2 | 3;
  kind: 'meal-draft-gates';
  metadata: ReproducibilityMetadata | null;
  model: ModelGate;
  overall: GateStatus;
  permits: string;
  reportVersion: typeof MEAL_DRAFT_REPORT_VERSION;
  verifier: VerifierGate;
}

/** FAIL wins over NOT_RUN, which wins over PASS. */
export function overallStatus(statuses: readonly GateStatus[]): GateStatus {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('NOT_RUN') || statuses.length === 0) return 'NOT_RUN';
  return 'PASS';
}

/** 0 PASS, 2 FAIL, 3 NOT_RUN. 1 is reserved for an error that prevented a verdict. */
export function gateExitCode(status: GateStatus): 0 | 2 | 3 {
  return status === 'PASS' ? 0 : status === 'FAIL' ? 2 : 3;
}

export function buildMealDraftGateReport(verifier: VerifierGate, model: ModelGate, metadata: ReproducibilityMetadata | null): MealDraftGateReport {
  const overall = overallStatus([verifier.status, model.status]);
  return { exitCode: gateExitCode(overall), kind: 'meal-draft-gates', metadata, model, overall, permits: MEAL_DRAFT_GATE_PERMITS, reportVersion: MEAL_DRAFT_REPORT_VERSION, verifier };
}
