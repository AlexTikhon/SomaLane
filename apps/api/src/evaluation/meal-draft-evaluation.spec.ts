import { describe, expect, it } from 'vitest';

import { LlmProviderError, type LlmProvider } from '../insights/llm-provider.js';
import { FakeMealDraftProvider } from '../meals/drafts/fake-meal-draft-provider.js';
import {
  buildMealDraftReport,
  formatMealDraftReport,
  loadMealDraftDataset,
  loadMealDraftDatasets,
  MEAL_DRAFT_DATASET_DIGESTS,
  MEAL_DRAFT_DATASET_REGISTRY,
  MEAL_DRAFT_DEFAULT_DATASET_VERSION,
  mealDraftDatasetDigest,
  mealDraftDatasetDigests,
  mealDraftEvaluationCaseSchema,
  parseMealDraftDatasetVersion,
  runMealDraftEvaluation,
  verifyMealDraftDataset,
  scoreMealDraftResults,
  type MealDraftCaseResult,
  type MealDraftEvaluationCase,
} from './meal-draft-evaluation.js';

const clock = { monotonicNow: () => performance.now() };

describe('meal draft evaluation sets (frozen)', () => {
  it('loads both sets only with their pinned digests, with English and Russian cases and no shared text', () => {
    const development = loadMealDraftDataset('development');
    const heldout = loadMealDraftDataset('heldout');
    expect(development.digest).toBe(MEAL_DRAFT_DATASET_DIGESTS.development);
    expect(heldout.digest).toBe(MEAL_DRAFT_DATASET_DIGESTS.heldout);
    for (const { dataset } of [development, heldout]) {
      expect(dataset.cases.filter((entry) => entry.language === 'en').length).toBeGreaterThanOrEqual(8);
      expect(dataset.cases.filter((entry) => entry.language === 'ru').length).toBeGreaterThanOrEqual(8);
    }
    const texts = new Set(development.dataset.cases.map((entry) => entry.text));
    expect(heldout.dataset.cases.some((entry) => texts.has(entry.text))).toBe(false);
    expect(() => loadMealDraftDataset('heldout', '1', { ...MEAL_DRAFT_DATASET_DIGESTS, heldout: '0'.repeat(64) })).toThrow(/not the frozen one/u);
  });
});

