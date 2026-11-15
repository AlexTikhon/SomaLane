import {
  MEAL_DRAFT_EXCERPT_MAX,
  MEAL_NUTRITION_FIELDS,
  MEAL_NUTRITION_MAX,
  MEAL_VALUE_DECIMALS,
  mealCarbohydrateGSchema,
  mealEnergyKcalSchema,
  mealFatGSchema,
  mealProteinGSchema,
  mealTitleSchema,
  type MealDraftClarificationReason,
  type MealDraftMealType,
  type MealDraftNutrition,
  type MealDraftNutritionResult,
  type MealDraftUnsupportedReason,
  type MealDraftWithheldReason,
  type MealNutritionField,
  type MealType,
} from '@running-tracker/contracts';
import type { z } from 'zod';

import type { MealDraftAbstention, MealDraftWireAnswer, NutrientClaim } from './meal-draft-wire.js';

// The grounding step of "Draft from text" (ADR-0092): deterministic code that decides what of a model's answer may be
// shown to the person as a proposal. The model only CLAIMS: "this excerpt of the text says protein 40 g". This module
// finds the excerpt in the text, finds the number in it with its own tokenizer, reads the sign before it in the ORIGINAL
// text, checks that the number is followed by the field's unit and attached to the field's nutrient, refuses a bound or
// negation in its clause or bound to its statement across any whitespace (before it, left dangling at a line end, or
// after it; "до", "от", "between … and"), a range or alternative around the number in the original text (across line
// breaks; "to", "or", "до", "или" whatever the units, a dash between units of the same measure) and a hedge anywhere, establishes that it is a
// whole-entry total (a per-portion qualifier, a nutrition label, a container or a partial amount anywhere in the text
// requires the person's own summing phrase, such as "in total" or "итого", never a label's "total", AND an assertion in
// the same sentence that the value was eaten, such as "I ate", because commas, lists, sentences and line breaks do not end
// a qualifier's scope and a summing phrase alone may sum a package), scans the text for a different value of the same
// nutrient under the same scope rule, and finally
// applies the meal contract (ADR-0083) to the exact decimal digits before any conversion to a number. It never computes a
// number: a proposed value is the number the person wrote, parsed exactly, or nothing.
//
// The rules are deliberately conservative. A false abstention costs the person one field to type; a false acceptance
// puts a number in their diary that they did not mean. When in doubt, the field is withheld.

export class UngroundedOutputError extends Error {
  public constructor() {
    super('The model answer is not grounded in the text');
    this.name = 'UngroundedOutputError';
  }
}

export type GroundedProposal =
  | { mealType: MealDraftMealType; nutrition: MealDraftNutrition; outcome: 'draft'; title: string }
  | { outcome: 'clarify'; reason: MealDraftClarificationReason }
  | { outcome: 'unsupported'; reason: MealDraftUnsupportedReason };

/** What happened to each field, for bounded logs and the evaluation. Never content. */
export type FieldDisposition = 'model_abstained' | 'not_stated' | 'proposed' | 'server_withheld';

export interface GroundingAudit {
  fields: Record<MealNutritionField, FieldDisposition> | null;
  /** The model answered with a draft, and the text names two different meals: the answer became a clarification. */
  multipleMealsOverride: boolean;
}

export interface GroundingResult {
  audit: GroundingAudit;
  proposal: GroundedProposal;
}

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary. English and Russian, matched case-insensitively and never inside a longer word.

const NOT_LETTER_BEFORE = '(?<![\\p{L}])';
const NOT_LETTER_AFTER = '(?![\\p{L}])';
const SPACE = '[ \\u00A0\\u202F]';

// Longest alternatives first: a regular expression alternation takes the first that matches.
const ENERGY_UNIT = '(?:kilocalories|kilocalorie|kcals|kcal|calories|calorie|cals|cal|килокалорий|килокалории|килокалория|ккал|калорий|калории|калория|кал)';
const GRAM_UNIT = '(?:grammes|gramme|grams|gram|gr|g|граммов|грамма|грамм|гр|г)';
const OTHER_UNIT = '(?:kj|кдж|mcg|мкг|mg|мг|kg|кг|oz|lbs|lb|ml|мл|l|л|%)';
// Words that name food energy as a unit when they come BEFORE the number ("Calories: 650", "ккал 650").
const ENERGY_UNIT_WORD_BEFORE = '(?:kcal|calories|калорий|калории|калорийность|ккал)';

const METRIC: Readonly<Record<Exclude<MealNutritionField, 'energyKcal'>, string>> = {
  carbohydrateG: '(?:carbohydrates|carbohydrate|carbs|carb|углеводов|углеводы|углевода|углевод)',
  fatG: '(?:fats|fat|жиров|жиры|жира|жир)',
  proteinG: '(?:proteins|protein|белков|белка|белки|белке|белком|белок|протеина|протеин)',
};

const MEAL_TYPE_WORDS: Readonly<Record<Exclude<MealType, 'other'>, string>> = {
  breakfast: '(?:breakfast\\p{L}*|позавтрака\\p{L}*|завтрак\\p{L}*)',
  dinner: '(?:dinner\\p{L}*|supper\\p{L}*|поужина\\p{L}*|ужин\\p{L}*)',
  lunch: '(?:lunch\\p{L}*|пообеда\\p{L}*|обед\\p{L}*)',
  snack: '(?:snack\\p{L}*|перекуси\\p{L}*|перекус\\p{L}*|полдник\\p{L}*)',
};

const word = (alternatives: string) => new RegExp(`${NOT_LETTER_BEFORE}${alternatives}${NOT_LETTER_AFTER}`, 'iu');

// Minus signs. ASCII hyphen-minus, the Unicode minus and their hyphen-like variants are a sign whenever they stand before
// a number that does not follow another number (that is a range). The en dash is a sign only directly before the digits;
// spaced, it is the usual separator ("Soup – 300 kcal"), as the em dash always is ("Белки — 35 г").
const MINUS = /[-‐‑‒−﹣－]/u;
const MINUS_OR_DASH = '[\\u002D\\u2010-\\u2014\\u2212\\uFE63\\uFF0D]';

