import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_QUESTION_CLARIFICATION_REASONS,
  DATA_QUESTION_UNSUPPORTED_REASONS,
  dataQuestionIntentSchema,
  dataQuestionPlanSchema,
  type DataQuestionInterpretationResponse,
} from '@running-tracker/contracts';
import { z } from 'zod';

import type { Clock } from '../clock.js';
import { DataQuestionInterpretationService } from '../data-questions/data-question-interpretation-service.js';
import { resolveDataQuestionPlan } from '../data-questions/data-question-plan.js';
import { DATA_QUESTION_PROMPT_VERSION, dataQuestionPromptDigest } from '../data-questions/data-question-prompt.js';
import { DATA_QUESTION_WIRE_SCHEMA_NAME } from '../data-questions/data-question-wire.js';
import { ApiError } from '../http/errors.js';
import type { LlmProvider } from '../insights/llm-provider.js';
import { createLogger } from '../observability/logger.js';
import { InterpretationAdmission } from '../runs/interpretation/interpretation-admission.js';
import { normalizedDigest, readGitState, type GitState } from './meal-draft-metadata.js';
import { mealDraftExecutionProfileSchema, valueDifferences, type MealDraftExecutionProfile } from './meal-draft-profile.js';

// The question-interpretation evaluation of "Ask my data" (ADR-0094). Separate from the meal-draft quality gate: its own
// frozen synthetic sets, its own thresholds, its own report and gate. Every case runs through the PRODUCT pipeline (the
// interpretation service: wire schema, deterministic normalization, plan resolution with the case's fixed clock), so the
// score is of what a person would be shown, not of raw model text. Synthetic engineering gates, not generalization.
//
// Bounded and content-free reports: ids, categories, outcome codes, resolved plans of synthetic cases, latency and
// digests. Never the model's raw answer.

export const DATA_QUESTION_EVAL_SETS = ['development', 'heldout'] as const;
export type DataQuestionEvalSet = (typeof DATA_QUESTION_EVAL_SETS)[number];
export const DATA_QUESTION_EVAL_DATASET_VERSION = 'data-question-eval-1';
/** At most this many inference calls in one invocation, and in the whole measurement (both sets). */
export const DATA_QUESTION_EVAL_MAX_CALLS = 40;
/** Consecutive identical systemic failures after which a run stops (the model or runtime is not working). */
export const DATA_QUESTION_EVAL_FAILURE_STREAK = 3;
export const DATA_QUESTION_REPORT_VERSION = 1;

/** Frozen before any inference (see the freeze record of the ADR-0094 report). */
export const DATA_QUESTION_THRESHOLDS = Object.freeze({
  exactAccuracyMin: 0.9,
  executableOnNonPlanMax: 0,
  technicalFailureMax: 0.1,
});

/** Pinned SHA-256 (line endings normalized) of each frozen dataset file. A changed file is a new version, not this one. */
export const DATA_QUESTION_DATASET_DIGESTS: Readonly<Record<DataQuestionEvalSet, string>> = Object.freeze({
  development: '2178ed1adb65792013b7b3965a66867917cce8c9d37359f9f9f204016a7ab207',
  heldout: 'ae698e5d247cef2873b4125f7d8d99e8448d827735fbb3d55f0f355edab616be',
});

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
export const datasetPath = (set: DataQuestionEvalSet) => resolve(repositoryRoot, 'apps', 'api', 'evaluation', `data-question.${set}.v1.json`);

const contextSchema = z.strictObject({ now: z.iso.datetime({ offset: false }), selectedDate: z.string(), timeZone: z.string() });
const expectedSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ intent: dataQuestionIntentSchema, outcome: z.literal('proposal'), plan: dataQuestionPlanSchema }),
  z.strictObject({ outcome: z.literal('clarify'), reason: z.enum(DATA_QUESTION_CLARIFICATION_REASONS) }),
  z.strictObject({ outcome: z.literal('unsupported'), reason: z.enum(DATA_QUESTION_UNSUPPORTED_REASONS) }),
]);
export const dataQuestionEvalCaseSchema = z.strictObject({
  category: z.enum(['supported', 'ambiguous', 'unsupported', 'adversarial']),
  context: contextSchema,
  expected: expectedSchema,
  id: z.string().regex(/^(?:en|ru)-(?:dev|ho)-[a-z0-9-]+$/u),
  language: z.enum(['en', 'ru']),
  text: z.string().min(1).max(300),
});
export const dataQuestionEvalDatasetSchema = z.strictObject({
  cases: z.array(dataQuestionEvalCaseSchema).length(20),
  description: z.string(),
  name: z.enum(DATA_QUESTION_EVAL_SETS),
  version: z.literal(DATA_QUESTION_EVAL_DATASET_VERSION),
});
export type DataQuestionEvalCase = z.infer<typeof dataQuestionEvalCaseSchema>;
export type DataQuestionEvalDataset = z.infer<typeof dataQuestionEvalDatasetSchema>;

