import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVITY_TYPES,
  DATA_QUESTION_ACTIVITY_SOURCES,
  DATA_QUESTION_DAY_PERIODS,
  DATA_QUESTION_WEEK_PERIODS,
  DATA_QUESTION_WEEKLY_FOCUSES,
  type DataQuestionIntent,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { analyzeQuestionConstraints } from '../data-questions/data-question-constraints.js';
import { decideDataQuestion } from '../data-questions/data-question-normalizer.js';
import { resolveDataQuestionPlan } from '../data-questions/data-question-plan.js';
import type { DataQuestionWireAnswer } from '../data-questions/data-question-wire.js';
import { FakeDataQuestionProvider } from '../data-questions/fake-data-question-provider.js';
import type { LlmProvider } from '../insights/llm-provider.js';
import {
  buildDataQuestionReport,
  canonical,
  DATA_QUESTION_DATASET_REGISTRY,
  DATA_QUESTION_DEFAULT_DATASET_VERSION,
  DATA_QUESTION_EVAL_SETS,
  DATA_QUESTION_FINGERPRINT_FILES,
  dataQuestionCodeFingerprint,
  dataQuestionDatasetDigests,
  datasetProblems,
  evaluateDataQuestionGate,
  loadDataQuestionDataset,
  parseDataQuestionDatasetVersion,
  runDataQuestionEvaluation,
  type DataQuestionDatasetVersion,
  type DataQuestionEvalCase,
  type DataQuestionEvalDataset,
  type DataQuestionEvalReport,
} from './data-question-evaluation.js';
import { buildExecutionProfile } from './meal-draft-profile.js';

// Version 2 of the data-question evaluation (ADR-0095): a dataset registry like the meal drafts' (v1 stays the default
// and unchanged), new frozen v2 sets written from the constraints policy, a gate that judges exactly one selected version,
// supplied-answer guard tests of the deterministic policy, and a fingerprint that covers every new policy module. Nothing
// here runs a model; an oracle or a replayed answer is not model evidence.

const git = { dirty: false, dirtyPathCount: 0, dirtyPaths: [], sha: null };
const defaults = { maxOutputTokens: 300, timeoutMs: 45_000 };
const profile = buildExecutionProfile({ maxOutputTokens: 300, maxResponseBytes: 32_768, model: 'qwen3:8b', modelDigest: 'a'.repeat(64), ollamaVersion: '0.12.0', timeoutMs: 45_000 });
const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

function wireOf(intent: DataQuestionIntent): DataQuestionWireAnswer {
  if (intent.operation === 'day_overview') return { outcome: 'day_overview', period: intent.period };
  if (intent.operation === 'weekly_review') return { focus: intent.focus, outcome: 'weekly_review', period: intent.period };
  return { activityType: intent.type, outcome: 'activity_comparison', period: intent.period, source: intent.source };
}

/** The wire answer a perfect model would give for a case's expectation. */
function oracleAnswer(entry: DataQuestionEvalCase): DataQuestionWireAnswer {
  const expected = entry.expected;
  return expected.outcome === 'proposal' ? wireOf(expected.intent) : ({ outcome: expected.outcome, reason: expected.reason } as DataQuestionWireAnswer);
}

/** Every intent the contracts accept: the 78 proposals a model could make (3 day, 9 week, 66 comparisons). */
const ALL_INTENTS: DataQuestionIntent[] = [
  ...DATA_QUESTION_DAY_PERIODS.map((period) => ({ operation: 'day_overview' as const, period })),
  ...DATA_QUESTION_WEEK_PERIODS.flatMap((period) => DATA_QUESTION_WEEKLY_FOCUSES.map((focus) => ({ focus, operation: 'weekly_review' as const, period }))),
  ...DATA_QUESTION_DAY_PERIODS.flatMap((period) =>
    DATA_QUESTION_ACTIVITY_SOURCES.flatMap((source) =>
      ACTIVITY_TYPES.filter((type) => source !== 'recorded_run' || type === 'run').map((type) => ({ operation: 'activity_comparison' as const, period, source, type })),
    ),
  ),
];

function providerFrom(dataset: DataQuestionEvalDataset, answer: (entry: DataQuestionEvalCase) => unknown): LlmProvider {
  return {
    generateStructured: (input) => Promise.resolve({ value: answer(dataset.cases.find((candidate) => candidate.text === input.user)!) }),
    model: 'test',
  };
}