// A per-portion qualifier: a value per something, or one that needs a multiplication to become a total. It can stand
// before or after the values it governs, in another clause, in a heading above a list or in a later sentence, so its
// presence ANYWHERE in the text means a value's whole-entry scope must be established explicitly (see `wholeEntryScoped`).
const PER_PORTION = new RegExp(
  [
    `${NOT_LETTER_BEFORE}(?:per|each|apiece|serving|servings|portion|portions|piece|pieces|pcs|pc|кажд\\p{L}*|порци\\p{L}*|штук\\p{L}*|шт)${NOT_LETTER_AFTER}`,
    // "по 70 ккал", "по 2 штуки": по before a number. Not "по-домашнему" or "по вкусу".
    `${NOT_LETTER_BEFORE}по${SPACE}*\\d`,
    // "in 100 g", "for 100", "на 100 г", "в 100 мл", "для 30 г".
    `${NOT_LETTER_BEFORE}(?:in|for|на|в|за|для)${SPACE}*100(?!\\d)`,
    `${NOT_LETTER_BEFORE}(?:in|for|на|в|за|для)${SPACE}*\\d+(?:[.,]\\d+)?${SPACE}*(?:grams|gram|gr|g|ml|граммов|грамма|грамм|гр|г|мл)${NOT_LETTER_AFTER}`,
    // "kcal/100 g", "g/serving": a slash after a unit. Not a date such as 14/11.
    '\\p{L}\\s*\\/\\s*[\\p{L}\\p{N}]',
    '\\d\\s*[x×*]\\s*\\d',
    `${NOT_LETTER_BEFORE}[x×]\\s*\\d`,
    '\\d\\s*[x×](?![\\p{L}\\p{N}])',
    `${NOT_LETTER_BEFORE}(?:twice|double|triple|times|дважды|раза)${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

// A nutrition label or its heading: the values under it are per serving or per 100 g, a basis the text may not state.
const NUTRITION_LABEL = new RegExp(
  `${NOT_LETTER_BEFORE}(?:nutrition facts|nutrition(?:al)? (?:information|info|values?|label)|label|этикетк\\p{L}*|на упаковке|пищев\\p{L}* ценност\\p{L}*|энергетическ\\p{L}* ценност\\p{L}*)${NOT_LETTER_AFTER}`,
  'iu',
);

// The person's own summing phrase: the only wording that ties a value to the entry when the text also carries a label or
// a per-portion qualifier (see `wholeEntryScoped`). Deliberately ONLY adverbial phrases that sum up what was eaten. Never
// a word a nutrition label prints or that also reads as an adjective in front of a nutrient, wherever it stands: "total"
// and "totals" ("Total fat 5 g", "Fat 4 g total", "Total: fat 4 g"), "overall" ("Overall fat"), and in Russian "всего"
// (also "only", and a label's "всего") or "целиком" (describes the food, not a figure). Those words are not refused; they
// simply prove nothing about scope, so a value they introduce stays under the label or qualifier.
const ENTRY_SUM = new RegExp(
  `${NOT_LETTER_BEFORE}(?:in${SPACE}+total|altogether|all${SPACE}+together|итого|в${SPACE}+сумме|суммарно|в${SPACE}+общей${SPACE}+сложности)${NOT_LETTER_AFTER}`,
  'iu',
);

// A container, a product, or a partial amount eaten. Values next to such words may be the whole package's or the
// product's ("I ate half the yogurt. The package has 4 g protein"), so their presence anywhere in the text means a value's
// whole-entry scope must be established explicitly, as for a label or a per-portion qualifier (see `wholeEntryScoped`).
// Nothing is inferred from them: not that the whole package was eaten, and never a fraction of a value.
const CONTAINER_OR_PARTIAL = new RegExp(
  [
    `${NOT_LETTER_BEFORE}(?:packages|package|packets|packet|packs|pack|containers|container|cartons|carton|boxes|box|bags|bag|jars|jar|bottles|bottle|tubs|tub|tins|tin|products|product)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}(?:half|halves|quarters|quarter|thirds|third|parts|part|partly|partially|some${SPACE}+of|most${SPACE}+of|bites|bite|sips|sip)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}(?:упаковк\\p{L}*|пачк\\p{L}*|банк(?:а|и|у|е|ой)|бутылк\\p{L}*|пакет\\p{L}*|коробк\\p{L}*|контейнер\\p{L}*|продукт\\p{L}*)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}(?:половин\\p{L}*|пол-?(?:упаковк|пачк|банк|бутылк|пакет|коробк|тарелк|порци|стакан)\\p{L}*|трет(?:ь|и|ью)|четверт\\p{L}*|част(?:ь|и|ью|ично))${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

// An assertion that something was eaten or drunk, by the person: a past or perfect consumption verb. In English "had"
// counts only with a first-person subject ("I had", "we've had"), because "the package had" is not consumption. Third
// persons in Russian are accepted as written ("съел", "съедено"); the rule is wording, not understanding.
const CONSUMPTION = new RegExp(
  `${NOT_LETTER_BEFORE}(?:ate|eaten|consumed|drank|drunk|(?:i|we)(?:['’]ve|${SPACE}+have)?${SPACE}+had|съел\\p{L}*|съеден\\p{L}*|скушал\\p{L}*|выпил\\p{L}*|употребил\\p{L}*|поел\\p{L}*)${NOT_LETTER_AFTER}`,
  'giu',
);

// A food quantity's unit: mass or volume. A number with one of these that is not a macronutrient statement is an amount
// of food ("I ate 200 g"), so a summing phrase beside it may sum the food rather than the nutrients.
const QUANTITY_UNIT = new RegExp(`^${SPACE}?(?:${GRAM_UNIT}|kg|кг|oz|lbs|lb|ml|мл|l|л)${NOT_LETTER_AFTER}`, 'iu');

// The unit right after a number, by the MEASURE it states, for telling a dash range ("500 - 600 kcal", "500 kcal -
// 2500 kJ", "5 g - 6000 mg") from two statements of different measures joined by a dash ("300 kcal - 5 g protein",
// "200 ml - 120 kcal"). kJ is energy like kcal; mg, mcg, kg, oz and lb are mass like g. Nothing is converted.
const UNIT_KIND = `(?:(?<energy>${ENERGY_UNIT}|kj|кдж)|(?<mass>${GRAM_UNIT}|mcg|мкг|mg|мг|kg|кг|oz|lbs|lb)|(?<volume>ml|мл|l|л)|(?<percent>%))${NOT_LETTER_AFTER}`;
// A dash between two numbers, with only whitespace (ordinary, no-break, narrow no-break, line breaks) around it; any
// punctuation between the numbers makes them separate statements.
const DASH_SEPARATOR = MINUS_OR_DASH;
// The lower endpoint (its last digit, its own optional unit) and the dash, directly before a number or its statement.
const DASH_RANGE_BEFORE = new RegExp(`\\d(?:\\s*${UNIT_KIND})?\\s*${DASH_SEPARATOR}\\s*$`, 'iu');
// The dash and the upper endpoint, directly after a number (and its own optional unit) or its statement. `lead` is
// everything before the upper endpoint's digits, so its position in the text is known.
const DASH_RANGE_AFTER = new RegExp(
  `^(?<lead>(?:\\s*(?:${ENERGY_UNIT}|${GRAM_UNIT}|${OTHER_UNIT})${NOT_LETTER_AFTER})?\\s*${DASH_SEPARATOR}\\s*)\\d+(?:[.,]\\d+)?(?:\\s*${UNIT_KIND})?`,
  'iu',
);
// A range or alternative written with a word: "to", "or", "до", "или". Unlike a dash, these words never separate two
// statements, so the units of the endpoints do not matter: "500 kcal to 2500 kJ", "fat 5 g or 6000 mg", "2 cups or 500
// kcal" are ranges or alternatives whatever the units, also when a unit is unsupported or names another measure. Another
// number, at most three words (its unit, "of fat"…) and only whitespace may stand between the connector and the value.
const RANGE_WORD = `${NOT_LETTER_BEFORE}(?:to|or|до|или)${NOT_LETTER_AFTER}`;
const WORD_RANGE_BEFORE = new RegExp(`\\d(?:\\s*(?:\\p{L}+|%)){0,3}\\s*${RANGE_WORD}\\s*$`, 'iu');
const WORD_RANGE_AFTER = new RegExp(`^(?:\\s*(?:\\p{L}+|%)){0,3}?\\s*${RANGE_WORD}\\s*\\d`, 'iu');

// A hedge makes every number the person wrote an estimate, wherever it stands ("These are estimates, 500 kcal").
const HEDGE = new RegExp(
  `${NOT_LETTER_BEFORE}(?:about|around|approx\\p{L}*|roughly|nearly|almost|maybe|probably|perhaps|possibly|estimat\\p{L}*|guess\\p{L}*|ish|or so|около|примерно|приблизительно|где-?то|вроде|наверное|наверно|может|возможно|кажется|почти|оцен\\p{L}*)${NOT_LETTER_AFTER}`,
  'iu',
);

// A bound, a range, an approximation sign or a question in the value's own clause.
const AMBIGUOUS = new RegExp(
  [
    `${NOT_LETTER_BEFORE}(?:at least|at most|up to|less than|more than|over|under|below|above|менее|более|меньше|больше|свыше|минимум|максимум)${NOT_LETTER_AFTER}`,
    '[~≈±<>≤≥?]',
    `\\d\\s*(?:${MINUS_OR_DASH}|to|or|или|до)\\s*\\d`,
  ].join('|'),
  'iu',
);

const NEGATED = new RegExp(
  `${NOT_LETTER_BEFORE}(?:no|not|without|never|none|не|без|нет|ни)${NOT_LETTER_AFTER}|n['’]t${NOT_LETTER_AFTER}`,
  'iu',
);

// Qualifiers bound to ONE numeric statement, read in the original text across any whitespace (spaces, tabs, line breaks,
// CRLF, no-break and narrow no-break spaces), whatever the model's excerpt or the clause shows (see `qualifierAround`).
// The words of a phrase may themselves be split by any whitespace ("up\nto", "не\nболее"). A bound or an open endpoint
// before a number: "до", "от", "from" and "between" alone bound or open a range only here, directly before a statement
// ("Суп, до 600 ккал"), never anywhere in a clause ("Перекус до обеда, 200 ккал").
const BOUND_WORD = `(?:${NOT_LETTER_BEFORE}(?:at\\s+least|at\\s+most|up\\s+to|(?:less|fewer|more|greater|higher|lower)\\s+than|over|under|below|above|(?:max|maximum|minimum)(?:\\s+of)?|from|between|менее|более|меньше|больше|свыше|выше|ниже|минимум|максимум|до|от|между)${NOT_LETTER_AFTER}|[~≈±<>≤≥])`;
const NEGATION_WORD = `(?:${NOT_LETTER_BEFORE}(?:no|not|without|never|none|не|без|нет|ни)|n['’]t)${NOT_LETTER_AFTER}`;
// Between a qualifier and its statement: whitespace and at most one colon, equals sign, en dash or em dash.
const QUALIFIER_GAP = '\\s*[:=\\u2013\\u2014]?\\s*';
const BOUND_BEFORE = new RegExp(`${BOUND_WORD}${QUALIFIER_GAP}$`, 'iu');
const NEGATION_BEFORE = new RegExp(`${NEGATION_WORD}${QUALIFIER_GAP}$`, 'iu');
// A qualifier left at the end of a line, before the statement on a following line with only words between them ("Pasta,
// up to\ntotal 600 kcal", "Salad, not\neven 400 kcal"): which number it qualifies is unresolved, so it binds this one.
const LINE_END = '[^\\S\\r\\n]*[\\r\\n]';
const BOUND_DANGLING = new RegExp(`${BOUND_WORD}${LINE_END}`, 'iu');
const NEGATION_DANGLING = new RegExp(`${NEGATION_WORD}${LINE_END}`, 'iu');
// A bound written after the statement ("600 kcal at most", "600 ккал\nили больше"). The `prefix` group holds the bounds
// that also open a statement ("at least 20 g protein", "не более 600 ккал"): when one of them directly introduces the
// next nutrient statement it qualifies that statement instead (see `introducesStatement`). The others ("or more", "and
// up", "tops", "или больше", "и более") only ever close one, so they stay on the value before them.
const BOUND_AFTER = new RegExp(
  `^${QUALIFIER_GAP}(?:(?<prefix>at\\s+most|at\\s+least|(?:max|maximum|minimum)(?:\\s+of)?|максимум|минимум|не\\s+(?:больше|меньше|более|менее|выше|ниже))|or\\s+(?:more|less|fewer|above|below|over|under|higher|lower)|and\\s+(?:more|less|above|below|over|under|up)|tops|(?:или|и)\\s+(?:больше|меньше|более|менее|выше|ниже))${NOT_LETTER_AFTER}`,
  'iu',
);
// The upper endpoint of "between N … and" / "между N … и": the lower number, at most three words (its unit, "of fat"…)
// and the conjunction, across any whitespace, directly before the statement. ("от N … и до" is bound by its "до".)
const BETWEEN_UPPER = new RegExp(
  `${NOT_LETTER_BEFORE}(?:between|между)\\s+\\d+(?:[.,]\\d+)?(?:\\s*(?:\\p{L}+|%)){0,3}?\\s+(?:and|и)${QUALIFIER_GAP}$`,
  'iu',
);

// A number as people write it: digits, optionally one decimal separator and more digits. Never directly after a letter
// or a digit (B12, x2), never after a separator that follows a digit (the tail of 1.5).
const NUMBER = /(?<![\p{L}\p{N}_])(?<!\d[.,])\d+(?:[.,]\d+)?(?!\p{N})/gu;

// ---------------------------------------------------------------------------------------------------------------
// Tokens and mentions.

interface NumberToken {
  end: number;
  start: number;
  text: string;
}

function numberTokens(text: string, from = 0, to = text.length): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start >= from && end <= to) tokens.push({ end, start, text: match[0] });
  }
  return tokens;
}