describe('meal draft dataset versions (pinned registry)', () => {
  it('defaults to version 1 and keeps its historical files and digests', () => {
    expect(MEAL_DRAFT_DEFAULT_DATASET_VERSION).toBe('1');
    expect(parseMealDraftDatasetVersion(undefined)).toBe('1');
    expect(parseMealDraftDatasetVersion('v1')).toBe('1');
    expect(parseMealDraftDatasetVersion('v2')).toBe('2');
    // The literal digests recorded on 2026-11-14: version 1 must never move.
    expect(MEAL_DRAFT_DATASET_REGISTRY['1']).toEqual({
      development: { caseCount: 20, digest: '7081d147294698185b8ba87c3ef98f4770c51a9aa72e2ecf22ff98f0cf9e2951', file: 'meal-draft.development.v1.json' },
      heldout: { caseCount: 20, digest: 'be55bcaf7c6b1707818a1137eddc7f0d160bc077c5ede7842a3c952e04863b85', file: 'meal-draft.heldout.v1.json' },
    });
    expect(MEAL_DRAFT_DATASET_DIGESTS).toEqual(mealDraftDatasetDigests('1'));
    expect(loadMealDraftDataset('development')).toMatchObject({ digest: MEAL_DRAFT_DATASET_DIGESTS.development, version: '1' });
    expect(Object.isFrozen(MEAL_DRAFT_DATASET_REGISTRY)).toBe(true);
    expect(Object.isFrozen(MEAL_DRAFT_DATASET_REGISTRY['2'].heldout)).toBe(true);
  });

  it.each(['v3', 'v0', '2', 'V2', 'v2.0', 'latest', ''])('refuses the unknown version %j', (value) => {
    expect(() => parseMealDraftDatasetVersion(value)).toThrow(/--dataset-version must be v1 or v2/u);
  });

  it('loads version 2 only with its pinned digests: 20 cases per set, 10 English and 10 Russian, distinct from each other and from version 1', () => {
    const v2 = loadMealDraftDatasets('2');
    const v1 = loadMealDraftDatasets('1');
    const v1Texts = new Set([...v1.development.dataset.cases, ...v1.heldout.dataset.cases].map((entry) => entry.text.toLocaleLowerCase('ru')));
    for (const set of ['development', 'heldout'] as const) {
      const { dataset, digest, version } = v2[set];
      expect(version).toBe('2');
      expect(dataset.datasetVersion).toBe('2');
      expect(digest).toBe(MEAL_DRAFT_DATASET_REGISTRY['2'][set].digest);
      expect(dataset.cases).toHaveLength(20);
      expect(dataset.cases.filter((entry) => entry.language === 'en')).toHaveLength(10);
      expect(dataset.cases.filter((entry) => entry.language === 'ru')).toHaveLength(10);
      expect(dataset.cases.some((entry) => v1Texts.has(entry.text.toLocaleLowerCase('ru')))).toBe(false);
      expect(dataset.description).toMatch(/not independent blind held-out evidence/u);
      // Every expectation names the documented rule it follows.
      expect(dataset.cases.every((entry) => (entry.rationale ?? '').length > 20)).toBe(true);
    }
  });

  it('has enough positive extraction in each set and language for precision and recall to mean something', () => {
    const v2 = loadMealDraftDatasets('2');
    const categories = new Set<string>();
    for (const set of ['development', 'heldout'] as const) {
      for (const language of ['en', 'ru'] as const) {
        const cases = v2[set].dataset.cases.filter((entry) => entry.language === language);
        const values = cases.flatMap((entry) => (entry.expected.outcome === 'draft' ? Object.values(entry.expected.nutrition).filter((value) => value !== null) : []));
        const mustNotShow = cases.flatMap((entry) => (entry.expected.outcome === 'draft' ? Object.values(entry.expected.nutrition).filter((value) => value === null) : []));
        expect(values.length).toBeGreaterThanOrEqual(12);
        expect(mustNotShow.length).toBeGreaterThanOrEqual(12);
        expect(values.some((value) => !Number.isInteger(value))).toBe(true);
      }
      // A recorded zero in every set.
      expect(v2[set].dataset.cases.some((entry) => entry.expected.outcome === 'draft' && Object.values(entry.expected.nutrition).includes(0))).toBe(true);
      for (const entry of v2[set].dataset.cases) categories.add(entry.category);
    }
    for (const category of ['grounded', 'title-only', 'zero', 'decimal', 'multiline', 'reordered', 'container-consumed', 'batch-unresolved', 'conflicting', 'competing-construction', 'per-portion', 'bound', 'range', 'unit', 'food-quantity', 'instruction', 'estimate-request']) {
      expect(categories).toContain(category);
    }
  });

  it('refuses a set whose digest, version, set, size, ids or texts are not the pinned ones', () => {
    const { dataset } = loadMealDraftDataset('development', '2');
    const pinned = MEAL_DRAFT_DATASET_REGISTRY['2'].development;
    expect(verifyMealDraftDataset(dataset, 'development', '2', pinned)).toBe(pinned.digest);
    expect(() => loadMealDraftDataset('development', '2', { ...mealDraftDatasetDigests('2'), development: '0'.repeat(64) })).toThrow(/The v2 development set is not the frozen one/u);
    // Version 1 digests are never accepted for version 2 files, nor the reverse.
    expect(() => loadMealDraftDataset('heldout', '2', mealDraftDatasetDigests('1'))).toThrow(/not the frozen one/u);
    expect(() => verifyMealDraftDataset(dataset, 'development', '1', pinned)).toThrow(/holds dataset version 2/u);
    expect(() => verifyMealDraftDataset(dataset, 'heldout', '2', pinned)).toThrow(/holds the development set/u);
    const edited = { ...dataset, cases: dataset.cases.map((entry, index) => (index === 0 ? { ...entry, expected: { outcome: 'clarify' as const, reason: 'multiple_meals' as const } } : entry)) };
    expect(() => verifyMealDraftDataset(edited, 'development', '2', pinned)).toThrow(/not the frozen one/u);
    const truncated = { ...dataset, cases: dataset.cases.slice(1) };
    expect(() => verifyMealDraftDataset(truncated, 'development', '2', { ...pinned, digest: mealDraftDatasetDigest(truncated) })).toThrow(/19 cases, 20 are pinned/u);
    const duplicateId = { ...dataset, cases: dataset.cases.map((entry, index) => (index === 1 ? { ...entry, id: dataset.cases[0]!.id } : entry)) };
    expect(() => verifyMealDraftDataset(duplicateId, 'development', '2', { ...pinned, digest: mealDraftDatasetDigest(duplicateId) })).toThrow(/duplicate case ids/u);
    const duplicateText = { ...dataset, cases: dataset.cases.map((entry, index) => (index === 1 ? { ...entry, text: dataset.cases[0]!.text } : entry)) };
    expect(() => verifyMealDraftDataset(duplicateText, 'development', '2', { ...pinned, digest: mealDraftDatasetDigest(duplicateText) })).toThrow(/duplicate texts/u);
  });

  it('keeps every case text within the public input contract', () => {
    const valid = { category: 'grounded', expected: { outcome: 'clarify', reason: 'no_food_named' }, id: 'en-x', language: 'en' };
    expect(mealDraftEvaluationCaseSchema.safeParse({ ...valid, text: 'Soup\nprotein 4 g' }).success).toBe(true);
    expect(mealDraftEvaluationCaseSchema.safeParse({ ...valid, text: 'ё'.repeat(500) }).success).toBe(true);
    expect(mealDraftEvaluationCaseSchema.safeParse({ ...valid, text: 'ё'.repeat(501) }).success).toBe(false);
    expect(mealDraftEvaluationCaseSchema.safeParse({ ...valid, text: 'Soup\u0007' }).success).toBe(false);
    expect(mealDraftEvaluationCaseSchema.safeParse({ ...valid, text: '   ' }).success).toBe(false);
    expect(mealDraftEvaluationCaseSchema.safeParse({ ...valid, text: 'Soup', unknown: true }).success).toBe(false);
  });
});