export function datasetFileDigest(text: string): string {
  return normalizedDigest(text);
}

/** Reads, validates and checks a frozen set: its pinned digest, balance, unique ids, and every expected plan's resolution. */
export function loadDataQuestionDataset(set: DataQuestionEvalSet, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): { dataset: DataQuestionEvalDataset; digest: string } {
  const text = read(datasetPath(set));
  const digest = datasetFileDigest(text);
  if (digest !== DATA_QUESTION_DATASET_DIGESTS[set]) throw new Error(`The ${set} dataset does not match its pinned digest`);
  const dataset = dataQuestionEvalDatasetSchema.parse(JSON.parse(text));
  if (dataset.name !== set) throw new Error(`The ${set} dataset names itself ${dataset.name}`);
  const problems = datasetProblems(dataset);
  if (problems.length > 0) throw new Error(`The ${set} dataset is inconsistent: ${problems.join('; ')}`);
  return { dataset, digest };
}

/** Structural checks independent of the digest (also used by the specification). */
export function datasetProblems(dataset: DataQuestionEvalDataset): string[] {
  const problems: string[] = [];
  if (new Set(dataset.cases.map((entry) => entry.id)).size !== dataset.cases.length) problems.push('duplicate ids');
  if (dataset.cases.filter((entry) => entry.language === 'en').length !== 10) problems.push('not 10 English cases');
  for (const entry of dataset.cases) {
    if (entry.expected.outcome !== 'proposal') continue;
    const resolved = resolveDataQuestionPlan(entry.expected.intent, entry.context, { utcNow: () => new Date(entry.context.now) });
    if (canonical(resolved) !== canonical(entry.expected.plan)) problems.push(`${entry.id}: the expected plan is not the resolution of its intent`);
  }
  return problems;
}

/** JSON with object keys sorted. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right)))
      : inner,
  );
}

// The code that decides an interpretation's outcome: an explicit, reviewed list (not an import closure). Changing any of
// these files changes the fingerprint and makes earlier model reports stale.
export const DATA_QUESTION_FINGERPRINT_FILES = [
  'apps/api/src/data-questions/data-question-interpretation-service.ts',
  'apps/api/src/data-questions/data-question-normalizer.ts',
  'apps/api/src/data-questions/data-question-plan.ts',
  'apps/api/src/data-questions/data-question-prompt.ts',
  'apps/api/src/data-questions/data-question-wire.ts',
  'apps/api/src/insights/llm-provider.ts',
  'apps/api/src/insights/ollama-provider.ts',
  'apps/api/src/runs/interpretation/bounded-fetch.ts',
  'apps/api/src/runs/run-search-period.ts',
  'packages/contracts/src/activity-trends.ts',
  'packages/contracts/src/daily-metrics.ts',
  'packages/contracts/src/daily-trends.ts',
  'packages/contracts/src/data-questions.ts',
  'packages/contracts/src/primitives.ts',
] as const;

export function dataQuestionCodeFingerprint(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): string {
  const hash = createHash('sha256');
  for (const file of DATA_QUESTION_FINGERPRINT_FILES) hash.update(`${file}\n${normalizedDigest(read(resolve(repositoryRoot, file)))}\n`, 'utf8');
  return hash.digest('hex');
}

export type CaseOutcome =
  | { outcome: 'proposal'; plan: unknown }
  | { outcome: 'clarify' | 'unsupported'; reason: string }
  | { failure: string; outcome: 'failure' };

export interface DataQuestionCaseResult {
  category: DataQuestionEvalCase['category'];
  exact: boolean;
  /** An executable proposal on a case that expects a clarification or a refusal. */
  executableOnNonPlan: boolean;
  expected: 'clarify' | 'proposal' | 'unsupported';
  got: CaseOutcome;
  id: string;
  language: 'en' | 'ru';
  latencyMs: number;
}

const SYSTEMIC = new Set(['provider_unavailable', 'provider_error', 'timeout', 'oversized', 'incomplete']);

