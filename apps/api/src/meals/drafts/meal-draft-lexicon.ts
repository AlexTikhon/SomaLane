import type { MealNutritionField } from '@running-tracker/contracts';

// Shared vocabulary of the "Draft from text" grounding (ADR-0092): units, nutrient names, word boundaries and signs, used
// by the mention recogniser (`meal-draft-mentions.ts`), the vessel-scope analysis (`meal-draft-vessel-scope.ts`) and the
// grounding itself (`meal-draft-grounding.ts`). English and Russian, matched case-insensitively and never inside a longer
// word.

export const NOT_LETTER_BEFORE = '(?<![\\p{L}])';
export const NOT_LETTER_AFTER = '(?![\\p{L}])';
export const SPACE = '[ \\u00A0\\u202F]';

// Longest alternatives first: a regular expression alternation takes the first that matches.
export const ENERGY_UNIT = '(?:kilocalories|kilocalorie|kcals|kcal|calories|calorie|cals|cal|килокалорий|килокалории|килокалория|ккал|калорий|калории|калория|кал)';
export const GRAM_UNIT = '(?:grammes|gramme|grams|gram|gr|g|граммов|грамма|грамм|гр|г)';
export const OTHER_UNIT = '(?:kj|кдж|mcg|мкг|mg|мг|kg|кг|oz|lbs|lb|ml|мл|l|л|%)';
// Words that name food energy as a unit when they come BEFORE the number ("Calories: 650", "ккал 650").
export const ENERGY_UNIT_WORD_BEFORE = '(?:kcal|calories|калорий|калории|калорийность|ккал)';

export const METRIC: Readonly<Record<Exclude<MealNutritionField, 'energyKcal'>, string>> = {
  carbohydrateG: '(?:carbohydrates|carbohydrate|carbs|carb|углеводов|углеводы|углевода|углевод)',
  fatG: '(?:fats|fat|жиров|жиры|жира|жир)',
  proteinG: '(?:proteins|protein|белков|белка|белки|белке|белком|белок|протеина|протеин)',
};


export const word = (alternatives: string) => new RegExp(`${NOT_LETTER_BEFORE}${alternatives}${NOT_LETTER_AFTER}`, 'iu');


// Minus signs. ASCII hyphen-minus, the Unicode minus and their hyphen-like variants are a sign whenever they stand before
// a number that does not follow another number (that is a range). The en dash is a sign only directly before the digits;
// spaced, it is the usual separator ("Soup – 300 kcal"), as the em dash always is ("Белки — 35 г").
export const MINUS = /[-‐‑‒−﹣－]/u;
export const MINUS_OR_DASH = '[\\u002D\\u2010-\\u2014\\u2212\\uFE63\\uFF0D]';
