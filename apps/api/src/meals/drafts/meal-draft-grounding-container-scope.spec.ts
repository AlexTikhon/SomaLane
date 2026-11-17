import { mealDraftProposalResponseSchema, type MealNutritionField } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { groundMealDraft, groundNutrient } from './meal-draft-grounding.js';
import { mealDraftWireSchema, type MealDraftWireDraft, type NutrientClaim } from './meal-draft-wire.js';

// Regressions for the last two false acceptances of the frozen safety corpus `meal-draft.safety.v1.json` (ADR-0092,
// container-scope remediation, 2026-11-16): a nutrition figure for a whole cooking vessel or batch ("the whole pot is
// 900 kcal", "вся кастрюля 900 ккал") is not the amount the person ate. It is withheld as `per_portion` unless the
// existing consumption-bound total rule establishes the person's own consumed total in a sentence of its own. Food names
// and cooking references that merely name a vessel ("Pot roast", "Pan-fried salmon", "Суп из кастрюли") are not such a
// figure. Every claim below is schema-valid and UNSAFE unless marked as a positive control. Nothing here calls a model.

const claim = (value: string, evidence: string): NutrientClaim => ({ abstain: null, evidence, value });
const notStated: NutrientClaim = { abstain: 'not_stated', evidence: null, value: null };
const ground = (text: string, field: MealNutritionField, value: string, evidence: string) => groundNutrient(text, field, claim(value, evidence)).result;
const withheld = (reason: string) => ({ reason, status: 'withheld' });
const proposed = (value: number, excerpt: string) => ({ excerpt, status: 'proposed', value });

const NBSP = String.fromCodePoint(0xa0);
const NNBSP = String.fromCodePoint(0x202f);
const GAPS = [' ', '\n', '\r\n', '\t', '\t\n', '\n\n', NBSP, NNBSP, ` ${NBSP}\n${NNBSP}`];