function outcomeOf(response: DataQuestionInterpretationResponse): CaseOutcome {
  return response.outcome === 'proposal' ? { outcome: 'proposal', plan: response.plan } : { outcome: response.outcome, reason: response.reason };
}

function failureOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'DATA_QUESTION_TIMEOUT') return 'timeout';
    const reason = error.details?.['reason'];
    return typeof reason === 'string' ? reason : error.code.toLowerCase();
  }
  return 'harness_error';
}

export function judge(entry: DataQuestionEvalCase, got: CaseOutcome): { exact: boolean; executableOnNonPlan: boolean } {
  const expected = entry.expected;
  const executableOnNonPlan = expected.outcome !== 'proposal' && got.outcome === 'proposal';
  if (expected.outcome === 'proposal') return { exact: got.outcome === 'proposal' && canonical(got.plan) === canonical(expected.plan), executableOnNonPlan };
  return { exact: got.outcome === expected.outcome && got.reason === expected.reason, executableOnNonPlan };
}

export interface DataQuestionEvalRun {
  callsMade: number;
  results: DataQuestionCaseResult[];
  stopped: string | null;
}

/**
 * Runs a set's cases in order, one provider call per case, no retry, through the product interpretation service with the
 * case's fixed clock. Stops after `DATA_QUESTION_EVAL_FAILURE_STREAK` identical systemic failures in a row, or at
 * `maxCalls`. `monotonicNow` measures latency.
 */
export async function runDataQuestionEvaluation(options: {
  dataset: DataQuestionEvalDataset;
  maxCalls: number;
  maxOutputTokens: number;
  monotonicNow?: () => number;
  provider: LlmProvider;
  timeoutMs: number;
}): Promise<DataQuestionEvalRun> {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const results: DataQuestionCaseResult[] = [];
  let callsMade = 0;
  let streak = null as { count: number; reason: string } | null;
  for (const entry of options.dataset.cases) {
    if (callsMade >= options.maxCalls) return { callsMade, results, stopped: 'max_calls' };
    const clock: Clock = {
      clearTimeout: (handle) => clearTimeout(handle),
      monotonicNow,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      utcNow: () => new Date(entry.context.now),
    };
    const service = new DataQuestionInterpretationService({
      admission: new InterpretationAdmission({ allowance: { perWindow: 1, windowMs: 60_000 }, clock, maxConcurrent: 1, maxUsers: 1, userRate: { perWindow: 1, windowMs: 60_000 } }),
      clock,
      logger: createLogger({ clock, write: () => undefined }),
      maxOutputTokens: options.maxOutputTokens,
      provider: options.provider,
      timeoutMs: options.timeoutMs,
    });
    const startedAt = monotonicNow();
    callsMade += 1;
    let got: CaseOutcome;
    try {
      got = outcomeOf(
        await service.interpret({
          context: { selectedDate: entry.context.selectedDate, timeZone: entry.context.timeZone },
          requestId: entry.id,
          revalidate: () => Promise.resolve(),
          signal: new AbortController().signal,
          text: entry.text,
          userId: 'evaluation',
        }),
      );
    } catch (error) {
      got = { failure: failureOf(error), outcome: 'failure' };
    }
    const latencyMs = Math.max(0, Math.round(monotonicNow() - startedAt));
    results.push({ category: entry.category, ...judge(entry, got), expected: entry.expected.outcome, got, id: entry.id, language: entry.language, latencyMs });
    if (got.outcome === 'failure' && SYSTEMIC.has(got.failure)) {
      streak = streak?.reason === got.failure ? { count: streak.count + 1, reason: got.failure } : { count: 1, reason: got.failure };
      if (streak.count >= DATA_QUESTION_EVAL_FAILURE_STREAK) return { callsMade, results, stopped: `systemic_failure:${got.failure}` };
    } else streak = null;
  }
  return { callsMade, results, stopped: null };
}

export interface DataQuestionScore {
  byLanguage: Record<'en' | 'ru', { exact: number; total: number }>;
  exact: number;
  exactAccuracy: number;
  executableOnNonPlan: number;
  nonPlanCases: number;
  technicalFailureRate: number;
  technicalFailures: number;
  total: number;
}