/**
 * A decimal exactly as written, normalised without any arithmetic: no leading zeros in the integer part (except a lone
 * 0) and no trailing zeros in the fraction. "12.50", "12,5" and "012.5" are one value; "12.5000000000000001" is not 12.5.
 */
interface ExactDecimal {
  fraction: string;
  integer: string;
}

function exactDecimal(digits: string): ExactDecimal {
  const [integer = '0', fraction = ''] = digits.split(/[.,]/u);
  return { fraction: fraction.replace(/0+$/u, ''), integer: integer.replace(/^0+(?=\d)/u, '') };
}

const sameDecimal = (left: ExactDecimal, right: ExactDecimal): boolean => left.integer === right.integer && left.fraction === right.fraction;

type ParsedNumber = { kind: 'ambiguous' } | { kind: 'negative' } | { decimal: ExactDecimal; kind: 'value' };

type SignBefore = 'ambiguous' | 'negative' | 'none';

/**
 * What stands before the number in the ORIGINAL text, whatever the excerpt includes: a minus sign directly before it
 * (negative), a minus sign separated from it by whitespace (ordinary, no-break, narrow no-break or any other space: it may
 * be a sign or a stray dash, so it is ambiguous), or nothing. A minus that follows another number is the dash of a range,
 * which the clause check refuses on its own.
 */