describe('meal draft evaluation scoring', () => {
  const draftCase = (nutrition: Partial<Record<'carbohydrateG' | 'energyKcal' | 'fatG' | 'proteinG', number | null>>): MealDraftEvaluationCase => ({
    category: 'grounded',
    expected: {
      mealType: null,
      nutrition: { carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null, ...nutrition },
      outcome: 'draft',
      titleIncludes: ['soup'],
    },
    id: 'case-a',
    language: 'en',
    text: 'Soup',
  });
  const notStated = { status: 'not_stated' } as const;

  it('separates correct, incorrectly accepted, abstained and stopped fields', () => {
    const results: MealDraftCaseResult[] = [
      {
        audit: { fields: { carbohydrateG: 'server_withheld', energyKcal: 'proposed', fatG: 'model_abstained', proteinG: 'proposed' }, multipleMealsOverride: false },
        case: draftCase({ energyKcal: 300, fatG: 5, proteinG: 10 }),
        durationMs: 100,
        failure: null,
        proposal: {
          mealType: notStated,
          nutrition: {
            carbohydrateG: { reason: 'per_portion', status: 'withheld' },
            energyKcal: { excerpt: '300 kcal', status: 'proposed', value: 300 },
            fatG: { reason: 'ambiguous', status: 'withheld' },
            proteinG: { excerpt: 'protein 12 g', status: 'proposed', value: 12 },
          },
          outcome: 'draft',
          title: 'Soup',
        },
      },
      { audit: null, case: { ...draftCase({ energyKcal: 200 }), id: 'case-b' }, durationMs: 300, failure: 'timeout', proposal: null },
    ];
    const score = scoreMealDraftResults(results);
    expect(score.fields).toEqual({
      correctAccepted: 1,
      correctNull: 4,
      expectedValues: 4,
      incorrectAccepted: 1,
      missedByModel: 1,
      missedByOutcome: 1,
      missedByServer: 0,
      stoppedByServer: 1,
    });
    expect(score.incorrectAccepted).toEqual([{ actual: 12, expected: 10, field: 'proteinG', id: 'case-a' }]);
    expect(score.extraction).toEqual({ precision: 0.5, recall: 0.25 });
    expect(score.outcome).toEqual({ correct: 1, total: 2 });
    expect(score.failures).toEqual({ byReason: { timeout: 1 }, total: 1 });
    expect(score.latencyMs).toEqual({ max: 300, mean: 200, p50: 100, p95: 300 });
  });
});