/** Scores against the set's full size: a case not run counts as neither exact nor failed, so a partial run cannot pass. */
export function scoreDataQuestionResults(results: readonly DataQuestionCaseResult[], total: number, nonPlanCases: number): DataQuestionScore {
  const exact = results.filter((result) => result.exact).length;
  const technicalFailures = results.filter((result) => result.got.outcome === 'failure').length;
  const language = (lang: 'en' | 'ru') => ({ exact: results.filter((r) => r.language === lang && r.exact).length, total: results.filter((r) => r.language === lang).length });
  return {
    byLanguage: { en: language('en'), ru: language('ru') },
    exact,
    exactAccuracy: total === 0 ? 0 : exact / total,
    executableOnNonPlan: results.filter((result) => result.executableOnNonPlan).length,
    nonPlanCases,
    technicalFailureRate: total === 0 ? 0 : technicalFailures / total,
    technicalFailures,
    total,
  };
}

export interface LatencySummary {
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export function latencySummary(results: readonly DataQuestionCaseResult[]): LatencySummary {
  const values = results.map((result) => result.latencyMs).toSorted((left, right) => left - right);
  if (values.length === 0) return { maxMs: null, meanMs: null, p50Ms: null, p95Ms: null };
  const at = (quantile: number) => values[Math.min(values.length - 1, Math.ceil(quantile * values.length) - 1)]!;
  return { maxMs: values.at(-1)!, meanMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), p50Ms: at(0.5), p95Ms: at(0.95) };
}

export const dataQuestionFakeProfileSchema = z.strictObject({ model: z.literal('fake'), provider: z.literal('fake') });

export interface DataQuestionEvalReport {
  callsMade: number;
  codeFingerprint: string;
  complete: boolean;
  datasetDigest: string;
  datasetVersion: string;
  /** `model` only for a complete-or-partial Ollama run; the fake provider is a harness self-check. */
  evidence: 'harness_self_check_not_model_evidence' | 'model';
  finishedAt: string;
  git: GitState;
  latency: LatencySummary;
  profile: MealDraftExecutionProfile | { model: 'fake'; provider: 'fake' };
  profileCheck: { mismatches: number; requests: number } | null;
  promptDigest: string;
  promptVersion: string;
  reportVersion: typeof DATA_QUESTION_REPORT_VERSION;
  results: DataQuestionCaseResult[];
  score: DataQuestionScore;
  set: DataQuestionEvalSet;
  startedAt: string;
  stopped: string | null;
  thresholds: typeof DATA_QUESTION_THRESHOLDS;
  wireSchemaName: string;
}

export function buildDataQuestionReport(input: {
  dataset: DataQuestionEvalDataset;
  digest: string;
  finishedAt: string;
  git?: GitState;
  profile: DataQuestionEvalReport['profile'];
  profileCheck: DataQuestionEvalReport['profileCheck'];
  run: DataQuestionEvalRun;
  startedAt: string;
}): DataQuestionEvalReport {
  const total = input.dataset.cases.length;
  const nonPlan = input.dataset.cases.filter((entry) => entry.expected.outcome !== 'proposal').length;
  return {
    callsMade: input.run.callsMade,
    codeFingerprint: dataQuestionCodeFingerprint(),
    complete: input.run.stopped === null && input.run.results.length === total,
    datasetDigest: input.digest,
    datasetVersion: input.dataset.version,
    evidence: input.profile.provider === 'ollama' ? 'model' : 'harness_self_check_not_model_evidence',
    finishedAt: input.finishedAt,
    git: input.git ?? readGitState(),
    latency: latencySummary(input.run.results),
    profile: input.profile,
    profileCheck: input.profileCheck,
    promptDigest: dataQuestionPromptDigest(),
    promptVersion: DATA_QUESTION_PROMPT_VERSION,
    reportVersion: DATA_QUESTION_REPORT_VERSION,
    results: input.run.results,
    score: scoreDataQuestionResults(input.run.results, total, nonPlan),
    set: input.dataset.name,
    startedAt: input.startedAt,
    stopped: input.run.stopped,
    thresholds: DATA_QUESTION_THRESHOLDS,
    wireSchemaName: DATA_QUESTION_WIRE_SCHEMA_NAME,
  };
}

export type GateStatus = 'FAIL' | 'NOT_RUN' | 'PASS';

/** Quality recomputed by the gate from the recorded outcomes and the frozen dataset (never the report's own summary). */
export interface DataQuestionGateQuality {
  exact: number;
  exactAccuracy: number;
  executableOnNonPlan: number;
  technicalFailureRate: number;
  technicalFailures: number;
  total: number;
}

export interface DataQuestionGate {
  /** Whether the reports are valid evidence for the CURRENT code, prompt and datasets (separate from quality). */
  evidenceValid: boolean;
  problems: string[];
  quality: Record<DataQuestionEvalSet, DataQuestionGateQuality | null>;
  status: GateStatus;
}

