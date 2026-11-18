import type { MealNutritionField } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { groundNutrient } from './meal-draft-grounding.js';
import type { NutrientClaim } from './meal-draft-wire.js';

// Generated invariants of the vessel-scope policy (docs/meal-draft-vessel-scope-policy.md). Every expectation here is
// stated by the test from the policy's semantics (a value of an unresolved list never leaves the conflict scan; a
// confirmed list's values never conflict with a consumed total; an action creates no permission; ...), never computed by
// calling the production analysis. Nothing here calls a model.

const claim = (value: string, evidence: string): NutrientClaim => ({ abstain: null, evidence, value });
const ground = (text: string, field: MealNutritionField, value: string, evidence: string) => groundNutrient(text, field, claim(value, evidence)).result;
const withheld = (reason: string) => ({ reason, status: 'withheld' });
const proposed = (value: number, excerpt: string) => ({ excerpt, status: 'proposed', value });

const FIELDS: readonly MealNutritionField[] = ['energyKcal', 'proteinG', 'fatG', 'carbohydrateG'];
type Language = 'en' | 'ru';

/** One stated figure: its text, the claim value and the field. */
interface Item {
  field: MealNutritionField;
  text: string;
  value: string;
}

const CONTAINER_ITEMS: Record<Language, Item[]> = {
  en: [
    { field: 'energyKcal', text: '900 kcal', value: '900' },
    { field: 'proteinG', text: 'protein 80 g', value: '80' },
    { field: 'fatG', text: 'fat 45 g', value: '45' },
    { field: 'carbohydrateG', text: 'carbs 120 g', value: '120' },
  ],
  ru: [
    { field: 'energyKcal', text: '900 ккал', value: '900' },
    { field: 'proteinG', text: 'белки 80 г', value: '80' },
    { field: 'fatG', text: 'жиры 45 г', value: '45' },
    { field: 'carbohydrateG', text: 'углеводы 120 г', value: '120' },
  ],
};

/** Consumed values: every one differs from the container value of its field. */
const CONSUMED_ITEMS: Record<Language, Item[]> = {
  en: [
    { field: 'energyKcal', text: '300 kcal', value: '300' },
    { field: 'proteinG', text: 'protein 20 g', value: '20' },
    { field: 'fatG', text: 'fat 15 g', value: '15' },
    { field: 'carbohydrateG', text: 'carbs 40 g', value: '40' },
  ],
  ru: [
    { field: 'energyKcal', text: '300 ккал', value: '300' },
    { field: 'proteinG', text: 'белки 20 г', value: '20' },
    { field: 'fatG', text: 'жиры 15 г', value: '15' },
    { field: 'carbohydrateG', text: 'углеводы 40 г', value: '40' },
  ],
};

const CONSUMED_LEAD: Record<Language, string> = { en: 'In total I ate', ru: 'Итого съела' };

/** Unresolved vessel clauses: unknown or synthetic vocabulary, and prepared batches. */
const UNRESOLVED_HEADINGS: Record<Language, string[]> = {
  en: ['Whole pot blorped', 'Full pot zindled', 'I cooked a full pot of soup.', 'Made the whole pot of chili.'],
  ru: ['Полная кастрюля окрошки', 'Целый казан зюмбры', 'Сварила полную кастрюлю супа', 'Наварила целый казан плова.'],
};

/** Confirmed vessel statements of their own, for every field of the list (a different number each). */
const CONFIRMED_ELSEWHERE: Record<Language, string[]> = {
  en: ['The whole pan has 1200 kcal.', 'The whole pan has protein 99 g.', 'The whole pan has fat 77 g.', 'The whole pan has carbs 222 g.'],
  ru: ['Вся сковорода содержит 1200 ккал.', 'Вся сковорода содержит белки 99 г.', 'Вся сковорода содержит жиры 77 г.', 'Вся сковорода содержит углеводы 222 г.'],
};
const CONFIRMED_SAME_LINE: Record<Language, string> = { en: ', the whole pan has 1200 kcal', ru: ', вся сковорода содержит 1200 ккал' };

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

const BREAKS = ['\n', '\r\n'];

