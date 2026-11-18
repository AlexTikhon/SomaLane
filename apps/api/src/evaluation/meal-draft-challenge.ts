import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  MEAL_DRAFT_CONTRACT_VERSION,
  MEAL_DRAFT_WITHHELD_REASONS,
  MEAL_NUTRITION_FIELDS,
  mealDraftProposalResponseSchema,
  type MealNutritionField,
} from '@running-tracker/contracts';
import { z } from 'zod';

import { groundMealDraft, UngroundedOutputError } from '../meals/drafts/meal-draft-grounding.js';
import { mealDraftWireSchema } from '../meals/drafts/meal-draft-wire.js';

// The deterministic vessel-scope CHALLENGE set of "Draft from text" (docs/meal-draft-vessel-scope-policy.md). It is an
// engineering challenge and regression set, written by the engineers who wrote the policy after examining earlier
// defects; it is NOT independent held-out evidence, and it is reported separately from the frozen safety corpus (which
// stays the verifier gate's evidence, unchanged). Every case supplies explicit claims; no model is called. Unlike the
// safety corpus, an expectation also fixes the existing reason code a withheld field must carry, so `conflicting` and
// `per_portion` are told apart.
//
// Frozen: the expectations were written and this digest pinned before the vessel-scope engine was rebuilt. A change is a
// new version in a new file. A FAIL here is a measured result, not something to make green by editing expectations.

export const MEAL_DRAFT_CHALLENGE_DIGEST = 'f521a88f39e70600e30eeeb8bda9057d2121752d8bbdfb463bf1c821ba078f26';

const CONTRACT_SCOPE = { localDate: '2026-11-17', timeZone: 'UTC', version: MEAL_DRAFT_CONTRACT_VERSION } as const;

const claimSchema = z.strictObject({ evidence: z.string().min(1).max(200), value: z.string().min(1).max(20) });
const expectationSchema = z.union([z.number().finite().nonnegative(), z.enum(MEAL_DRAFT_WITHHELD_REASONS)]);
const fieldRecord = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ carbohydrateG: schema.optional(), energyKcal: schema.optional(), fatG: schema.optional(), proteinG: schema.optional() });

export const mealDraftChallengeCaseSchema = z
  .strictObject({
    category: z.string().regex(/^[a-z][a-z-]{2,40}$/u),
    claims: fieldRecord(claimSchema),
    expect: fieldRecord(expectationSchema),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/u),
    language: z.enum(['en', 'ru']),
    text: z.string().min(1).max(500),
    title: z.string().min(1).max(120),
  })
  .refine((entry) => MEAL_NUTRITION_FIELDS.every((field) => (entry.claims[field] === undefined) === (entry.expect[field] === undefined)), {
    message: 'Every claimed field has an expectation, and only claimed fields',
  });

export const mealDraftChallengeSetSchema = z.strictObject({
  cases: z.array(mealDraftChallengeCaseSchema).min(10).max(300),
  challengeVersion: z.string().regex(/^\d+$/u),
  description: z.string().min(1),
  set: z.literal('challenge'),
});

export type MealDraftChallengeCase = z.infer<typeof mealDraftChallengeCaseSchema>;
export type MealDraftChallengeSet = z.infer<typeof mealDraftChallengeSetSchema>;

export function mealDraftChallengeDigest(set: MealDraftChallengeSet): string {
  return createHash('sha256').update(JSON.stringify(set), 'utf8').digest('hex');
}

const setUrl = new URL('../../evaluation/meal-draft.challenge.v1.json', import.meta.url);

/** Reads the frozen challenge set and refuses it if its content is not the pinned one. */
export function loadMealDraftChallengeSet(digest: string = MEAL_DRAFT_CHALLENGE_DIGEST): { digest: string; set: MealDraftChallengeSet } {
  const set = mealDraftChallengeSetSchema.parse(JSON.parse(readFileSync(setUrl, 'utf8')));
  const actual = mealDraftChallengeDigest(set);
  if (actual !== digest) throw new Error(`The challenge set is not the frozen one (digest ${actual.slice(0, 12)}…)`);
  if (new Set(set.cases.map((entry) => entry.id)).size !== set.cases.length) throw new Error('The challenge set has duplicate case ids');
  return { digest: actual, set };
}