function signBefore(text: string, start: number): SignBefore {
  let index = start;
  while (index > 0 && /\s/u.test(text[index - 1]!)) index -= 1;
  const spaced = index < start;
  const sign = text[index - 1] ?? '';
  const enDash = sign === '–';
  if (!MINUS.test(sign) && !enDash) return 'none';
  let before = index - 1;
  while (before > 0 && /\s/u.test(text[before - 1]!)) before -= 1;
  if (/\d/u.test(text[before - 1] ?? '')) return 'none';
  if (enDash) return spaced ? 'none' : 'negative';
  return spaced ? 'ambiguous' : 'negative';
}

/** The number a token denotes, exactly, or why it does not denote exactly one non-negative number. */
function parseToken(text: string, token: NumberToken): ParsedNumber {
  const separator = /[.,]/u.exec(token.text);
  // 1,200 or 1.200: a thousands separator in one convention, a decimal in another. Never guessed.
  if (separator !== null && token.text.length - separator.index - 1 === 3) return { kind: 'ambiguous' };
  // 1 200 (space-grouped thousands) seen from either side.
  if (new RegExp(`\\d${SPACE}$`, 'u').test(text.slice(Math.max(0, token.start - 2), token.start))) return { kind: 'ambiguous' };
  if (new RegExp(`^${SPACE}\\d{3}(?!\\d)`, 'u').test(text.slice(token.end, token.end + 5))) return { kind: 'ambiguous' };
  const sign = signBefore(text, token.start);
  if (sign === 'negative') return { kind: 'negative' };
  if (sign === 'ambiguous') return { kind: 'ambiguous' };
  return { decimal: exactDecimal(token.text), kind: 'value' };
}

/** The model's value as an exact decimal, or null when it is anything else ("about 600", "-30", "6e2", "650 kcal"). */
function parseClaimedValue(value: string): ExactDecimal | null {
  const trimmed = value.trim();
  if (!/^\d+(?:[.,]\d+)?$/u.test(trimmed)) return null;
  return exactDecimal(trimmed);
}

/**
 * The public number for an exact decimal, only after the meal contract's rules held on the exact digits: at most
 * MEAL_VALUE_DECIMALS meaningful decimals and at most the field's maximum, compared in integer tenths (BigInt), so no
 * floating-point conversion can round a refused value into an accepted one. Null when the contract refuses it.
 */
function contractValue(decimal: ExactDecimal, field: MealNutritionField): number | null {
  if (decimal.fraction.length > MEAL_VALUE_DECIMALS) return null;
  const scale = 10n ** BigInt(MEAL_VALUE_DECIMALS);
  const scaled = BigInt(decimal.integer) * scale + BigInt(decimal.fraction.padEnd(MEAL_VALUE_DECIMALS, '0'));
  if (scaled > BigInt(MEAL_NUTRITION_MAX[field]) * scale) return null;
  // Exact now: at most five integer digits and one decimal, which a double represents as the decimal it is written as.
  const value = Number(decimal.fraction === '' ? decimal.integer : `${decimal.integer}.${decimal.fraction}`);
  const accepted = fieldSchemas[field].safeParse(value);
  return accepted.success ? accepted.data : null;
}

type MentionCheck =
  | { kind: 'mention'; end: number; start: number }
  | { kind: 'no_unit' }
  | { kind: 'other_unit' }
  | { kind: 'not_attached' };

/**
 * Whether the number token is a statement of `field`: followed by the field's unit (energy may name its unit before the
 * number instead), and for a macronutrient attached to its name on either side ("protein 40 g", "40 g of protein",
 * "белок 40 г", "40 г белка"). A grams figure next to anything else is a food quantity, never a nutrient.
 */
