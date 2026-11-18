import { MEAL_NUTRITION_FIELDS, type MealNutritionField } from '@running-tracker/contracts';

import { ENERGY_UNIT, ENERGY_UNIT_WORD_BEFORE, GRAM_UNIT, METRIC, MINUS, NOT_LETTER_AFTER, NOT_LETTER_BEFORE, OTHER_UNIT, SPACE } from './meal-draft-lexicon.js';

// Number tokens, exact decimals, nutrient mentions, clauses and sentences of the "Draft from text" grounding (ADR-0092).
// Every span is an offset into the ORIGINAL text: nothing is normalised in a way that would move evidence positions, so
// the excerpt the model claimed, the mention found in it and the analysis of its scope all refer to the same characters.

// A number as people write it: digits, optionally one decimal separator and more digits. Never directly after a letter
// or a digit (B12, x2), never after a separator that follows a digit (the tail of 1.5).
export const NUMBER = /(?<![\p{L}\p{N}_])(?<!\d[.,])\d+(?:[.,]\d+)?(?!\p{N})/gu;

// ---------------------------------------------------------------------------------------------------------------
// Tokens and mentions.

export interface NumberToken {
  end: number;
  start: number;
  text: string;
}

export function numberTokens(text: string, from = 0, to = text.length): NumberToken[] {
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
export interface ExactDecimal {
  fraction: string;
  integer: string;
}

export function exactDecimal(digits: string): ExactDecimal {
  const [integer = '0', fraction = ''] = digits.split(/[.,]/u);
  return { fraction: fraction.replace(/0+$/u, ''), integer: integer.replace(/^0+(?=\d)/u, '') };
}

export const sameDecimal = (left: ExactDecimal, right: ExactDecimal): boolean => left.integer === right.integer && left.fraction === right.fraction;

export type ParsedNumber = { kind: 'ambiguous' } | { kind: 'negative' } | { decimal: ExactDecimal; kind: 'value' };

export type SignBefore = 'ambiguous' | 'negative' | 'none';

/**
 * What stands before the number in the ORIGINAL text, whatever the excerpt includes: a minus sign directly before it
 * (negative), a minus sign separated from it by whitespace (ordinary, no-break, narrow no-break or any other space: it may
 * be a sign or a stray dash, so it is ambiguous), or nothing. A minus that follows another number is the dash of a range,
 * which the clause check refuses on its own.
 */
export function signBefore(text: string, start: number): SignBefore {
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
export function parseToken(text: string, token: NumberToken): ParsedNumber {
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

export type MentionCheck =
  | { kind: 'mention'; end: number; start: number }
  | { kind: 'no_unit' }
  | { kind: 'other_unit' }
  | { kind: 'not_attached' };

/**
 * Whether the number token is a statement of `field`: followed by the field's unit (energy may name its unit before the
 * number instead), and for a macronutrient attached to its name on either side ("protein 40 g", "40 g of protein",
 * "белок 40 г", "40 г белка"). A grams figure next to anything else is a food quantity, never a nutrient.
 */
export function checkMention(text: string, token: NumberToken, field: MealNutritionField): MentionCheck {
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
export function clauseAround(text: string, start: number, end: number): { closer: string; text: string } {
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
export function sentences(text: string): Array<{ end: number; start: number; text: string }> {
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

// ---------------------------------------------------------------------------------------------------------------
// Nutrient mentions and lists (docs/meal-draft-vessel-scope-policy.md, sections 1 and 2).

/**
 * One statement of one field: the number token, the field, its exact decimal (null when the token is not exactly one
 * non-negative number: a sign, a thousands separator) and its span in the original text (from the nutrient name or the
 * number to the unit or the name after it, as `checkMention` reads it).
 */
export interface NutrientMention {
  decimal: ExactDecimal | null;
  end: number;
  field: MealNutritionField;
  /** The index of the mention's list in `MentionStructure.lists`. */
  list: number;
  start: number;
  token: NumberToken;
}

/** A run of coordinated mentions: the indexes of its mentions (in text order) and the span they cover. */
export interface NutrientList {
  end: number;
  mentions: number[];
  start: number;
}

export interface MentionStructure {
  lists: NutrientList[];
  /** Every mention of every field, ordered by position. */
  mentions: NutrientMention[];
}

// Between two mentions of one list: inline whitespace and commas on one line (a comma directly before a line break also
// continues the list), then at most one "and", "plus", "&", "и" or "плюс". Anything else (a word, a sentence end, a
// colon, a parenthesis, a bare line break) ends the list.
const LIST_GAP = /^(?:[^\S\r\n]|,(?:[^\S\r\n]*\r?\n)?)*(?:(?:and|plus|и|плюс)[^\S\r\n]+|&[^\S\r\n]*)?$/iu;

/** Every nutrient mention of the text, grouped into coordinated lists. Bounded by the text (at most 500 characters). */
export function mentionStructure(text: string): MentionStructure {
  const mentions: NutrientMention[] = [];
  for (const token of numberTokens(text)) {
    for (const field of MEAL_NUTRITION_FIELDS) {
      const check = checkMention(text, token, field);
      if (check.kind !== 'mention') continue;
      const parsed = parseToken(text, token);
      mentions.push({ decimal: parsed.kind === 'value' ? parsed.decimal : null, end: check.end, field, list: -1, start: check.start, token });
    }
  }
  mentions.sort((left, right) => left.start - right.start || left.end - right.end);
  const lists: NutrientList[] = [];
  let current: NutrientList | null = null;
  for (const [index, mention] of mentions.entries()) {
    // Overlapping mentions (one token read for two fields, or a name shared by two statements) are one list.
    const joins = current !== null && (mention.start < current.end || LIST_GAP.test(text.slice(current.end, mention.start)));
    if (current !== null && joins) {
      current.mentions.push(index);
      current.end = Math.max(current.end, mention.end);
    } else {
      current = { end: mention.end, mentions: [index], start: mention.start };
      lists.push(current);
    }
    mention.list = lists.length - 1;
  }
  return { lists, mentions };
}
