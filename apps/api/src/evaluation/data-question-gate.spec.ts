import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FakeDataQuestionProvider } from '../data-questions/fake-data-question-provider.js';
import type { LlmProvider } from '../insights/llm-provider.js';
import {
  buildDataQuestionReport,
  DATA_QUESTION_GATE_PROBLEM_LIMIT,
  evaluateDataQuestionGate,
  loadDataQuestionDataset,
  runDataQuestionEvaluation,
  type DataQuestionEvalCase,
  type DataQuestionEvalDataset,
  type DataQuestionEvalReport,
} from './data-question-evaluation.js';
import { buildExecutionProfile } from './meal-draft-profile.js';

// The offline gate re-derives its verdict from the evidence (ADR-0094 review correction): it validates every report at
// run time, loads the pinned datasets itself, requires each frozen case exactly once and in order, recomputes every
// judgment and every aggregate from the recorded outcomes against the frozen expectations, and treats any stored summary
// or flag that disagrees as invalid evidence (NOT_RUN), never as a verdict. These are mutation regressions: each edit
// below made the gate PASS before the correction.

const git = { dirty: false, dirtyPathCount: 0, dirtyPaths: [], sha: null };
const defaults = { maxOutputTokens: 300, timeoutMs: 45_000 };
const profile = buildExecutionProfile({ maxOutputTokens: 300, maxResponseBytes: 32_768, model: 'qwen3:8b', modelDigest: 'a'.repeat(64), ollamaVersion: '0.12.0', timeoutMs: 45_000 });

function oracleAnswer(entry: DataQuestionEvalCase): unknown {
  const expected = entry.expected;
  if (expected.outcome !== 'proposal') return { outcome: expected.outcome, reason: expected.reason };
  const intent = expected.intent;
  if (intent.operation === 'day_overview') return { outcome: 'day_overview', period: intent.period };
  if (intent.operation === 'weekly_review') return { focus: intent.focus, outcome: 'weekly_review', period: intent.period };
  return { activityType: intent.type, outcome: 'activity_comparison', period: intent.period, source: intent.source };
}

function providerFrom(dataset: DataQuestionEvalDataset): LlmProvider {
  return {
    generateStructured: (input) => Promise.resolve({ value: oracleAnswer(dataset.cases.find((candidate) => candidate.text === input.user)!) }),
    model: 'test',
  };
}

/** A complete, valid, passing model report (an oracle interpreter). */
async function oracleReport(set: 'development' | 'heldout'): Promise<DataQuestionEvalReport> {
  const { dataset, digest } = loadDataQuestionDataset(set);
  const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, ...defaults, provider: providerFrom(dataset) });
  return buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git, profile, profileCheck: { mismatches: 0, requests: run.callsMade }, run, startedAt: 'x' });
}