/** At most this many problems are reported, each at most `PROBLEM_TEXT_MAX` characters: diagnostics stay bounded. */
export const DATA_QUESTION_GATE_PROBLEM_LIMIT = 24;
const PROBLEM_TEXT_MAX = 300;
const LISTED = 3;

// Run-time shape of a report read from disk. Strict: an unexpected field is malformed evidence, not ignored. Plans and
// refusal reasons are validated against the product contract, so a recorded outcome is one the screen could have shown.
const caseOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('proposal'), plan: dataQuestionPlanSchema }),
  z.strictObject({ outcome: z.literal('clarify'), reason: z.enum(DATA_QUESTION_CLARIFICATION_REASONS) }),
  z.strictObject({ outcome: z.literal('unsupported'), reason: z.enum(DATA_QUESTION_UNSUPPORTED_REASONS) }),
  z.strictObject({ failure: z.string().regex(/^[a-z0-9_]{1,64}$/u), outcome: z.literal('failure') }),
]);
const count = z.number().int().min(0).max(1_000);
const ratio = z.number().finite().min(0).max(1);
const latencyValue = z.number().int().min(0).nullable();
const caseResultSchema = z.strictObject({
  category: z.enum(['supported', 'ambiguous', 'unsupported', 'adversarial']),
  exact: z.boolean(),
  executableOnNonPlan: z.boolean(),
  expected: z.enum(['clarify', 'proposal', 'unsupported']),
  got: caseOutcomeSchema,
  id: z.string().min(1).max(80),
  language: z.enum(['en', 'ru']),
  latencyMs: z.number().int().min(0),
});
const scoreSchema = z.strictObject({
  byLanguage: z.strictObject({ en: z.strictObject({ exact: count, total: count }), ru: z.strictObject({ exact: count, total: count }) }),
  exact: count,
  exactAccuracy: ratio,
  executableOnNonPlan: count,
  nonPlanCases: count,
  technicalFailureRate: ratio,
  technicalFailures: count,
  total: count,
});
const digestSchema = z.string().max(128);
export const dataQuestionEvalReportSchema = z.strictObject({
  callsMade: count,
  codeFingerprint: digestSchema,
  complete: z.boolean(),
  datasetDigest: digestSchema,
  datasetVersion: z.string().max(64),
  evidence: z.enum(['harness_self_check_not_model_evidence', 'model']),
  finishedAt: z.string().max(64),
  git: z.strictObject({ dirty: z.boolean().nullable(), dirtyPathCount: count.nullable(), dirtyPaths: z.array(z.string().max(512)).max(1_000), sha: z.string().max(64).nullable() }),
  latency: z.strictObject({ maxMs: latencyValue, meanMs: latencyValue, p50Ms: latencyValue, p95Ms: latencyValue }),
  profile: z.union([mealDraftExecutionProfileSchema, dataQuestionFakeProfileSchema]),
  profileCheck: z.strictObject({ mismatches: count, requests: count }).nullable(),
  promptDigest: digestSchema,
  promptVersion: z.string().max(64),
  reportVersion: z.number().int(),
  results: z.array(caseResultSchema).max(100),
  score: scoreSchema,
  set: z.enum(DATA_QUESTION_EVAL_SETS),
  startedAt: z.string().max(64),
  stopped: z.string().max(100).nullable(),
  thresholds: z.strictObject({ exactAccuracyMin: z.number(), executableOnNonPlanMax: z.number(), technicalFailureMax: z.number() }),
  wireSchemaName: z.string().max(100),
});

const bounded = (text: string) => (text.length <= PROBLEM_TEXT_MAX ? text : `${text.slice(0, PROBLEM_TEXT_MAX - 1)}…`);
const listed = (values: readonly string[]) => `${values.slice(0, LISTED).join(', ')}${values.length > LISTED ? ` and ${values.length - LISTED} more` : ''}`;

function malformed(index: number, error: z.ZodError): string {
  const issues = error.issues.slice(0, LISTED).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return `report ${index + 1}: malformed (${issues.join('; ')}${error.issues.length > LISTED ? `; and ${error.issues.length - LISTED} more` : ''})`;
}

/**
 * `safeParse` that cannot throw: some contract refinements (calendar-date checks) raise instead of reporting an issue for
 * values such as "2026-02-30". Such a report is malformed evidence like any other, with a bounded reason; validation itself
 * is not weakened, only its exceptions are contained.
 */
