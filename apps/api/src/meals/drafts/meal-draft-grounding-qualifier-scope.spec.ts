import { mealDraftProposalResponseSchema, type MealNutritionField } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { groundMealDraft, groundNutrient } from './meal-draft-grounding.js';
import type { MealDraftWireDraft, NutrientClaim } from './meal-draft-wire.js';

// Regressions for the qualifier defects ADR-0092 listed as not established after its third correction (fourth
// correction, 2026-11-15):
//   E. a line break hid a bound ("Pasta, up to\n600 kcal", "at least\n600 kcal", "более\n600 ккал");
//   F. a line break hid a negation ("Salad, not\n400 kcal");
//   G. a Russian "до" without a lower endpoint was not a bound ("Суп, до 600 ккал");
//   H. range wording outside "to/or/до/или" was not recognised ("between 500 and 600 kcal", "от 500 и до 600 ккал").
// Every claim below is schema-valid and UNSAFE unless marked as a positive control. Nothing here calls a model.

const claim = (value: string, evidence: string): NutrientClaim => ({ abstain: null, evidence, value });
const ground = (text: string, field: MealNutritionField, value: string, evidence: string) => groundNutrient(text, field, claim(value, evidence)).result;
const withheld = (reason: string) => ({ reason, status: 'withheld' });
const proposed = (value: number, excerpt: string) => ({ excerpt, status: 'proposed', value });

const NBSP = String.fromCodePoint(0xa0);
const NNBSP = String.fromCodePoint(0x202f);
// The whitespace a line-broken qualifier may hide behind: line feed, CRLF, a tab before the break, several breaks, and
// the supported no-break spaces around a break.
const BREAKS = ['\n', '\r\n', '\t\n', '\n\n', ` ${NBSP}\n${NNBSP}`];