function checkMention(text: string, token: NumberToken, field: MealNutritionField): MentionCheck {
  const after = text.slice(token.end);
  const before = text.slice(0, token.start);
  if (new RegExp(`^${SPACE}?${OTHER_UNIT}${NOT_LETTER_AFTER}`, 'iu').test(after)) return { kind: 'other_unit' };

  if (field === 'energyKcal') {
    const unit = new RegExp(`^${SPACE}?${ENERGY_UNIT}${NOT_LETTER_AFTER}`, 'iu').exec(after);
    if (unit !== null) return { end: token.end + unit[0].length, kind: 'mention', start: token.start };
    const unitBefore = new RegExp(`${NOT_LETTER_BEFORE}${ENERGY_UNIT_WORD_BEFORE}${SPACE}*[:=\\-–—]?${SPACE}*$`, 'iu').exec(before);
    if (unitBefore !== null && !new RegExp(`^${SPACE}?${GRAM_UNIT}${NOT_LETTER_AFTER}`, 'iu').test(after)) {
      return { end: token.end, kind: 'mention', start: unitBefore.index };
    }
    return { kind: 'no_unit' };
  }

  const unit = new RegExp(`^${SPACE}?${GRAM_UNIT}${NOT_LETTER_AFTER}`, 'iu').exec(after);
  if (unit === null) return { kind: 'no_unit' };
  const unitEnd = token.end + unit[0].length;
  const metric = METRIC[field];
  const metricBefore = new RegExp(`${NOT_LETTER_BEFORE}${metric}${SPACE}*[:=\\-–—]?${SPACE}*$`, 'iu').exec(before);
  if (metricBefore !== null) return { end: unitEnd, kind: 'mention', start: metricBefore.index };
  const metricAfter = new RegExp(`^${SPACE}*(?:of${SPACE}+)?${metric}${NOT_LETTER_AFTER}`, 'iu').exec(text.slice(unitEnd));
  if (metricAfter !== null) return { end: unitEnd + metricAfter[0].length, kind: 'mention', start: token.start };
  return { kind: 'not_attached' };
}

/** The clause around [start, end): up to the nearest ; ! ? | line break, or a . or , that is not between two digits. */
function clauseAround(text: string, start: number, end: number): { closer: string; text: string } {
  const isBoundary = (index: number): boolean => {
    const character = text[index] ?? '';
    if (/[;!?|\n\r]/u.test(character)) return true;
    if (character === '.' || character === ',') {
      return !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? ''));
    }
    return false;
  };
  let left = start;
  while (left > 0 && !isBoundary(left - 1)) left -= 1;
  let right = end;
  while (right < text.length && !isBoundary(right)) right += 1;
  return { closer: text[right] ?? '', text: text.slice(left, right) };
}

/**
 * The sentences of the text: split at ; ! ? or a full stop that is not a decimal point. Commas, colons and line breaks do
 * NOT end a sentence, so a heading and the list below it, or a list and the qualifier after it, stay together.
 */
function sentences(text: string): Array<{ end: number; start: number; text: string }> {
  const found: Array<{ end: number; start: number; text: string }> = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const character = text[index] ?? '';
    const boundary =
      index === text.length || /[;!?]/u.test(character) || (character === '.' && !(/\d/u.test(text[index - 1] ?? '') && /\d/u.test(text[index + 1] ?? '')));
    if (boundary) {
      found.push({ end: index, start, text: text.slice(start, index) });
      start = index + 1;
    }
  }
  return found;
}

const hasPortionQualifier = (fragment: string): boolean => PER_PORTION.test(fragment) || NUTRITION_LABEL.test(fragment);

/** Whether a stretch of the text states any nutrient at all (a number with a nutrient's unit and, for grams, its name). */
function statesAnyNutrient(text: string, start: number, end: number): boolean {
  return numberTokens(text, start, end).some((token) =>
    MEAL_NUTRITION_FIELDS.some((field) => {
      const mention = checkMention(text, token, field);
      return mention.kind === 'mention' && mention.end <= end;
    }),
  );
}

const MACRONUTRIENT_FIELDS = MEAL_NUTRITION_FIELDS.filter((field) => field !== 'energyKcal');

/** Whether a stretch of the text states an amount of food: a mass or volume that is not a macronutrient statement. */
function statesFoodQuantity(text: string, start: number, end: number): boolean {
  return numberTokens(text, start, end).some(
    (token) => QUANTITY_UNIT.test(text.slice(token.end)) && !MACRONUTRIENT_FIELDS.some((field) => checkMention(text, token, field).kind === 'mention'),
  );
}

/**
 * Whether the value at [start, end) is a total for the whole entry. With no per-portion qualifier, nutrition label,
 * container, product or partial amount (`CONTAINER_OR_PARTIAL`) anywhere in the text, it is. Otherwise that context stays
 * in force across commas, lists, sentences, line breaks and the model's excerpt until the person resolves it for this
 * value, which takes ALL of:
 *
 * - the value's sentence carries the person's own summing phrase (`ENTRY_SUM`: "in total", "altogether", "итого", "в
 *   сумме"…). A label's "total" ("Total protein 4 g", "Fat 4 g total", "Total: fat 4 g"), "overall" or "всего" is not
 *   one, so it never establishes the amount eaten;
 * - the value is bound to the person's assertion that they ate it, in that same sentence (`boundToConsumption`: "In
 *   total I ate 120 kcal, protein 8 g"). A summing phrase alone ("In total the package has 4 g protein", "Итого 240
 *   ккал") does not say the value was eaten, and a consumption verb in another sentence ("I ate half the yogurt.")
 *   authorizes nothing;
 * - that sentence carries no qualifier, label, container, product or partial amount itself, and states no amount of food
 *   ("I ate 200 g in total, protein 8 g": the phrase may sum the food, and the 8 g may still be per 100 g);
 * - no qualifier in the text floats free of values (a value-less sentence such as "Values are per 100 g." may refer to
 *   any sentence).
 *
 * Sentences end only at . ; ! ? (not at commas, colons or line breaks), so a heading and the lines below it stay one
 * sentence and keep their qualifier. Nothing is multiplied or inferred either way: not that a whole package was eaten,
 * and never a fraction of a value.
 */
function wholeEntryScoped(text: string, start: number, end: number): boolean {
  if (!hasPortionQualifier(text) && !CONTAINER_OR_PARTIAL.test(text)) return true;
  const all = sentences(text);
  const own = all.find((sentence) => start >= sentence.start && end <= sentence.end);
  if (own === undefined || hasPortionQualifier(own.text) || CONTAINER_OR_PARTIAL.test(own.text) || !ENTRY_SUM.test(own.text)) return false;
  if (statesFoodQuantity(text, own.start, own.end) || !boundToConsumption(text, own, start)) return false;
  return all.every((sentence) => !hasPortionQualifier(sentence.text) || statesAnyNutrient(text, sentence.start, sentence.end));
}

/**
 * Whether the value at [start, end) is bound to the person's assertion that they ate it: a consumption verb
 * (`CONSUMPTION`) stands before it in the same sentence, and between the verb and the value there is nothing but other
 * nutrient statements, separators (whitespace, `,` `:` dashes), "and"/"plus"/"и"/"плюс", the summing phrase, and the
 * lower endpoint of a range directly before a nutrient statement ("In total I ate 120 kcal, protein 8 g"; "Итого съел
 * 240 ккал, белки 32 г"; "I ate 330 kcal in total"). Anything else between them ("I ate the yogurt, which has 4 g
 * protein", "съел половину, в упаковке 4 г") means the value describes something other than the amount eaten.
 */
