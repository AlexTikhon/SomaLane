import { mealDraftProposalResponseSchema, type MealNutritionField } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { groundMealDraft, groundNutrient } from './meal-draft-grounding.js';
import type { MealDraftWireDraft, NutrientClaim } from './meal-draft-wire.js';

// Regressions for two further confirmed grounding defects of ADR-0092 (third correction, 2026-11-15):
//   C. a summing phrase alone was taken as proof that a value is what was eaten, so a package's total escaped the label
//      and the partial consumption ("I ate half the yogurt. Nutrition facts per 100 g: 60 kcal. In total the package has
//      4 g protein.");
//   D. a range or alternative was dismissed because its endpoints carry different units ("Soup, 500 kcal to\n2500 kJ",
//      "Soup, fat 5 g to\n6000 mg").
// Every claim below is schema-valid and UNSAFE unless marked as a positive control. Nothing here calls a model.

const claim = (value: string, evidence: string): NutrientClaim => ({ abstain: null, evidence, value });
const ground = (text: string, field: MealNutritionField, value: string, evidence: string) => groundNutrient(text, field, claim(value, evidence)).result;
const withheld = (reason: string) => ({ reason, status: 'withheld' });
const proposed = (value: number, excerpt: string) => ({ excerpt, status: 'proposed', value });