/** The model answer a case stands for: its claims, every other field abstaining as not stated. */
export function challengeAnswer(entry: MealDraftChallengeCase): Record<string, unknown> {
  const answer: Record<string, unknown> = { mealType: null, mealTypeEvidence: null, outcome: 'draft', title: entry.title };
  for (const field of MEAL_NUTRITION_FIELDS) {
    const claim = entry.claims[field];
    answer[field] = claim === undefined ? { abstain: 'not_stated', evidence: null, value: null } : { abstain: null, evidence: claim.evidence, value: claim.value };
  }
  return answer;
}

/** What the person would be shown for one field: a proposed value, a withheld reason, or not stated. */
export type ChallengeFieldResult = { status: 'not_stated' } | { reason: string; status: 'withheld' } | { status: 'proposed'; value: number };

export type ChallengeOutcome = { kind: 'draft'; nutrition: Record<MealNutritionField, ChallengeFieldResult> } | { kind: 'refused'; reason: string };

/** The production pipeline on supplied claims: wire schema, groundMealDraft on the trimmed text, the response contract. */
export function runChallengeClaims(text: string, answer: unknown): ChallengeOutcome {
  const wire = mealDraftWireSchema.safeParse(answer);
  if (!wire.success) return { kind: 'refused', reason: 'invalid_output' };
  let grounded;
  try {
    grounded = groundMealDraft(text.trim(), wire.data);
  } catch (error) {
    if (error instanceof UngroundedOutputError) return { kind: 'refused', reason: 'ungrounded_output' };
    throw error;
  }
  const response = mealDraftProposalResponseSchema.safeParse({ ...grounded.proposal, ...CONTRACT_SCOPE });
  if (!response.success) return { kind: 'refused', reason: 'contract_rejected' };
  if (response.data.outcome !== 'draft') return { kind: 'refused', reason: response.data.outcome };
  const nutrition = {} as Record<MealNutritionField, ChallengeFieldResult>;
  for (const field of MEAL_NUTRITION_FIELDS) {
    const result = response.data.nutrition[field];
    nutrition[field] =
      result.status === 'proposed' ? { status: 'proposed', value: result.value } : result.status === 'withheld' ? { reason: result.reason, status: 'withheld' } : { status: 'not_stated' };
  }
  return { kind: 'draft', nutrition };
}

/**
 * Per field: `ok`; `unsafe_acceptance` (a value shown where it must be withheld, or another value than expected);
 * `missed_control` (an expected value withheld); `reason_mismatch` (withheld, but with another reason); `refused` (the
 * whole answer refused, so nothing was judged).
 */
export type ChallengeVerdict = 'missed_control' | 'ok' | 'reason_mismatch' | 'refused' | 'unsafe_acceptance';

export interface ChallengeCaseResult {
  category: string;
  fields: Partial<Record<MealNutritionField, { actual: ChallengeFieldResult | null; expected: number | string; verdict: ChallengeVerdict }>>;
  id: string;
  language: 'en' | 'ru';
  /** Unclaimed fields that were not reported as not stated (the runner's own sanity check). */
  unclaimedMismatches: MealNutritionField[];
}