async function reportOf(set: 'development' | 'heldout', version: DataQuestionDatasetVersion, answer: (entry: DataQuestionEvalCase) => unknown = oracleAnswer): Promise<DataQuestionEvalReport> {
  const { dataset, digest } = loadDataQuestionDataset(set, undefined, version);
  const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, ...defaults, provider: providerFrom(dataset, answer) });
  return buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git, profile, profileCheck: { mismatches: 0, requests: run.callsMade }, run, startedAt: 'x' });
}

const v2 = () => DATA_QUESTION_EVAL_SETS.map((set) => loadDataQuestionDataset(set, undefined, '2').dataset);
const v1 = () => DATA_QUESTION_EVAL_SETS.map((set) => loadDataQuestionDataset(set, undefined, '1').dataset);

describe('the dataset registry', () => {
  it('keeps version 1 the default and parses only the registered versions', () => {
    expect(DATA_QUESTION_DEFAULT_DATASET_VERSION).toBe('1');
    expect(parseDataQuestionDatasetVersion(undefined)).toBe('1');
    expect(parseDataQuestionDatasetVersion('v1')).toBe('1');
    expect(parseDataQuestionDatasetVersion('v2')).toBe('2');
    for (const value of ['v3', '2', 'V2', 'v2 ', 'version2', '']) expect(() => parseDataQuestionDatasetVersion(value), value).toThrow(/--dataset-version must be v1 or v2/u);
  });

  it('leaves the version 1 files, digests and expectations unchanged', () => {
    expect(dataQuestionDatasetDigests('1')).toEqual({
      development: '2178ed1adb65792013b7b3965a66867917cce8c9d37359f9f9f204016a7ab207',
      heldout: 'ae698e5d247cef2873b4125f7d8d99e8448d827735fbb3d55f0f355edab616be',
    });
    for (const dataset of v1()) {
      expect(dataset.version).toBe('data-question-eval-1');
      expect(dataset.cases.every((entry) => entry.rationale === undefined)).toBe(true);
    }
  });
});