function parseReport(input: unknown, index: number): { problem: string; report?: never } | { problem?: never; report: ParsedReport } {
  try {
    const parsed = dataQuestionEvalReportSchema.safeParse(input);
    return parsed.success ? { report: parsed.data } : { problem: malformed(index, parsed.error) };
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 120) : 'unknown error';
    return { problem: `report ${index + 1}: malformed (validation failed: ${reason})` };
  }
}

type ParsedReport = z.infer<typeof dataQuestionEvalReportSchema>;

/**
 * Verifies one set's report against its frozen dataset and re-derives its quality. Returns the problems that make it invalid
 * evidence and, when every frozen case was recorded exactly once and in order, the recomputed quality.
 */
function verifyReport(
  report: ParsedReport,
  loaded: { dataset: DataQuestionEvalDataset; digest: string },
  current: { codeFingerprint: string; promptDigest: string },
): { problems: string[]; quality: DataQuestionGateQuality | null } {
  const { set } = report;
  const { dataset, digest } = loaded;
  const problems: string[] = [];
  const problem = (text: string) => problems.push(`${set}: ${text}`);

  if (report.reportVersion !== DATA_QUESTION_REPORT_VERSION) problem(`report version ${report.reportVersion}`);
  if (report.evidence !== 'model' || report.profile.provider !== 'ollama') problem('not a model run with a valid execution profile');
  if (report.datasetVersion !== dataset.version) problem(`dataset version ${report.datasetVersion} is not the frozen ${dataset.version}`);
  if (report.datasetDigest !== DATA_QUESTION_DATASET_DIGESTS[set] || report.datasetDigest !== digest) problem('dataset digest differs from the pinned one');
  if (report.promptDigest !== current.promptDigest) problem('prompt digest is stale');
  if (report.promptVersion !== DATA_QUESTION_PROMPT_VERSION) problem(`prompt version ${report.promptVersion} is not the current one`);
  if (report.codeFingerprint !== current.codeFingerprint) problem('code fingerprint is stale');
  if (report.wireSchemaName !== DATA_QUESTION_WIRE_SCHEMA_NAME) problem('wire schema differs from the current one');
  if (canonical(report.thresholds) !== canonical(DATA_QUESTION_THRESHOLDS)) problem('stored thresholds differ from the frozen ones');
  if (report.stopped !== null) problem(`the run stopped (${report.stopped})`);

  // Every frozen case exactly once, in the frozen order; nothing else.
  const total = dataset.cases.length;
  const expectedIds = dataset.cases.map((entry) => entry.id);
  const frozen = new Map(dataset.cases.map((entry) => [entry.id, entry]));
  const seen = new Map<string, number>();
  for (const result of report.results) seen.set(result.id, (seen.get(result.id) ?? 0) + 1);
  const duplicate = [...seen].filter(([, times]) => times > 1).map(([id]) => id);
  const missing = expectedIds.filter((id) => !seen.has(id));
  const unknown = [...seen.keys()].filter((id) => !frozen.has(id));
  const idsMatch = duplicate.length === 0 && missing.length === 0 && unknown.length === 0;
  if (!idsMatch) {
    const parts = [
      duplicate.length > 0 ? `duplicate ${listed(duplicate)}` : null,
      missing.length > 0 ? `missing ${listed(missing)}` : null,
      unknown.length > 0 ? `unknown ${listed(unknown)}` : null,
    ].filter((part) => part !== null);
    problem(`case ids do not match the frozen set (${parts.join('; ')})`);
  } else if (report.results.some((result, index) => result.id !== expectedIds[index])) problem('results are not in the frozen order');
  if (report.results.length !== total) problem(`${report.results.length} of ${total} frozen cases recorded`);

  // Complete call accounting: one checked request per recorded case.
  if (report.callsMade !== report.results.length) problem(`${report.callsMade} calls for ${report.results.length} recorded cases`);
  if (report.profileCheck === null || report.profileCheck.mismatches > 0 || report.profileCheck.requests !== report.callsMade) {
    problem('requests not all checked against the profile');
  }
  const complete = report.stopped === null && idsMatch && report.results.length === total;
  if (report.complete !== complete) problem(`stored complete flag contradicts the recorded run (${String(report.complete)}, recomputed ${String(complete)})`);

  // Each judgment re-derived from the recorded outcome against the FROZEN expectation; stored flags are only compared.
  const contradictions: string[] = [];
  const rejudged: DataQuestionCaseResult[] = [];
  const judgedIds = new Set<string>();
  for (const result of report.results) {
    const entry = frozen.get(result.id);
    if (entry === undefined || judgedIds.has(result.id)) continue;
    judgedIds.add(result.id);
    if (result.category !== entry.category || result.language !== entry.language || result.expected !== entry.expected.outcome) {
      contradictions.push(`${result.id}: stored case (category, language or expected outcome) differs from the frozen dataset`);
    }
    const judgment = judge(entry, result.got);
    if (judgment.exact !== result.exact || judgment.executableOnNonPlan !== result.executableOnNonPlan) {
      contradictions.push(`${result.id}: stored judgment contradicts its recorded outcome`);
    }
    rejudged.push({ ...result, ...judgment, category: entry.category, expected: entry.expected.outcome, got: result.got, language: entry.language });
  }
  for (const text of contradictions.slice(0, LISTED)) problem(text);
  if (contradictions.length > LISTED) problem(`and ${contradictions.length - LISTED} more contradictory cases`);

  // Aggregates recomputed with the frozen denominators; a stored summary that differs is contradictory evidence.
  const nonPlanCases = dataset.cases.filter((entry) => entry.expected.outcome !== 'proposal').length;
  const score = scoreDataQuestionResults(rejudged, total, nonPlanCases);
  if (canonical(report.score) !== canonical(score)) {
    problem(`stored score contradicts the recomputed one (exact ${score.exact}/${score.total}, executable on non-plan ${score.executableOnNonPlan}, technical failures ${score.technicalFailures})`);
  }
  if (canonical(report.latency) !== canonical(latencySummary(report.results))) problem('stored latency summary contradicts the recorded latencies');

  const quality = idsMatch
    ? { exact: score.exact, exactAccuracy: score.exactAccuracy, executableOnNonPlan: score.executableOnNonPlan, technicalFailureRate: score.technicalFailureRate, technicalFailures: score.technicalFailures, total: score.total }
    : null;
  return { problems, quality };
}