describe('reordering an unresolved nutrient list never changes its protection', () => {
  for (const language of ['en', 'ru'] as const) {
    it(`keeps every member in the conflict scan and never proposes it, for all 24 orders (${language})`, () => {
      let checked = 0;
      for (const order of permutations(CONTAINER_ITEMS[language])) {
        const list = order.map((item) => item.text).join(', ');
        for (const heading of UNRESOLVED_HEADINGS[language]) {
          for (const br of BREAKS) {
            for (const tail of ['', CONFIRMED_SAME_LINE[language]]) {
              const base = `${heading}${br}${list}${tail}.`;
              for (const consumed of CONSUMED_ITEMS[language]) {
                const text = `${base}${br}${CONSUMED_LEAD[language]} ${consumed.text}.`;
                // The list's value of this field differs from the consumed one: the possible conflict must survive.
                expect(ground(text, consumed.field, consumed.value, consumed.text), JSON.stringify(text)).toEqual(withheld('conflicting'));
                checked += 1;
              }
              for (const item of order) {
                expect(ground(base, item.field, item.value, item.text), JSON.stringify(base)).toEqual(withheld('per_portion'));
              }
            }
          }
        }
      }
      expect(checked).toBe(24 * 4 * 2 * 2 * 4);
    });
  }
});

describe('a confirmed vessel list stays the vessel’s in any order, and the consumed list stays proposable', () => {
  const SUBJECT: Record<Language, string> = { en: 'The whole pot is', ru: 'Вся кастрюля содержит' };
  for (const language of ['en', 'ru'] as const) {
    it(`withholds the container figures and proposes the consumed totals, for every order of both lists (${language})`, () => {
      const consumedOrders = permutations(CONSUMED_ITEMS[language]);
      permutations(CONTAINER_ITEMS[language]).forEach((order, index) => {
        const consumed = consumedOrders[(index * 7) % consumedOrders.length]!;
        for (const br of [' ', '\n', '\r\n']) {
          const text = `${SUBJECT[language]} ${order.map((item) => item.text).join(', ')}.${br}${CONSUMED_LEAD[language]} ${consumed.map((item) => item.text).join(', ')}.`;
          for (const item of order) expect(ground(text, item.field, item.value, item.text), JSON.stringify(text)).toEqual(withheld('per_portion'));
          for (const item of consumed) expect(ground(text, item.field, item.value, item.text), JSON.stringify(text)).toEqual(proposed(Number(item.value), item.text));
        }
      });
    });
  }
});

describe('adding a confirmed vessel statement never erases an unresolved conflicting mention', () => {
  for (const language of ['en', 'ru'] as const) {
    it(`keeps the conflict with confirmed statements of every field before, between and after (${language})`, () => {
      for (const heading of UNRESOLVED_HEADINGS[language]) {
        for (const item of CONTAINER_ITEMS[language]) {
          const consumed = CONSUMED_ITEMS[language].find((entry) => entry.field === item.field)!;
          for (const confirmed of CONFIRMED_ELSEWHERE[language]) {
            for (const br of BREAKS) {
              const unresolved = `${heading}${br}${item.text}.`;
              const total = `${CONSUMED_LEAD[language]} ${consumed.text}.`;
              for (const text of [`${confirmed}${br}${unresolved} ${total}`, `${unresolved} ${confirmed} ${total}`, `${unresolved} ${total} ${confirmed}`]) {
                expect(ground(text, consumed.field, consumed.value, consumed.text), JSON.stringify(text)).toEqual(withheld('conflicting'));
              }
            }
          }
        }
      }
    });
  }
});

