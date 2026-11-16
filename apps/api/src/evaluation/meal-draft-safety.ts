import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { MEAL_DRAFT_CONTRACT_VERSION, MEAL_NUTRITION_FIELDS, mealDraftProposalResponseSchema, type MealNutritionField } from '@running-tracker/contracts';
import { z } from 'zod';

import { groundMealDraft, UngroundedOutputError } from '../meals/drafts/meal-draft-grounding.js';
import { mealDraftWireSchema } from '../meals/drafts/meal-draft-wire.js';

// The deterministic SAFETY corpus of "Draft from text" (ADR-0092; docs/runbooks/meal-drafts.md). Every case supplies an
// explicit model answer: no model is called. The answer goes through exactly what a provider's answer goes through in
// the service (the wire schema, groundMealDraft on the trimmed text) and then through the public response contract the
// route applies. So a result here is a statement about the VERIFIER: whether it accepts a claim the text does not
// support. It is never a statement about a model, and a model that does not make a wrong claim proves nothing about the
// verifier (that is why this corpus exists beside the model sets).
//
// The corpus is frozen: its expectations were written and its digest pinned before its first run. A change is a new
// version in a new file. A FAIL here is a measured result, not something to make green by editing expectations.

export const MEAL_DRAFT_SAFETY_CORPUS_DIGEST = '35a514372d3b4f6ea4151ed6f3cf25dc705f2a81663e3669f3f0c0b41c007c43';

/** The date and zone a safety case is checked against the public contract with; never seen by the grounding. */
const CONTRACT_SCOPE = { localDate: '2026-11-16', timeZone: 'UTC', version: MEAL_DRAFT_CONTRACT_VERSION } as const;

const fieldExpectation = z.union([z.literal('not_proposed'), z.number().finite().nonnegative()]);

const safetyExpectationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    nutrition: z.strictObject({ carbohydrateG: fieldExpectation, energyKcal: fieldExpectation, fatG: fieldExpectation, proteinG: fieldExpectation }),
    outcome: z.literal('draft'),
  }),
  z.strictObject({ outcome: z.enum(['invalid_output', 'ungrounded_output']) }),
]);

export const mealDraftSafetyCaseSchema = z.strictObject({
  /** The model answer as a provider would return it, verbatim: deliberately NOT typed, so the wire schema judges it. */
  answer: z.record(z.string(), z.unknown()),
  category: z.string().regex(/^[a-z][a-z-]{2,40}$/u),
  expect: safetyExpectationSchema,
  id: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/u),
  language: z.enum(['en', 'ru']),
  note: z.string().min(1).max(300),
  text: z.string().min(1).max(500),
});

export const mealDraftSafetyCorpusSchema = z.strictObject({
  cases: z.array(mealDraftSafetyCaseSchema).min(24).max(200),
  corpusVersion: z.string().regex(/^\d+$/u),
  description: z.string().min(1),
  set: z.literal('safety'),
});

export type MealDraftSafetyCase = z.infer<typeof mealDraftSafetyCaseSchema>;
export type MealDraftSafetyCorpus = z.infer<typeof mealDraftSafetyCorpusSchema>;

export function mealDraftSafetyCorpusDigest(corpus: MealDraftSafetyCorpus): string {
  return createHash('sha256').update(JSON.stringify(corpus), 'utf8').digest('hex');
}

const corpusUrl = new URL('../../evaluation/meal-draft.safety.v1.json', import.meta.url);

/** Reads the frozen corpus and refuses it if its content is not the pinned one (or `digest` says otherwise, for tests). */
export function loadMealDraftSafetyCorpus(digest: string = MEAL_DRAFT_SAFETY_CORPUS_DIGEST): { corpus: MealDraftSafetyCorpus; digest: string } {
  const corpus = mealDraftSafetyCorpusSchema.parse(JSON.parse(readFileSync(corpusUrl, 'utf8')));
  const actual = mealDraftSafetyCorpusDigest(corpus);
  if (actual !== digest) throw new Error(`The safety corpus is not the frozen one (digest ${actual.slice(0, 12)}…)`);
  if (new Set(corpus.cases.map((entry) => entry.id)).size !== corpus.cases.length) throw new Error('The safety corpus has duplicate case ids');
  return { corpus, digest: actual };
}

// ---------------------------------------------------------------------------------------------------------------
// The claim pipeline: the service's own steps, in its order.

export type SafetyOutcome = 'clarify' | 'contract_rejected' | 'draft' | 'invalid_output' | 'ungrounded_output' | 'unsupported';

export interface VerifiedClaims {
  /** The value each field would show the person, or null when it is not proposed (or there is no draft). */
  proposed: Record<MealNutritionField, number | null>;
  outcome: SafetyOutcome;
}

const noValues = (): Record<MealNutritionField, number | null> => ({ carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null });

/** What a person would be shown for this text if a model had returned `answer`. Pure and deterministic. */
export function verifySuppliedClaims(text: string, answer: unknown): VerifiedClaims {
  const wire = mealDraftWireSchema.safeParse(answer);
  if (!wire.success) return { outcome: 'invalid_output', proposed: noValues() };
  let grounded;
  try {
    grounded = groundMealDraft(text.trim(), wire.data);
  } catch (error) {
    if (error instanceof UngroundedOutputError) return { outcome: 'ungrounded_output', proposed: noValues() };
    throw error;
  }
  const response = mealDraftProposalResponseSchema.safeParse({ ...grounded.proposal, ...CONTRACT_SCOPE });
  if (!response.success) return { outcome: 'contract_rejected', proposed: noValues() };
  if (response.data.outcome !== 'draft') return { outcome: response.data.outcome, proposed: noValues() };
  const proposed = noValues();
  for (const field of MEAL_NUTRITION_FIELDS) {
    const result = response.data.nutrition[field];
    proposed[field] = result.status === 'proposed' ? result.value : null;
  }
  return { outcome: 'draft', proposed };
}