describe('the frozen version 2 sets', () => {
  it('match their pinned digests, are balanced EN/RU, cover every category and name their policy rule', () => {
    for (const set of DATA_QUESTION_EVAL_SETS) {
      const { dataset, digest } = loadDataQuestionDataset(set, undefined, '2');
      expect(digest).toBe(DATA_QUESTION_DATASET_REGISTRY['2'][set].digest);
      expect(dataset.version).toBe('data-question-eval-2');
      expect(dataset.cases).toHaveLength(20);
      expect(dataset.cases.filter((entry) => entry.language === 'ru')).toHaveLength(10);
      expect(new Set(dataset.cases.map((entry) => entry.category))).toEqual(new Set(['adversarial', 'ambiguous', 'supported', 'unsupported']));
      expect(dataset.cases.every((entry) => entry.rationale !== undefined && /^(?:en|ru)-(?:dev|ho)2-/u.test(entry.id))).toBe(true);
      expect(datasetProblems(dataset)).toEqual([]);
    }
  });

  it('refuses a changed v2 file and a v2 file under the v1 name', () => {
    expect(() => loadDataQuestionDataset('development', (path) => readFileSync(path, 'utf8').replace('Thursday', 'Friday'), '2')).toThrow(/pinned digest/u);
    expect(() => loadDataQuestionDataset('development', (path) => readFileSync(path.replace('.v1.json', '.v2.json'), 'utf8'), '1')).toThrow(/pinned digest/u);
  });

  it('share no id or text with version 1 or with each other', () => {
    const [development, heldout] = v2();
    const old = v1().flatMap((dataset) => dataset.cases);
    const all = [...development!.cases, ...heldout!.cases];
    expect(new Set(all.map((entry) => entry.id)).size).toBe(40);
    expect(new Set(all.map((entry) => entry.text.toLowerCase())).size).toBe(40);
    for (const entry of all) {
      expect(old.map((oldEntry) => oldEntry.id)).not.toContain(entry.id);
      expect(old.map((oldEntry) => oldEntry.text.toLowerCase())).not.toContain(entry.text.toLowerCase());
    }
  });

  it('cover distinct and coincident periods, every source, operation and focus, and each kind of non-plan case', () => {
    const cases = v2().flatMap((dataset) => dataset.cases);
    const proposals = cases.flatMap((entry) => (entry.expected.outcome === 'proposal' ? [{ entry, intent: entry.expected.intent }] : []));
    const resolvedAs = (entry: DataQuestionEvalCase, intent: DataQuestionIntent) =>
      canonical(resolveDataQuestionPlan(intent, entry.context, { utcNow: () => new Date(entry.context.now) }).period);
    const datesOf = (entry: DataQuestionEvalCase, intent: DataQuestionIntent) => {
      const period = JSON.parse(resolvedAs(entry, intent)) as Record<string, string>;
      delete period['symbol'];
      return canonical(period);
    };
    const alternatives = ({ entry, intent }: (typeof proposals)[number]) => {
      const symbols: readonly string[] = intent.operation === 'weekly_review' ? DATA_QUESTION_WEEK_PERIODS : DATA_QUESTION_DAY_PERIODS;
      return symbols.filter((symbol) => symbol !== intent.period).map((symbol) => datesOf(entry, { ...intent, period: symbol } as DataQuestionIntent) === datesOf(entry, intent));
    };
    // Coincident: another symbol resolves to the same dates, but the required symbol is distinct (weeks, both directions).
    const coincident = proposals.filter((proposal) => alternatives(proposal).some(Boolean));
    expect(coincident.filter(({ intent }) => intent.operation === 'weekly_review').map(({ intent }) => intent.period).toSorted()).toEqual(
      expect.arrayContaining(['current_week', 'previous_week', 'selected_week']),
    );
    // Distinct: selected, current/today and previous/yesterday each resolve apart from every other symbol somewhere.
    const distinct = proposals.filter((proposal) => alternatives(proposal).every((same) => !same));
    expect(new Set(distinct.map(({ intent }) => intent.period))).toEqual(new Set(['selected_date', 'today', 'yesterday', 'selected_week', 'current_week', 'previous_week']));
    expect(new Set(proposals.map(({ intent }) => intent.operation))).toEqual(new Set(['day_overview', 'weekly_review', 'activity_comparison']));
    expect(new Set(proposals.flatMap(({ intent }) => (intent.operation === 'weekly_review' ? [intent.focus] : [])))).toEqual(new Set(DATA_QUESTION_WEEKLY_FOCUSES));
    expect(new Set(proposals.flatMap(({ intent }) => (intent.operation === 'activity_comparison' ? [intent.source] : [])))).toEqual(new Set(DATA_QUESTION_ACTIVITY_SOURCES));

    const nonPlan = cases.filter((entry) => entry.expected.outcome !== 'proposal');
    const analysis = (entry: DataQuestionEvalCase) => analyzeQuestionConstraints(entry.text);
    const codes = (entry: DataQuestionEvalCase) => analysis(entry).evidence.map((evidence) => evidence.code);
    expect(nonPlan.some((entry) => analysis(entry).instruction && /^en-/u.test(entry.id))).toBe(true);
    expect(nonPlan.some((entry) => analysis(entry).instruction && /^ru-/u.test(entry.id))).toBe(true);
    expect(nonPlan.some((entry) => analysis(entry).sources.size > 1)).toBe(true);
    expect(nonPlan.some((entry) => analysis(entry).negatedSource)).toBe(true);
    expect(nonPlan.some((entry) => analysis(entry).sources.size === 0 && entry.expected.outcome === 'clarify' && entry.expected.reason === 'activity_source_missing')).toBe(true);
    expect(nonPlan.some((entry) => codes(entry).includes('temporal.weekday'))).toBe(true);
    expect(nonPlan.some((entry) => codes(entry).includes('temporal.calendar_date'))).toBe(true);
    expect(nonPlan.some((entry) => analysis(entry).unsupportedRange)).toBe(true);
    expect(nonPlan.some((entry) => entry.expected.outcome === 'clarify' && entry.expected.reason === 'activity_type_missing' && analysis(entry).types.size === 0)).toBe(true);
    expect(nonPlan.some((entry) => entry.expected.outcome === 'clarify' && entry.expected.reason === 'activity_type_missing' && analysis(entry).types.size > 1)).toBe(true);
    // Benign controls: ordinary source words that are not instruction markers, in both languages.
    expect(proposals.some(({ entry, intent }) => intent.operation === 'activity_comparison' && intent.source === 'recorded_run' && entry.language === 'en')).toBe(true);
    expect(proposals.some(({ entry, intent }) => intent.operation === 'activity_comparison' && intent.source === 'recorded_run' && entry.language === 'ru')).toBe(true);
  });
});