describe('a whole-container figure is not the total eaten', () => {
  it('withholds the two frozen corpus cases as per_portion', () => {
    expect(ground('Soup from the pot; the whole pot is 900 kcal', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Суп из кастрюли; вся кастрюля 900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
  });

  it('withholds them whatever the excerpt includes', () => {
    expect(ground('Soup from the pot; the whole pot is 900 kcal', 'energyKcal', '900', 'the whole pot is 900 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Суп из кастрюли; вся кастрюля 900 ккал', 'energyKcal', '900', 'вся кастрюля 900 ккал')).toEqual(withheld('per_portion'));
  });

  it('withholds equivalent English container-total wording', () => {
    for (const [text, field, value, evidence] of [
      ['Soup from the pot. The whole pot is 900 kcal.', 'energyKcal', '900', '900 kcal'],
      ['THE WHOLE POT IS 900 KCAL', 'energyKcal', '900', '900 KCAL'],
      ['Chili; the entire pot has 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Chili, a full pot, 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Chili. 900 kcal for the whole pot', 'energyKcal', '900', '900 kcal'],
      ['Chili. All of the pot: 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Stew. The pot has 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Stew. This pot contains 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Stew. The pot of stew was 1200 kcal', 'energyKcal', '1200', '1200 kcal'],
      ['Stew. Pot: 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Rice in the pot: 600 kcal', 'energyKcal', '600', '600 kcal'],
      ['Rice in the pot is 600 kcal', 'energyKcal', '600', '600 kcal'],
      ['Pasta; the whole pan is 800 kcal', 'energyKcal', '800', '800 kcal'],
      ['Pasta; the whole saucepan is 800 kcal', 'energyKcal', '800', '800 kcal'],
      ['Frittata; the entire skillet has 1100 kcal', 'energyKcal', '1100', '1100 kcal'],
      ['Cookies; the whole batch is 2000 kcal', 'energyKcal', '2000', '2000 kcal'],
      ['Chili, the whole pot has protein 80 g', 'proteinG', '80', 'protein 80 g'],
      ['Chili. The pot: 120 g carbs', 'carbohydrateG', '120', '120 g carbs'],
      ['Chili. The pot – 120 g carbs', 'carbohydrateG', '120', '120 g carbs'],
      // A whole-quantified vessel set beside a figure in its clause. (Until the 2026-11-17 correction a whole-quantifier
      // needed no figure at all, which also withheld "Washed the whole pan, then soup 300 kcal"; that one is now a
      // positive control below and in meal-draft-grounding-container-relation.spec.ts.)
      ['Chili; whole pot, fat 45.5 g', 'fatG', '45.5', 'fat 45.5 g'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });

  it('withholds equivalent Russian container-total wording and its grammatical forms', () => {
    for (const [text, field, value, evidence] of [
      ['Суп из кастрюли. Вся кастрюля 900 ккал.', 'energyKcal', '900', '900 ккал'],
      ['ВСЯ КАСТРЮЛЯ 900 ККАЛ', 'energyKcal', '900', '900 ККАЛ'],
      ['Борщ; на всю кастрюлю 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ; во всей кастрюле 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ; целая кастрюля — 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ; полная кастрюля, 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ. Кастрюля целиком 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ. Кастрюля: 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ. Кастрюля 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ. Кастрюля содержит 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ. В кастрюле 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ. В этой кастрюле: 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Борщ; вся кастрюлька 600 ккал', 'energyKcal', '600', '600 ккал'],
      ['Жаркое; вся сковорода 1200 ккал', 'energyKcal', '1200', '1200 ккал'],
      ['Жаркое; всю сковородку 1200 ккал', 'energyKcal', '1200', '1200 ккал'],
      ['Плов; весь казан 3000 ккал', 'energyKcal', '3000', '3000 ккал'],
      ['Плов; в казане 3000 ккал', 'energyKcal', '3000', '3000 ккал'],
      ['Суп; на всю кастрюлю белки 80 г', 'proteinG', '80', 'белки 80 г'],
      ['Суп; вся кастрюля, 120 г углеводов', 'carbohydrateG', '120', '120 г углеводов'],
      ['Суп; вся кастрюля, жиры 45,5 г', 'fatG', '45,5', 'жиры 45,5 г'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });

  it('withholds them across any whitespace inside the container phrase', () => {
    for (const gap of GAPS) {
      expect(ground(`Soup from the pot; the whole${gap}pot is 900 kcal`, 'energyKcal', '900', '900 kcal'), JSON.stringify(gap)).toEqual(withheld('per_portion'));
      expect(ground(`Stew. The${gap}pot${gap}has 900 kcal`, 'energyKcal', '900', '900 kcal'), JSON.stringify(gap)).toEqual(withheld('per_portion'));
      expect(ground(`Суп из кастрюли; вся${gap}кастрюля 900 ккал`, 'energyKcal', '900', '900 ккал'), JSON.stringify(gap)).toEqual(withheld('per_portion'));
      expect(ground(`Плов; в${gap}казане${gap}3000 ккал`, 'energyKcal', '3000', '3000 ккал'), JSON.stringify(gap)).toEqual(withheld('per_portion'));
    }
  });

  it('withholds a container figure even when the person said they ate the whole container in the same sentence', () => {
    // As for "I ate the whole package, 240 kcal": nothing is inferred about how much of the container was eaten.
    expect(ground('I ate the whole pot, 900 kcal', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Итого съел всю кастрюлю, 900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
  });

  it('withholds every other value of a container text unless it is the person\'s own consumed total', () => {
    const english = 'Soup from the pot; the whole pot is 900 kcal; protein 20 g';
    expect(ground(english, 'proteinG', '20', 'protein 20 g')).toEqual(withheld('per_portion'));
    const russian = 'Суп; вся кастрюля 900 ккал. Белки 20 г.';
    expect(ground(russian, 'proteinG', '20', 'Белки 20 г')).toEqual(withheld('per_portion'));
  });
});

describe('an explicitly consumed total beside a container figure', () => {
  it('proposes the consumed total and withholds the container figure (EN and RU from the brief)', () => {
    const english = 'The whole pot has 900 kcal. In total I ate 300 kcal.';
    expect(ground(english, 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground(english, 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    const russian = 'Вся кастрюля 900 ккал. Итого съел 300 ккал.';
    expect(ground(russian, 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground(russian, 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
  });

  it('proposes consumed totals with zero and exact decimals for every field, without computing anything', () => {
    const english = 'Chili. The whole pot is 900 kcal, protein 80 g. In total I ate 300 kcal, protein 0 g, fat 2.50 g, carbs 30,5 g.';
    expect(ground(english, 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground(english, 'proteinG', '0', 'protein 0 g')).toEqual(proposed(0, 'protein 0 g'));
    expect(ground(english, 'fatG', '2.5', 'fat 2.50 g')).toEqual(proposed(2.5, 'fat 2.50 g'));
    expect(ground(english, 'carbohydrateG', '30,5', 'carbs 30,5 g')).toEqual(proposed(30.5, 'carbs 30,5 g'));
    expect(ground(english, 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground(english, 'proteinG', '80', 'protein 80 g')).toEqual(withheld('per_portion'));
    const russian = 'Плов. Весь казан 3000 ккал. Итого съел 450 ккал, белки 0 г, жиры 12,5 г.';
    expect(ground(russian, 'energyKcal', '450', '450 ккал')).toEqual(proposed(450, '450 ккал'));
    expect(ground(russian, 'proteinG', '0', 'белки 0 г')).toEqual(proposed(0, 'белки 0 г'));
    expect(ground(russian, 'fatG', '12,5', 'жиры 12,5 г')).toEqual(proposed(12.5, 'жиры 12,5 г'));
    expect(ground(russian, 'energyKcal', '3000', '3000 ккал')).toEqual(withheld('per_portion'));
  });

  it('proposes the consumed total across a line break between the two sentences', () => {
    for (const gap of ['\n', '\r\n', '\n\n', ` ${NBSP}`]) {
      const text = `The whole pot has 900 kcal.${gap}In total I ate 300 kcal.`;
      expect(ground(text, 'energyKcal', '300', '300 kcal'), JSON.stringify(gap)).toEqual(proposed(300, '300 kcal'));
      expect(ground(text, 'energyKcal', '900', '900 kcal'), JSON.stringify(gap)).toEqual(withheld('per_portion'));
    }
  });

  it('still requires both the summing phrase and the consumption verb (existing rule, unchanged)', () => {
    expect(ground('The whole pot has 900 kcal. In total 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('per_portion'));
    expect(ground('The whole pot has 900 kcal. I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Вся кастрюля 900 ккал. Итого 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(withheld('per_portion'));
  });

  it('never lets a container figure conflict with the consumed total, and still detects two consumed totals', () => {
    const one = groundNutrient('The whole pot has 900 kcal. In total I ate 300 kcal.', 'energyKcal', claim('300', '300 kcal'));
    expect(one.disposition).toBe('proposed');
    const two = 'The whole pot has 900 kcal. In total I ate 300 kcal. In total I ate 350 kcal.';
    expect(ground(two, 'energyKcal', '300', '300 kcal')).toEqual(withheld('conflicting'));
  });
});

describe('vessel words in food names and cooking references are not container figures (positive controls)', () => {
  it('proposes values beside food names that contain a vessel word', () => {
    for (const [text, field, value, evidence, expected] of [
      ['Pot roast, 500 kcal', 'energyKcal', '500', '500 kcal', 500],
      ['Pot roast with carrots, 500 kcal, protein 35 g', 'proteinG', '35', 'protein 35 g', 35],
      ['Pot pie, fat 22.5 g', 'fatG', '22.5', 'fat 22.5 g', 22.5],
      ['Pan-fried salmon, 400 kcal', 'energyKcal', '400', '400 kcal', 400],
      ['Pancakes from the pan, 350 kcal', 'energyKcal', '350', '350 kcal', 350],
      ['Wok noodles, 600 kcal', 'energyKcal', '600', '600 kcal', 600],
      ['Skillet cornbread, carbs 40,5 g', 'carbohydrateG', '40,5', 'carbs 40,5 g', 40.5],
      ['Batch-cooked chili, 520 kcal', 'energyKcal', '520', '520 kcal', 520],
      ['Сковородка с овощами, 350 ккал', 'energyKcal', '350', '350 ккал', 350],
      ['Плов из казана, 700 ккал', 'energyKcal', '700', '700 ккал', 700],
      ['Казанский плов, белки 25 г', 'proteinG', '25', 'белки 25 г', 25],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(proposed(expected, evidence));
    }
  });

  it('proposes values beside ordinary cooking references to a vessel', () => {
    for (const [text, field, value, evidence, expected] of [
      ['Stew cooked in a pot, 450 kcal', 'energyKcal', '450', '450 kcal', 450],
      ['Soup from the pot, 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['Soup from the pot, 300 kcal, fat 0 g', 'fatG', '0', 'fat 0 g', 0],
      ['Soup from the pot: 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['Stew from the pot – 450 kcal', 'energyKcal', '450', '450 kcal', 450],
      ['Soup from the pot is 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['Chili out of the pot was 420 kcal', 'energyKcal', '420', '420 kcal', 420],
      ['Heated it in a pan. Omelette, 320 kcal', 'energyKcal', '320', '320 kcal', 320],
      ['The pot was hot. Soup, 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      // A whole-quantified vessel with no figure related to it (2026-11-17 correction).
      ['Washed the whole pan, then soup 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['Rice from the saucepan, protein 4.5 g', 'proteinG', '4.5', 'protein 4.5 g', 4.5],
      ['Суп из кастрюли, 300 ккал', 'energyKcal', '300', '300 ккал', 300],
      ['Курица, жаренная на сковороде, 400 ккал', 'energyKcal', '400', '400 ккал', 400],
      ['Тушила в кастрюле 40 минут. Рагу, 450 ккал', 'energyKcal', '450', '450 ккал', 450],
      ['Гречка из кастрюльки, белки 12,5 г', 'proteinG', '12,5', 'белки 12,5 г', 12.5],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(proposed(expected, evidence));
    }
  });

  it('keeps the earlier container list unchanged ("package", "пачка": still context)', () => {
    expect(ground('Cookies, the package has 240 kcal', 'energyKcal', '240', '240 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Печенье, в пачке 500 ккал', 'energyKcal', '500', '500 ккал')).toEqual(withheld('per_portion'));
  });
});

describe('a grounded container text still fits the public response contract', () => {
  it('builds a valid draft: the container figure withheld, the consumed totals proposed', () => {
    const text = 'Chili from the pot. The whole pot is 900 kcal. In total I ate 300 kcal, protein 0 g, fat 2.50 g.';
    const answer: MealDraftWireDraft = {
      carbohydrateG: notStated,
      energyKcal: claim('900', '900 kcal'),
      fatG: claim('2.5', 'fat 2.50 g'),
      mealType: null,
      mealTypeEvidence: null,
      outcome: 'draft',
      proteinG: claim('0', 'protein 0 g'),
      title: 'Chili from the pot',
    };
    expect(mealDraftWireSchema.safeParse(answer).success).toBe(true);
    const { proposal } = groundMealDraft(text, answer);
    expect(proposal).toMatchObject({
      nutrition: {
        carbohydrateG: { status: 'not_stated' },
        energyKcal: { reason: 'per_portion', status: 'withheld' },
        fatG: { excerpt: 'fat 2.50 g', status: 'proposed', value: 2.5 },
        proteinG: { excerpt: 'protein 0 g', status: 'proposed', value: 0 },
      },
      title: 'Chili from the pot',
    });
    expect(mealDraftProposalResponseSchema.safeParse({ ...proposal, localDate: '2026-11-16', timeZone: 'Europe/Warsaw', version: 'meal-draft-1' }).success).toBe(true);

    const russian = 'Суп из кастрюли; вся кастрюля 900 ккал';
    const russianAnswer: MealDraftWireDraft = { ...answer, energyKcal: claim('900', '900 ккал'), fatG: notStated, proteinG: notStated, title: 'Суп из кастрюли' };
    expect(mealDraftWireSchema.safeParse(russianAnswer).success).toBe(true);
    const grounded = groundMealDraft(russian, russianAnswer).proposal;
    expect(grounded).toMatchObject({ nutrition: { energyKcal: { reason: 'per_portion', status: 'withheld' } } });
    expect(mealDraftProposalResponseSchema.safeParse({ ...grounded, localDate: '2026-11-16', timeZone: 'Europe/Warsaw', version: 'meal-draft-1' }).success).toBe(true);
  });
});