function boundToConsumption(text: string, sentence: { end: number; start: number }, start: number): boolean {
  let verbEnd = -1;
  for (const match of text.slice(sentence.start, start).matchAll(CONSUMPTION)) verbEnd = sentence.start + match.index + match[0].length;
  if (verbEnd === -1) return false;

  // The nutrient statements between the verb and the value, masked as one placeholder each.
  const spans: Array<{ end: number; start: number }> = [];
  for (const token of numberTokens(text, verbEnd, start)) {
    for (const field of MEAL_NUTRITION_FIELDS) {
      const mention = checkMention(text, token, field);
      if (mention.kind === 'mention' && mention.start >= verbEnd && mention.end <= start) spans.push({ end: mention.end, start: mention.start });
    }
  }
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  let gap = '';
  let cursor = verbEnd;
  for (const span of spans) {
    if (span.start < cursor) continue;
    gap += `${text.slice(cursor, span.start)}\u0000`;
    cursor = span.end;
  }
  gap += text.slice(cursor, start);

  const allowed = new RegExp(
    [
      '\\s+',
      '[,:\\u2010-\\u2014-]',
      '\\u0000',
      `${NOT_LETTER_BEFORE}(?:and|plus|и|плюс)${NOT_LETTER_AFTER}`,
      ENTRY_SUM.source,
      `\\d+(?:[.,]\\d+)?(?:\\s*${UNIT_KIND})?\\s*(?:${DASH_SEPARATOR}|${RANGE_WORD})\\s*(?=\\u0000|$)`,
    ].join('|'),
    'iuy',
  );
  let position = 0;
  while (position < gap.length) {
    allowed.lastIndex = position;
    const match = allowed.exec(gap);
    if (match === null || match[0].length === 0) return false;
    position += match[0].length;
  }
  return true;
}

type Measure = 'energy' | 'mass' | 'none' | 'percent' | 'volume';

const measureOf = (groups: Record<string, string | undefined> | undefined): Measure =>
  groups?.energy !== undefined
    ? 'energy'
    : groups?.mass !== undefined
      ? 'mass'
      : groups?.volume !== undefined
        ? 'volume'
        : groups?.percent !== undefined
          ? 'percent'
          : 'none';

/**
 * Whether the value (the number token, inside its statement at [start, end)) is one endpoint of a range or alternative in
 * the ORIGINAL text, whatever the excerpt or the clause shows. Both directions are checked, from the number and from the
 * edges of its statement, across whitespace and line breaks, so a range is seen from either endpoint and whatever the
 * model's excerpt includes.
 *
 * - Joined by "to", "or", "до" or "или" to another number: always a range or alternative, whatever the endpoints' units
 *   ("500 kcal to\n2500 kJ", "fat 5 g or 6000 mg", "2 cups or 500 kcal"). The units are never converted or compared.
 * - Joined by a dash (any minus or dash) to another number: a range when the other number states the SAME MEASURE (energy:
 *   kcal, kJ…; mass: g, mg, kg, oz…) or no unit ("500 -\n600 kcal", "500 kcal –\n2500 kJ", "fat 5 g –\n6000 mg"). A
 *   dash also separates statements, so it is NOT a range when the other number states another measure ("300 kcal –\n5 g
 *   protein", "200 ml –\n120 kcal"), or is itself a statement of a different nutrient ("protein 30 g –\n5 g fat").
 * - Anything else between the numbers (a full stop, a semicolon, a comma) makes them separate statements.
 */
function inRange(text: string, token: NumberToken, start: number, end: number, field: MealNutritionField): boolean {
  const own: Measure = field === 'energyKcal' ? 'energy' : 'mass';
  const tokens = numberTokens(text);
  const joins = (other: NumberToken | undefined, measure: Measure): boolean => {
    if (measure !== own && measure !== 'none') return false;
    return other === undefined || !MEAL_NUTRITION_FIELDS.some((candidate) => candidate !== field && checkMention(text, other, candidate).kind === 'mention');
  };
  for (const edge of new Set([token.start, start])) {
    const before = text.slice(0, edge);
    if (WORD_RANGE_BEFORE.test(before)) return true;
    const dash = DASH_RANGE_BEFORE.exec(before);
    if (dash !== null && joins(tokens.find((other) => other.end === dash.index + 1), measureOf(dash.groups))) return true;
  }
  for (const edge of new Set([token.end, end])) {
    const after = text.slice(edge);
    if (WORD_RANGE_AFTER.test(after)) return true;
    const dash = DASH_RANGE_AFTER.exec(after);
    if (dash === null) continue;
    const upperStart = edge + (dash.groups?.lead ?? '').length;
    if (joins(tokens.find((other) => other.start === upperStart), measureOf(dash.groups))) return true;
  }
  return false;
}

/**
 * The text before `edge` back to the nearest , . ; ! ? | or digit, crossing line breaks: the words that lead into a
 * statement on its own or on earlier lines, without reaching another clause or another number.
 */
function leadIn(text: string, edge: number): string {
  let left = edge;
  while (left > 0 && !/[,.;!?|\p{N}]/u.test(text[left - 1]!)) left -= 1;
  return text.slice(left, edge);
}

/**
 * A bound, an open endpoint, a range or a negation bound to the value's own statement (the number `token`, inside its
 * statement at [start, end)) in the ORIGINAL text, which the clause check cannot see when a line break, a tab or a
 * no-break space separates it from the number, or when the word ("до", "от", "between") bounds only a number directly
 * after it. Read from the number and from the start of its statement, so "up to\nprotein 20 g" and "up to\n20 g protein"
 * are read alike, whatever the excerpt includes:
 *
 * - directly before the statement, with only whitespace (and one `:` `=` `–` `—`) between: a bound or open endpoint
 *   ("up to\n600 kcal", "более\n600 ккал", "до 600 ккал", "от 500 ккал", "between 500 kcal") or a negation ("not\n400
 *   kcal");
 * - the upper endpoint of "between N … and" / "между N … и" ("between 500 and\n600 kcal");
 * - left dangling at the end of a line in the words leading into the statement ("up to\ntotal 600 kcal"): the
 *   association is unresolved, so the value is withheld rather than taken as exact;
 * - directly after the statement ("600 kcal at most", "600 ккал\nили больше"), unless that bound is one that also opens
 *   a statement and it directly introduces the next nutrient statement ("500 kcal\nat least 20 g protein": the bound
 *   qualifies the protein, read by the "directly before" rule above, and 500 stays exact).
 *
 * A qualifier that stands before other words on its own line ("No sauce\n500 kcal", "Перекус до обеда 200 ккал"), in
 * another clause ("No sauce, 500 kcal") or in another sentence does not reach the value. Nothing is computed from a bound
 * or a range: no endpoint is chosen, no midpoint formed.
 */
