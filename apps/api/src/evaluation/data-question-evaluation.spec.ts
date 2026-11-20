import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FakeDataQuestionProvider } from '../data-questions/fake-data-question-provider.js';
import { LlmProviderError, type LlmProvider } from '../insights/llm-provider.js';
import {
  buildDataQuestionReport,
  DATA_QUESTION_DATASET_DIGESTS,
  DATA_QUESTION_EVAL_SETS,
  datasetPath,
  datasetProblems,
  evaluateDataQuestionGate,
  loadDataQuestionDataset,
  runDataQuestionEvaluation,
  type DataQuestionEvalCase,
  type DataQuestionEvalDataset,
  type DataQuestionEvalReport,
} from './data-question-evaluation.js';
import { buildExecutionProfile } from './meal-draft-profile.js';

// The evaluator itself (ADR-0094), proven with an oracle and deliberately wrong interpreters. These tests say nothing about
// any real model's accuracy.

const git = { dirty: false, dirtyPathCount: 0, dirtyPaths: [], sha: null };
const defaults = { maxOutputTokens: 300, timeoutMs: 45_000 };
const profile = buildExecutionProfile({ maxOutputTokens: 300, maxResponseBytes: 32_768, model: 'qwen3:8b', modelDigest: 'a'.repeat(64), ollamaVersion: '0.12.0', timeoutMs: 45_000 });

/** The wire answer that the expected outcome of a case corresponds to (what a perfect model would say). */
function oracleAnswer(entry: DataQuestionEvalCase): unknown {
  const expected = entry.expected;
  if (expected.outcome !== 'proposal') return { outcome: expected.outcome, reason: expected.reason };
  const intent = expected.intent;
  if (intent.operation === 'day_overview') return { outcome: 'day_overview', period: intent.period };
  if (intent.operation === 'weekly_review') return { focus: intent.focus, outcome: 'weekly_review', period: intent.period };
  return { activityType: intent.type, outcome: 'activity_comparison', period: intent.period, source: intent.source };
}

function providerFrom(dataset: DataQuestionEvalDataset, answer: (entry: DataQuestionEvalCase) => unknown): LlmProvider {
  return {
    generateStructured: (input) => {
      const entry = dataset.cases.find((candidate) => candidate.text === input.user)!;
      return Promise.resolve({ value: answer(entry) });
    },
    model: 'test',
  };
}

const modelReport = async (set: 'development' | 'heldout', answer: (entry: DataQuestionEvalCase) => unknown): Promise<DataQuestionEvalReport> => {
  const { dataset, digest } = loadDataQuestionDataset(set);
  const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, ...defaults, provider: providerFrom(dataset, answer) });
  return buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git, profile, profileCheck: { mismatches: 0, requests: run.callsMade }, run, startedAt: 'x' });
};

describe('the frozen datasets', () => {
  it('match their pinned digests, are balanced EN/RU, and every expected plan is the server resolution of its intent', () => {
    for (const set of DATA_QUESTION_EVAL_SETS) {
      const { dataset, digest } = loadDataQuestionDataset(set);
      expect(digest).toBe(DATA_QUESTION_DATASET_DIGESTS[set]);
      expect(dataset.cases.filter((entry) => entry.language === 'ru')).toHaveLength(10);
      const categories = new Set(dataset.cases.map((entry) => entry.category));
      expect([...categories].sort()).toEqual(['adversarial', 'ambiguous', 'supported', 'unsupported']);
      expect(datasetProblems(dataset)).toEqual([]);
    }
  });

  it('refuses a dataset whose bytes differ from the pinned digest', () => {
    expect(() => loadDataQuestionDataset('development', (path) => readFileSync(path, 'utf8').replace('selected day', 'chosen day'))).toThrow(/pinned digest/u);
  });

  it('detects an expected plan that is not the resolution of its intent', () => {
    const dataset = JSON.parse(readFileSync(datasetPath('development'), 'utf8')) as DataQuestionEvalDataset;
    const proposal = dataset.cases.find((entry) => entry.expected.outcome === 'proposal' && entry.expected.plan.operation === 'day_overview')!;
    if (proposal.expected.outcome !== 'proposal' || proposal.expected.plan.operation !== 'day_overview') throw new Error('fixture');
    proposal.expected.plan.period.localDate = '2026-01-01';
    expect(datasetProblems(dataset).join()).toContain(proposal.id);
  });
});