describe('defect C: a whole-entry value must be bound to an assertion of what was eaten', () => {
  const reproduction = 'I ate half the yogurt. Nutrition facts per 100 g: 60 kcal. In total the package has 4 g protein.';

  it('withholds the reproduction, with the shortest or a longer excerpt', () => {
    expect(ground(reproduction, 'proteinG', '4', '4 g protein')).toEqual(withheld('per_portion'));
    expect(ground(reproduction, 'proteinG', '4', 'In total the package has 4 g protein')).toEqual(withheld('per_portion'));
    expect(ground(reproduction, 'energyKcal', '60', '60 kcal')).toEqual(withheld('per_portion'));
  });

  it.each([
    // A package, box, bag or jar total beside partial consumption, with and without a label or per-portion qualifier.
    ['en pack beside a label', 'I ate half the yogurt. Per 100 g: 60 kcal. In total the pack has 120 kcal.', 'energyKcal', '120', '120 kcal'],
    ['en box beside a serving', 'I ate a quarter of the box. Per serving: 110 kcal. Altogether the box has 40 g fat.', 'fatG', '40', '40 g fat'],
    ['en package, no label', 'I ate half the yogurt. In total the package has 4 g protein.', 'proteinG', '4', '4 g protein'],
    ['en bag, no label', 'Ate half a bag of chips. The bag has 800 kcal in total.', 'energyKcal', '800', '800 kcal'],
    ['en jar, no label', 'I ate part of the jar. In total the jar holds 30 g carbs.', 'carbohydrateG', '30', '30 g carbs'],
    ['en product, no label', 'I ate some of it. Altogether the product has 25 g protein.', 'proteinG', '25', '25 g protein'],
    ['ru упаковка beside a label', 'Съел половину йогурта. Пищевая ценность на 100 г: 60 ккал. Итого в упаковке 4 г белка.', 'proteinG', '4', '4 г белка'],
    ['ru пачка, no label', 'Съела полпачки печенья. Итого в пачке 2000 ккал.', 'energyKcal', '2000', '2000 ккал'],
    ['ru банка, no label', 'Съел треть банки. В сумме в банке жиры 15 г.', 'fatG', '15', 'жиры 15 г'],
    ['ru бутылка, no label', 'Выпил часть бутылки. Суммарно в бутылке углеводы 50 г.', 'carbohydrateG', '50', 'углеводы 50 г'],
  ])('withholds a container total despite partial consumption (%s)', (_name, text, field, value, evidence) => {
    expect(ground(text, field as MealNutritionField, value, evidence)).toEqual(withheld('per_portion'));
  });

  it.each([
    ['en energy', 'Yogurt. Per 100 g: 60 kcal. In total 120 kcal.', 'energyKcal', '120', '120 kcal'],
    ['en protein, "it has"', 'Yogurt. Nutrition facts per 100 g: 60 kcal. In total it has 8 g protein.', 'proteinG', '8', '8 g protein'],
    ['en third person "had"', 'Yogurt. Per 100 g: 60 kcal. In total the yogurt had 4 g protein.', 'proteinG', '4', '4 g protein'],
    ['en altogether', 'Bread. Per slice: 80 kcal. Altogether fat 3 g.', 'fatG', '3', 'fat 3 g'],
    ['ru итого', 'Творог. На 100 г: 120 ккал. Итого 240 ккал.', 'energyKcal', '240', '240 ккал'],
    ['ru в сумме', 'Суп. На 100 г: 50 ккал. В сумме жиры 6 г.', 'fatG', '6', 'жиры 6 г'],
    ['ru суммарно', 'Каша, на порцию 200 ккал. Суммарно углеводы 70 г.', 'carbohydrateG', '70', 'углеводы 70 г'],
  ])('withholds a summing phrase without any consumption beside a label or qualifier (%s)', (_name, text, field, value, evidence) => {
    expect(ground(text, field as MealNutritionField, value, evidence)).toEqual(withheld('per_portion'));
  });

  it('does not let a consumption phrase in another sentence authorize a value', () => {
    expect(ground('I ate the yogurt. Per 100 g: 60 kcal. In total 120 kcal.', 'energyKcal', '120', '120 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Per 100 g: 60 kcal. In total I ate yogurt; it has 120 kcal.', 'energyKcal', '120', '120 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Я съел творог. На 100 г: 120 ккал. Итого 240 ккал.', 'energyKcal', '240', '240 ккал')).toEqual(withheld('per_portion'));
    expect(ground('Съел творог.\nНа 100 г: 120 ккал. В сумме белки 32 г.', 'proteinG', '32', 'белки 32 г')).toEqual(withheld('per_portion'));
  });

  it('does not bind a value to a consumption verb in its sentence when something else stands between them', () => {
    // What was eaten is "the yogurt" or "half"; the value belongs to the yogurt or the package, not to the amount eaten.
    expect(ground('Per 100 g: 60 kcal. In total I ate the yogurt, which has 4 g protein.', 'proteinG', '4', '4 g protein')).toEqual(withheld('per_portion'));
    expect(ground('Per 100 g: 60 kcal. In total I ate half, the yogurt has 4 g protein.', 'proteinG', '4', '4 g protein')).toEqual(withheld('per_portion'));
    expect(ground('Per 100 g: 60 kcal. In total I ate the package with 120 kcal.', 'energyKcal', '120', '120 kcal')).toEqual(withheld('per_portion'));
    expect(ground('На 100 г: 60 ккал. Итого я съел йогурт, в котором 4 г белка.', 'proteinG', '4', '4 г белка')).toEqual(withheld('per_portion'));
    expect(ground('На 100 г: 60 ккал. В сумме съел половину, в упаковке 4 г белка.', 'proteinG', '4', '4 г белка')).toEqual(withheld('per_portion'));
    // The value before the verb is not asserted as eaten by this rule.
    expect(ground('Per 100 g: 60 kcal. In total 120 kcal is what I ate.', 'energyKcal', '120', '120 kcal')).toEqual(withheld('per_portion'));
  });

  it('withholds a consumed-looking sentence that names a container or a partial amount itself', () => {
    expect(ground('Per 100 g: 60 kcal. In total I ate 120 kcal of the package.', 'energyKcal', '120', '120 kcal')).toEqual(withheld('per_portion'));
    expect(ground('Per 100 g: 60 kcal. In total I ate 120 kcal, half of it.', 'energyKcal', '120', '120 kcal')).toEqual(withheld('per_portion'));
    expect(ground('На 100 г: 60 ккал. Итого съел 120 ккал из пачки.', 'energyKcal', '120', '120 ккал')).toEqual(withheld('per_portion'));
  });

  it('proposes the totals the person states as eaten and withholds the label values (positive control from the brief)', () => {
    const text = 'Yogurt 200 g. Per 100 g: 60 kcal, protein 4 g. In total I ate 120 kcal, protein 8 g.';
    expect(ground(text, 'energyKcal', '120', '120 kcal')).toEqual(proposed(120, '120 kcal'));
    expect(ground(text, 'proteinG', '8', 'protein 8 g')).toEqual(proposed(8, 'protein 8 g'));
    expect(ground(text, 'energyKcal', '60', '60 kcal')).toEqual(withheld('per_portion'));
    expect(ground(text, 'proteinG', '4', 'protein 4 g')).toEqual(withheld('per_portion'));
  });

  it('proposes explicit consumed totals in EN and RU wording, with zero and exact decimals (positive controls)', () => {
    expect(ground('Yogurt. Per 100 g: 60 kcal. I had 120 kcal in total.', 'energyKcal', '120', '120 kcal')).toEqual(proposed(120, '120 kcal'));
    expect(ground('Yogurt. Per 100 g: 60 kcal. Altogether I consumed 120 kcal and 8 g protein.', 'proteinG', '8', '8 g protein')).toEqual(proposed(8, '8 g protein'));
    expect(ground('Yogurt. Per 100 g: 60 kcal. I have eaten, in total, fat 0 g.', 'fatG', '0', 'fat 0 g')).toEqual(proposed(0, 'fat 0 g'));
    expect(ground('Juice. Per 100 ml: 45 kcal. In total I drank 112.5 kcal.', 'energyKcal', '112.5', '112.5 kcal')).toEqual(proposed(112.5, '112.5 kcal'));
    expect(ground('Творог. На 100 г: 120 ккал. Итого съел 240 ккал, белки 32 г.', 'proteinG', '32', 'белки 32 г')).toEqual(proposed(32, 'белки 32 г'));
    expect(ground('Сыр. На 100 г: 350 ккал. В сумме я съела 0 г углеводов.', 'carbohydrateG', '0', '0 г углеводов')).toEqual(proposed(0, '0 г углеводов'));
    expect(ground('Кефир. На 100 мл: 50 ккал. Суммарно выпил 12,50 г белка.', 'proteinG', '12,5', '12,50 г белка')).toEqual(proposed(12.5, '12,50 г белка'));
    expect(ground('Каша. На 100 г: 90 ккал. Съедено в общей сложности 180 ккал.', 'energyKcal', '180', '180 ккал')).toEqual(proposed(180, '180 ккал'));
  });

  it('proposes an explicit consumed total beside partial consumption, without computing anything (positive control)', () => {
    const text = 'I ate half the yogurt. Nutrition facts per 100 g: 60 kcal. In total I ate 90 kcal.';
    expect(ground(text, 'energyKcal', '90', '90 kcal')).toEqual(proposed(90, '90 kcal'));
    expect(ground(text, 'energyKcal', '60', '60 kcal')).toEqual(withheld('per_portion'));
  });

  it('keeps conflict detection on the consumed scope; an unconsumed package total never conflicts', () => {
    expect(ground('Soup. Per 100 g: 50 kcal. In total I ate 300 kcal. In total I ate 350 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(withheld('conflicting'));
    expect(ground('Суп. На 100 г: 50 ккал. Итого съел 300 ккал. Итого съел 350 ккал.', 'energyKcal', '350', '350 ккал')).toEqual(withheld('conflicting'));
    expect(ground('Soup. Per 100 g: 50 kcal. In total the package has 900 kcal. In total I ate 300 kcal.', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
  });

  it('keeps ordinary whole-entry descriptions without label, portion, container or partial context (positive controls)', () => {
    expect(ground('Dinner: chicken and rice, total 650 kcal, protein 40 g', 'energyKcal', '650', '650 kcal')).toEqual(proposed(650, '650 kcal'));
    expect(ground('Yogurt, total protein 4 g', 'proteinG', '4', 'protein 4 g')).toEqual(proposed(4, 'protein 4 g'));
    expect(ground('I ate soup, 300 kcal', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground('Каша, всего 310 ккал, белки 9,5 г', 'proteinG', '9,5', 'белки 9,5 г')).toEqual(proposed(9.5, 'белки 9,5 г'));
    expect(ground('Завтрак: овсянка 60 г и банан, 310 ккал', 'energyKcal', '310', '310 ккал')).toEqual(proposed(310, '310 ккал'));
  });
});

describe('defect D: a range or alternative keeps its meaning when its endpoints carry different units', () => {
  it('withholds the two reproductions', () => {
    expect(ground('Soup, 500 kcal to\n2500 kJ', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, fat 5 g to\n6000 mg', 'fatG', '5', 'fat 5 g')).toEqual(withheld('ambiguous'));
  });

  it.each([['to'], ['or'], ['до'], ['или']])('withholds mixed-unit ranges joined by "%s", from either endpoint, across whitespace', (connector) => {
    const energy = [
      `Soup, 500 kcal ${connector}\n2500 kJ`,
      `Soup, 500 kcal\n${connector} 2500 kJ`,
      `Soup, 500 kcal ${connector}\r\n2500 kJ`,
      `Soup, 2500 kJ ${connector}\n500 kcal`,
      `Soup, 2500 кДж ${connector}\n500 kcal`,
    ];
    for (const text of energy) expect(ground(text, 'energyKcal', '500', '500 kcal'), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    const nbsp = String.fromCodePoint(0xa0);
    const noBreak = `Soup, 500${nbsp}kcal${nbsp}${connector}\n${nbsp}2500${nbsp}kJ`;
    expect(ground(noBreak, 'energyKcal', '500', `500${nbsp}kcal`), JSON.stringify(noBreak)).toEqual(withheld('ambiguous'));
    const fat: Array<[string, string]> = [
      [`Soup, fat 5 g ${connector}\n6000 mg`, 'fat 5 g'],
      [`Soup, 6000 mg ${connector}\n5 g fat`, '5 g fat'],
      [`Soup, 6000 mg ${connector}\nfat 5 g`, 'fat 5 g'],
      [`Soup, 5 g of fat ${connector}\n6000 mg of fat`, '5 g of fat'],
      [`Soup, fat 5 g ${connector}\n0.2 oz`, 'fat 5 g'],
    ];
    for (const [text, evidence] of fat) expect(ground(text, 'fatG', '5', evidence), JSON.stringify(text)).toEqual(withheld('ambiguous'));
  });

  it('withholds an alternative whose other endpoint has an unsupported unit or another measure', () => {
    expect(ground('Soup, 2 cups or\n500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup, 500 kcal or\n2 cups', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Салат, 2 миски или\n5 г жира', 'fatG', '5', '5 г жира')).toEqual(withheld('ambiguous'));
    expect(ground('Soup 300 kcal or\n5 g protein', 'energyKcal', '300', '300 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup 300 kcal or\n5 g protein', 'proteinG', '5', '5 g protein')).toEqual(withheld('ambiguous'));
  });

  it.each([
    ['ASCII hyphen', '-'],
    ['hyphen', '‐'],
    ['non-breaking hyphen', '‑'],
    ['figure dash', '‒'],
    ['en dash', '–'],
    ['em dash', '—'],
    ['minus sign', '−'],
    ['small hyphen-minus', '﹣'],
    ['fullwidth hyphen-minus', '－'],
  ])('withholds a %s range between two units of the same measure (kcal/kJ, g/mg)', (_name, dash) => {
    for (const text of [`Soup, 500 kcal ${dash}\n2500 kJ`, `Soup, 500 kcal${dash}2500 kJ`, `Soup, 2500 kJ ${dash}\n500 kcal`]) {
      expect(ground(text, 'energyKcal', '500', '500 kcal'), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    }
    for (const [text, evidence] of [
      [`Soup, fat 5 g ${dash}\n6000 mg`, 'fat 5 g'],
      [`Soup, 6000 mg ${dash}\n5 g fat`, '5 g fat'],
      [`Soup, 5 g fat ${dash}\n6000 mg`, '5 g fat'],
    ] as const) {
      expect(ground(text, 'fatG', '5', evidence), JSON.stringify(text)).toEqual(withheld('ambiguous'));
    }
  });

  it('keeps separate statements joined by a dash when the units measure different things (positive controls)', () => {
    const mixed = 'Soup 300 kcal –\n5 g protein';
    expect(ground(mixed, 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
    expect(ground(mixed, 'proteinG', '5', '5 g protein')).toEqual(proposed(5, '5 g protein'));
    expect(ground('Milk 200 ml –\n120 kcal', 'energyKcal', '120', '120 kcal')).toEqual(proposed(120, '120 kcal'));
    expect(ground('Milk 200 ml –\n6 g protein', 'proteinG', '6', '6 g protein')).toEqual(proposed(6, '6 g protein'));
    expect(ground('Shake, protein 30 g\n– 5 g fat', 'fatG', '5', '5 g fat')).toEqual(proposed(5, '5 g fat'));
    expect(ground('Yogurt, fat 5 g – 10%', 'fatG', '5', 'fat 5 g')).toEqual(proposed(5, 'fat 5 g'));
    expect(ground('Soup 300 kcal; 1255 kJ', 'energyKcal', '300', '300 kcal')).toEqual(proposed(300, '300 kcal'));
  });

  it('keeps zero and exact decimals in separate statements, and the earlier sign and precision fixes (positive controls)', () => {
    expect(ground('Tea 0 kcal –\n0 g fat', 'energyKcal', '0', '0 kcal')).toEqual(proposed(0, '0 kcal'));
    expect(ground('Tea 0 kcal –\n0 g fat', 'fatG', '0', '0 g fat')).toEqual(proposed(0, '0 g fat'));
    expect(ground('Oil, fat 13.50 g –\n120 kcal', 'fatG', '13.5', 'fat 13.50 g')).toEqual(proposed(13.5, 'fat 13.50 g'));
    expect(ground('Йогурт, белок 12,5 г —\n90 ккал', 'proteinG', '12,5', 'белок 12,5 г')).toEqual(proposed(12.5, 'белок 12,5 г'));
    expect(ground('Soup, - 500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('ambiguous'));
    expect(ground('Soup,\n-500 kcal', 'energyKcal', '500', '500 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Soup\nprotein 12.5000000000000001 g', 'proteinG', '12.5', 'protein 12.5000000000000001 g')).toEqual(withheld('unverified'));
    expect(ground('Soup\nprotein 12.55 g', 'proteinG', '12.55', 'protein 12.55 g')).toEqual(withheld('outside_contract'));
    expect(ground('Feast\n20000.05 kcal', 'energyKcal', '20000.05', '20000.05 kcal')).toEqual(withheld('outside_contract'));
    expect(ground('Feast\n20000 kcal', 'energyKcal', '20000', '20000 kcal')).toEqual(proposed(20000, '20000 kcal'));
  });
});

describe('a grounded answer with the third correction still fits the public response contract', () => {
  it('builds a valid draft: package totals and mixed-unit ranges withheld, consumed totals proposed', () => {
    const text = 'Lunch: yogurt, I ate half. Per 100 g: 60 kcal. In total the package has 4 g protein. In total I ate 90 kcal, 0 g fat, carbs 6 g to\n6000 mg.';
    const answer: MealDraftWireDraft = {
      carbohydrateG: claim('6', 'carbs 6 g'),
      energyKcal: claim('90', '90 kcal'),
      fatG: claim('0', '0 g fat'),
      mealType: 'lunch',
      mealTypeEvidence: 'Lunch',
      outcome: 'draft',
      proteinG: claim('4', '4 g protein'),
      title: 'yogurt',
    };
    const { proposal } = groundMealDraft(text, answer);
    expect(proposal).toMatchObject({
      nutrition: {
        carbohydrateG: { reason: 'ambiguous', status: 'withheld' },
        energyKcal: { status: 'proposed', value: 90 },
        fatG: { status: 'proposed', value: 0 },
        proteinG: { reason: 'per_portion', status: 'withheld' },
      },
    });
    expect(mealDraftProposalResponseSchema.safeParse({ ...proposal, localDate: '2026-11-15', timeZone: 'Europe/Warsaw', version: 'meal-draft-1' }).success).toBe(true);
  });
});