function qualifierAround(text: string, token: NumberToken, start: number, end: number): 'ambiguous' | 'negated' | null {
  let negated = false;
  for (const edge of new Set([token.start, start])) {
    const before = text.slice(0, edge);
    const lead = leadIn(text, edge);
    if (BOUND_BEFORE.test(before) || BETWEEN_UPPER.test(before) || BOUND_DANGLING.test(lead)) return 'ambiguous';
    if (NEGATION_BEFORE.test(before) || NEGATION_DANGLING.test(lead)) negated = true;
  }
  const after = BOUND_AFTER.exec(text.slice(end));
  if (after !== null && !(after.groups?.prefix !== undefined && introducesStatement(text, end + after[0].length))) return 'ambiguous';
  return negated ? 'negated' : null;
}

/**
 * Whether a nutrient statement of any field (the existing mention recognition: a number with its unit and, for grams,
 * its attached nutrient name, either side) starts at `position` on the SAME line, after only spaces, tabs, no-break
 * spaces and at most one `:` `=` `–` `—`. Only the first number after that point is considered, and the statement must
 * begin exactly there, so a later digit, a number without a supported unit or nutrient ("2 cups", "600", "20 g", "2500
 * kJ"), a sign, punctuation or another word in between never counts as a separate statement. A bound alone on its line
 * between two statements ("600 kcal\nat most\n20 g protein") introduces neither: its association is unresolved.
 */
function introducesStatement(text: string, position: number): boolean {
  const gap = /^[^\S\r\n]*[:=–—]?[^\S\r\n]*/u.exec(text.slice(position));
  const start = position + (gap?.[0].length ?? 0);
  const next = numberTokens(text).find((token) => token.start >= start);
  if (next === undefined) return false;
  return MEAL_NUTRITION_FIELDS.some((field) => {
    const mention = checkMention(text, next, field);
    return mention.kind === 'mention' && mention.start === start;
  });
}

/**
 * Why the value at [start, end) (the number `token` with its unit and nutrient) cannot be proposed as stated, or null:
 * its clause, a range or qualifier around its statement in the original text, a hedge anywhere, then its scope.
 */
function scopeReason(text: string, start: number, end: number, token: NumberToken, field: MealNutritionField): MealDraftWithheldReason | null {
  const clause = clauseAround(text, start, end);
  if (hasPortionQualifier(clause.text)) return 'per_portion';
  const qualifier = qualifierAround(text, token, start, end);
  if (AMBIGUOUS.test(clause.text) || clause.closer === '?' || inRange(text, token, start, end, field) || qualifier === 'ambiguous') return 'ambiguous';
  if (NEGATED.test(clause.text) || qualifier === 'negated') return 'negated';
  if (HEDGE.test(text)) return 'ambiguous';
  if (!wholeEntryScoped(text, start, end)) return 'per_portion';
  return null;
}

/**
 * Every value the text states for `field` with whole-entry scope (the same rule as for a proposal); more than one is a
 * conflict. A mention whose sign or notation is not one plain number counts as a value of its own, so "500 kcal" next to
 * "-500 kcal" or "1,200 kcal" is a conflict, never a quiet choice.
 */
function distinctStatedValues(text: string, field: MealNutritionField): Set<string> {
  const values = new Set<string>();
  for (const token of numberTokens(text)) {
    const mention = checkMention(text, token, field);
    if (mention.kind !== 'mention') continue;
    if (hasPortionQualifier(clauseAround(text, mention.start, mention.end).text) || !wholeEntryScoped(text, mention.start, mention.end)) continue;
    const parsed = parseToken(text, token);
    values.add(parsed.kind === 'value' ? `${parsed.decimal.integer}.${parsed.decimal.fraction}` : `${parsed.kind}@${token.start}`);
  }
  return values;
}

/** Where the claimed excerpt is in the text: exactly, or else ignoring case, as the text spells it. */
function locate(text: string, excerpt: string): { end: number; start: number } | null {
  const claimed = excerpt.trim();
  if (claimed === '') return null;
  const exact = text.indexOf(claimed);
  if (exact !== -1) return { end: exact + claimed.length, start: exact };
  const escaped = claimed.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const folded = new RegExp(escaped, 'iu').exec(text);
  return folded === null ? null : { end: folded.index + folded[0].length, start: folded.index };
}

const fieldSchemas: Readonly<Record<MealNutritionField, z.ZodType<number>>> = {
  carbohydrateG: mealCarbohydrateGSchema,
  energyKcal: mealEnergyKcalSchema,
  fatG: mealFatGSchema,
  proteinG: mealProteinGSchema,
};

const abstentionReason: Readonly<Record<Exclude<MealDraftAbstention, 'not_stated'>, MealDraftWithheldReason>> = {
  conflicting: 'conflicting',
  negated: 'negated',
  not_exact: 'ambiguous',
  per_portion: 'per_portion',
  unit_not_supported: 'unit_not_supported',
};

interface FieldOutcome {
  disposition: FieldDisposition;
  result: MealDraftNutritionResult;
}

const withheld = (reason: MealDraftWithheldReason): FieldOutcome => ({
  disposition: 'server_withheld',
  result: { reason, status: 'withheld' },
});

