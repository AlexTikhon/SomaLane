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

export interface DataQuestionGate {
  /** Whether the reports are valid evidence for the CURRENT code, prompt and datasets (separate from quality). */
  evidenceValid: boolean;
  problems: string[];
  quality: Record<DataQuestionEvalSet, { exactAccuracy: number; executableOnNonPlan: number; technicalFailureRate: number } | null>;
  status: GateStatus;
}

/**
 * The model gate: both sets exactly once, complete, from Ollama, with the pinned dataset digests, the current prompt digest
 * and code fingerprint, one execution profile for both (checked on every request), and each set meeting the thresholds.
 * Invalid or missing evidence is NOT_RUN (never PASS); valid evidence below a threshold is FAIL.
 */
export function evaluateDataQuestionGate(reports: readonly DataQuestionEvalReport[], current = { codeFingerprint: dataQuestionCodeFingerprint(), promptDigest: dataQuestionPromptDigest() }): DataQuestionGate {
  const problems: string[] = [];
  const quality: DataQuestionGate['quality'] = { development: null, heldout: null };
  const bySet = new Map<DataQuestionEvalSet, DataQuestionEvalReport>();
  for (const report of reports) {
    if (bySet.has(report.set)) problems.push(`more than one ${report.set} report`);
    bySet.set(report.set, report);
  }
  for (const set of DATA_QUESTION_EVAL_SETS) {
    const report = bySet.get(set);
    if (report === undefined) {
      problems.push(`no ${set} report`);
      continue;
    }
    if (report.reportVersion !== DATA_QUESTION_REPORT_VERSION) problems.push(`${set}: report version ${String(report.reportVersion)}`);
    if (report.evidence !== 'model' || !mealDraftExecutionProfileSchema.safeParse(report.profile).success) problems.push(`${set}: not a model run with a valid execution profile`);
    if (!report.complete) problems.push(`${set}: incomplete (${report.results.length} of ${report.score.total}${report.stopped === null ? '' : `, stopped: ${report.stopped}`})`);
    if (report.datasetDigest !== DATA_QUESTION_DATASET_DIGESTS[set]) problems.push(`${set}: dataset digest differs from the pinned one`);
    if (report.promptDigest !== current.promptDigest) problems.push(`${set}: prompt digest is stale`);
    if (report.codeFingerprint !== current.codeFingerprint) problems.push(`${set}: code fingerprint is stale`);
    if (report.profileCheck === null || report.profileCheck.mismatches > 0 || report.profileCheck.requests !== report.callsMade) {
      problems.push(`${set}: requests not all checked against the profile`);
    }
    if (report.callsMade !== report.results.length) problems.push(`${set}: calls and results differ`);
    quality[set] = { exactAccuracy: report.score.exactAccuracy, executableOnNonPlan: report.score.executableOnNonPlan, technicalFailureRate: report.score.technicalFailureRate };
  }
  const development = bySet.get('development');
  const heldout = bySet.get('heldout');
  if (development !== undefined && heldout !== undefined) {
    const differences = valueDifferences(development.profile, heldout.profile);
    if (differences.length > 0) problems.push(`the two sets ran under different profiles (${differences.join(', ')})`);
    if (development.callsMade + heldout.callsMade > DATA_QUESTION_EVAL_MAX_CALLS) problems.push('more than 40 inference calls in total');
  }
  const evidenceValid = problems.length === 0;
  if (!evidenceValid) return { evidenceValid, problems, quality, status: 'NOT_RUN' };
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
  return [`MODEL GATE (data questions): ${gate.status}; evidence ${gate.evidenceValid ? 'valid' : 'NOT valid for the current code'}`, ...gate.problems.map((problem) => `  - ${problem}`)].join('\n');
}
