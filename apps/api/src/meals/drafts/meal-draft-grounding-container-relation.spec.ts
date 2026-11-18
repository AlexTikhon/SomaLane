import type { MealNutritionField } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { groundNutrient } from './meal-draft-grounding.js';
import type { NutrientClaim } from './meal-draft-wire.js';

// Whole-vessel context needs a supported relationship to a nutrition statement (ADR-0092, container-relation correction,
// 2026-11-17). Amendment 6 made a bare whole-quantified vessel ("the whole pan", "a full pot", "вся сковорода") container
// context ANYWHERE in the text, with no figure of its own. Because that one classification decides both acceptance and
// conflict detection, unrelated cooking or cleaning words withheld a plain value ("Cooked soup in a full pot. Lunch,
// 300 kcal.") and, worse, hid a second whole-entry value from the conflict scan ("I washed the whole pan. Soup, 400
// kcal. In total I ate 300 kcal." proposed 300). A whole-quantified vessel is now context only in a supported
// construction: as the subject of a figure ("the whole pot is 900 kcal"), set beside a figure in the same clause ("whole
// pot, fat 45.5 g", "вся кастрюля 900 ккал"; across a line only after an explicit ":" "=" or dash), or after a figure
// that it qualifies ("900 kcal for the whole pot", "900 ккал на всю кастрюлю"). Nothing here calls a model.

const claim = (value: string, evidence: string): NutrientClaim => ({ abstain: null, evidence, value });
const ground = (text: string, field: MealNutritionField, value: string, evidence: string) => groundNutrient(text, field, claim(value, evidence)).result;
const withheld = (reason: string) => ({ reason, status: 'withheld' });
const proposed = (value: number, excerpt: string) => ({ excerpt, status: 'proposed', value });

