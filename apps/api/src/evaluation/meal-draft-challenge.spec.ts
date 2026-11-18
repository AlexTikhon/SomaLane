import { describe, expect, it } from 'vitest';

import {
  challengeAnswer,
  judgeChallengeCase,
  loadMealDraftChallengeSet,
  MEAL_DRAFT_CHALLENGE_DIGEST,
  runMealDraftChallenge,
  scoreMealDraftChallenge,
  type MealDraftChallengeCase,
} from './meal-draft-challenge.js';

// The frozen vessel-scope challenge set (an engineering challenge and regression set, not held-out evidence): every case
// through the production pipeline, judged against expectations fixed before the engine was rebuilt.

describe('the vessel-scope challenge set v1', () => {
  const { set, digest } = loadMealDraftChallengeSet();

  it('is the frozen artifact', () => {
    expect(digest).toBe(MEAL_DRAFT_CHALLENGE_DIGEST);
    expect(set.challengeVersion).toBe('1');
    expect(set.description).toContain('NOT independent held-out evidence');
  });

  it('passes every case: no unsafe acceptance, every positive control, every reason code', () => {
    const score = scoreMealDraftChallenge(runMealDraftChallenge(set.cases));
    expect(score.failures).toEqual([]);
    expect(score.unclaimedMismatches).toBe(0);
    expect(score.status).toBe('PASS');
    // Rejecting everything is not success: the set holds real positive controls and they are all proposed.
    expect(score.controls).toBeGreaterThanOrEqual(20);
  });

  it('covers every category of the acceptance matrix in both languages', () => {
    const categories = new Set(set.cases.map((entry) => entry.category));
    for (const category of ['mixed-context', 'unresolved-list', 'batch', 'confirmed-consumed', 'unrelated-action', 'label', 'unknown-qualifier', 'positive-control', 'global-policy']) {
      expect(categories.has(category), category).toBe(true);
    }
    expect(set.cases.some((entry) => entry.language === 'ru')).toBe(true);
    expect(set.cases.some((entry) => entry.text.includes('\r\n'))).toBe(true);
  });
});

describe('the challenge runner judges each field independently of the engine', () => {
  const entry: MealDraftChallengeCase = {
    category: 'positive-control',
    claims: { energyKcal: { evidence: '300 kcal', value: '300' } },
    expect: { energyKcal: 300 },
    id: 'probe-case',
    language: 'en',
    text: 'Soup, 300 kcal',
    title: 'Soup',
  };
  const draft = (energy: unknown) => ({
    kind: 'draft' as const,
    nutrition: { carbohydrateG: { status: 'not_stated' as const }, energyKcal: energy as never, fatG: { status: 'not_stated' as const }, proteinG: { status: 'not_stated' as const } },
  });

  it('builds the answer from the claims, every other field abstaining as not stated', () => {
    expect(challengeAnswer(entry)).toEqual({
      carbohydrateG: { abstain: 'not_stated', evidence: null, value: null },
      energyKcal: { abstain: null, evidence: '300 kcal', value: '300' },
      fatG: { abstain: 'not_stated', evidence: null, value: null },
      mealType: null,
      mealTypeEvidence: null,
      outcome: 'draft',
      proteinG: { abstain: 'not_stated', evidence: null, value: null },
      title: 'Soup',
    });
  });

  it('tells an unsafe acceptance, a missed control, a reason mismatch and a refusal apart', () => {
    expect(judgeChallengeCase(entry, draft({ status: 'proposed', value: 300 })).fields.energyKcal?.verdict).toBe('ok');
    expect(judgeChallengeCase(entry, draft({ status: 'proposed', value: 301 })).fields.energyKcal?.verdict).toBe('unsafe_acceptance');
    expect(judgeChallengeCase(entry, draft({ reason: 'per_portion', status: 'withheld' })).fields.energyKcal?.verdict).toBe('missed_control');
    const withheldCase = { ...entry, expect: { energyKcal: 'conflicting' as const } };
    expect(judgeChallengeCase(withheldCase, draft({ status: 'proposed', value: 300 })).fields.energyKcal?.verdict).toBe('unsafe_acceptance');
    expect(judgeChallengeCase(withheldCase, draft({ reason: 'per_portion', status: 'withheld' })).fields.energyKcal?.verdict).toBe('reason_mismatch');
    expect(judgeChallengeCase(withheldCase, draft({ reason: 'conflicting', status: 'withheld' })).fields.energyKcal?.verdict).toBe('ok');
    expect(judgeChallengeCase(entry, { kind: 'refused', reason: 'ungrounded_output' }).fields.energyKcal?.verdict).toBe('refused');
  });

  it('fails the score on any non-ok field or an unclaimed field that is not "not stated"', () => {
    const ok = judgeChallengeCase(entry, draft({ status: 'proposed', value: 300 }));
    expect(scoreMealDraftChallenge([ok]).status).toBe('PASS');
    const bad = judgeChallengeCase(entry, draft({ status: 'proposed', value: 301 }));
    expect(scoreMealDraftChallenge([ok, bad])).toMatchObject({ status: 'FAIL', unsafeAcceptances: 1 });
    const extra = judgeChallengeCase(entry, { ...draft({ status: 'proposed', value: 300 }), nutrition: { ...draft({ status: 'proposed', value: 300 }).nutrition, fatG: { status: 'proposed', value: 1 } } });
    expect(scoreMealDraftChallenge([extra])).toMatchObject({ status: 'FAIL', unclaimedMismatches: 1 });
  });

  it('refuses an edited artifact', () => {
    expect(() => loadMealDraftChallengeSet('0'.repeat(64))).toThrow(/not the frozen one/u);
  });
});