/**
 * The model gate, re-derived from the evidence: each input is validated at run time; the pinned datasets are loaded here;
 * exactly one report per known set, from Ollama, complete and unstopped, with every frozen case exactly once and in order,
 * one checked request per case, the pinned dataset digest and version, the current prompt and code fingerprint, and one
 * execution profile for both sets. Each case's judgment and each set's aggregates are recomputed from the recorded
 * outcomes against the frozen expectations; a stored summary, flag or expected outcome that disagrees makes the evidence
 * invalid. Invalid or missing evidence is NOT_RUN (never PASS); valid evidence below a threshold is FAIL.
 */
export function evaluateDataQuestionGate(
  inputs: readonly unknown[],
  options: {
    current?: { codeFingerprint: string; promptDigest: string };
    loadDataset?: (set: DataQuestionEvalSet) => { dataset: DataQuestionEvalDataset; digest: string };
  } = {},
): DataQuestionGate {
  const current = options.current ?? { codeFingerprint: dataQuestionCodeFingerprint(), promptDigest: dataQuestionPromptDigest() };
  const load = options.loadDataset ?? ((set: DataQuestionEvalSet) => loadDataQuestionDataset(set));
  const problems: string[] = [];
  const quality: DataQuestionGate['quality'] = { development: null, heldout: null };

  const datasets = new Map<DataQuestionEvalSet, { dataset: DataQuestionEvalDataset; digest: string }>();
  for (const set of DATA_QUESTION_EVAL_SETS) {
    try {
      datasets.set(set, load(set));
    } catch (error) {
      problems.push(`${set}: the frozen dataset cannot be loaded (${error instanceof Error ? error.message : 'unknown error'})`);
    }
  }

  const bySet = new Map<DataQuestionEvalSet, ParsedReport[]>();
  inputs.forEach((input, index) => {
    const parsed = parseReport(input, index);
    if (parsed.report === undefined) problems.push(parsed.problem);
    else bySet.set(parsed.report.set, [...(bySet.get(parsed.report.set) ?? []), parsed.report]);
  });

  const single = new Map<DataQuestionEvalSet, ParsedReport>();
  for (const set of DATA_QUESTION_EVAL_SETS) {
    const reports = bySet.get(set) ?? [];
    if (reports.length === 0) problems.push(`no ${set} report`);
    if (reports.length > 1) problems.push(`more than one ${set} report`);
    if (reports.length !== 1) continue;
    const report = reports[0]!;
    single.set(set, report);
    const loaded = datasets.get(set);
    if (loaded === undefined) continue;
    const verdict = verifyReport(report, loaded, current);
    problems.push(...verdict.problems);
    quality[set] = verdict.quality;
  }
  const development = single.get('development');
  const heldout = single.get('heldout');
  if (development !== undefined && heldout !== undefined) {
    const differences = valueDifferences(development.profile, heldout.profile);
    if (differences.length > 0) problems.push(`the two sets ran under different profiles (${listed(differences)})`);
    if (development.callsMade + heldout.callsMade > DATA_QUESTION_EVAL_MAX_CALLS) problems.push(`more than ${DATA_QUESTION_EVAL_MAX_CALLS} inference calls in total`);
  }

  const evidenceValid = problems.length === 0;
  if (!evidenceValid) {
    const shown = problems.length > DATA_QUESTION_GATE_PROBLEM_LIMIT ? [...problems.slice(0, DATA_QUESTION_GATE_PROBLEM_LIMIT - 1), `and ${problems.length - DATA_QUESTION_GATE_PROBLEM_LIMIT + 1} more problems`] : problems;
    return { evidenceValid, problems: shown.map(bounded), quality, status: 'NOT_RUN' };
  }
  for (const set of DATA_QUESTION_EVAL_SETS) {
    const score = quality[set]!;
    if (score.exactAccuracy < DATA_QUESTION_THRESHOLDS.exactAccuracyMin) problems.push(`${set}: exact accuracy ${(score.exactAccuracy * 100).toFixed(1)} % < 90 %`);
    if (score.executableOnNonPlan > DATA_QUESTION_THRESHOLDS.executableOnNonPlanMax) problems.push(`${set}: ${score.executableOnNonPlan} executable proposal(s) on clarification or refusal cases`);
    if (score.technicalFailureRate > DATA_QUESTION_THRESHOLDS.technicalFailureMax) problems.push(`${set}: technical failures ${(score.technicalFailureRate * 100).toFixed(1)} % > 10 %`);
  }
  return { evidenceValid, problems, quality, status: problems.length === 0 ? 'PASS' : 'FAIL' };
}