describe('supplied-answer guard tests of the deterministic policy (not model evidence)', () => {
  it('an oracle scores every v2 case exactly and the v2 gate passes', async () => {
    const development = await reportOf('development', '2');
    const heldout = await reportOf('heldout', '2');
    expect(development.score).toMatchObject({ exact: 20, executableOnNonPlan: 0, technicalFailures: 0 });
    expect(heldout.score).toMatchObject({ exact: 20, executableOnNonPlan: 0, technicalFailures: 0 });
    const gate = evaluateDataQuestionGate([development, heldout], { datasetVersion: '2' });
    expect(gate).toMatchObject({ datasetVersion: 'data-question-eval-2', evidenceValid: true, problems: [], status: 'PASS' });
  });

  it('for every v2 plan case exactly one of the 78 possible proposals is accepted, and it is the expected one', () => {
    for (const entry of v2().flatMap((dataset) => dataset.cases)) {
      if (entry.expected.outcome !== 'proposal') continue;
      const accepted = ALL_INTENTS.filter((intent) => decideDataQuestion(entry.text, wireOf(intent)).rule === 'accepted');
      expect(accepted, entry.id).toEqual([entry.expected.intent]);
    }
  });

  it('no proposal at all is executable on a v2 non-plan case the constraints decide; the one model-dependent refusal is named', () => {
    const modelDependent: string[] = [];
    for (const entry of v2().flatMap((dataset) => dataset.cases)) {
      if (entry.expected.outcome === 'proposal') continue;
      const executable = ALL_INTENTS.filter((intent) => decideDataQuestion(entry.text, wireOf(intent)).normalized.outcome === 'intent');
      if (executable.length > 0) modelDependent.push(entry.id);
    }
    // A dietary target cannot be recognised by word rules: only the model refuses it, and a selected-date day overview would
    // pass the constraints. (Another person's comparison names no source, so no proposal for it can execute.)
    expect(modelDependent).toEqual(['ru-dev2-medical-protein']);
  });

  it('an instruction-bearing v2 question is refused whatever is proposed, a refusal reason included', () => {
    for (const entry of v2().flatMap((dataset) => dataset.cases)) {
      if (!analyzeQuestionConstraints(entry.text).instruction) continue;
      expect(entry.expected).toEqual({ outcome: 'unsupported', reason: 'not_a_data_question' });
      for (const answer of [...ALL_INTENTS.map(wireOf), { outcome: 'unsupported', reason: 'write_action' } as const, { outcome: 'clarify', reason: 'operation_ambiguous' } as const]) {
        expect(decideDataQuestion(entry.text, answer).normalized, entry.id).toEqual({ outcome: 'unsupported', reason: 'not_a_data_question' });
      }
    }
  });

  it('a wrong refusal reason stays a refusal (inexact, never executable)', async () => {
    const development = await reportOf('development', '2', (entry) => (entry.expected.outcome === 'unsupported' ? { outcome: 'unsupported', reason: 'write_action' } : oracleAnswer(entry)));
    expect(development.score.executableOnNonPlan).toBe(0);
    expect(development.score.exact).toBe(20 - development.results.filter((result) => result.expected === 'unsupported' && result.got.outcome === 'unsupported' && result.got.reason === 'write_action').length);
  });
});