describe('scoring and the gate', () => {
  it('a v1 oracle scores every case exactly except the two documented ADR-0095 policy changes, and the gate passes', async () => {
    // Under the constraints policy two instruction-bearing v1 questions are refused as a whole (not_a_data_question), which
    // their v1 expectations predate; v1 is not edited (data-question-evaluation-v2.spec.ts pins exactly which).
    const development = await modelReport('development', oracleAnswer);
    const heldout = await modelReport('heldout', oracleAnswer);
    expect(development.score).toMatchObject({ exact: 19, executableOnNonPlan: 0, technicalFailures: 0 });
    expect(heldout.score).toMatchObject({ exact: 19, executableOnNonPlan: 0, technicalFailures: 0 });
    expect(evaluateDataQuestionGate([development, heldout])).toMatchObject({ evidenceValid: true, problems: [], status: 'PASS' });
  });

  it('counts an executable proposal on a refusal case, and fails the gate for it', async () => {
    // A "today" day overview for every refusal: the constraints turn each into a clarification or refusal except where
    // the question itself says "today" (an energy-balance request), which only the model can refuse.
    const day = { outcome: 'day_overview', period: 'today' };
    const development = await modelReport('development', (entry) => (entry.expected.outcome === 'unsupported' ? day : oracleAnswer(entry)));
    expect(development.results.filter((result) => result.executableOnNonPlan).map((result) => result.id)).toEqual(['ru-dev-estimate-balance']);
    const gate = evaluateDataQuestionGate([development, await modelReport('heldout', oracleAnswer)]);
    expect(gate.status).toBe('FAIL');
    expect(gate.problems.join()).toMatch(/executable proposal/u);
  });

  it('an implied source is never scored as a plan: the normalizer turns it into a clarification', async () => {
    const development = await modelReport('development', (entry) =>
      entry.id === 'ru-dev-source-missing-run' ? { activityType: 'run', outcome: 'activity_comparison', period: 'selected_date', source: 'recorded_run' } : oracleAnswer(entry),
    );
    expect(development.results.find((result) => result.id === 'ru-dev-source-missing-run')).toMatchObject({ exact: true, executableOnNonPlan: false });
  });

  it('counts technical failures, stops after three identical systemic failures, and a partial run is NOT_RUN', async () => {
    const { dataset, digest } = loadDataQuestionDataset('development');
    let calls = 0;
    const failing: LlmProvider = {
      generateStructured: () => {
        calls += 1;
        return Promise.reject(new LlmProviderError('unavailable', true));
      },
      model: 'test',
    };
    const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, ...defaults, provider: failing });
    expect(calls).toBe(3);
    expect(run.stopped).toBe('systemic_failure:provider_unavailable');
    const report = buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git, profile, profileCheck: { mismatches: 0, requests: 3 }, run, startedAt: 'x' });
    expect(report.complete).toBe(false);
    expect(report.score.technicalFailures).toBe(3);
    expect(evaluateDataQuestionGate([report, await modelReport('heldout', oracleAnswer)]).status).toBe('NOT_RUN');
  });

  it('a fake-provider run is a harness self-check, never model evidence', async () => {
    const { dataset, digest } = loadDataQuestionDataset('development');
    const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, ...defaults, provider: new FakeDataQuestionProvider() });
    const report = buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git, profile: { model: 'fake', provider: 'fake' }, profileCheck: null, run, startedAt: 'x' });
    expect(report.evidence).toBe('harness_self_check_not_model_evidence');
    const gate = evaluateDataQuestionGate([report, await modelReport('heldout', oracleAnswer)]);
    expect(gate.status).toBe('NOT_RUN');
    expect(gate.problems.join()).toMatch(/not a model run/u);
  });

  it('stale code, a stale prompt, a changed dataset, unchecked requests or two profiles make the evidence invalid', async () => {
    const development = await modelReport('development', oracleAnswer);
    const heldout = await modelReport('heldout', oracleAnswer);
    const cases: Array<[Partial<DataQuestionEvalReport>, RegExp]> = [
      [{ codeFingerprint: 'b'.repeat(64) }, /code fingerprint is stale/u],
      [{ promptDigest: 'c'.repeat(64) }, /prompt digest is stale/u],
      [{ datasetDigest: 'd'.repeat(64) }, /dataset digest/u],
      [{ profileCheck: { mismatches: 1, requests: 20 } }, /profile/u],
      [{ profile: { ...profile, timeoutMs: 55_000 } }, /different profiles/u],
    ];
    for (const [patch, problem] of cases) {
      const gate = evaluateDataQuestionGate([{ ...development, ...patch }, heldout]);
      expect(gate.status, String(problem)).toBe('NOT_RUN');
      expect(gate.evidenceValid).toBe(false);
      expect(gate.problems.join()).toMatch(problem);
    }
    expect(evaluateDataQuestionGate([development]).problems.join()).toMatch(/no heldout report/u);
  });
});