/** One field's claim against the text. Exported for its specification. */
export function groundNutrient(text: string, field: MealNutritionField, claim: NutrientClaim): FieldOutcome {
  // An abstention is taken as it is: it proposes nothing. Its reason only chooses the sentence the screen shows.
  if (claim.value === null && claim.evidence === null && claim.abstain !== null) {
    return claim.abstain === 'not_stated'
      ? { disposition: 'not_stated', result: { status: 'not_stated' } }
      : { disposition: 'model_abstained', result: { reason: abstentionReason[claim.abstain], status: 'withheld' } };
  }
  if (claim.value === null || claim.evidence === null || claim.abstain !== null) return withheld('unverified');

  const claimed = parseClaimedValue(claim.value);
  const span = locate(text, claim.evidence);
  if (claimed === null || span === null) return withheld('unverified');
  const excerpt = text.slice(span.start, span.end);
  if ([...excerpt].length > MEAL_DRAFT_EXCERPT_MAX) return withheld('unverified');

  // The excerpt's own numbers, read by this tokenizer; the one that states the claimed value for this field.
  const tokens = numberTokens(text, span.start, span.end);
  let diagnosis: MealDraftWithheldReason = 'unverified';
  let chosen: { decimal: ExactDecimal; end: number; start: number; token: NumberToken } | null = null;
  for (const token of tokens) {
    const parsed = parseToken(text, token);
    if (parsed.kind === 'ambiguous') {
      diagnosis = 'ambiguous';
      continue;
    }
    if (parsed.kind === 'negative') {
      diagnosis = 'outside_contract';
      continue;
    }
    // Exact decimal equality: a claim of 12.5 is not the text's 12.5000000000000001.
    if (!sameDecimal(parsed.decimal, claimed)) continue;
    const mention = checkMention(text, token, field);
    if (mention.kind === 'other_unit' || mention.kind === 'no_unit') {
      diagnosis = 'unit_not_supported';
      continue;
    }
    if (mention.kind === 'not_attached') continue;
    // The value, its unit and its nutrient must all be inside the excerpt the model pointed at.
    if (mention.start < span.start || mention.end > span.end) continue;
    chosen = { decimal: parsed.decimal, end: mention.end, start: mention.start, token };
    break;
  }
  if (chosen === null) return withheld(diagnosis);

  const scope = scopeReason(text, chosen.start, chosen.end, chosen.token, field);
  if (scope !== null) return withheld(scope);
  if (distinctStatedValues(text, field).size > 1) return withheld('conflicting');

  // The contract's precision and bounds on the exact digits; only then the public number.
  const value = contractValue(chosen.decimal, field);
  if (value === null) return withheld('outside_contract');
  return { disposition: 'proposed', result: { excerpt, status: 'proposed', value } };
}

/** The meal types the text names (by their words), in a fixed order. */
export function mealTypesNamed(text: string): Exclude<MealType, 'other'>[] {
  return (Object.keys(MEAL_TYPE_WORDS) as Exclude<MealType, 'other'>[]).filter((type) => word(MEAL_TYPE_WORDS[type]).test(text));
}

function groundMealType(text: string, answer: { mealType: string | null; mealTypeEvidence: string | null }): MealDraftMealType {
  const type = answer.mealType as Exclude<MealType, 'other'> | null;
  if (type === null || answer.mealTypeEvidence === null || !(type in MEAL_TYPE_WORDS)) return { status: 'not_stated' };
  const span = locate(text, answer.mealTypeEvidence);
  if (span === null) return { status: 'not_stated' };
  const excerpt = text.slice(span.start, span.end);
  if ([...excerpt].length > MEAL_DRAFT_EXCERPT_MAX || !word(MEAL_TYPE_WORDS[type]).test(excerpt)) return { status: 'not_stated' };
  return { excerpt, status: 'proposed', value: type };
}

// A nutrition STATEMENT, not a nutrient word: "Protein bar" and "Low-fat yogurt" are titles, "Shake 30 g protein" and
// "Soup 300 kcal" are not.
const ANY_METRIC = `(?:${Object.values(METRIC).join('|')})`;
const NUTRITION_IN_TITLE = new RegExp(
  [
    `\\d${SPACE}?${ENERGY_UNIT}${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}${ENERGY_UNIT_WORD_BEFORE}${SPACE}*[:=\\-–—]?${SPACE}*\\d`,
    `${NOT_LETTER_BEFORE}${ANY_METRIC}${SPACE}*[:=\\-–—]?${SPACE}*\\d`,
    `\\d${SPACE}?${GRAM_UNIT}${SPACE}*(?:of${SPACE}+)?${ANY_METRIC}${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);

/**
 * The title as the text spells it, or null. It must be an excerpt of the text, a valid meal title, say something beyond
 * the meal's name ("Dinner" alone is not a title), and carry no nutrition statement (a title is not evidence).
 */
export function groundTitle(text: string, claimed: string): string | null {
  const span = locate(text, claimed);
  if (span === null) return null;
  const title = text.slice(span.start, span.end);
  if (/[\n\r]/u.test(title) || !mealTitleSchema.safeParse(title).success || !/\p{L}/u.test(title)) return null;
  if (NUTRITION_IN_TITLE.test(title)) return null;
  const withoutMealWords = Object.values(MEAL_TYPE_WORDS).reduce(
    (rest, words) => rest.replace(new RegExp(`${NOT_LETTER_BEFORE}${words}${NOT_LETTER_AFTER}`, 'giu'), ''),
    title,
  );
  if (!/\p{L}/u.test(withoutMealWords)) return null;
  return title;
}

/**
 * The model's answer, grounded in the text. A clarification or an unsupported answer carries only its code. A draft is
 * rebuilt from what checks out: the title (or the whole answer is refused as ungrounded, because a draft without a
 * grounded title is not a draft of what the person wrote), a meal type the text names, and each nutrient on its own.
 * Throws UngroundedOutputError for a title that is not grounded.
 */
export function groundMealDraft(text: string, answer: MealDraftWireAnswer): GroundingResult {
  if (answer.outcome === 'clarify') {
    return { audit: { fields: null, multipleMealsOverride: false }, proposal: { outcome: 'clarify', reason: answer.reason } };
  }
  if (answer.outcome === 'unsupported') {
    return { audit: { fields: null, multipleMealsOverride: false }, proposal: { outcome: 'unsupported', reason: answer.reason } };
  }

  // Two different meals named in one text ("breakfast ... lunch ...") is never one entry, whatever the model said.
  if (mealTypesNamed(text).length > 1) {
    return { audit: { fields: null, multipleMealsOverride: true }, proposal: { outcome: 'clarify', reason: 'multiple_meals' } };
  }

  const title = groundTitle(text, answer.title);
  if (title === null) throw new UngroundedOutputError();

  const fields = {} as Record<MealNutritionField, FieldDisposition>;
  const nutrition = {} as Record<MealNutritionField, MealDraftNutritionResult>;
  for (const field of MEAL_NUTRITION_FIELDS) {
    const outcome = groundNutrient(text, field, answer[field]);
    fields[field] = outcome.disposition;
    nutrition[field] = outcome.result;
  }
  return {
    audit: { fields, multipleMealsOverride: false },
    proposal: {
      mealType: groundMealType(text, answer),
      nutrition,
      outcome: 'draft',
      title,
    },
  };
}