describe('an unrelated action never creates permission and keeps ordinary values', () => {
  const ACTIONS: Record<Language, string[]> = {
    en: ['Washed the whole pan.', 'Cooked soup in a full pot.', 'Scrubbed the entire skillet.', 'Whole pot washed afterwards.', 'For the whole pot I used a lid.'],
    ru: ['Помыла всю сковороду.', 'Сварила суп в полной кастрюле.', 'Полная кастрюля помыта.', 'Отмыла казан целиком.', 'На всю кастрюлю ушла крышка.'],
  };
  const PLAIN: Record<Language, { conflict: string[]; positive: string[] }> = {
    en: { conflict: ['Soup, 400 kcal.', 'In total I ate 300 kcal.'], positive: ['Soup, 300 kcal.'] },
    ru: { conflict: ['Суп, 400 ккал.', 'Итого съела 300 ккал.'], positive: ['Суп, 300 ккал.'] },
  };
  const unit = { en: '300 kcal', ru: '300 ккал' };
  for (const language of ['en', 'ru'] as const) {
    it(`keeps a plain conflict and a plain value wherever the action stands, across LF and CRLF (${language})`, () => {
      for (const action of ACTIONS[language]) {
        for (const br of [' ', '\n', '\r\n']) {
          const [first, second] = PLAIN[language].conflict as [string, string];
          for (const text of [`${action}${br}${first}${br}${second}`, `${first}${br}${action}${br}${second}`, `${first}${br}${second}${br}${action}`]) {
            expect(ground(text, 'energyKcal', '300', unit[language]), JSON.stringify(text)).toEqual(withheld('conflicting'));
          }
          const [only] = PLAIN[language].positive as [string];
          for (const text of [`${action}${br}${only}`, `${only}${br}${action}`]) {
            expect(ground(text, 'energyKcal', '300', unit[language]), JSON.stringify(text)).toEqual(proposed(300, unit[language]));
          }
        }
      }
    });
  }
});

describe('multiple mentions under one heading', () => {
  it('attributes only the coordinated list next to a label; values on further lines stay ordinary values', () => {
    for (const br of BREAKS) {
      // The heading's own line is the vessel's; the protein on the next line is an ordinary value, so it conflicts with
      // the consumed protein (a bare line break ends a list), and it is never proposed while vessel context exists.
      // (Sentence ends keep the consumed total in a sentence of its own, which the consumed-total rule requires.)
      const heading = `Whole pot:${br}900 kcal${br}Protein 80 g.${br}In total I ate protein 20 g.`;
      expect(ground(heading, 'proteinG', '20', 'protein 20 g'), JSON.stringify(heading)).toEqual(withheld('conflicting'));
      expect(ground(heading, 'proteinG', '80', 'Protein 80 g'), JSON.stringify(heading)).toEqual(withheld('per_portion'));
      // Coordinated on the label's line, the protein is the vessel's: the consumed protein is proposed.
      const coordinated = `Whole pot:${br}900 kcal, protein 80 g.${br}In total I ate protein 20 g.`;
      expect(ground(coordinated, 'proteinG', '20', 'protein 20 g'), JSON.stringify(coordinated)).toEqual(proposed(20, 'protein 20 g'));
      // Under an unresolved heading every line keeps its conflict.
      const unresolved = `Whole pot blorped${br}900 kcal${br}Protein 80 g, fat 45 g.${br}In total I ate fat 15 g.`;
      expect(ground(unresolved, 'fatG', '15', 'fat 15 g'), JSON.stringify(unresolved)).toEqual(withheld('conflicting'));
    }
  });
});

describe('exact decimals, zeros and duplicates beside vessel contexts', () => {
  it('proposes zero and equivalent decimal spellings exactly in a consumed list beside a confirmed vessel', () => {
    for (const br of BREAKS) {
      const text = `The whole pot is 900 kcal, protein 80 g.${br}In total I ate 300.0 kcal, protein 0 g, fat 2.50 g, carbs 30,5 g.`;
      expect(ground(text, 'energyKcal', '300', '300.0 kcal')).toEqual(proposed(300, '300.0 kcal'));
      expect(ground(text, 'proteinG', '0', 'protein 0 g')).toEqual(proposed(0, 'protein 0 g'));
      expect(ground(text, 'fatG', '2.5', 'fat 2.50 g')).toEqual(proposed(2.5, 'fat 2.50 g'));
      expect(ground(text, 'carbohydrateG', '30.5', 'carbs 30,5 g')).toEqual(proposed(30.5, 'carbs 30,5 g'));
      // A claim that is not the exact decimal written is never accepted.
      expect(ground(text, 'fatG', '2.51', 'fat 2.50 g').status).toBe('withheld');
    }
  });

  it('does not manufacture a conflict from equal values, also when one of them is unresolved', () => {
    for (const [text, field, value, evidence] of [
      ['Whole pot blorped\n300 kcal. In total I ate 300.0 kcal.', 'energyKcal', '300', '300.0 kcal'],
      ['Полная кастрюля окрошки\r\nбелки 20 г. Итого съела белки 20,0 г.', 'proteinG', '20', 'белки 20,0 г'],
      ['I cooked a full pot of soup.\nProtein 0 g, 900 kcal. In total I ate protein 0 g.', 'proteinG', '0', 'ate protein 0 g'],
    ] as const) {
      const result = ground(text, field, value, evidence);
      expect(result, JSON.stringify(text)).toMatchObject({ status: 'proposed', value: Number(value) });
    }
  });

  it('judges a repeated excerpt at its first occurrence', () => {
    // "300 kcal" first occurs in the unresolved list: that occurrence is judged, and it is never proposed.
    expect(ground('Whole pot blorped\n300 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Whole pot blorped\n300 kcal. In total I ate 300 kcal.', 'energyKcal', '300', 'ate 300 kcal')).toEqual(proposed(300, 'ate 300 kcal'));
  });
});