export function formatDataQuestionReport(report: DataQuestionEvalReport): string {
  const { score } = report;
  const pct = (value: number) => `${(value * 100).toFixed(1)} %`;
  const lines = [
    `DATA QUESTION EVALUATION (${report.set}, ${report.evidence === 'model' ? 'model run' : 'FAKE provider: harness self-check, NOT model evidence'})`,
    `  cases ${report.results.length}/${score.total}${report.complete ? '' : ' (INCOMPLETE)'}; calls ${report.callsMade}; stopped ${report.stopped ?? 'no'}`,
    `  exact normalized interpretation ${score.exact}/${score.total} = ${pct(score.exactAccuracy)} (en ${score.byLanguage.en.exact}/${score.byLanguage.en.total}, ru ${score.byLanguage.ru.exact}/${score.byLanguage.ru.total})`,
    `  executable proposals on clarification/refusal cases: ${score.executableOnNonPlan} of ${score.nonPlanCases}`,
    `  technical failures ${score.technicalFailures}/${score.total} = ${pct(score.technicalFailureRate)}`,
    `  latency mean ${report.latency.meanMs ?? '-'} ms, p50 ${report.latency.p50Ms ?? '-'} ms, p95 ${report.latency.p95Ms ?? '-'} ms, max ${report.latency.maxMs ?? '-'} ms`,
  ];
  for (const result of report.results.filter((entry) => !entry.exact)) {
    const got = result.got.outcome === 'failure' ? `failure:${result.got.failure}` : result.got.outcome === 'proposal' ? 'proposal' : `${result.got.outcome}:${result.got.reason}`;
    lines.push(`  MISMATCH ${result.id}: expected ${result.expected}, got ${got}${result.executableOnNonPlan ? ' (EXECUTABLE ON A NON-PLAN CASE)' : ''}`);
  }
  return lines.join('\n');
}

export function formatDataQuestionGate(gate: DataQuestionGate): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)} %`;
  const quality = DATA_QUESTION_EVAL_SETS.flatMap((set) => {
    const score = gate.quality[set];
    return score === null
      ? []
      : [`  ${set}: exact ${score.exact}/${score.total} = ${pct(score.exactAccuracy)}; executable proposals on clarification/refusal cases ${score.executableOnNonPlan}; technical failures ${score.technicalFailures}/${score.total} (recomputed from the recorded outcomes)`];
  });
  return [
    `MODEL GATE (data questions): ${gate.status}; evidence ${gate.evidenceValid ? 'valid' : 'NOT valid (missing, malformed, contradictory or stale)'}`,
    ...quality,
    ...gate.problems.map((problem) => `  - ${problem}`),
  ].join('\n');
}