describe('meal draft evaluation runner', () => {
  it('makes one call per case, never more than allowed, and stops after three identical systemic failures', async () => {
    const { dataset } = loadMealDraftDataset('development');
    let calls = 0;
    const failing: LlmProvider = {
      generateStructured: () => {
        calls += 1;
        return Promise.reject(new LlmProviderError('unavailable', true));
      },
      model: 'test',
    };
    const run = await runMealDraftEvaluation({ cases: dataset.cases, clock, maxCalls: 20, maxOutputTokens: 600, provider: failing, timeoutMs: 1_000 });
    expect(calls).toBe(3);
    expect(run.stopped).toEqual({ afterCases: 3, reason: 'provider_unavailable' });
    await expect(runMealDraftEvaluation({ cases: dataset.cases, clock, maxCalls: 41, maxOutputTokens: 600, provider: failing, timeoutMs: 1_000 })).rejects.toThrow(/maxCalls/u);
  });

  // Harness verification with the deterministic fake. It proves that the runner, the grounding and the scoring work
  // together; it is NOT evidence about any model (the fake copies numbers naively and the grounding withholds the rest).
  it.each(['development', 'heldout'] as const)('runs the %s set end to end with the fake provider, labelled as such', async (set) => {
    const { dataset, digest } = loadMealDraftDataset(set);
    const run = await runMealDraftEvaluation({ cases: dataset.cases, clock, maxCalls: 20, maxOutputTokens: 600, provider: new FakeMealDraftProvider(), timeoutMs: 5_000 });
    const report = buildMealDraftReport({ dataset, digest, generation: {}, model: 'fake', provider: 'fake', run, runtimeVersion: null, timeoutMs: 5_000 });
    expect(report.kind).toBe('fake-harness-verification');
    expect(report.executedCount).toBe(20);
    expect(report.calls).toBe(20);
    expect(report.partial).toBe(false);
    // The fake proposes every number it sees next to a unit; the grounding keeps all the wrong ones out.
    expect(report.score.fields.incorrectAccepted).toBe(0);
    expect(report.score.fields.stoppedByServer).toBeGreaterThan(0);
    expect(formatMealDraftReport(report)).toContain('FAKE PROVIDER: harness verification only. This is NOT evidence about any model.');
  });

  // The same harness check on version 2: it proves the runner, the grounding and the scoring run over the new sets and
  // label the result; its numbers are recorded in the report as harness output, never as model quality.
  it.each(['development', 'heldout'] as const)('runs the version 2 %s set end to end with the fake provider, labelled as harness verification', async (set) => {
    const { dataset, digest } = loadMealDraftDataset(set, '2');
    const run = await runMealDraftEvaluation({ cases: dataset.cases, clock, maxCalls: 20, maxOutputTokens: 600, provider: new FakeMealDraftProvider(), timeoutMs: 5_000 });
    const report = buildMealDraftReport({ dataset, digest, generation: {}, model: 'fake', provider: 'fake', run, runtimeVersion: null, timeoutMs: 5_000 });
    expect(report).toMatchObject({ calls: 20, datasetDigest: MEAL_DRAFT_DATASET_REGISTRY['2'][set].digest, datasetVersion: '2', executedCount: 20, kind: 'fake-harness-verification', partial: false });
    expect(report.score.fields.expectedValues).toBe(set === 'development' ? 30 : 28);
    expect(formatMealDraftReport(report)).toMatch(/^FAKE PROVIDER: harness verification only\. This is NOT evidence about any model\.\nSet: \S+ v2 /u);
  });
});