describe('version 1 under the new policy: intentional changes, not regressions', () => {
  it('feeding each v1 expectation through the new normalizer changes exactly the two documented cases', async () => {
    const changed: Array<{ got: unknown; id: string }> = [];
    for (const set of DATA_QUESTION_EVAL_SETS) {
      const report = await reportOf(set, '1');
      for (const result of report.results) if (!result.exact) changed.push({ got: result.got, id: result.id });
    }
    expect(changed.toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([
      { got: { outcome: 'unsupported', reason: 'not_a_data_question' }, id: 'en-ho-injection-source' },
      { got: { outcome: 'unsupported', reason: 'not_a_data_question' }, id: 'ru-dev-injection-admin' },
    ]);
  });

  it('the five measured v1 mismatches, replayed as wire answers, are no longer executable (a replay, not a new measurement)', () => {
    const cases = Object.fromEntries(v1().flatMap((dataset) => dataset.cases.map((entry) => [entry.id, entry.text])));
    const replay = (id: string, answer: DataQuestionWireAnswer) => decideDataQuestion(cases[id]!, answer).normalized;
    expect(replay('en-dev-period-weekday', { outcome: 'day_overview', period: 'selected_date' })).toEqual({ outcome: 'clarify', reason: 'period_ambiguous', sourceChoice: null });
    expect(replay('en-ho-injection-source', { activityType: 'run', outcome: 'activity_comparison', period: 'selected_date', source: 'recorded_run' })).toEqual({
      outcome: 'unsupported',
      reason: 'not_a_data_question',
    });
    expect(replay('en-ho-week-previous-nutrition', { focus: 'nutrition', outcome: 'weekly_review', period: 'selected_week' })).toEqual({ outcome: 'clarify', reason: 'period_ambiguous', sourceChoice: null });
    expect(replay('en-dev-injection-prompt', { outcome: 'unsupported', reason: 'write_action' })).toEqual({ outcome: 'unsupported', reason: 'not_a_data_question' });
    expect(replay('ru-ho-injection-sql', { outcome: 'unsupported', reason: 'write_action' })).toEqual({ outcome: 'unsupported', reason: 'not_a_data_question' });
  });
});

function expectNotRun(gate: ReturnType<typeof evaluateDataQuestionGate>, problem: RegExp): void {
  expect(gate.status, gate.problems.join(' | ')).toBe('NOT_RUN');
  expect(gate.evidenceValid).toBe(false);
  expect(gate.problems.join(' | ')).toMatch(problem);
}

describe('the gate judges exactly one selected version', () => {
  it('v2 evidence is not v1 evidence, nor the reverse; mixed, relabelled and unknown versions are refused', async () => {
    const [development2, heldout2] = [await reportOf('development', '2'), await reportOf('heldout', '2')];
    const [development1, heldout1] = [await reportOf('development', '1'), await reportOf('heldout', '1')];
    expect(evaluateDataQuestionGate([development2, heldout2]).datasetVersion).toBe('data-question-eval-1');
    expectNotRun(evaluateDataQuestionGate([development2, heldout2]), /development: dataset version data-question-eval-2 is not the selected frozen data-question-eval-1/u);
    expectNotRun(evaluateDataQuestionGate([development1, heldout1], { datasetVersion: '2' }), /dataset version data-question-eval-1 is not the selected frozen data-question-eval-2/u);
    expectNotRun(evaluateDataQuestionGate([development1, heldout2], { datasetVersion: '2' }), /the reports mix dataset versions/u);
    // v1 results relabelled as v2, digest included: the frozen v2 case ids are missing.
    const relabelled = { ...development1, datasetDigest: development2.datasetDigest, datasetVersion: development2.datasetVersion };
    expectNotRun(evaluateDataQuestionGate([relabelled, heldout2], { datasetVersion: '2' }), /development: case ids do not match the frozen set \(missing en-dev2-/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development2, datasetVersion: 'data-question-eval-9' }, heldout2], { datasetVersion: '2' }), /dataset version data-question-eval-9/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development2, datasetDigest: development1.datasetDigest }, heldout2], { datasetVersion: '2' }), /dataset digest differs/u);
  });

  it('partial, stopped, fake and contradictory v2 evidence stays NOT_RUN', async () => {
    const [development, heldout] = [await reportOf('development', '2'), await reportOf('heldout', '2')];
    const options = { datasetVersion: '2' as const };
    const results = development.results.slice(0, 19);
    expectNotRun(evaluateDataQuestionGate([{ ...development, callsMade: 19, profileCheck: { mismatches: 0, requests: 19 }, results }, heldout], options), /19 of 20 frozen cases/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, stopped: 'max_calls' }, heldout], options), /the run stopped/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, results: development.results.map((result) => ({ ...result, exact: !result.exact })) }, heldout], options), /stored judgment contradicts/u);
    const { dataset, digest } = loadDataQuestionDataset('development', undefined, '2');
    const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, ...defaults, provider: new FakeDataQuestionProvider() });
    const fake = buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git, profile: { model: 'fake', provider: 'fake' }, profileCheck: null, run, startedAt: 'x' });
    expect(fake.datasetVersion).toBe('data-question-eval-2');
    expectNotRun(evaluateDataQuestionGate([fake, heldout], options), /not a model run/u);
  });

  it('valid v2 evidence below a threshold is FAIL, not NOT_RUN', async () => {
    // A refusal answered as a selected-date day overview: the constraints cannot recognise the dietary target.
    const day = { outcome: 'day_overview', period: 'selected_date' };
    const development = await reportOf('development', '2', (entry) => (entry.expected.outcome === 'unsupported' ? day : oracleAnswer(entry)));
    expect(development.results.filter((result) => result.executableOnNonPlan).map((result) => result.id)).toEqual(['ru-dev2-medical-protein']);
    const gate = evaluateDataQuestionGate([development, await reportOf('heldout', '2')], { datasetVersion: '2' });
    expect(gate.evidenceValid).toBe(true);
    expect(gate.status).toBe('FAIL');
    expect(gate.problems.join()).toMatch(/development: 1 executable proposal/u);
  });
});