/** The unchanged saved measurement of ADR-0094 (qwen3:8b), read only. */
const artifact = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../docs/reports/artifacts/ask-my-data-2026-11-19/${name}`, import.meta.url), 'utf8')) as DataQuestionEvalReport;
const originals = () => ({ development: artifact('qwen3-8b-development.json'), heldout: artifact('qwen3-8b-heldout.json') });
/** The code and prompt the saved reports were measured with, so these tests judge the gate, not the code's currency. */
const measured = (report: DataQuestionEvalReport) => ({ current: { codeFingerprint: report.codeFingerprint, promptDigest: report.promptDigest } });

const passingScore = (report: DataQuestionEvalReport): DataQuestionEvalReport => ({
  ...report,
  score: { ...report.score, byLanguage: { en: { exact: 10, total: 10 }, ru: { exact: 10, total: 10 } }, exact: 20, exactAccuracy: 1, executableOnNonPlan: 0 },
});
/** Every result claimed exact and safe, and the summary made to agree with the claims. */
const flippedFlags = (report: DataQuestionEvalReport): DataQuestionEvalReport =>
  passingScore({ ...report, results: report.results.map((result) => ({ ...result, exact: true, executableOnNonPlan: false })) });
/** A run cut to `count` exact cases whose counts all agree with each other and claim completeness. */
const cutTo = (report: DataQuestionEvalReport, count: number, extra: Partial<DataQuestionEvalReport> = {}): DataQuestionEvalReport => {
  const results = report.results.filter((result) => result.exact).slice(0, count);
  return passingScore({ ...report, callsMade: results.length, complete: true, profileCheck: { mismatches: 0, requests: results.length }, results, ...extra });
};

function expectNotRun(gate: ReturnType<typeof evaluateDataQuestionGate>, problem: RegExp): void {
  expect(gate.status, gate.problems.join(' | ')).toBe('NOT_RUN');
  expect(gate.evidenceValid).toBe(false);
  expect(gate.problems.join(' | ')).toMatch(problem);
}

describe('the saved ADR-0094 measurement', () => {
  it('is valid evidence that fails quality, with the independently verified figures', () => {
    const { development, heldout } = originals();
    const gate = evaluateDataQuestionGate([development, heldout], measured(development));
    expect(gate.evidenceValid).toBe(true);
    expect(gate.status).toBe('FAIL');
    expect(gate.quality.development).toEqual({ exact: 18, exactAccuracy: 0.9, executableOnNonPlan: 1, technicalFailureRate: 0, technicalFailures: 0, total: 20 });
    expect(gate.quality.heldout).toEqual({ exact: 17, exactAccuracy: 0.85, executableOnNonPlan: 1, technicalFailureRate: 0, technicalFailures: 0, total: 20 });
    expect(development.callsMade + heldout.callsMade).toBe(40);
  });

  it('altered passing summaries over the unchanged failing outcomes are invalid evidence, not a PASS', () => {
    const { development, heldout } = originals();
    expectNotRun(evaluateDataQuestionGate([passingScore(development), passingScore(heldout)], measured(development)), /development: stored score .*contradicts/u);
  });

  it('altered per-case judgment flags are invalid evidence', () => {
    const { development, heldout } = originals();
    const gate = evaluateDataQuestionGate([flippedFlags(development), flippedFlags(heldout)], measured(development));
    expectNotRun(gate, /en-dev-period-weekday: stored judgment contradicts/u);
    expect(gate.problems.join()).toMatch(/en-ho-injection-source: stored judgment contradicts/u);
    // Flags alone, with the summary left as it was, are just as invalid.
    const flagsOnly = { ...development, results: development.results.map((result) => ({ ...result, exact: true })) };
    expectNotRun(evaluateDataQuestionGate([flagsOnly, heldout], measured(development)), /stored judgment contradicts/u);
  });

  it('a stored expected outcome is never authority: one that disagrees with the frozen dataset is invalid', () => {
    const { development, heldout } = originals();
    const results = development.results.map((result) => (result.id === 'en-dev-period-weekday' ? { ...result, exact: true, executableOnNonPlan: false, expected: 'proposal' as const } : result));
    expectNotRun(evaluateDataQuestionGate([{ ...development, results }, heldout], measured(development)), /en-dev-period-weekday: stored case .*differs from the frozen dataset/u);
  });
});

describe('completeness and accounting', () => {
  it('complete=true on a partial run is refused', async () => {
    const [development, heldout] = [await oracleReport('development'), await oracleReport('heldout')];
    expectNotRun(evaluateDataQuestionGate([cutTo(development, 1), cutTo(heldout, 1)]), /development: 1 of 20 frozen cases/u);
    expectNotRun(evaluateDataQuestionGate([cutTo(development, 19), heldout]), /development: 19 of 20 frozen cases/u);
  });

  it('a stopped run is refused whatever its complete flag says', async () => {
    const [development, heldout] = [await oracleReport('development'), await oracleReport('heldout')];
    expectNotRun(evaluateDataQuestionGate([{ ...development, complete: true, stopped: 'max_calls' }, heldout]), /development: the run stopped \(max_calls\)/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, complete: false }, heldout]), /development: stored complete flag contradicts/u);
  });

  it('missing, duplicate, unknown, substituted and reordered case ids are refused', async () => {
    const [development, heldout] = [await oracleReport('development'), await oracleReport('heldout')];
    const withResults = (results: DataQuestionEvalReport['results']) => ({ ...development, callsMade: results.length, profileCheck: { mismatches: 0, requests: results.length }, results });
    const [first, second] = development.results;

    expectNotRun(evaluateDataQuestionGate([withResults(development.results.slice(1)), heldout]), new RegExp(`missing ${first!.id}`, 'u'));
    expectNotRun(evaluateDataQuestionGate([withResults([first!, first!, ...development.results.slice(2)]), heldout]), new RegExp(`duplicate ${first!.id}.*missing ${second!.id}`, 'u'));
    expectNotRun(evaluateDataQuestionGate([withResults([{ ...first!, id: 'en-dev-invented' }, ...development.results.slice(1)]), heldout]), /unknown en-dev-invented/u);
    // A held-out case substituted for a development one.
    expectNotRun(evaluateDataQuestionGate([withResults([heldout.results[0]!, ...development.results.slice(1)]), heldout]), new RegExp(`unknown ${heldout.results[0]!.id}`, 'u'));
    // One case's recorded outcome substituted under another case's id.
    const other = development.results.find((result) => result.expected !== first!.expected)!;
    expectNotRun(evaluateDataQuestionGate([withResults([{ ...other, id: first!.id }, ...development.results.slice(1)]), heldout]), new RegExp(`${first!.id}: stored`, 'u'));
    expectNotRun(evaluateDataQuestionGate([withResults([second!, first!, ...development.results.slice(2)]), heldout]), /not in the frozen order/u);
  });

  it('a wrong set or dataset version, a relabelled report, an unknown set and inconsistent counts are refused', async () => {
    const [development, heldout] = [await oracleReport('development'), await oracleReport('heldout')];
    expectNotRun(evaluateDataQuestionGate([{ ...development, datasetVersion: 'data-question-eval-2' }, heldout]), /development: dataset version/u);
    // The development results relabelled as the held-out set (digest included), and the other way round.
    const relabelled = [
      { ...development, datasetDigest: heldout.datasetDigest, set: 'heldout' as const },
      { ...heldout, datasetDigest: development.datasetDigest, set: 'development' as const },
    ];
    expectNotRun(evaluateDataQuestionGate(relabelled), /heldout: .*unknown en-dev-/u);
    expectNotRun(evaluateDataQuestionGate([development, heldout, { ...heldout, set: 'extra' }]), /report 3: malformed/u);
    expectNotRun(evaluateDataQuestionGate([development, heldout, heldout]), /more than one heldout report/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, score: { ...development.score, total: 19 } }, heldout]), /development: stored score .*contradicts/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, score: { ...development.score, nonPlanCases: 1 } }, heldout]), /development: stored score .*contradicts/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, callsMade: 21, profileCheck: { mismatches: 0, requests: 21 } }, heldout]), /development: 21 calls/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, thresholds: { ...development.thresholds, exactAccuracyMin: 0.5 } }, heldout]), /development: stored thresholds/u);
  });

  it('a dataset that cannot be loaded makes every verdict NOT_RUN', async () => {
    const [development, heldout] = [await oracleReport('development'), await oracleReport('heldout')];
    const gate = evaluateDataQuestionGate([development, heldout], {
      loadDataset: () => {
        throw new Error('The development dataset does not match its pinned digest');
      },
    });
    expectNotRun(gate, /dataset cannot be loaded/u);
  });
});

describe('structure, provenance and bounded diagnostics', () => {
  it('malformed reports are refused without throwing', async () => {
    const heldout = await oracleReport('heldout');
    for (const value of [null, 42, 'report', [], {}, { set: 'development' }]) {
      expectNotRun(evaluateDataQuestionGate([value, heldout]), /report 1: malformed/u);
    }
    const development = await oracleReport('development');
    const noPlan = { ...development, results: development.results.map((result, index) => (index === 0 ? { ...result, got: { outcome: 'proposal', plan: { operation: 'drop_table' } } } : result)) };
    expectNotRun(evaluateDataQuestionGate([noPlan, heldout]), /report 1: malformed/u);
  });

  it('a recorded plan whose date makes a contract refinement throw is malformed evidence, not an exception', () => {
    const { development, heldout } = originals();
    const weekly = development.results.find((result) => result.got.outcome === 'proposal' && (result.got.plan as { operation: string }).operation === 'weekly_review')!;
    for (const weekStart of ['2026-02-30', 'not-a-date']) {
      const broken = structuredClone(development);
      const target = broken.results.find((result) => result.id === weekly.id)!;
      (target.got as { plan: { period: { weekStart: string } } }).plan.period.weekStart = weekStart;
      let gate: ReturnType<typeof evaluateDataQuestionGate> | undefined;
      expect(() => {
        gate = evaluateDataQuestionGate([broken, heldout], measured(development));
      }, weekStart).not.toThrow();
      expectNotRun(gate!, /report 1: malformed \(validation failed: RangeError/u);
      expect(gate!.problems.every((problem) => problem.length <= 300)).toBe(true);
      // The other report is still processed: its quality is recomputed and only the broken set is missing.
      expect(gate!.quality.heldout).toMatchObject({ exact: 17, total: 20 });
      expect(gate!.quality.development).toBeNull();
      expect(gate!.problems.join(' | ')).toMatch(/no development report/u);
      expect(gate!.problems.join(' | ')).not.toMatch(/heldout:/u);
    }
  });

  it('fake and mismatched-profile evidence stay NOT_RUN', async () => {
    const { dataset, digest } = loadDataQuestionDataset('development');
    const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, ...defaults, provider: new FakeDataQuestionProvider() });
    const fake = buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git, profile: { model: 'fake', provider: 'fake' }, profileCheck: null, run, startedAt: 'x' });
    const heldout = await oracleReport('heldout');
    expectNotRun(evaluateDataQuestionGate([fake, heldout]), /not a model run/u);
    expectNotRun(evaluateDataQuestionGate([{ ...fake, evidence: 'model' }, heldout]), /not a model run/u);
    const development = await oracleReport('development');
    expectNotRun(evaluateDataQuestionGate([{ ...development, profile: { ...profile, modelDigest: 'b'.repeat(64) } }, heldout]), /different profiles/u);
    expectNotRun(evaluateDataQuestionGate([{ ...development, profileCheck: { mismatches: 0, requests: 19 } }, heldout]), /requests not all checked/u);
  });

  it('valid passing evidence still passes', async () => {
    const gate = evaluateDataQuestionGate([await oracleReport('development'), await oracleReport('heldout')]);
    expect(gate).toMatchObject({ evidenceValid: true, problems: [], status: 'PASS' });
    expect(gate.quality.development).toMatchObject({ exact: 20, total: 20 });
  });

  it('diagnostics stay bounded however much of the evidence is contradictory', async () => {
    const [development, heldout] = [await oracleReport('development'), await oracleReport('heldout')];
    const everyFlag = { ...development, results: development.results.map((result) => ({ ...result, exact: !result.exact, executableOnNonPlan: !result.executableOnNonPlan })) };
    const gate = evaluateDataQuestionGate([everyFlag, { ...heldout, results: heldout.results.map((result) => ({ ...result, id: `${result.id}-x` })) }]);
    expect(gate.status).toBe('NOT_RUN');
    expect(gate.problems.length).toBeLessThanOrEqual(DATA_QUESTION_GATE_PROBLEM_LIMIT);
    for (const problem of gate.problems) expect(problem.length).toBeLessThanOrEqual(400);
    expect(gate.problems.join()).toMatch(/and \d+ more/u);
  });
});
