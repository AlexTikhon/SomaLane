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
      ['Soup, 300 kcal\nThen the whole pot was washed', 'energyKcal', '300', '300 kcal', 300],
      ['Soup, protein 20 g.\n\nThe entire pan went into the dishwasher.', 'proteinG', '20', 'protein 20 g', 20],
      ['Суп, 300 ккал. Потом помыла всю кастрюлю.', 'energyKcal', '300', '300 ккал', 300],
      ['Суп, 300 ккал\nПотом помыла всю кастрюлю', 'energyKcal', '300', '300 ккал', 300],
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
      ['Washed the whole pan. Soup, protein 25 g. In total I ate protein 20 g.', 'proteinG', '20', 'protein 20 g'],
      ['Washed the whole pan; soup, fat 4 g, later fat 5 g', 'fatG', '4', 'fat 4 g'],
      ['Помыла всю сковороду. Суп, 400 ккал. Итого съела 300 ккал.', 'energyKcal', '400', '400 ккал'],
      ['Сварила в полной кастрюле. Суп, белки 25 г. Итого съела белки 20 г.', 'proteinG', '20', 'белки 20 г'],
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

  it('reads a figure right after the whole vessel as the vessel\'s, also after a verb before the vessel (documented consequence)', () => {
    // Only punctuation separates "whole pan" from "Protein 25 g", so 25 is a container figure and does not conflict with
    // the consumed total, exactly as in "Whole pot\n900 kcal. In total I ate 300 kcal.".
    const text = 'Washed the whole pan. Protein 25 g. In total I ate protein 20 g.';
    expect(ground(text, 'proteinG', '25', 'Protein 25 g')).toEqual(withheld('per_portion'));
    expect(ground(text, 'proteinG', '20', 'protein 20 g')).toEqual(proposed(20, 'protein 20 g'));
    const russian = 'Сварила в полной кастрюле. Белки 25 г. Итого съела белки 20 г.';
    expect(ground(russian, 'proteinG', '25', 'Белки 25 г')).toEqual(withheld('per_portion'));
    expect(ground(russian, 'proteinG', '20', 'белки 20 г')).toEqual(proposed(20, 'белки 20 г'));
  });
});