// ---------------------------------------------------------------------------------------------------------------
// Judging one case.

/**
 * Per field: a positive control proposed exactly (`control_ok`) or not (`control_missed`); a value that must not be
 * accepted kept out (`withheld_ok`) or shown (`forbidden_accepted`, also for a control proposed with another value).
 */
export type SafetyFieldVerdict = 'control_missed' | 'control_ok' | 'forbidden_accepted' | 'withheld_ok';

export interface SafetyCaseResult {
  actualOutcome: SafetyOutcome;
  category: string;
  expectedOutcome: MealDraftSafetyCase['expect']['outcome'];
  fields: Record<MealNutritionField, { actual: number | null; expected: number | 'not_proposed'; verdict: SafetyFieldVerdict }>;
  id: string;
  language: 'en' | 'ru';
  outcomeMatches: boolean;
}

export function judgeSafetyCase(entry: MealDraftSafetyCase, verified: VerifiedClaims): SafetyCaseResult {
  const fields = {} as SafetyCaseResult['fields'];
  for (const field of MEAL_NUTRITION_FIELDS) {
    const expected = entry.expect.outcome === 'draft' ? entry.expect.nutrition[field] : 'not_proposed';
    const actual = verified.proposed[field];
    let verdict: SafetyFieldVerdict;
    if (actual !== null) verdict = actual === expected ? 'control_ok' : 'forbidden_accepted';
    else verdict = expected === 'not_proposed' ? 'withheld_ok' : 'control_missed';
    fields[field] = { actual, expected, verdict };
  }
  return {
    actualOutcome: verified.outcome,
    category: entry.category,
    expectedOutcome: entry.expect.outcome,
    fields,
    id: entry.id,
    language: entry.language,
    outcomeMatches: verified.outcome === entry.expect.outcome,
  };
}

export function runMealDraftSafety(cases: readonly MealDraftSafetyCase[]): SafetyCaseResult[] {
  return cases.map((entry) => judgeSafetyCase(entry, verifySuppliedClaims(entry.text, entry.answer)));
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring.

export interface SafetyTally {
  cases: number;
  /** Fields whose claimed value must never be shown and were shown: the safety number. */
  forbiddenAccepted: number;
  /** Positive-control fields (an exact value that must be proposed). */
  controls: number;
  controlsMissed: number;
  /** Fields that must not be proposed. */
  mustWithhold: number;
  outcomeMismatches: number;
}

export interface SafetyFinding {
  actual: number | null;
  category: string;
  expected: number | 'not_proposed';
  field: MealNutritionField;
  id: string;
  kind: 'control_missed' | 'forbidden_accepted';
  language: 'en' | 'ru';
}

export interface MealDraftSafetyScore {
  byCategory: Record<string, SafetyTally>;
  byLanguage: Record<'en' | 'ru', SafetyTally>;
  findings: SafetyFinding[];
  outcomeMismatches: Array<{ actual: SafetyOutcome; expected: string; id: string }>;
  total: SafetyTally;
}

const emptyTally = (): SafetyTally => ({ cases: 0, controls: 0, controlsMissed: 0, forbiddenAccepted: 0, mustWithhold: 0, outcomeMismatches: 0 });

function addTo(tally: SafetyTally, result: SafetyCaseResult): void {
  tally.cases += 1;
  if (!result.outcomeMatches) tally.outcomeMismatches += 1;
  for (const field of MEAL_NUTRITION_FIELDS) {
    const { expected, verdict } = result.fields[field];
    if (expected === 'not_proposed') tally.mustWithhold += 1;
    else tally.controls += 1;
    if (verdict === 'forbidden_accepted') tally.forbiddenAccepted += 1;
    if (verdict === 'control_missed') tally.controlsMissed += 1;
  }
}

export function scoreMealDraftSafety(results: readonly SafetyCaseResult[]): MealDraftSafetyScore {
  const total = emptyTally();
  const byLanguage = { en: emptyTally(), ru: emptyTally() };
  const byCategory: Record<string, SafetyTally> = {};
  const findings: SafetyFinding[] = [];
  const outcomeMismatches: MealDraftSafetyScore['outcomeMismatches'] = [];
  for (const result of results) {
    addTo(total, result);
    addTo(byLanguage[result.language], result);
    addTo((byCategory[result.category] ??= emptyTally()), result);
    if (!result.outcomeMatches) outcomeMismatches.push({ actual: result.actualOutcome, expected: result.expectedOutcome, id: result.id });
    for (const field of MEAL_NUTRITION_FIELDS) {
      const { actual, expected, verdict } = result.fields[field];
      if (verdict === 'forbidden_accepted' || verdict === 'control_missed') {
        findings.push({ actual, category: result.category, expected, field, id: result.id, kind: verdict, language: result.language });
      }
    }
  }
  return { byCategory, byLanguage, findings, outcomeMismatches, total };
}