export function judgeChallengeCase(entry: MealDraftChallengeCase, outcome: ChallengeOutcome): ChallengeCaseResult {
  const fields: ChallengeCaseResult['fields'] = {};
  const unclaimedMismatches: MealNutritionField[] = [];
  for (const field of MEAL_NUTRITION_FIELDS) {
    const expected = entry.expect[field];
    if (expected === undefined) {
      if (outcome.kind === 'draft' && outcome.nutrition[field].status !== 'not_stated') unclaimedMismatches.push(field);
      continue;
    }
    if (outcome.kind === 'refused') {
      fields[field] = { actual: null, expected, verdict: 'refused' };
      continue;
    }
    const actual = outcome.nutrition[field];
    let verdict: ChallengeVerdict;
    if (actual.status === 'proposed') verdict = actual.value === expected ? 'ok' : 'unsafe_acceptance';
    else if (typeof expected === 'number') verdict = 'missed_control';
    else verdict = actual.status === 'withheld' && actual.reason === expected ? 'ok' : 'reason_mismatch';
    fields[field] = { actual, expected, verdict };
  }
  return { category: entry.category, fields, id: entry.id, language: entry.language, unclaimedMismatches };
}

export function runMealDraftChallenge(cases: readonly MealDraftChallengeCase[]): ChallengeCaseResult[] {
  return cases.map((entry) => judgeChallengeCase(entry, runChallengeClaims(entry.text, challengeAnswer(entry))));
}

export interface ChallengeScore {
  byCategory: Record<string, { cases: number; failures: number }>;
  cases: number;
  controls: number;
  failures: Array<{ actual: ChallengeFieldResult | null; expected: number | string; field: MealNutritionField; id: string; verdict: ChallengeVerdict }>;
  fields: number;
  missedControls: number;
  reasonMismatches: number;
  refused: number;
  status: 'FAIL' | 'PASS';
  unclaimedMismatches: number;
  unsafeAcceptances: number;
}

export function scoreMealDraftChallenge(results: readonly ChallengeCaseResult[]): ChallengeScore {
  const score: ChallengeScore = {
    byCategory: {},
    cases: results.length,
    controls: 0,
    failures: [],
    fields: 0,
    missedControls: 0,
    reasonMismatches: 0,
    refused: 0,
    status: 'PASS',
    unclaimedMismatches: 0,
    unsafeAcceptances: 0,
  };
  for (const result of results) {
    const category = (score.byCategory[result.category] ??= { cases: 0, failures: 0 });
    category.cases += 1;
    score.unclaimedMismatches += result.unclaimedMismatches.length;
    let failed = result.unclaimedMismatches.length > 0;
    for (const field of MEAL_NUTRITION_FIELDS) {
      const judged = result.fields[field];
      if (judged === undefined) continue;
      score.fields += 1;
      if (typeof judged.expected === 'number') score.controls += 1;
      if (judged.verdict === 'ok') continue;
      failed = true;
      if (judged.verdict === 'unsafe_acceptance') score.unsafeAcceptances += 1;
      if (judged.verdict === 'missed_control') score.missedControls += 1;
      if (judged.verdict === 'reason_mismatch') score.reasonMismatches += 1;
      if (judged.verdict === 'refused') score.refused += 1;
      score.failures.push({ actual: judged.actual, expected: judged.expected, field, id: result.id, verdict: judged.verdict });
    }
    if (failed) category.failures += 1;
  }
  if (score.failures.length > 0 || score.unclaimedMismatches > 0) score.status = 'FAIL';
  return score;
}

export function formatChallengeScore(score: ChallengeScore, version: string): string {
  const lines = [
    `CHALLENGE SET: ${score.status} (vessel-scope engineering challenge v${version}, ${score.cases} cases, ${score.fields} claimed fields, supplied claims, no model; not held-out evidence)`,
    `  unsafe acceptances: ${score.unsafeAcceptances}; positive controls: ${score.controls - score.missedControls}/${score.controls}; reason mismatches: ${score.reasonMismatches}; refused answers: ${score.refused}`,
  ];
  for (const failure of score.failures) {
    const actual = failure.actual === null ? 'refused' : failure.actual.status === 'proposed' ? `proposed ${failure.actual.value}` : failure.actual.status === 'withheld' ? `withheld ${failure.actual.reason}` : 'not stated';
    lines.push(`    ${failure.verdict}: ${failure.id} ${failure.field} ${actual}, expected ${failure.expected}`);
  }
  return lines.join('\n');
}