describe('bounds, negations and per-portion qualifiers keep their own reason beside every kind of vessel context', () => {
  const CONTEXTS: Array<[string, (value: string) => string]> = [
    ['label before', (value) => `Whole pot\n${value}`],
    ['label after', (value) => `${value}\nWhole pot`],
    ['unresolved', (value) => `Whole pot blorped\n${value}`],
    ['batch', (value) => `I cooked a full pot of soup.\n${value}`],
    ['action', (value) => `Washed the whole pan.\n${value}`],
    ['confirmed elsewhere', (value) => `The whole pan has protein 99 g. ${value}`],
  ];
  it.each(CONTEXTS)('%s', (_label, build) => {
    expect(ground(build('Soup, up to 900 kcal'), 'energyKcal', '900', '900 kcal')).toEqual(withheld('ambiguous'));
    expect(ground(build('Soup, not 900 kcal'), 'energyKcal', '900', '900 kcal')).toEqual(withheld('negated'));
    expect(ground(build('Soup, 900 kcal per serving'), 'energyKcal', '900', '900 kcal')).toEqual(withheld('per_portion'));
    expect(ground(build('Soup, 900 kcal - 1000 kcal'), 'energyKcal', '900', '900 kcal')).toEqual(withheld('ambiguous'));
  });
});

describe('every proposal keeps valid original evidence and exact numeric equality', () => {
  it('holds across the generated texts above and the established controls', () => {
    const pool: Array<[string, MealNutritionField, string, string]> = [];
    for (const language of ['en', 'ru'] as const) {
      for (const order of permutations(CONSUMED_ITEMS[language]).slice(0, 6)) {
        for (const br of BREAKS) {
          const text = `The whole pot is ${CONTAINER_ITEMS[language].map((item) => item.text).join(', ')}.${br}${CONSUMED_LEAD[language]} ${order.map((item) => item.text).join(', ')}.`;
          for (const item of [...order, ...CONTAINER_ITEMS[language]]) pool.push([text, item.field, item.value, item.text]);
        }
      }
    }
    pool.push(['Cooked soup in a full pot. Lunch, 300 kcal.', 'energyKcal', '300', '300 kcal']);
    pool.push(['Soup, 300 kcal\nWhole pot washed afterwards', 'energyKcal', '300', '300 kcal']);
    pool.push(['Chicken salad, 450 kcal, protein 35 g, fat 20,5 g, carbs 0 g', 'fatG', '20,5', 'fat 20,5 g']);
    let proposals = 0;
    for (const [text, field, value, evidence] of pool) {
      const result = ground(text, field, value, evidence);
      if (result.status !== 'proposed') continue;
      proposals += 1;
      // The excerpt is the original text at the claimed evidence, and the value is exactly the claimed decimal.
      expect(text.includes(result.excerpt), JSON.stringify(text)).toBe(true);
      expect(result.excerpt).toBe(evidence);
      expect(result.value).toBe(Number(value.replace(',', '.')));
    }
    expect(proposals).toBeGreaterThan(20);
  });
});