describe('the code fingerprint covers every interpretation policy module', () => {
  const policyModules = [
    'apps/api/src/data-questions/data-question-constraints.ts',
    'apps/api/src/data-questions/data-question-normalizer.ts',
    'apps/api/src/data-questions/data-question-prompt.ts',
    'apps/api/src/data-questions/data-question-plan.ts',
    'apps/api/src/data-questions/data-question-wire.ts',
    'apps/api/src/data-questions/data-question-interpretation-service.ts',
  ] as const;

  it('lists each module, and a change to any of them invalidates saved evidence', async () => {
    const [development, heldout] = [await reportOf('development', '2'), await reportOf('heldout', '2')];
    const original = dataQuestionCodeFingerprint();
    for (const module of policyModules) {
      expect(DATA_QUESTION_FINGERPRINT_FILES, module).toContain(module);
      const changed = dataQuestionCodeFingerprint((path) => {
        const text = readFileSync(path, 'utf8');
        return resolve(path) === resolve(repositoryRoot, module) ? `${text}\n// one changed line\n` : text;
      });
      expect(changed, module).not.toBe(original);
      const gate = evaluateDataQuestionGate([development, heldout], { current: { codeFingerprint: changed, promptDigest: development.promptDigest }, datasetVersion: '2' });
      expectNotRun(gate, /code fingerprint is stale/u);
    }
  });

  it('the saved ADR-0094 reports are stale for the current code and prompt (NOT_RUN), and still FAIL when judged as measured', () => {
    const artifact = (name: string) =>
      JSON.parse(readFileSync(resolve(repositoryRoot, 'docs/reports/artifacts/ask-my-data-2026-11-19', name), 'utf8')) as DataQuestionEvalReport;
    const development = artifact('qwen3-8b-development.json');
    const heldout = artifact('qwen3-8b-heldout.json');
    const current = evaluateDataQuestionGate([development, heldout]);
    expectNotRun(current, /code fingerprint is stale/u);
    expect(current.problems.join()).toMatch(/prompt digest is stale/u);
    expect(current.problems.join()).toMatch(/prompt version data-question-prompt-1 is not the current one/u);
    const asMeasured = evaluateDataQuestionGate([development, heldout], {
      current: { codeFingerprint: development.codeFingerprint, promptDigest: development.promptDigest, promptVersion: development.promptVersion },
    });
    expect(asMeasured).toMatchObject({ evidenceValid: true, status: 'FAIL' });
  });

  it('the saved ADR-0095 v2 reports (39/40) are stale for the corrected constraints (NOT_RUN), and still PASS only as measured', () => {
    const artifact = (name: string) =>
      JSON.parse(readFileSync(resolve(repositoryRoot, 'docs/reports/artifacts/ask-my-data-v2-2026-11-20', name), 'utf8')) as DataQuestionEvalReport;
    const development = artifact('qwen3-8b-development.json');
    const heldout = artifact('qwen3-8b-heldout.json');
    // The prompt did not change; only the code fingerprint (data-question-constraints-2) did.
    const current = evaluateDataQuestionGate([development, heldout], { datasetVersion: '2' });
    expectNotRun(current, /code fingerprint is stale/u);
    expect(current.problems.join()).not.toMatch(/prompt digest is stale|dataset digest/u);
    const asMeasured = evaluateDataQuestionGate([development, heldout], {
      current: { codeFingerprint: development.codeFingerprint, promptDigest: development.promptDigest, promptVersion: development.promptVersion },
      datasetVersion: '2',
    });
    expect(asMeasured).toMatchObject({ evidenceValid: true, status: 'PASS' });
  });
});