describe('the confirmed reproductions', () => {
  it('1. proposes a value beside a cooking reference that states no container figure', () => {
    expect(ground('Cooked soup in a full pot. Lunch, 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
  });

  it('2. keeps a conflicting whole-entry value visible when unrelated cleaning context is added', () => {
    expect(ground('I washed the whole pan. Soup, 400 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('conflicting'));
  });

  it('3. still withholds the same conflict without any vessel context (unchanged)', () => {
    expect(ground('Soup, 400 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('conflicting'));
  });

  it('the Russian equivalents behave the same', () => {
    expect(ground('Сварила суп в полной кастрюле. Обед, 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
    expect(ground('Помыла всю сковороду. Суп, 400 ккал. Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(withheld('conflicting'));
    expect(ground('Суп, 400 ккал. Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(withheld('conflicting'));
  });
});

describe('unrelated whole-vessel context is not container context', () => {
  it('proposes values with unrelated context before them, across sentences, punctuation and line breaks', () => {
    for (const [text, field, value, evidence, expected] of [
      ['Washed the whole pan, then soup 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['I washed the whole pan. Soup, 300 kcal.', 'energyKcal', '300', '300 kcal', 300],
      ['I washed the whole pan.\nSoup, 300 kcal.', 'energyKcal', '300', '300 kcal', 300],
      ['I washed the whole pan\nSoup, 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['I washed the whole pan\r\n\r\nSoup – 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['Scrubbed the entire skillet; omelette, protein 18 g', 'proteinG', '18', 'protein 18 g', 18],
      ['Made a full pot of tea! Toast, carbs 30,5 g', 'carbohydrateG', '30,5', 'carbs 30,5 g', 30.5],
      ['Cooked in a full pot. Salad, fat 0 g', 'fatG', '0', 'fat 0 g', 0],
      ['Ate all of the pot of rice yesterday. Soup, 300 kcal', 'energyKcal', '300', '300 kcal', 300],
      ['Помыла всю сковороду. Суп, 300 ккал.', 'energyKcal', '300', '300 ккал', 300],
      ['Помыла всю сковороду\nСуп, 300 ккал', 'energyKcal', '300', '300 ккал', 300],
      ['Сварила суп в полной кастрюле; обед, белки 25 г', 'proteinG', '25', 'белки 25 г', 25],
      ['Отмыла казан целиком. Плов, жиры 12,5 г', 'fatG', '12,5', 'жиры 12,5 г', 12.5],
      ['Вымыла всю кастрюлю. Каша, углеводы 0 г', 'carbohydrateG', '0', 'углеводы 0 г', 0],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(proposed(expected, evidence));
    }
  });

  it('proposes values with unrelated context after them, across sentences, punctuation and line breaks', () => {
    for (const [text, field, value, evidence, expected] of [
      ['Soup, 300 kcal. Then I washed the whole pot.', 'energyKcal', '300', '300 kcal', 300],
      ['Soup, 300 kcal, then I washed the whole pot', 'energyKcal', '300', '300 kcal', 300],
      ['Soup, 300 kcal\nWhole pot washed afterwards', 'energyKcal', '300', '300 kcal', 300],
      ['Soup, protein 20 g.\n\nThe entire pan went into the dishwasher.', 'proteinG', '20', 'protein 20 g', 20],
      ['Суп, 300 ккал. Потом помыла всю кастрюлю.', 'energyKcal', '300', '300 ккал', 300],
      ['Суп, 300 ккал\nВсю кастрюлю помыла потом', 'energyKcal', '300', '300 ккал', 300],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(proposed(expected, evidence));
    }
  });

  it('keeps every same-field conflict visible whatever unrelated context is added, for energy and macronutrients', () => {
    for (const [text, field, value, evidence] of [
      ['I washed the whole pan. Soup, 400 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal'],
      ['I washed the whole pan. Soup, 400 kcal. In total I ate 300 kcal.', 'energyKcal', '400', '400 kcal'],
      ['Soup, 400 kcal. In total I ate 300 kcal. Then I washed the whole pan.', 'energyKcal', '300', '300 kcal'],
      ['Cooked in a full pot.\nSoup, 400 kcal.\nIn total I ate 300 kcal.', 'energyKcal', '300', '300 kcal'],
      ['Washed the whole pan. Protein 25 g. In total I ate protein 20 g.', 'proteinG', '20', 'protein 20 g'],
      ['Washed the whole pan; soup, fat 4 g, later fat 5 g', 'fatG', '4', 'fat 4 g'],
      ['Помыла всю сковороду. Суп, 400 ккал. Итого съела 300 ккал.', 'energyKcal', '400', '400 ккал'],
      ['Сварила в полной кастрюле. Белки 25 г. Итого съела белки 20 г.', 'proteinG', '20', 'белки 20 г'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
    }
  });

  it('keeps bounds, negations, ranges and per-portion qualifiers beside unrelated vessel context', () => {
    expect(ground('Washed the whole pot. Soup, up to 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Washed the whole pot. Soup, 300 kcal - 400 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Washed the whole pot. Soup 300 kcal or 400 kcal', 'energyKcal', '300', '300 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Washed the whole pot. Soup, not 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('negated'));
    expect(ground('Washed the whole pot. Soup, 300 kcal per serving.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Помыла всю кастрюлю. Суп, не 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(withheld('negated'));
    expect(ground('Помыла всю кастрюлю. Суп, до 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(withheld('ambiguous'));
  });

  it('keeps the consumption binding rule beside unrelated vessel context and a per-portion qualifier', () => {
    const text = 'Washed the whole pot. Soup 300 kcal per bowl. In total I ate 600 kcal.';
    expect(ground(text, 'energyKcal', '600', '600 kcal')).toEqual(proposed(600, '600 kcal'));
    expect(ground(text, 'energyKcal', '300', '300 kcal')).toEqual(withheld('per_portion'));
    // A summing phrase without the consumption verb still proves nothing.
    expect(ground('Washed the whole pot. Soup 300 kcal per bowl. In total 600 kcal.', 'energyKcal', '600', '600 kcal')).toEqual(withheld('per_portion'));
  });
});

describe('supported whole-vessel constructions stay container context (paired negative controls)', () => {
  it('a whole-quantified vessel as the subject of a figure', () => {
    for (const [text, field, value, evidence] of [
      ['The whole pot has 900 kcal.', 'energyKcal', '900', '900 kcal'],
      ['Cooked soup. The full pot is 300 kcal.', 'energyKcal', '300', '300 kcal'],
      ['The entire pot of chili contains protein 80 g', 'proteinG', '80', 'protein 80 g'],
      ['All of the pot was\n900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Вся кастрюля содержит 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Целая кастрюля — это 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Вся сковорода была 1200 ккал', 'energyKcal', '1200', '1200 ккал'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });

  it('a whole-quantified vessel beside a figure in the same clause, or across a line after an explicit separator', () => {
    for (const [text, field, value, evidence] of [
      ['Lunch: a full pot, 300 kcal', 'energyKcal', '300', '300 kcal'],
      ['Whole pot: 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Whole pot:\n900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Whole pot –\nprotein 80 g', 'proteinG', '80', 'protein 80 g'],
      ['A full pot of soup, 900 kcal', 'energyKcal', '900', '900 kcal'],
      ['Whole pan 800 kcal', 'energyKcal', '800', '800 kcal'],
      ['Полная кастрюля супа, 900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Вся кастрюля:\n900 ккал', 'energyKcal', '900', '900 ккал'],
      ['Казан целиком — жиры 120 г', 'fatG', '120', 'жиры 120 г'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });

  it('a figure followed by the whole-quantified vessel it qualifies (the value precedes the vessel)', () => {
    for (const [text, field, value, evidence] of [
      ['Chili. 900 kcal for the whole pot', 'energyKcal', '900', '900 kcal'],
      ['Chili, 900 kcal in the entire pot', 'energyKcal', '900', '900 kcal'],
      ['Chili: protein 80 g, the whole pot', 'proteinG', '80', 'protein 80 g'],
      ['Soup 300 kcal – a full pot', 'energyKcal', '300', '300 kcal'],
      ['Chili, 900 kcal for all of the pot', 'energyKcal', '900', '900 kcal'],
      ['Борщ, 900 ккал на всю кастрюлю', 'energyKcal', '900', '900 ккал'],
      ['Борщ, 900 ккал во всей кастрюле', 'energyKcal', '900', '900 ккал'],
      ['Плов: белки 80 г, весь казан', 'proteinG', '80', 'белки 80 г'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });

  it('pairs each related form with an unrelated one that differs only in the relationship', () => {
    for (const [related, unrelated, value, evidence] of [
      ['Lunch: a full pot, 300 kcal', 'Lunch in a full pot. Soup, 300 kcal', '300', '300 kcal'],
      ['The whole pan is 400 kcal', 'The whole pan is clean. Soup, 400 kcal', '400', '400 kcal'],
      ['Soup, 300 kcal for the whole pot', 'Soup, 300 kcal. For the whole pot I used a lid', '300', '300 kcal'],
      ['Вся сковорода 400 ккал', 'Вся сковорода чистая. Суп, 400 ккал', '400', '400 ккал'],
      ['Суп, 300 ккал на всю кастрюлю', 'Суп, 300 ккал. На всю кастрюлю ушла крышка', '300', '300 ккал'],
    ] as const) {
      expect(ground(related, 'energyKcal', value, evidence), JSON.stringify(related)).toEqual(withheld('per_portion'));
      expect(ground(unrelated, 'energyKcal', value, evidence), JSON.stringify(unrelated)).toEqual(proposed(Number(value), evidence));
    }
  });

  it('keeps a genuine container figure in force for the other values, and the consumed total proposed', () => {
    const text = 'The whole pot has 900 kcal. In total I ate 300 kcal.';
    expect(ground(text, 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground(text, 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('The whole pot has 900 kcal. Protein 20 g.', 'proteinG', '20', 'Protein 20 g')).toEqual(withheld('per_portion'));
    expect(ground('Вся кастрюля 900 ккал. Белки 20 г.', 'proteinG', '20', 'Белки 20 г')).toEqual(withheld('per_portion'));
  });

  it('keeps food names and cooking references proposed', () => {
    expect(ground('Pot roast, 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(proposed(500, '500 kcal'));
    expect(ground('Soup from the pot, 300 kcal', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Суп из кастрюли, 300 ккал', 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
  });
});

// Adjacency follow-up (2026-11-17): a whole-quantified vessel and a figure separated by nothing but punctuation and
// whitespace (a sentence end, a line break, CRLF), in either order, are related. Words between them still separate them.
describe('a whole vessel and a figure separated only by punctuation or whitespace are related', () => {
  const BREAKS = ['\n', '\r\n', '\n\n', '\r\n\r\n'];

  it('withholds the figure after a whole vessel across a line break or a sentence end, for energy and macronutrients', () => {
    for (const br of BREAKS) {
      for (const [text, field, value, evidence] of [
        [`Whole pot${br}900 kcal`, 'energyKcal', '900', '900 kcal'],
        [`Full pot.${br}Protein 80 g.`, 'proteinG', '80', 'Protein 80 g'],
        [`The entire pan;${br}fat 45.5 g`, 'fatG', '45.5', 'fat 45.5 g'],
        [`Вся кастрюля${br}900 ккал`, 'energyKcal', '900', '900 ккал'],
        [`Полная кастрюля.${br}Белки 80 г.`, 'proteinG', '80', 'Белки 80 г'],
        [`Казан целиком${br}углеводы 120 г`, 'carbohydrateG', '120', 'углеводы 120 г'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
      }
    }
    expect(ground('Full pot. 900 kcal.', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Полная кастрюля. 900 ккал.', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground('Whole pot! 900 kcal', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
  });

  it('withholds the figure before a whole vessel across a line break or a sentence end', () => {
    for (const br of BREAKS) {
      for (const [text, field, value, evidence] of [
        [`900 kcal${br}Whole pot`, 'energyKcal', '900', '900 kcal'],
        [`Protein 80 g.${br}Full pot.`, 'proteinG', '80', 'Protein 80 g'],
        [`900 ккал${br}Вся кастрюля`, 'energyKcal', '900', '900 ккал'],
        [`Белки 80 г.${br}Полная кастрюля.`, 'proteinG', '80', 'Белки 80 г'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
      }
    }
    expect(ground('900 kcal. Whole pot.', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
  });

  it('withholds the container figure and proposes the consumed total beside it', () => {
    for (const br of BREAKS) {
      const english = `Whole pot${br}900 kcal. In total I ate 300 kcal.`;
      expect(ground(english, 'energyKcal', '900', '900 kcal'), JSON.stringify(english)).toEqual(withheld('per_portion'));
      expect(ground(english, 'energyKcal', '300', '300 kcal'), JSON.stringify(english)).toEqual(proposed(300, '300 kcal'));
      const russian = `Вся кастрюля${br}900 ккал. Итого съел 300 ккал.`;
      expect(ground(russian, 'energyKcal', '900', '900 ккал'), JSON.stringify(russian)).toEqual(withheld('per_portion'));
      expect(ground(russian, 'energyKcal', '300', '300 ккал'), JSON.stringify(russian)).toEqual(proposed(300, '300 ккал'));
    }
  });

  it('keeps the controls: words between the vessel and the figure still separate them, also across CRLF', () => {
    for (const br of ['. ', '.\n', '.\r\n', '\n', '\r\n']) {
      const cooked = `Cooked soup in a full pot${br}Lunch, 300 kcal.`;
      expect(ground(cooked, 'energyKcal', '300', '300 kcal'), JSON.stringify(cooked)).toEqual(proposed(300, '300 kcal'));
      const washed = `I washed the whole pan${br}Soup, 400 kcal. In total I ate 300 kcal.`;
      expect(ground(washed, 'energyKcal', '300', '300 kcal'), JSON.stringify(washed)).toEqual(withheld('conflicting'));
      const cookedRu = `Сварила суп в полной кастрюле${br}Обед, 300 ккал.`;
      expect(ground(cookedRu, 'energyKcal', '300', '300 ккал'), JSON.stringify(cookedRu)).toEqual(proposed(300, '300 ккал'));
      const washedRu = `Помыла всю сковороду${br}Суп, 400 ккал. Итого съела 300 ккал.`;
      expect(ground(washedRu, 'energyKcal', '300', '300 ккал'), JSON.stringify(washedRu)).toEqual(withheld('conflicting'));
    }
    expect(ground('Soup, 300 kcal.\r\nThen I washed the whole pot.', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
  });

});

// Clause classification (2026-11-17, second follow-up): across a sentence end, a line break or a parenthesis, a whole
// vessel is related to an adjacent figure only when its own clause is nothing but the vessel reference (an optional
// preposition and article, the quantified vessel, an English "of …"): a label such as "Whole pot", "(whole pot)" or "(for
// the whole pot)". A clause that also says what was done with the vessel ("Washed the whole pan.", "Whole pot washed
// afterwards") attributes no nutrition to it, so the values beside it keep their scope and their conflicts.
describe('a vessel clause that only names the vessel is related; one that describes an action is not', () => {
  const BREAKS = ['\n', '\r\n', '. ', '.\n', '.\r\n'];

  it('keeps a same-field conflict beside an unrelated cooking or cleaning sentence (EN and RU, every field)', () => {
    for (const [text, field, value, evidence] of [
      ['Protein 25 g. In total I ate protein 20 g.', 'proteinG', '20', 'protein 20 g'],
      ['Washed the whole pan. Protein 25 g. In total I ate protein 20 g.', 'proteinG', '20', 'protein 20 g'],
      ['Washed the whole pan.\r\nProtein 25 g.\r\nIn total I ate protein 20 g.', 'proteinG', '20', 'protein 20 g'],
      ['Scrubbed the entire skillet.\nFat 9 g. In total I ate fat 4 g.', 'fatG', '4', 'fat 4 g'],
      ['Cooked rice in a full pot. Carbs 60 g. In total I ate carbs 45 g.', 'carbohydrateG', '45', 'carbs 45 g'],
      ['Washed the whole pot. 400 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal'],
      ['Белки 25 г. Итого съела белки 20 г.', 'proteinG', '20', 'белки 20 г'],
      ['Помыла всю сковороду. Белки 25 г. Итого съела белки 20 г.', 'proteinG', '20', 'белки 20 г'],
      ['Сварила в полной кастрюле. Белки 25 г. Итого съела белки 20 г.', 'proteinG', '20', 'белки 20 г'],
      ['Отмыла казан целиком.\r\nЖиры 9 г.\r\nИтого съела жиры 4 г.', 'fatG', '4', 'жиры 4 г'],
      ['Помыла всю кастрюлю. 400 ккал. Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
    }
  });

  it('withholds a figure with a parenthesized whole-vessel attribution after it (EN and RU, every field)', () => {
    for (const [text, field, value, evidence] of [
      ['Soup, 900 kcal (whole pot).', 'energyKcal', '900', '900 kcal'],
      ['Soup, 900 kcal (for the whole pot).', 'energyKcal', '900', '900 kcal'],
      ['Soup, 900 kcal (the entire pot)', 'energyKcal', '900', '900 kcal'],
      ['Protein 80 g (whole pot).', 'proteinG', '80', 'Protein 80 g'],
      ['Chili: fat 45.5 g (full pot)', 'fatG', '45.5', 'fat 45.5 g'],
      ['Chili: carbs 120 g\n(whole pot)', 'carbohydrateG', '120', 'carbs 120 g'],
      ['Суп, 900 ккал (вся кастрюля).', 'energyKcal', '900', '900 ккал'],
      ['Суп, 900 ккал (на всю кастрюлю).', 'energyKcal', '900', '900 ккал'],
      ['Белки 80 г (вся кастрюля).', 'proteinG', '80', 'Белки 80 г'],
      ['Плов: жиры 120 г (казан целиком)', 'fatG', '120', 'жиры 120 г'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });

  it('withholds a figure under a parenthesized whole-vessel label across LF and CRLF', () => {
    for (const br of ['\n', '\r\n', ' ', '\n\n']) {
      for (const [text, field, value, evidence] of [
        [`(Whole pot)${br}900 kcal`, 'energyKcal', '900', '900 kcal'],
        [`(For the whole pot)${br}protein 80 g`, 'proteinG', '80', 'protein 80 g'],
        [`(Вся кастрюля)${br}900 ккал`, 'energyKcal', '900', '900 ккал'],
        [`(На всю кастрюлю)${br}углеводы 120 г`, 'carbohydrateG', '120', 'углеводы 120 г'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
      }
    }
  });

  it('keeps the consumed total beside a parenthesized container figure', () => {
    const english = 'Soup, 900 kcal (whole pot). In total I ate 300 kcal.';
    expect(ground(english, 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground(english, 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    const russian = 'Суп, 900 ккал (вся кастрюля). Итого съела 300 ккал.';
    expect(ground(russian, 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground(russian, 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
  });

  it('pairs an attributing vessel label with an unrelated vessel action that differs only in the verb', () => {
    for (const br of BREAKS) {
      for (const [label, action, field, value, evidence] of [
        [`Whole pan${br}Protein 25 g. In total I ate protein 20 g.`, `Washed the whole pan${br}Protein 25 g. In total I ate protein 20 g.`, 'proteinG', '20', 'protein 20 g'],
        [`Full pot${br}400 kcal. In total I ate 300 kcal.`, `Cooked in a full pot${br}400 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`Вся сковорода${br}Белки 25 г. Итого съела белки 20 г.`, `Помыла всю сковороду${br}Белки 25 г. Итого съела белки 20 г.`, 'proteinG', '20', 'белки 20 г'],
      ] as const) {
        // The label attributes the first figure to the vessel: the consumed total is the only whole-entry value.
        expect(ground(label, field, value, evidence), JSON.stringify(label)).toEqual(proposed(Number(value), evidence));
        // The action attributes nothing: both values are whole-entry values, and they conflict.
        expect(ground(action, field, value, evidence), JSON.stringify(action)).toEqual(withheld('conflicting'));
      }
    }
    for (const [attributed, unrelated, field, value, evidence] of [
      ['Soup, 300 kcal (whole pot).', 'Soup, 300 kcal (washed the whole pot after).', 'energyKcal', '300', '300 kcal'],
      ['Soup, 300 kcal\nWhole pot', 'Soup, 300 kcal\nWhole pot washed afterwards', 'energyKcal', '300', '300 kcal'],
      ['Белки 30 г (вся кастрюля).', 'Белки 30 г (потом помыла всю кастрюлю).', 'proteinG', '30', 'Белки 30 г'],
      ['Суп, 300 ккал\r\nВся кастрюля', 'Суп, 300 ккал\r\nВсю кастрюлю помыла потом', 'energyKcal', '300', '300 ккал'],
    ] as const) {
      expect(ground(attributed, field, value, evidence), JSON.stringify(attributed)).toEqual(withheld('per_portion'));
      expect(ground(unrelated, field, value, evidence), JSON.stringify(unrelated)).toEqual(proposed(Number(value), evidence));
    }
  });

  it('keeps the earlier controls', () => {
    expect(ground('Whole pot\n900 kcal', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    const consumed = 'Whole pot\n900 kcal. In total I ate 300 kcal.';
    expect(ground(consumed, 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground(consumed, 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Cooked soup in a full pot. Lunch, 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('I washed the whole pan. Soup, 400 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('conflicting'));
    expect(ground('Soup, 300 kcal\nWhole pot washed afterwards', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
  });
});

// Russian food qualifier (2026-11-17, third follow-up): the clause classification above accepted the English "of soup"
// after a whole vessel but rejected the Russian genitive food qualifier ("Полная кастрюля супа"), so "Полная кастрюля
// супа\n900 ккал" proposed 900 where HEAD withheld it. A supported dish or food noun in the genitive may follow the
// vessel in a label; any other trailing word ("Полная кастрюля помыта") makes the clause an action, which attributes
// nothing.
describe('a Russian whole-vessel label may carry a supported food qualifier; an action word is not one', () => {
  const BREAKS = ['\n', '\r\n', '. ', '.\n', '.\r\n'];

  it('withholds the reproduction and keeps the explicit-colon control', () => {
    expect(ground('Полная кастрюля супа\n900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground('Полная кастрюля супа:\n900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground('Полная кастрюля помыта\n900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(proposed(900, '900 ккал'));
  });

  it('pairs a food-qualified label with an action word, label before the figure (energy and macronutrients)', () => {
    for (const br of BREAKS) {
      for (const [label, action, field, value, evidence] of [
        [`Полная кастрюля супа${br}400 ккал. Итого съела 300 ккал.`, `Полная кастрюля помыта${br}400 ккал. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Вся сковорода плова${br}Жиры 25 г. Итого съела жиры 20 г.`, `Вся сковорода вымыта${br}Жиры 25 г. Итого съела жиры 20 г.`, 'fatG', '20', 'жиры 20 г'],
        [`Целый казан борща${br}Белки 80 г. Итого съела белки 20 г.`, `Целый казан отмыт${br}Белки 80 г. Итого съела белки 20 г.`, 'proteinG', '20', 'белки 20 г'],
      ] as const) {
        expect(ground(label, field, value, evidence), JSON.stringify(label)).toEqual(proposed(Number(value), evidence));
        expect(ground(action, field, value, evidence), JSON.stringify(action)).toEqual(withheld('conflicting'));
      }
    }
  });

  it('pairs a food-qualified label with an action word, label after the figure (energy and macronutrients)', () => {
    for (const br of BREAKS) {
      for (const [label, action, field, value, evidence] of [
        [`400 ккал${br}Полная кастрюля супа. Итого съела 300 ккал.`, `400 ккал${br}Полная кастрюля помыта. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Углеводы 120 г${br}Вся кастрюля каши. Итого съела углеводы 40 г.`, `Углеводы 120 г${br}Вся кастрюля помыта. Итого съела углеводы 40 г.`, 'carbohydrateG', '40', 'углеводы 40 г'],
      ] as const) {
        expect(ground(label, field, value, evidence), JSON.stringify(label)).toEqual(proposed(Number(value), evidence));
        expect(ground(action, field, value, evidence), JSON.stringify(action)).toEqual(withheld('conflicting'));
      }
      for (const [label, action, field, value, evidence] of [
        [`900 ккал${br}Полная кастрюля супа`, `900 ккал${br}Полная кастрюля помыта`, 'energyKcal', '900', '900 ккал'],
        [`Белки 80 г${br}Вся сковорода плова.`, `Белки 80 г${br}Вся сковорода вымыта.`, 'proteinG', '80', 'Белки 80 г'],
      ] as const) {
        expect(ground(label, field, value, evidence), JSON.stringify(label)).toEqual(withheld('per_portion'));
        expect(ground(action, field, value, evidence), JSON.stringify(action)).toEqual(proposed(Number(value), evidence));
      }
    }
  });

  it('withholds a figure beside a parenthesized food-qualified label, in either order', () => {
    for (const br of ['\n', '\r\n', ' ']) {
      for (const [text, field, value, evidence] of [
        [`(Полная кастрюля супа)${br}900 ккал`, 'energyKcal', '900', '900 ккал'],
        [`(На всю кастрюлю борща)${br}белки 80 г`, 'proteinG', '80', 'белки 80 г'],
        [`Суп, 900 ккал${br}(полная кастрюля супа).`, 'energyKcal', '900', '900 ккал'],
        [`Плов: жиры 120 г${br}(весь казан плова)`, 'fatG', '120', 'жиры 120 г'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
      }
    }
    for (const [text, field, value, evidence] of [
      ['Суп, 900 ккал (полная кастрюля помыта).', 'energyKcal', '900', '900 ккал'],
      ['(Вся кастрюля помыта)\nбелки 80 г', 'proteinG', '80', 'белки 80 г'],
    ] as const) {
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(proposed(Number(value), evidence));
    }
  });

  it('keeps the consumed total beside a food-qualified container figure', () => {
    for (const br of BREAKS) {
      const text = `Полная кастрюля супа${br}900 ккал. Итого съела 300 ккал.`;
      expect(ground(text, 'energyKcal', '900', '900 ккал'), JSON.stringify(text)).toEqual(withheld('per_portion'));
      expect(ground(text, 'energyKcal', '300', '300 ккал'), JSON.stringify(text)).toEqual(proposed(300, '300 ккал'));
    }
  });

  it('does not accept an arbitrary trailing word or a second word as a food qualifier', () => {
    // An explicit action word makes the clause an action, whatever else it says: the figure keeps its scope.
    for (const text of ['Полная кастрюля помыта\n900 ккал', 'Полная кастрюля супа помыта\n900 ккал']) {
      expect(ground(text, 'energyKcal', '900', '900 ккал'), JSON.stringify(text)).toEqual(proposed(900, '900 ккал'));
    }
    // An unknown word is not a label, but it is not an action either: the attribution is unresolved, so the figure is
    // withheld (Unknown-qualifier correction, below).
    for (const text of [
      'Вся кастрюля стояла\n900 ккал',
      'Полная кастрюля потом\n900 ккал',
      'Полная кастрюля супа стояла. 900 ккал',
    ]) {
      expect(ground(text, 'energyKcal', '900', '900 ккал'), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });
});

// Unknown-qualifier correction (2026-11-17, fourth follow-up): the clause classification above treated every word missing
// from FOOD_QUALIFIER_RU as an action, so "Полная кастрюля окрошки\n900 ккал" proposed 900 where HEAD withheld it. A word
// the classifier does not know establishes nothing. A vessel clause beside a figure is now one of three things: a LABEL
// (confirmed attribution: the figure is the vessel's), an explicit ACTION (a cleaning, handling or cooking word: the
// clause attributes nothing), or UNRESOLVED (anything else). An unresolved clause withholds the figure beside it
// ('per_portion', as a container figure), but it never removes that figure from conflict detection, so it cannot clear the
// way for another value to be proposed.
describe('an unresolved vessel clause withholds the figure beside it without hiding a conflict', () => {
  const BREAKS = ['\n', '\r\n', '\n\n', '\r\n\r\n', '. ', '.\n', '.\r\n'];

  it('withholds the confirmed regressions', () => {
    expect(ground('Полная кастрюля окрошки\n900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground('900 ккал\r\nПолная кастрюля окрошки', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground('Полная кастрюля салата.\nБелки 80 г.', 'proteinG', '80', 'Белки 80 г')).toEqual(withheld('per_portion'));
  });

  it('withholds a figure beside an unlisted food name, in either order, across LF, CRLF and sentence ends', () => {
    for (const br of BREAKS) {
      for (const [before, after, field, value, evidence] of [
        [`Полная кастрюля окрошки${br}900 ккал`, `900 ккал${br}Полная кастрюля окрошки`, 'energyKcal', '900', '900 ккал'],
        [`Вся сковорода драников${br}Жиры 45,5 г`, `Жиры 45,5 г${br}Вся сковорода драников`, 'fatG', '45.5', 'Жиры 45,5 г'],
        [`Целый казан шулюма${br}Белки 80 г`, `Белки 80 г${br}Целый казан шулюма`, 'proteinG', '80', 'Белки 80 г'],
        [`Полная кастрюля салата${br}углеводы 120 г`, `углеводы 120 г${br}Полная кастрюля салата`, 'carbohydrateG', '120', 'углеводы 120 г'],
      ] as const) {
        expect(ground(before, field, value, evidence), JSON.stringify(before)).toEqual(withheld('per_portion'));
        expect(ground(after, field, value, evidence), JSON.stringify(after)).toEqual(withheld('per_portion'));
      }
    }
  });

  it('withholds a figure beside a synthetic unknown qualifier, so no dictionary membership decides the outcome', () => {
    for (const qualifier of ['зюмбры', 'кваклы', 'флорпа', 'глокачи']) {
      for (const br of ['\n', '\r\n', '. ']) {
        for (const [text, field, value, evidence] of [
          [`Полная кастрюля ${qualifier}${br}900 ккал`, 'energyKcal', '900', '900 ккал'],
          [`900 ккал${br}Вся кастрюля ${qualifier}`, 'energyKcal', '900', '900 ккал'],
          [`Целый казан ${qualifier}${br}Белки 80 г.`, 'proteinG', '80', 'Белки 80 г'],
        ] as const) {
          expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
        }
      }
      for (const text of [`Суп, 900 ккал (полная кастрюля ${qualifier}).`, `(Вся кастрюля ${qualifier})\n900 ккал`]) {
        expect(ground(text, 'energyKcal', '900', '900 ккал'), JSON.stringify(text)).toEqual(withheld('per_portion'));
      }
    }
    // The English counterpart: a clause with a word the classifier does not know is unresolved too.
    for (const text of ['Whole pot blorped\n900 kcal', '900 kcal\r\nThe whole pot, zindled', 'Full pot stood. 900 kcal.']) {
      expect(ground(text, 'energyKcal', '900', '900 kcal'), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
  });

  it('never lets an unresolved figure drop out of conflict detection and authorize another value', () => {
    for (const br of BREAKS) {
      for (const [text, field, value, evidence] of [
        [`Полная кастрюля окрошки${br}900 ккал. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`900 ккал${br}Полная кастрюля окрошки. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Полная кастрюля салата${br}Белки 80 г. Итого съела белки 20 г.`, 'proteinG', '20', 'белки 20 г'],
        [`Целый казан зюмбры${br}Жиры 45 г. Итого съела жиры 15 г.`, 'fatG', '15', 'жиры 15 г'],
        [`Whole pot blorped${br}900 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
      }
    }
    // The unresolved figure itself stays withheld; the same consumed total with no second value is proposed.
    expect(ground('Полная кастрюля окрошки\n900 ккал. Итого съела 300 ккал.', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground('Полная кастрюля окрошки\n300 ккал. Итого съела 300 ккал.', 'energyKcal', '300', 'Итого съела 300 ккал')).toEqual(
      proposed(300, 'Итого съела 300 ккал'),
    );
  });

  it('keeps the confirmed cooking and cleaning controls', () => {
    expect(ground('Washed the whole pan. Protein 25 g. In total I ate protein 20 g.', 'proteinG', '20', 'protein 20 g')).toEqual(withheld('conflicting'));
    expect(ground('Полная кастрюля помыта\n400 ккал. Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(withheld('conflicting'));
    expect(ground('Cooked soup in a full pot. Lunch, 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Soup, 300 kcal\nWhole pot washed afterwards', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Суп, 300 ккал\r\nВсю кастрюлю помыла потом', 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
  });

  it('keeps the known labels and the consumed total beside a confirmed container figure', () => {
    for (const br of BREAKS) {
      const russian = `Полная кастрюля супа${br}900 ккал. Итого съела 300 ккал.`;
      expect(ground(russian, 'energyKcal', '900', '900 ккал'), JSON.stringify(russian)).toEqual(withheld('per_portion'));
      expect(ground(russian, 'energyKcal', '300', '300 ккал'), JSON.stringify(russian)).toEqual(proposed(300, '300 ккал'));
      const english = `Full pot of okroshka${br}900 kcal. In total I ate 300 kcal.`;
      expect(ground(english, 'energyKcal', '900', '900 kcal'), JSON.stringify(english)).toEqual(withheld('per_portion'));
      expect(ground(english, 'energyKcal', '300', '300 kcal'), JSON.stringify(english)).toEqual(proposed(300, '300 kcal'));
    }
    expect(ground('Суп, 900 ккал (вся кастрюля). Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
  });

  it('does not let a food adjective after the vessel pass for a cooking action', () => {
    // "fried", "жареной" describe the food here, not something done with the vessel: the attribution stays unresolved.
    expect(ground('Full pan of fried rice\n900 kcal', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Целая сковорода жареной картошки\n900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
    expect(ground('Полная кастрюля вареников стояла\n900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
  });
});

// Per-mention vessel attribution (2026-11-17, fifth follow-up). Conflict detection decided vessel context for the whole
// text: once any CONFIRMED vessel statement existed ("The whole pan has protein 80 g"), every value without explicit
// whole-entry scope dropped out of the conflict scan, an unresolved figure included, so "Whole pot blorped\n900 kcal. The
// whole pan has protein 80 g. In total I ate 300 kcal." proposed 300. Vessel context now removes a value from the
// conflict scan only when THAT value is attributed to a confirmed vessel. The global policy for a proposal is unchanged:
// vessel context anywhere still withholds every value without explicit scope.
describe('vessel attribution is tracked per mention in conflict detection', () => {
  const BREAKS = ['\n', '\r\n'];

  it('withholds the consumed total as conflicting in both reproductions', () => {
    expect(ground('Whole pot blorped\n900 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('conflicting'));
    expect(
      ground('Whole pot blorped\n900 kcal. The whole pan has protein 80 g. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal'),
    ).toEqual(withheld('conflicting'));
  });

  it('keeps an unresolved figure in the scan beside a confirmed vessel statement, in both orders, same-field and cross-field (EN and RU)', () => {
    for (const br of BREAKS) {
      for (const [text, field, value, evidence] of [
        // Cross-field confirmed statement after, then before the unresolved one.
        [`Whole pot blorped${br}900 kcal. The whole pan has protein 80 g. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`The whole pan has protein 80 g.${br}Whole pot blorped${br}900 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        // The unresolved clause after its figure.
        [`900 kcal${br}Whole pot blorped. The whole pan has protein 80 g. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        // Same-field confirmed figure, both orders.
        [`Whole pot blorped${br}900 kcal. The whole pan has 1200 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`The whole pan has 1200 kcal.${br}Whole pot blorped${br}900 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        // A confirmed label instead of a subject construction.
        [`Whole pan${br}1200 kcal. Whole pot blorped${br}900 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        // Macronutrient fields.
        [`Whole pot blorped${br}Protein 80 g. The whole pan has 900 kcal. In total I ate protein 20 g.`, 'proteinG', '20', 'protein 20 g'],
        [`The whole pan has fat 60 g.${br}Full pot zindled${br}Fat 45 g. In total I ate fat 15 g.`, 'fatG', '15', 'fat 15 g'],
        // Russian.
        [`Полная кастрюля окрошки${br}900 ккал. Вся сковорода содержит белки 80 г. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Вся сковорода содержит 1200 ккал.${br}Полная кастрюля окрошки${br}900 ккал. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`900 ккал${br}Целый казан зюмбры. Вся сковорода 1200 ккал. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Полная кастрюля салата${br}Белки 80 г. Вся кастрюля содержит 900 ккал. Итого съела белки 20 г.`, 'proteinG', '20', 'белки 20 г'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
      }
    }
  });

  it('still withholds the unresolved figure itself, and every unscoped value beside a confirmed vessel (global proposal policy)', () => {
    const text = 'Whole pot blorped\n900 kcal. The whole pan has protein 80 g. In total I ate 300 kcal.';
    expect(ground(text, 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground(text, 'proteinG', '80', 'protein 80 g')).toEqual(withheld('per_portion'));
    expect(ground('The whole pot has 900 kcal. Protein 20 g.', 'proteinG', '20', 'Protein 20 g')).toEqual(withheld('per_portion'));
    expect(ground('Вся кастрюля 900 ккал. Белки 20 г.', 'proteinG', '20', 'Белки 20 г')).toEqual(withheld('per_portion'));
  });

  it('keeps the consumed total proposed when every other figure is attributed to a confirmed vessel', () => {
    for (const br of BREAKS) {
      for (const [text, field, value, evidence] of [
        ['The whole pot has 900 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal'],
        [`Whole pot${br}900 kcal. The whole pan has protein 80 g. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`Whole pot${br}900 kcal. The whole pan has 1200 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`900 kcal${br}Whole pot. The whole pan has 1200 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`Soup, 900 kcal (whole pot).${br}In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`Полная кастрюля супа${br}900 ккал. Вся сковорода содержит 1200 ккал. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Белки 80 г (вся кастрюля).${br}Итого съела белки 20 г.`, 'proteinG', '20', 'белки 20 г'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(proposed(Number(value), evidence));
      }
    }
    expect(ground('The whole pot has 900 kcal. In total I ate 300 kcal.', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
  });

  it('attributes a confirmed construction’s coordinated list to the vessel, but never a figure beside an unresolved or action clause', () => {
    // A confirmed construction owns the other figures of its coordinated list ("…is 900 kcal, protein 80 g"; Amendment 7).
    const statement = 'Chili. The whole pot is 900 kcal, protein 80 g. In total I ate 300 kcal, protein 20 g.';
    expect(ground(statement, 'proteinG', '20', 'protein 20 g')).toEqual(proposed(20, 'protein 20 g'));
    expect(ground('Полная кастрюля супа, 900 ккал. Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
    // The same-line construction admits any one word after the Russian vessel; when that word is unknown or an action, the
    // figure's own attribution is not confirmed, so it stays in the scan (the figure itself stays withheld).
    for (const text of ['Полная кастрюля окрошки, 900 ккал. Итого съела 300 ккал.', 'Полная кастрюля помыта, 900 ккал. Итого съела 300 ккал.']) {
      expect(ground(text, 'energyKcal', '300', '300 ккал'), JSON.stringify(text)).toEqual(withheld('conflicting'));
      expect(ground(text, 'energyKcal', '900', '900 ккал'), JSON.stringify(text)).toEqual(withheld('per_portion'));
    }
    // A plain value is not the vessel's because a vessel statement stands elsewhere: it stays in the scan.
    expect(ground('Soup 900 kcal. The whole pan has protein 80 g. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(
      withheld('conflicting'),
    );
    expect(ground('Суп 900 ккал. Вся сковорода содержит белки 80 г. Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал')).toEqual(
      withheld('conflicting'),
    );
  });

  it('scans an unresolved figure exactly like a plain figure, whatever per-portion or package context the text has', () => {
    for (const [unresolved, plain] of [
      ['Whole pot blorped\n900 kcal. In total I ate 300 kcal.', 'Soup\n900 kcal. In total I ate 300 kcal.'],
      ['Whole pot blorped\n900 kcal. Bread 100 kcal per slice. In total I ate 300 kcal.', 'Soup\n900 kcal. Bread 100 kcal per slice. In total I ate 300 kcal.'],
      ['Whole pot blorped\n900 kcal. The package has 4 g protein. In total I ate 300 kcal.', 'Soup\n900 kcal. The package has 4 g protein. In total I ate 300 kcal.'],
    ] as const) {
      expect(ground(unresolved, 'energyKcal', '300', '300 kcal'), JSON.stringify(unresolved)).toEqual(ground(plain, 'energyKcal', '300', '300 kcal'));
    }
  });
});

// Batch preparation (2026-11-17, fifth follow-up). Every cooking verb before the vessel made its clause an unrelated
// action, so "I cooked a full pot of soup.\n900 kcal" proposed 900 although nothing says 900 was eaten: the figure may be
// the batch's. A cooking verb is now an unrelated action only when the vessel is where the cooking happened ("Cooked soup
// in a full pot", "Сварила суп в полной кастрюле"). When the whole vessel is what was cooked ("cooked a full pot of soup",
// "сварила полную кастрюлю супа"), the clause describes the batch: the attribution is unresolved, so the figure beside it
// is withheld and stays in the conflict scan. Cleaning and handling words stay actions wherever they stand.
describe('preparing a whole batch is not an unrelated vessel action', () => {
  const BREAKS = ['\n', '\r\n', '\n\n', '. '];

  it('withholds the figure beside a prepared batch (the reproductions)', () => {
    expect(ground('I cooked a full pot of soup.\n900 kcal', 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Сварила полную кастрюлю супа\n900 ккал', 'energyKcal', '900', '900 ккал')).toEqual(withheld('per_portion'));
  });

  it('withholds it in either order, across LF, CRLF and sentence ends, for energy and macronutrients', () => {
    for (const br of BREAKS) {
      for (const [text, field, value, evidence] of [
        [`I cooked a full pot of soup${br}900 kcal`, 'energyKcal', '900', '900 kcal'],
        [`900 kcal${br}I cooked a full pot of soup`, 'energyKcal', '900', '900 kcal'],
        [`Made the whole pot of chili${br}Protein 80 g`, 'proteinG', '80', 'Protein 80 g'],
        [`Boiled an entire pan of pasta${br}carbs 120 g`, 'carbohydrateG', '120', 'carbs 120 g'],
        [`Сварила полную кастрюлю супа${br}900 ккал`, 'energyKcal', '900', '900 ккал'],
        [`900 ккал${br}Сварила полную кастрюлю супа`, 'energyKcal', '900', '900 ккал'],
        [`Наварила целый казан плова${br}Жиры 120 г`, 'fatG', '120', 'Жиры 120 г'],
        [`Пожарила всю сковороду драников${br}Белки 40 г`, 'proteinG', '40', 'Белки 40 г'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('per_portion'));
      }
    }
  });

  it('keeps a prepared batch figure in conflict detection beside a consumed total', () => {
    for (const br of ['\n', '\r\n']) {
      for (const [text, field, value, evidence] of [
        [`I cooked a full pot of soup.${br}900 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`Сварила полную кастрюлю супа${br}900 ккал. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
      }
    }
  });

  it('keeps the vessel used for cooking, and washing, as unrelated actions', () => {
    expect(ground('Cooked soup in a full pot. Lunch, 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Washed the whole pan. Protein 25 g. In total I ate protein 20 g.', 'proteinG', '20', 'protein 20 g')).toEqual(withheld('conflicting'));
    for (const br of ['\n', '\r\n', '. ']) {
      for (const [text, field, value, evidence] of [
        [`Cooked in a full pot${br}400 kcal. In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`Cooked rice in a full pot${br}Carbs 60 g. In total I ate carbs 45 g.`, 'carbohydrateG', '45', 'carbs 45 g'],
        [`Сварила суп в полной кастрюле${br}400 ккал. Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Сварила в полной кастрюле${br}Белки 25 г. Итого съела белки 20 г.`, 'proteinG', '20', 'белки 20 г'],
      ] as const) {
        // The vessel is where the cooking happened: both values are whole-entry values, and they conflict.
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
      }
    }
    expect(ground('Soup, 300 kcal\nWhole pot washed afterwards', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Суп, 300 ккал\r\nВсю кастрюлю помыла потом', 'energyKcal', '300', '300 ккал')).toEqual(proposed(300, '300 ккал'));
  });
});