describe('defect E: a bound separated from its number by a line break', () => {
  it('withholds the three documented reproductions, with the shortest or a longer excerpt', () => {
    expect(ground('Pasta, up to\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, up to\n600 kcal', 'energyKcal', '600', 'up to\n600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, at least\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, at least\n600 kcal', 'energyKcal', '600', 'Pasta, at least\n600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, более\n600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, более\n600 ккал', 'energyKcal', '600', 'более\n600 ккал')).toEqual(withheld('ambiguous'));
  });

  it.each(BREAKS.map((gap) => [JSON.stringify(gap), gap]))('withholds bounds across %s', (_name, gap) => {
    const cases: Array<[string, MealNutritionField, string, string]> = [
      [`Pasta, up to${gap}600 kcal`, 'energyKcal', '600', '600 kcal'],
      [`Pasta, at most${gap}600 kcal`, 'energyKcal', '600', '600 kcal'],
      [`Pasta, less than${gap}600 kcal`, 'energyKcal', '600', '600 kcal'],
      [`Pasta, no more than${gap}600 kcal`, 'energyKcal', '600', '600 kcal'],
      [`Pasta, over${gap}600 kcal`, 'energyKcal', '600', '600 kcal'],
      [`Pasta, <${gap}600 kcal`, 'energyKcal', '600', '600 kcal'],
      [`Паста, не более${gap}600 ккал`, 'energyKcal', '600', '600 ккал'],
      [`Паста, свыше${gap}600 ккал`, 'energyKcal', '600', '600 ккал'],
      [`Паста, максимум${gap}600 ккал`, 'energyKcal', '600', '600 ккал'],
      [`Shake, up to${gap}30 g protein`, 'proteinG', '30', '30 g protein'],
      [`Shake, at least${gap}protein 30 g`, 'proteinG', '30', 'protein 30 g'],
      [`Коктейль, не менее${gap}белка 30 г`, 'proteinG', '30', 'белка 30 г'],
      [`Каша, минимум${gap}углеводы 40 г`, 'carbohydrateG', '40', 'углеводы 40 г'],
      [`Bread, more than${gap}40 g of carbs`, 'carbohydrateG', '40', '40 g of carbs'],
      [`Soup, under${gap}fat 5 g`, 'fatG', '5', 'fat 5 g'],
      [`Суп, меньше${gap}5 г жира`, 'fatG', '5', '5 г жира'],
    ];
    for (const [text, field, value, evidence] of cases) expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('ambiguous'));
  });

  it('withholds a bound phrase whose own words are split by a line break or a no-break space', () => {
    expect(ground('Pasta, up\nto 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, at\nleast 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground(`Pasta, at${NBSP}least 600 kcal`, 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, не\nболее 600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
  });

  it('withholds "a maximum of", comparatives and "выше"/"ниже" across a line break', () => {
    expect(ground('Pasta, a maximum of\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, minimum of 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, greater than\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Shake, higher than\n30 g protein', 'proteinG', '30', '30 g protein')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, не выше\n600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, ниже\n5 г жира', 'fatG', '5', '5 г жира')).toEqual(withheld('ambiguous'));
  });

  it('withholds a bound left dangling at the end of a line before the value', () => {
    expect(ground('Pasta, up to\ntotal 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, более\nвсего 600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Shake, at least\nabout\n30 g protein', 'proteinG', '30', '30 g protein')).toEqual(withheld('ambiguous'));
  });

  it('withholds a bound written after the value, on its line or the next', () => {
    expect(ground('Pasta, 600 kcal\nat most', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, 600 kcal or more', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, 600 kcal max', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, 600 ккал\nмаксимум', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, 600 ккал или больше', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Shake, protein 30 g\nat least', 'proteinG', '30', 'protein 30 g')).toEqual(withheld('ambiguous'));
    expect(ground('Shake, 30 g of protein or less', 'proteinG', '30', '30 g of protein')).toEqual(withheld('ambiguous'));
  });

  it('withholds bounded zero and exact decimals; never substitutes a bound for a value', () => {
    expect(ground('Tea, less than\n0.5 g fat', 'fatG', '0.5', '0.5 g fat')).toEqual(withheld('ambiguous'));
    expect(ground('Tea, up to\n0 kcal', 'energyKcal', '0', '0 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Чай, до\n12,50 г углеводов', 'carbohydrateG', '12,5', '12,50 г углеводов')).toEqual(withheld('ambiguous'));
  });
});

describe('defect F: a negation separated from its number by a line break', () => {
  it('withholds the documented reproduction, with the shortest or a longer excerpt', () => {
    expect(ground('Salad, not\n400 kcal', 'energyKcal', '400', '400 kcal')).toEqual(withheld('negated'));
    expect(ground('Salad, not\n400 kcal', 'energyKcal', '400', 'not\n400 kcal')).toEqual(withheld('negated'));
    expect(ground('Salad, not\n400 kcal', 'energyKcal', '400', 'Salad, not\n400 kcal')).toEqual(withheld('negated'));
  });

  it.each(BREAKS.map((gap) => [JSON.stringify(gap), gap]))('withholds negations across %s', (_name, gap) => {
    const cases: Array<[string, MealNutritionField, string, string]> = [
      [`Salad, not${gap}400 kcal`, 'energyKcal', '400', '400 kcal'],
      [`Salad, isn't${gap}400 kcal`, 'energyKcal', '400', '400 kcal'],
      [`Салат, не${gap}400 ккал`, 'energyKcal', '400', '400 ккал'],
      [`Salad, not${gap}protein 20 g`, 'proteinG', '20', 'protein 20 g'],
      [`Soup, without${gap}5 g fat`, 'fatG', '5', '5 g fat'],
      [`Суп, без${gap}5 г жира`, 'fatG', '5', '5 г жира'],
      [`Каша, нет${gap}углеводов 30 г`, 'carbohydrateG', '30', 'углеводов 30 г'],
    ];
    for (const [text, field, value, evidence] of cases) expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('negated'));
  });

  it('withholds a negation left dangling at the end of a line before the value, including zero and decimals', () => {
    expect(ground('Salad, not\neven 400 kcal', 'energyKcal', '400', '400 kcal')).toEqual(withheld('negated'));
    expect(ground('Tea, not\n0 kcal', 'energyKcal', '0', '0 kcal')).toEqual(withheld('negated'));
    expect(ground('Чай, не\r\n0,5 г жира', 'fatG', '0,5', '0,5 г жира')).toEqual(withheld('negated'));
  });
});

describe('defect G: a Russian "до" alone is a bound', () => {
  it('withholds the documented reproduction and its variants', () => {
    expect(ground('Суп, до 600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, до 600 ккал', 'energyKcal', '600', 'до 600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Суп до\n600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, до 20 г белка', 'proteinG', '20', '20 г белка')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, до\nжиры 7,5 г', 'fatG', '7,5', 'жиры 7,5 г')).toEqual(withheld('ambiguous'));
  });

  it('withholds an open lower bound: "от" or "from" alone', () => {
    expect(ground('Суп, от 600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, from\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
  });
});

describe('defect H: "between … and …" and "от … (и) до …" are ranges, from either endpoint', () => {
  it('withholds the two documented reproductions', () => {
    expect(ground('Pasta, between 500 and 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, от 500 и до 600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
  });

  it('withholds either endpoint when each forms a nutrient statement of its own', () => {
    for (const [text, value, evidence] of [
      ['Pasta, between 500 kcal and 600 kcal', '500', '500 kcal'],
      ['Pasta, between 500 kcal and 600 kcal', '600', '600 kcal'],
      ['Паста, от 500 ккал и до 600 ккал', '500', '500 ккал'],
      ['Паста, от 500 ккал и до 600 ккал', '600', '600 ккал'],
      ['Паста, между 500 и 600 ккал', '600', '600 ккал'],
      ['Паста, между 500 ккал и 600 ккал', '500', '500 ккал'],
    ] as const) {
      expect(ground(text, 'energyKcal', value, evidence), text).toEqual(withheld('ambiguous'));
    }
    expect(ground('Shake, between 20 and 25 g protein', 'proteinG', '25', '25 g protein')).toEqual(withheld('ambiguous'));
    expect(ground('Shake, between 20 g protein and 25 g protein', 'proteinG', '20', '20 g protein')).toEqual(withheld('ambiguous'));
    expect(ground('Коктейль, от 20 г белка и до 25 г белка', 'proteinG', '20', '20 г белка')).toEqual(withheld('ambiguous'));
    expect(ground('Коктейль, от 20 г белка и до 25 г белка', 'proteinG', '25', '25 г белка')).toEqual(withheld('ambiguous'));
  });

  it('withholds the range across line breaks and with decimal points, decimal commas and zero', () => {
    expect(ground('Pasta, between\n500 and\n600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Pasta, between 500\r\nand 600 kcal', 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Паста, от 500\nи до\n600 ккал', 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Oil, between 5.5 and 6.5 g fat', 'fatG', '6.5', '6.5 g fat')).toEqual(withheld('ambiguous'));
    expect(ground('Масло, от 5,5 и до 6,5 г жира', 'fatG', '6,5', '6,5 г жира')).toEqual(withheld('ambiguous'));
    expect(ground('Tea, between 0 and 2 g carbs', 'carbohydrateG', '2', '2 g carbs')).toEqual(withheld('ambiguous'));
    expect(ground('Tea, between 0 g carbs and 2 g carbs', 'carbohydrateG', '0', '0 g carbs')).toEqual(withheld('ambiguous'));
  });

  it('keeps mixed-unit ranges withheld with the new wording too', () => {
    expect(ground('Soup, between 500 kcal and 2500 kJ', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, between 2500 kJ and 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, от 6000 мг и до 5 г жира', 'fatG', '5', '5 г жира')).toEqual(withheld('ambiguous'));
  });
});

// Correction of this amendment (2026-11-15): a bound at the start of a line that introduces the NEXT nutrient statement
// was read as a postfix bound on the previous one, so "Soup, 500 kcal\nat least 20 g protein" withheld the exact 500.
describe('a bound that introduces the next nutrient statement qualifies that statement, not the previous one', () => {
  const GAPS = ['\n', '\r\n', '\t\n', ` ${NBSP}\n${NNBSP}`, '\n\n'];

  it('reproduces both confirmed cases: the independent exact field is proposed, the qualified one withheld', () => {
    const forward = 'Soup, 500 kcal\nat least 20 g protein';
    expect(ground(forward, 'energyKcal', '500', '500 kcal')).toEqual(proposed(500, '500 kcal'));
    expect(ground(forward, 'energyKcal', '500', 'Soup, 500 kcal')).toEqual(proposed(500, 'Soup, 500 kcal'));
    expect(ground(forward, 'proteinG', '20', '20 g protein')).toEqual(withheld('ambiguous'));
    expect(ground(forward, 'proteinG', '20', 'at least 20 g protein')).toEqual(withheld('ambiguous'));
    const reverse = 'Soup, protein 20 g\nat most 600 kcal';
    expect(ground(reverse, 'proteinG', '20', 'protein 20 g')).toEqual(proposed(20, 'protein 20 g'));
    expect(ground(reverse, 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground(reverse, 'energyKcal', '600', 'at most 600 kcal')).toEqual(withheld('ambiguous'));
  });

  it.each(GAPS.map((gap) => [JSON.stringify(gap), gap]))('associates the bound with the following statement across %s, in both field orders', (_name, gap) => {
    const cases: Array<[string, [MealNutritionField, string, string, number], [MealNutritionField, string, string]]> = [
      [`Soup, 500 kcal${gap}at least 20 g protein`, ['energyKcal', '500', '500 kcal', 500], ['proteinG', '20', '20 g protein']],
      [`Soup, 500 kcal${gap}at least protein 20 g`, ['energyKcal', '500', '500 kcal', 500], ['proteinG', '20', 'protein 20 g']],
      [`Soup, 500 kcal${gap}at least 20 g of protein`, ['energyKcal', '500', '500 kcal', 500], ['proteinG', '20', '20 g of protein']],
      [`Soup, protein 20 g${gap}at most 600 kcal`, ['proteinG', '20', 'protein 20 g', 20], ['energyKcal', '600', '600 kcal']],
      [`Soup, 20 g protein${gap}maximum of 600 kcal`, ['proteinG', '20', '20 g protein', 20], ['energyKcal', '600', '600 kcal']],
      [`Shake, fat 3 g${gap}max 30 g carbs`, ['fatG', '3', 'fat 3 g', 3], ['carbohydrateG', '30', '30 g carbs']],
      [`Суп, 500 ккал${gap}не менее 20 г белка`, ['energyKcal', '500', '500 ккал', 500], ['proteinG', '20', '20 г белка']],
      [`Суп, белки 20 г${gap}максимум 600 ккал`, ['proteinG', '20', 'белки 20 г', 20], ['energyKcal', '600', '600 ккал']],
      [`Каша, 20 г белка${gap}минимум углеводы 40 г`, ['proteinG', '20', '20 г белка', 20], ['carbohydrateG', '40', 'углеводы 40 г']],
      [`Чай, 0 ккал${gap}не более 0,5 г жира`, ['energyKcal', '0', '0 ккал', 0], ['fatG', '0,5', '0,5 г жира']],
      [`Oil, fat 13.50 g${gap}at most 120 kcal`, ['fatG', '13.5', 'fat 13.50 g', 13.5], ['energyKcal', '120', '120 kcal']],
    ];
    for (const [text, [exactField, exactValue, exactEvidence, exactNumber], [boundField, boundValue, boundEvidence]] of cases) {
      expect(ground(text, exactField, exactValue, exactEvidence), JSON.stringify(text)).toEqual(proposed(exactNumber, exactEvidence));
      expect(ground(text, boundField, boundValue, boundEvidence), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    }
  });

  it('associates a bound whose own words are split across whitespace with the following statement', () => {
    for (const text of ['Soup, 500 kcal\nat\nleast 20 g protein', `Soup, 500 kcal\nat${NBSP}least 20 g protein`, `Soup, 500 kcal\r\nat\r\nleast${NBSP}20 g protein`]) {
      expect(ground(text, 'energyKcal', '500', '500 kcal'), JSON.stringify(text)).toEqual(proposed(500, '500 kcal'));
      expect(ground(text, 'proteinG', '20', '20 g protein'), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    }
    const russian = 'Суп, белки 20 г\nне\nболее 600 ккал';
    expect(ground(russian, 'proteinG', '20', 'белки 20 г')).toEqual(proposed(20, 'белки 20 г'));
    expect(ground(russian, 'energyKcal', '600', '600 ккал')).toEqual(withheld('ambiguous'));
  });

  it('keeps genuine postfix bounds withheld (negative controls)', () => {
    expect(ground('Soup, 500 kcal at most', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, 500 kcal\nat most', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Shake, protein 20 g\nat least', 'proteinG', '20', 'protein 20 g')).toEqual(withheld('ambiguous'));
    expect(ground('Shake, protein 20 g\r\nat least.', 'proteinG', '20', 'protein 20 g')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, 500 ккал\nмаксимум', 'energyKcal', '500', '500 ккал')).toEqual(withheld('ambiguous'));
  });

  it('keeps the previous value withheld when what follows the bound is not an independent nutrient statement', () => {
    for (const text of [
      'Soup, 500 kcal\nat least 2 cups', // an unsupported unit
      'Soup, 500 kcal\nat most 600', // no unit
      'Soup, 500 kcal\nat least 20 g', // grams without a nutrient: a food quantity
      'Soup, 500 kcal\nat most 2500 kJ', // another unit, not a statement of a field
      'Soup, 500 kcal\nat least -20 g protein', // a sign between the bound and the statement
      'Soup, 500 kcal\nat least 20 to 25 g protein', // the following number opens a range
      'Soup, 500 kcal\nat least, 20 g protein', // punctuation between the bound and the statement
      'Soup, 500 kcal\nat least the 20 g protein', // a word between the bound and the statement
    ]) {
      expect(ground(text, 'energyKcal', '500', '500 kcal'), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    }
  });

  it('withholds both values when a bound stands alone on its line between two statements (unresolved)', () => {
    for (const [text, first, second] of [
      ['Soup, 600 kcal\nat most\n20 g protein', ['energyKcal', '600', '600 kcal'], ['proteinG', '20', '20 g protein']],
      ['Soup, protein 20 g\r\nat least\r\n600 kcal', ['proteinG', '20', 'protein 20 g'], ['energyKcal', '600', '600 kcal']],
      ['Суп, 600 ккал\nне более\nбелка 20 г', ['energyKcal', '600', '600 ккал'], ['proteinG', '20', 'белка 20 г']],
    ] as const) {
      expect(ground(text, first[0], first[1], first[2]), JSON.stringify(text)).toEqual(withheld('ambiguous'));
      expect(ground(text, second[0], second[1], second[2]), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    }
  });

  it('keeps postfix-only bounds on the previous value even when a statement follows (unresolved)', () => {
    expect(ground('Soup, 500 kcal\nor more 20 g protein', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, 500 kcal\nand up 20 g protein', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, 500 ккал\nили больше 20 г белка', 'energyKcal', '500', '500 ккал')).toEqual(withheld('ambiguous'));
    expect(ground('Суп, 500 ккал\nи более 20 г белка', 'energyKcal', '500', '500 ккал')).toEqual(withheld('ambiguous'));
  });

  it('keeps the same-line clause rule, same-field conflicts and negation unchanged', () => {
    // Without a line break or punctuation the bound shares the clause of both values, as before this amendment.
    expect(ground('Soup, 500 kcal at least 20 g protein', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    // Two energy values: the bounded one is withheld, the exact one conflicts with it rather than being chosen.
    const sameField = 'Soup, 500 kcal\nat most 600 kcal';
    expect(ground(sameField, 'energyKcal', '500', '500 kcal')).toEqual(withheld('conflicting'));
    expect(ground(sameField, 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    const negated = 'Soup, 500 kcal\nnot 20 g protein';
    expect(ground(negated, 'energyKcal', '500', '500 kcal')).toEqual(proposed(500, '500 kcal'));
    expect(ground(negated, 'proteinG', '20', '20 g protein')).toEqual(withheld('negated'));
  });
});

describe('qualifier scope stays bound to its own numeric statement (positive controls)', () => {
  it('keeps unrelated negation', () => {
    expect(ground('No sauce, 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(proposed(500, '500 kcal'));
    expect(ground('I did not add sugar. Soup, 500 kcal.', 'energyKcal', '500', '500 kcal')).toEqual(proposed(500, '500 kcal'));
    expect(ground('No sauce\n500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(proposed(500, '500 kcal'));
    expect(ground('Salad, not spicy\n400 kcal', 'energyKcal', '400', '400 kcal')).toEqual(proposed(400, '400 kcal'));
    expect(ground('Суп без соли, 300 ккал, белки 12 г', 'proteinG', '12', 'белки 12 г')).toEqual(proposed(12, 'белки 12 г'));
  });

  it('keeps an independent exact field beside a qualified value', () => {
    const text = 'Soup, up to\n600 kcal; protein 20 g.';
    expect(ground(text, 'energyKcal', '600', '600 kcal')).toEqual(withheld('ambiguous'));
    expect(ground(text, 'proteinG', '20', 'protein 20 g')).toEqual(proposed(20, 'protein 20 g'));
    const negated = 'Salad, not\n400 kcal\nprotein 20 g\nfat 0 g';
    expect(ground(negated, 'energyKcal', '400', '400 kcal')).toEqual(withheld('negated'));
    expect(ground(negated, 'proteinG', '20', 'protein 20 g')).toEqual(proposed(20, 'protein 20 g'));
    expect(ground(negated, 'fatG', '0', 'fat 0 g')).toEqual(proposed(0, 'fat 0 g'));
    const range = 'Паста, от 500 и до 600 ккал, белки 12,5 г';
    expect(ground(range, 'proteinG', '12,5', 'белки 12,5 г')).toEqual(proposed(12.5, 'белки 12,5 г'));
  });

  it('keeps the same words when they do not qualify a number', () => {
    expect(ground('Перекус до обеда, 200 ккал', 'energyKcal', '200', '200 ккал')).toEqual(proposed(200, '200 ккал'));
    expect(ground('Перекус до обеда 200 ккал', 'energyKcal', '200', '200 ккал')).toEqual(proposed(200, '200 ккал'));
    expect(ground('Between meals I had soup, 300 kcal', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Soup from the market\n300 kcal', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Суп от бабушки, 300 ккал', 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
    expect(ground('Dinner: chicken and rice, total 650 kcal, protein 40 g', 'energyKcal', '650', '650 kcal')).toEqual(proposed(650, '650 kcal'));
  });

  it('keeps exact zero, decimals, trailing zeros and the earlier sign, precision and bounds fixes', () => {
    expect(ground('Tea\n0 kcal\nfat 0,50 g', 'fatG', '0,5', 'fat 0,50 g')).toEqual(proposed(0.5, 'fat 0,50 g'));
    expect(ground('Tea\n0 kcal\nfat 0,50 g', 'energyKcal', '0', '0 kcal')).toEqual(proposed(0, '0 kcal'));
    expect(ground('Soup, - 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup,\n-500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Soup\nprotein 12.5000000000000001 g', 'proteinG', '12.5', 'protein 12.5000000000000001 g')).toEqual(withheld('unverified'));
    expect(ground('Feast\n20000.05 kcal', 'energyKcal', '20000.05', '20000.05 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Feast\n20000 kcal', 'energyKcal', '20000', '20000 kcal')).toEqual(proposed(20000, '20000 kcal'));
  });

  it('keeps counting a qualified mention as a stated value for conflict detection', () => {
    // Unchanged by this correction: a bounded, ranged or negated mention of the nutrient is still a value the text
    // states, so an exact value beside it conflicts rather than being chosen quietly.
    expect(ground('Pasta, up to\n600 kcal, 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('conflicting'));
    expect(ground('Salad, not\n400 kcal; 450 kcal', 'energyKcal', '450', '450 kcal')).toEqual(withheld('conflicting'));
  });
});

describe('a grounded answer with the fourth correction still fits the public response contract', () => {
  it('builds a valid draft: bounded, negated and ranged values withheld, the independent exact values proposed', () => {
    const text = 'Dinner: pasta, up to\n600 kcal; not\n30 g protein; between 70 and\n80 g carbs; fat 0 g.';
    const answer: MealDraftWireDraft = {
      carbohydrateG: claim('80', '80 g carbs'),
      energyKcal: claim('600', '600 kcal'),
      fatG: claim('0', 'fat 0 g'),
      mealType: 'dinner',
      mealTypeEvidence: 'Dinner',
      outcome: 'draft',
      proteinG: claim('30', '30 g protein'),
      title: 'pasta',
    };
    const { proposal } = groundMealDraft(text, answer);
    expect(proposal).toMatchObject({
      nutrition: {
        carbohydrateG: { reason: 'ambiguous', status: 'withheld' },
        energyKcal: { reason: 'ambiguous', status: 'withheld' },
        fatG: { status: 'proposed', value: 0 },
        proteinG: { reason: 'negated', status: 'withheld' },
      },
    });
    expect(mealDraftProposalResponseSchema.safeParse({ ...proposal, localDate: '2026-11-15', timeZone: 'Europe/Warsaw', version: 'meal-draft-1' }).success).toBe(true);
  });
});