// Overlapping constructions (2026-11-18). One whole-vessel reference can be read by two supported constructions at once:
// "Soup, 300 kcal, the whole pot has 900 kcal" is both "300 kcal, the whole pot" (a figure qualified by the vessel after
// it) and "the whole pot has 900 kcal" (the vessel as the subject). Which list the vessel's figure is cannot be decided,
// so neither reading may take a value out of the conflict scan: both lists are unresolved. Equivalent readings of the
// same list ("900 kcal for the whole pot" read from "900" and from "kcal"; "вся кастрюля содержит" read from "вся" and
// from "кастрюля") are one reading and stay confirmed.
describe('competing constructions sharing one vessel reference never remove a value from the conflict scan', () => {
  const COMPETING: Record<Language, (first: string, second: string) => string> = {
    en: (first, second) => `Soup, ${first}, the whole pot has ${second}.`,
    ru: (first, second) => `Суп, ${first}, вся кастрюля содержит ${second}.`,
  };
  const LAST_LEAD_WORD: Record<Language, string> = { en: 'ate', ru: 'съела' };

  it('withholds the reproduction as conflicting, claiming the final consumed 900', () => {
    const text = 'Soup, 300 kcal, the whole pot has 900 kcal. In total I ate 900 kcal.';
    expect(ground(text, 'energyKcal', '900', 'ate 900 kcal')).toEqual(withheld('conflicting'));
  });

  it('withholds the same text as conflicting when the final consumed total is 300', () => {
    const text = 'Soup, 300 kcal, the whole pot has 900 kcal. In total I ate 300 kcal.';
    expect(ground(text, 'energyKcal', '300', 'ate 300 kcal')).toEqual(withheld('conflicting'));
  });

  it('withholds a consumption statement that competes for the vessel as conflicting', () => {
    const text = 'I ate 300 kcal, the whole pot has 900 kcal. In total I ate 900 kcal.';
    expect(ground(text, 'energyKcal', '900', 'In total I ate 900 kcal')).toEqual(withheld('conflicting'));
    expect(ground(text, 'energyKcal', '300', '300 kcal').status).toBe('withheld');
  });

  for (const language of ['en', 'ru'] as const) {
    it(`withholds either final total for every field, across LF, CRLF and a space, with exact decimals (${language})`, () => {
      for (const first of CONSUMED_ITEMS[language]) {
        const second = CONTAINER_ITEMS[language].find((item) => item.field === first.field)!;
        for (const br of [' ', ...BREAKS]) {
          for (const final of [first, second]) {
            const text = `${COMPETING[language](first.text, second.text)}${br}${CONSUMED_LEAD[language]} ${final.text}.`;
            const evidence = `${LAST_LEAD_WORD[language]} ${final.text}`;
            expect(ground(text, final.field, final.value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
          }
        }
      }
      // Equivalent decimal spellings are one value, so the conflict is between the two numbers, not their notation.
      const decimals: Record<Language, [string, MealNutritionField, string, string]> = {
        en: ['Soup, fat 15,5 g, the whole pot has fat 45.5 g.\r\nIn total I ate fat 45,50 g.', 'fatG', '45.5', 'ate fat 45,50 g'],
        ru: ['Суп, 300,0 ккал, вся кастрюля содержит 900 ккал.\nИтого съела 900.00 ккал.', 'energyKcal', '900', 'съела 900.00 ккал'],
      };
      const [text, field, value, evidence] = decimals[language];
      expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
    });

    it(`keeps both competing lists in the conflict scan for every order of either list (${language})`, () => {
      const firstOrders = permutations(CONSUMED_ITEMS[language]);
      const secondOrders = permutations(CONTAINER_ITEMS[language]);
      let checked = 0;
      firstOrders.forEach((firstOrder, index) => {
        const secondOrder = secondOrders[(index * 5) % secondOrders.length]!;
        const base = COMPETING[language](firstOrder.map((item) => item.text).join(', '), secondOrder.map((item) => item.text).join(', '));
        for (const br of BREAKS) {
          for (const final of [...firstOrder, ...secondOrder]) {
            const text = `${base}${br}${CONSUMED_LEAD[language]} ${final.text}.`;
            const evidence = `${LAST_LEAD_WORD[language]} ${final.text}`;
            expect(ground(text, final.field, final.value, evidence), JSON.stringify(text)).toEqual(withheld('conflicting'));
            checked += 1;
          }
          // Neither list is proposable: each one's vessel attribution is undecided.
          for (const item of [...firstOrder, ...secondOrder]) {
            expect(ground(`${base}${br}`, item.field, item.value, item.text), JSON.stringify(base)).toEqual(withheld('per_portion'));
          }
        }
      });
      expect(checked).toBe(24 * 2 * 8);
    });
  }

  it('leaves an unrelated list and an unrelated confirmed statement as they were', () => {
    for (const br of BREAKS) {
      // A confirmed statement of another vessel stays confirmed: its protein leaves the scan, the consumed protein is proposed.
      const unrelated = `The whole pan has protein 99 g.${br}Soup, 300 kcal, the whole pot has 900 kcal.${br}In total I ate protein 20 g.`;
      expect(ground(unrelated, 'proteinG', '20', 'protein 20 g'), JSON.stringify(unrelated)).toEqual(proposed(20, 'protein 20 g'));
      // A list with no vessel construction keeps no attribution and stays in the scan.
      const ordinary = `Lunch, 450 kcal.${br}Soup, 300 kcal, the whole pot has 300 kcal.${br}In total I ate 300 kcal.`;
      expect(ground(ordinary, 'energyKcal', '300', 'ate 300 kcal'), JSON.stringify(ordinary)).toEqual(withheld('conflicting'));
    }
  });

  it('does not manufacture a conflict when both competing lists state the consumed value', () => {
    const text = 'Soup, 300 kcal, the whole pot has 300 kcal. In total I ate 300.0 kcal.';
    expect(ground(text, 'energyKcal', '300', 'ate 300.0 kcal')).toEqual(proposed(300, 'ate 300.0 kcal'));
  });

  it('treats equivalent overlapping readings of one list as one confirmed reading', () => {
    for (const br of [' ', ...BREAKS]) {
      for (const [text, field, value, evidence] of [
        // Read from the number and from the energy word "kcal": the same list, the same vessel.
        [`900 kcal for the whole pot.${br}In total I ate 300 kcal.`, 'energyKcal', '300', '300 kcal'],
        [`Protein 80 g, the whole pot.${br}In total I ate protein 20 g.`, 'proteinG', '20', 'protein 20 g'],
        [`The whole pot: 900 kcal, protein 80 g.${br}In total I ate 300 kcal, protein 20 g.`, 'proteinG', '20', 'protein 20 g'],
        // Read from the quantifier and from the nominative vessel.
        [`Вся кастрюля содержит 900 ккал, белки 80 г.${br}Итого съела 300 ккал, белки 20 г.`, 'energyKcal', '300', '300 ккал'],
        [`Вся кастрюля 900 ккал.${br}Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`900 ккал на всю кастрюлю.${br}Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
        [`Кастрюля целиком: 900 ккал.${br}Итого съела 300 ккал.`, 'energyKcal', '300', '300 ккал'],
      ] as const) {
        expect(ground(text, field, value, evidence), JSON.stringify(text)).toEqual(proposed(Number(value), evidence));
      }
    }
  });
});

describe('established positive controls still pass (rejecting everything is not success)', () => {
  it.each([
    ['Cooked soup in a full pot. Lunch, 300 kcal.', 'energyKcal', '300', '300 kcal', 300],
    ['The whole pot has 900 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal', 300],
    ['900 kcal for the whole pot. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal', 300],
    ['The whole pot is 900 kcal, protein 80 g, fat 45 g. In total I ate 300 kcal, protein 20 g, fat 15 g.', 'fatG', '15', 'fat 15 g', 15],
    ['Soup, 300 kcal\nWhole pot washed afterwards', 'energyKcal', '300', '300 kcal', 300],
    ['Pot roast, 500 kcal', 'energyKcal', '500', '500 kcal', 500],
    ['Суп из кастрюли, 300 ккал', 'energyKcal', '300', '300 ккал', 300],
    ['Полная кастрюля помыта\n900 ккал', 'energyKcal', '900', '900 ккал', 900],
    ['Whole pot\n900 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal', 300],
    ['Полная кастрюля супа\r\n900 ккал. Итого съела 300 ккал.', 'energyKcal', '300', '300 ккал', 300],
    ['Soup 300 kcal per bowl. In total I ate 600 kcal.', 'energyKcal', '600', '600 kcal', 600],
  ] as const)('%s', (text, field, value, evidence, expected) => {
    expect(ground(text, field, value, evidence)).toEqual(proposed(expected, evidence));
  });
  for (const field of FIELDS) {
    it(`proposes a plain ${field} value with no context`, () => {
      const item = CONSUMED_ITEMS.en.find((entry) => entry.field === field)!;
      expect(ground(`Lunch, ${item.text}`, field, item.value, item.text)).toEqual(proposed(Number(item.value), item.text));
    });
  }
});
