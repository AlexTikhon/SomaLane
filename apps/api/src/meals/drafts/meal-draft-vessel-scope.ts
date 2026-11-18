import { ENERGY_UNIT, ENERGY_UNIT_WORD_BEFORE, GRAM_UNIT, METRIC, MINUS_OR_DASH, NOT_LETTER_AFTER, NOT_LETTER_BEFORE, SPACE } from './meal-draft-lexicon.js';
import { mentionStructure, type NutrientList, type NutrientMention } from './meal-draft-mentions.js';

// The vessel-scope analysis of the "Draft from text" grounding: ONE analysis of the original text, shared by proposal
// validation and conflict detection, that decides which nutrient mentions belong to a whole cooking vessel or batch
// ("the whole pot is 900 kcal"), which are explicitly unrelated to a vessel mentioned beside them ("Washed the whole
// pan."), and which cannot be decided ("Полная кастрюля окрошки\n900 ккал", "I cooked a full pot of soup.\n900 kcal").
// The policy, its supported constructions and its precedence are in docs/meal-draft-vessel-scope-policy.md; this module
// implements exactly that and nothing more. It is a bounded deterministic verifier, not language understanding.
//
// Shape: the text's nutrient mentions are grouped into coordinated LISTS (`mentionStructure`). Every vessel CONTEXT has
// a span and attaches to whole lists, never to a line or sentence: a supported construction to the list of the figure it
// names; a vessel clause to the list next to it. Each list then gets ONE attribution (confirmed, unresolved or none) by
// the precedence of the policy, and every mention of the list carries it.
//
// A vessel word on its own is NOT context: food names and cooking references ("Pot roast", "Pan-fried salmon", "Soup
// from the pot", "Суп из кастрюли", "Плов из казана", "Тушила в кастрюле 40 минут") name the vessel without giving it a
// figure, and a whole-quantified vessel is context only in the constructions below or as a clause next to a figure.
// Supported constructions (ADR-0092 Amendment 6 and its correction):
// - a whole-quantified vessel ("whole/entire/full pot", "all (of) the pot", "вся/всю/всей/целая/полная кастрюля",
//   "весь/целый казан", "кастрюля целиком") that is
//   - the subject of a figure: "the whole pot (of chili) is/has/contains/was … 900 kcal" (at most two words before the
//     figure, any whitespace), "вся кастрюля содержит/была/это 900 ккал";
//   - set beside a figure in the same statement: on the same line with at most one "," ":" "=" or dash between them, or
//     a line break after ":" "=" or a dash ("whole pot, fat 45.5 g", "a full pot of soup: 900 kcal", "вся кастрюля 900
//     ккал", "полная кастрюля супа, 900 ккал");
//   - qualifying a figure before it on the same line through an optional "for/in/of" or "на/за/в/во/для" and an article
//     ("900 kcal for the whole pot", "protein 80 g, the whole pot", "900 ккал на всю кастрюлю");
// - the vessel as the subject of a figure: "the/this/that pot (of soup) is/has/contains/was … 900 kcal" (at most two
//   words before the figure; not after "from" or "out of", which name where the food came from: "Soup from the pot is
//   300 kcal"), "Pot: 900 kcal" at the start of a clause, "Кастрюля 900 ккал", "Кастрюля: 900 ккал", "Кастрюля
//   содержит 900 ккал" (the nominative only: "Суп из кастрюли 300 ккал" is a source);
// - a figure located in the vessel: "в (этой) кастрюле 900 ккал", "in the pot: 900 kcal".
// A figure is a number with an energy or gram unit, or a nutrient or energy word that opens a statement. Vessel CLAUSES
// next to a figure (labels, actions, unresolved clauses) are classified by `classifyVesselClause` below. Nothing is
// inferred from any of these: not how much of the vessel was eaten, and never a fraction of a value.
const VESSEL_EN = '(?:saucepans|saucepan|skillets|skillet|batches|batch|pots|pot|pans|pan)';
const VESSEL_RU = [
  'кастрюл(?:я|и|ю|е|ей|ею|ь|ям|ями|ях)',
  'кастрюльк(?:а|и|у|е|ой|ою)',
  'сковород(?:а|ы|у|е|ой|ою)',
  'сковородк(?:а|и|у|е|ой|ою)',
  'казан(?:а|у|ом|е|ы|ов)?',
].join('|');
const VESSEL_RU_NOMINATIVE = '(?:кастрюля|кастрюлька|сковорода|сковородка|казан)';
const VESSEL_RU_LOCATIVE = '(?:кастрюле|кастрюльке|сковороде|сковородке|казане)';
const NUTRIENT_WORD = `(?:${Object.values(METRIC).join('|')}|${ENERGY_UNIT_WORD_BEFORE})`;
const FIGURE = `(?:\\d+(?:[.,]\\d+)?${SPACE}?(?:${ENERGY_UNIT}|${GRAM_UNIT})${NOT_LETTER_AFTER}|${NOT_LETTER_BEFORE}${NUTRIENT_WORD}${NOT_LETTER_AFTER})`;
const FIGURE_GAP = `\\s*(?:[:=]|${MINUS_OR_DASH})?\\s*`;
// Horizontal whitespace only (spaces, tabs, no-break spaces): a bare line break separates statements.
const INLINE_SPACE = '[^\\S\\r\\n]';
// Between a whole-quantified vessel and a figure beside it in the same statement: the same line with at most one "," ":"
// "=" or dash, or a line break only after an explicit ":" "=" or dash. Wider adjacency (sentence ends, bare line breaks,
// parentheses) is a vessel clause next to a figure (`vesselClauses`), which also looks at the vessel's own clause.
const BESIDE_GAP = `(?:${INLINE_SPACE}*(?:[,:=]|${MINUS_OR_DASH})?${INLINE_SPACE}*|${INLINE_SPACE}*(?:[:=]|${MINUS_OR_DASH})\\s*)`;
// Between a figure and the whole-quantified vessel after it when a preposition or an article stands between them: the
// same line with at most one "," ":" "=" or dash ("900 kcal for the whole pot", "protein 80 g, the whole pot").
const AFTER_FIGURE_GAP = `${INLINE_SPACE}*(?:[,:=]|${MINUS_OR_DASH})?${INLINE_SPACE}*`;
const WHOLE_VESSEL_EN = `${NOT_LETTER_BEFORE}(?:(?:whole|entire|full)\\s+${VESSEL_EN}|all\\s+(?:of\\s+)?(?:the|this|that|my|our)\\s+${VESSEL_EN})${NOT_LETTER_AFTER}`;
const WHOLE_VESSEL_RU = `${NOT_LETTER_BEFORE}(?:(?:вс(?:я|ю|ей|ею|ем|его|ё|е)|весь|цел(?:ая|ую|ой|ый|ого|ом)|полн(?:ая|ую|ой|ый|ого|ом))\\s+(?:${VESSEL_RU})|(?:${VESSEL_RU})\\s+целиком)${NOT_LETTER_AFTER}`;
// Each supported construction on its own, so that every reading of the text is found, also where two of them overlap
// (`constructionContexts`).
const CONSTRUCTIONS: readonly RegExp[] = [
  // A whole-quantified vessel as the subject of a figure: "the whole pot (of chili) is … 900 kcal".
  `${WHOLE_VESSEL_EN}(?:\\s+of\\s+\\p{L}+)?\\s+(?:is|was|has|had|contains|contained|holds|held|totals|totaled|totalled|comes\\s+to|came\\s+to)\\s+(?:\\p{L}+\\s+){0,2}${FIGURE}`,
  // Beside a figure in the same statement: "whole pot, fat 45.5 g", "a full pot of soup: 900 kcal", "Whole pot:\n900 kcal".
  `${WHOLE_VESSEL_EN}(?:\\s+of\\s+\\p{L}+)?${BESIDE_GAP}${FIGURE}`,
  // Russian, beside or as the subject: "вся кастрюля 900 ккал", "полная кастрюля супа, 900 ккал", "целая кастрюля —
  // это 900 ккал", "вся кастрюля содержит 900 ккал" (one word may follow the vessel on its line).
  `${WHOLE_VESSEL_RU}(?:${INLINE_SPACE}+\\p{L}+)?${BESIDE_GAP}(?:(?:это|содерж\\p{L}*|был[аио]?|составля\\p{L}*)${INLINE_SPACE}*(?:[:=]|${MINUS_OR_DASH})?${INLINE_SPACE}*)?${FIGURE}`,
  // A figure qualified by the whole-quantified vessel after it on the same line: "900 kcal for the whole pot", "900 ккал
  // на всю кастрюлю".
  `${FIGURE}${AFTER_FIGURE_GAP}(?:(?:for|in|of)\\s+)?(?:(?:a|an|the|this|that|my|our)\\s+)?${WHOLE_VESSEL_EN}`,
  `${FIGURE}${AFTER_FIGURE_GAP}(?:(?:на|за|в|во|для)\\s+)?${WHOLE_VESSEL_RU}`,
  `${NOT_LETTER_BEFORE}(?<!${NOT_LETTER_BEFORE}(?:from|out\\s+of)\\s+)(?:the|this|that|my|our)\\s+${VESSEL_EN}(?:\\s+of\\s+\\p{L}+)?\\s+(?:is|was|has|had|contains|contained|holds|held|totals|totaled|totalled|comes\\s+to|came\\s+to)\\s+(?:\\p{L}+\\s+){0,2}${FIGURE}`,
  `(?:(?:^|[\\r\\n.;!?,(])\\s*(?:(?:the|this|that|my|our)\\s+)?|${NOT_LETTER_BEFORE}in\\s+(?:the|this|that|my|our)\\s+)${VESSEL_EN}\\s*(?:[:=]|${MINUS_OR_DASH})\\s*${FIGURE}`,
  `${NOT_LETTER_BEFORE}${VESSEL_RU_NOMINATIVE}(?:\\s+(?:содерж\\p{L}*|был[аио]?|это))?${FIGURE_GAP}${FIGURE}`,
  `${NOT_LETTER_BEFORE}в\\s+(?:(?:этой|этом|той|том|моей|моём|моем)\\s+)?${VESSEL_RU_LOCATIVE}${FIGURE_GAP}${FIGURE}`,
].map((source) => new RegExp(source, 'giu'));
// One vessel word (any case form), the reference a construction is about: two readings that contain the same occurrence
// compete for it.
const VESSEL_WORD = new RegExp(`${NOT_LETTER_BEFORE}(?:${VESSEL_EN}|${VESSEL_RU})${NOT_LETTER_AFTER}`, 'giu');

// A Russian food qualifier after a whole vessel in a label: a dish or food noun in the genitive ("Полная кастрюля супа",
// "весь казан плова"), the Russian counterpart of the English "of soup". Russian marks it by case alone, and a genitive
// noun cannot be told from a short participle by its ending ("супа", "салата", "бульона" against "помыта", "налита",
// "убрана"), so only the words listed here CONFIRM a label. Another trailing word does not make the clause an action:
// unless it is an explicit action word (`VESSEL_ACTION_ANYWHERE`), the attribution is unresolved ("Полная кастрюля
// окрошки"), and unresolved is treated conservatively (see `analyzeVesselScope`). The list only spares known dishes that
// abstention; it is not what keeps unknown ones safe.
const FOOD_QUALIFIER_RU = [
  'суп(?:а|ов)',
  'супчика',
  'борщ(?:а|ей)',
  'щей',
  'бульон(?:а|ов)',
  'солянки',
  'рассольника',
  'ухи',
  'харчо',
  'лагмана',
  'шурпы',
  'плова',
  'каши',
  'гречки',
  'риса',
  'рагу',
  'гуляша',
  'жаркого',
  'чили',
  'лапши',
  'макарон',
  'пасты',
  'картошки',
  'картофеля',
  'пюре',
  'овощей',
  'мяса',
  'курицы',
  'фарша',
  'тушенки',
  'тушёнки',
  'котлет',
  'пельменей',
  'вареников',
  'голубцов',
  'омлета',
  'яичницы',
  'компота',
  'киселя',
  'соуса',
  'фасоли',
  'чечевицы',
  'капусты',
].join('|');

// A whole-vessel LABEL (a confirmed attribution): a clause that is nothing but the vessel reference, with an optional
// preposition and article and an English "of …" or a Russian food qualifier ("Whole pot", "(whole pot)", "(for the whole
// pot)", "The entire pan", "Вся кастрюля", "(на всю кастрюлю)", "Казан целиком", "Полная кастрюля супа").
const WHOLE_VESSEL_LABEL = new RegExp(
  `^\\s*(?:(?:(?:for|in|of)\\s+)?(?:(?:a|an|the|this|that|my|our)\\s+)?${WHOLE_VESSEL_EN}(?:\\s+of\\s+\\p{L}+)?|(?:(?:на|за|в|во|для)\\s+)?${WHOLE_VESSEL_RU}(?:\\s+(?:${FOOD_QUALIFIER_RU})${NOT_LETTER_AFTER})?)\\s*$`,
  'iu',
);
const WHOLE_VESSEL_ANYWHERE = new RegExp(`${WHOLE_VESSEL_EN}|${WHOLE_VESSEL_RU}`, 'giu');

// An explicit ACTION in a vessel clause: something done with the vessel as an object, so the clause attributes no
// nutrition to it ("Washed the whole pan", "Whole pot washed afterwards", "For the whole pot I used a lid", "Помыла всю
// сковороду", "Полная кастрюля помыта", "Всю кастрюлю помыла потом", "На всю кастрюлю ушла крышка"). Anywhere in the
// clause: cleaning words and kitchen objects other than food, which never describe a dish, and Russian finite handling
// verbs (past tense or infinitive only). English handling verbs count only BEFORE the vessel ("Used the whole pot"). Only
// listed words count: a clause with neither a label nor one of these is unresolved, never an action by default.
const VESSEL_ACTION_ANYWHERE = new RegExp(
  [
    `${NOT_LETTER_BEFORE}(?:wash\\p{L}*|scrub\\p{L}*|clean\\p{L}*|rins\\p{L}*|soak\\p{L}*|dishwasher\\p{L}*|sinks?|lids?)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}(?:(?:по|вы|от|с|про|об|за)?мы(?:л|т|в)\\p{L}*|(?:по|вы|о|от)чист\\p{L}*|чист(?:ая|ую|ил\\p{L}*|ить)|(?:с|о|про)?полосн\\p{L}*|замоч\\p{L}*|крышк\\p{L}*|посудомо\\p{L}*|раковин\\p{L}*)${NOT_LETTER_AFTER}`,
    `${NOT_LETTER_BEFORE}(?:постави(?:л|ть)\\p{L}*|убра(?:л|ть)\\p{L}*|накры(?:л|ть)\\p{L}*|использова(?:л|ть)\\p{L}*)${NOT_LETTER_AFTER}`,
  ].join('|'),
  'iu',
);
const VESSEL_ACTION_BEFORE_EN = new RegExp(`${NOT_LETTER_BEFORE}(?:used|put|stored|covered)${NOT_LETTER_AFTER}`, 'iu');

// COOKING in a vessel clause. Unlike washing, cooking can produce the batch the figure describes, so a cooking word is an
// unrelated action only when the vessel is where the cooking happened: the vessel reference follows a locative preposition
// (`VESSEL_AS_PLACE`: "Cooked soup in a full pot", "Cooked in a full pot", "Сварила суп в полной кастрюле"). When the
// whole vessel is what was cooked ("I cooked a full pot of soup", "Made the whole pot of chili", "Сварила полную
// кастрюлю супа", "Наварила целый казан плова"), the clause describes the batch and no consumed amount is established:
// the attribution stays unresolved. Russian finite verbs anywhere (past tense or infinitive, never a participle or an
// adjective such as "жареной", "вареников", "тушенки", which name the food); English verbs only BEFORE the vessel,
// because after it they describe the food ("Full pan of fried rice").
const VESSEL_COOKING_ANYWHERE_RU = new RegExp(
  `${NOT_LETTER_BEFORE}(?:(?:с|за|на|у|при|до|по|пере)?вари(?:л|ть)\\p{L}*|(?:по|за|об|из|под|пере)?жари(?:л|ть)\\p{L}*|(?:за|по|при|пере)?туши(?:л|ть)\\p{L}*|приготови(?:л|ть)\\p{L}*)${NOT_LETTER_AFTER}`,
  'iu',
);
const VESSEL_COOKING_BEFORE_EN = new RegExp(
  `${NOT_LETTER_BEFORE}(?:cook(?:ed|ing|s)?|made|make|making|boiled|boiling|simmered|simmering|stewed|stewing|fried|frying|baked|baking|roasted|roasting|prepared|preparing)${NOT_LETTER_AFTER}`,
  'iu',
);
// The vessel reference directly after a locative preposition (and an optional article): the place of the cooking.
const VESSEL_AS_PLACE = new RegExp(`${NOT_LETTER_BEFORE}(?:(?:in|into|inside|on|over)\\s+(?:(?:a|an|the|this|that|my|our)\\s+)?|(?:в|во|на)\\s+)$`, 'iu');

type VesselClause = 'action' | 'label' | 'unresolved';

/** What a clause holding a whole-vessel reference (starting at `vesselStart` within it) says about the vessel. */
function classifyVesselClause(clause: string, vesselStart: number): VesselClause {
  if (WHOLE_VESSEL_LABEL.test(clause)) return 'label';
  const before = clause.slice(0, vesselStart);
  if (VESSEL_ACTION_ANYWHERE.test(clause) || VESSEL_ACTION_BEFORE_EN.test(before)) return 'action';
  const cooking = VESSEL_COOKING_ANYWHERE_RU.test(clause) || VESSEL_COOKING_BEFORE_EN.test(before);
  if (cooking && VESSEL_AS_PLACE.test(before)) return 'action';
  return 'unresolved';
}
// Clause edges for a vessel reference: sentence ends, line breaks, parentheses, brackets, commas, colons, semicolons, an
// equals sign and spaced dashes.
const VESSEL_CLAUSE_EDGE = /[.;!?,:=()[\]\r\n–—]/u;
// Only punctuation and whitespace between a label and a figure (parentheses and line breaks included).
const LABEL_GAP = `(?:\\s|[,:;.!=()[\\]]|${MINUS_OR_DASH})*`;
const FIGURE_AFTER_LABEL = new RegExp(`^${LABEL_GAP}${FIGURE}`, 'iu');
const FIGURE_BEFORE_LABEL = new RegExp(`${FIGURE}${LABEL_GAP}$`, 'iu');
const LEADING_LABEL_GAP = new RegExp(`^${LABEL_GAP}`, 'u');
const TRAILING_LABEL_GAP = new RegExp(`${LABEL_GAP}$`, 'u');

// ---------------------------------------------------------------------------------------------------------------
// The analysis.

export interface Span {
  end: number;
  start: number;
}

/** How a list of mentions relates to a vessel (policy, section 4). */
export type VesselAttribution = 'confirmed' | 'none' | 'unresolved';

/**
 * One vessel context. `construction`: one reading by the supported constructions (`CONSTRUCTIONS`), its span the match
 * (or the union of equivalent overlapping matches); downgraded to `unresolved` when its own words are also read as an
 * action clause, or when another reading of the same vessel word attaches to different lists (`constructionContexts`).
 * `clause`: a vessel clause next to a figure, its span
 * the clause, classified as a label (confirmed), an action or unresolved; a label next to figures on both sides becomes
 * unresolved. `lists` are the indexes of the lists it attaches to (possibly none, when its figure is not a nutrient
 * mention, such as a food weight "900 g").
 */
export interface VesselContext {
  kind: 'action' | 'confirmed' | 'unresolved';
  lists: number[];
  source: 'clause' | 'construction';
  span: Span;
}

export interface VesselScopeAnalysis {
  /** The attribution of each list, by list index. */
  attribution: VesselAttribution[];
  contexts: VesselContext[];
  /** Whether a confirmed or unresolved context exists anywhere: the trigger of the global proposal policy. */
  hasVesselContext: boolean;
  lists: NutrientList[];
  mentions: NutrientMention[];
}

interface VesselClauseFinding {
  after: Span | null;
  before: Span | null;
  clause: Span;
  kind: VesselClause;
}

const overlaps = (left: Span, right: Span): boolean => left.start < right.end && right.start < left.end;

/** The lists with a mention overlapping `span`. */
function listsOverlapping(mentions: readonly NutrientMention[], span: Span): number[] {
  return [...new Set(mentions.filter((mention) => overlaps(mention, span)).map((mention) => mention.list))];
}

/**
 * Every vessel clause next to a figure: the clause around a whole-vessel reference (up to `VESSEL_CLAUSE_EDGE`) that holds
 * no nutrient mention of its own (a clause with one is judged only by the constructions), with a figure directly before
 * or after it across punctuation and whitespace only. One entry per clause, classified at its first vessel reference.
 */
function vesselClauses(text: string, mentions: readonly NutrientMention[]): VesselClauseFinding[] {
  const found: VesselClauseFinding[] = [];
  const seen = new Set<number>();
  for (const match of text.matchAll(WHOLE_VESSEL_ANYWHERE)) {
    let left = match.index;
    while (left > 0 && !VESSEL_CLAUSE_EDGE.test(text[left - 1] ?? '')) left -= 1;
    let right = match.index + match[0].length;
    while (right < text.length && !VESSEL_CLAUSE_EDGE.test(text[right] ?? '')) right += 1;
    if (seen.has(left)) continue;
    seen.add(left);
    const clause = { end: right, start: left };
    if (mentions.some((mention) => overlaps(mention, clause))) continue;
    const afterMatch = FIGURE_AFTER_LABEL.exec(text.slice(right));
    const after = afterMatch === null ? null : { end: right + afterMatch[0].length, start: right + (LEADING_LABEL_GAP.exec(afterMatch[0])?.[0].length ?? 0) };
    const beforeMatch = FIGURE_BEFORE_LABEL.exec(text.slice(0, left));
    const before =
      beforeMatch === null ? null : { end: beforeMatch.index + (TRAILING_LABEL_GAP.exec(beforeMatch[0])?.index ?? beforeMatch[0].length), start: beforeMatch.index };
    if (after === null && before === null) continue;
    found.push({ after, before, clause, kind: classifyVesselClause(text.slice(left, right), match.index - left) });
  }
  return found;
}

/**
 * Every reading of the text by a supported construction (`CONSTRUCTIONS`), overlapping ones included, as contexts:
 *
 * - each construction is matched from every position, so a reading is never hidden by an overlapping one found first
 *   ("Soup, 300 kcal, the whole pot has 900 kcal" is read both as "300 kcal, the whole pot" and as "the whole pot has
 *   900 kcal");
 * - readings that contain the same vessel words and attach to the same lists establish the same attribution and are one
 *   context ("900 kcal for the whole pot" read from "900" and from "kcal"; "вся кастрюля содержит 900 ккал" read from
 *   "вся" and from "кастрюля");
 * - readings that contain the same vessel word but attach to different lists COMPETE: which figure is the vessel's
 *   cannot be decided, so each of them is unresolved and none can take a value out of the conflict scan;
 * - a reading whose own words are also read as an action clause is unresolved (the same evidence read two ways).
 *
 * Bounded by the text (at most 500 characters): a handful of patterns, each tried once per match position.
 */
function constructionContexts(text: string, mentions: readonly NutrientMention[], actionClauses: readonly Span[]): VesselContext[] {
  const vesselWords: Span[] = [...text.matchAll(VESSEL_WORD)].map((match) => ({ end: match.index + match[0].length, start: match.index }));
  const readings = new Map<string, { contradicted: boolean; lists: number[]; span: Span; vessels: number[] }>();
  for (const pattern of CONSTRUCTIONS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      // The next attempt starts one character later, not after the match: overlapping readings are wanted.
      pattern.lastIndex = match.index + 1;
      const span = { end: match.index + match[0].length, start: match.index };
      const vessels = vesselWords.flatMap((vessel, index) => (vessel.start >= span.start && vessel.end <= span.end ? [index] : []));
      const lists = listsOverlapping(mentions, span).sort((left, right) => left - right);
      // The same words read as an action clause (the same-line construction admits one free Russian word: "Полная
      // кастрюля помыта, 900 ккал"): contradictory evidence, so unresolved.
      const contradicted = actionClauses.some((clause) => overlaps(clause, span));
      const key = `${vessels.join(',')}|${lists.join(',')}`;
      const same = readings.get(key);
      if (same === undefined) readings.set(key, { contradicted, lists, span, vessels });
      else readings.set(key, { ...same, contradicted: same.contradicted || contradicted, span: { end: Math.max(same.span.end, span.end), start: Math.min(same.span.start, span.start) } });
    }
  }
  const all = [...readings.values()];
  return all.map((reading) => {
    const competing = all.some(
      (other) => other.lists.join(',') !== reading.lists.join(',') && other.vessels.some((vessel) => reading.vessels.includes(vessel)),
    );
    return { kind: reading.contradicted || competing ? 'unresolved' : 'confirmed', lists: reading.lists, source: 'construction', span: reading.span };
  });
}

/**
 * The vessel scope of the text (docs/meal-draft-vessel-scope-policy.md, sections 2 to 4): its mentions and lists, every
 * vessel context with the lists it attaches to, and one attribution per list by this precedence:
 *
 * 1. any unresolved context (an unresolved clause, a label next to figures on both sides, a construction whose own words
 *    are also an action clause, constructions competing for one vessel reference) makes the list unresolved;
 * 2. otherwise a confirmed context (a construction or a label) makes it confirmed;
 * 3. otherwise (an action or nothing) it has no attribution. An action changes nothing on its own.
 *
 * Attribution is local to the lists a context attaches to: a context elsewhere never changes another list.
 */
export function analyzeVesselScope(text: string): VesselScopeAnalysis {
  const { lists, mentions } = mentionStructure(text);
  const clauses = vesselClauses(text, mentions);
  const actionClauses = clauses.filter((clause) => clause.kind === 'action').map((clause) => clause.clause);
  const contexts: VesselContext[] = constructionContexts(text, mentions, actionClauses);
  for (const clause of clauses) {
    const sides = [clause.before, clause.after].filter((side): side is Span => side !== null);
    const attached = [...new Set(sides.flatMap((side) => listsOverlapping(mentions, side)))];
    // A label next to figures on both sides: which one it labels is ambiguous.
    const kind = clause.kind === 'label' ? (clause.before !== null && clause.after !== null ? 'unresolved' : 'confirmed') : clause.kind;
    contexts.push({ kind, lists: attached, source: 'clause', span: clause.clause });
  }

  const attribution: VesselAttribution[] = lists.map(() => 'none');
  for (const context of contexts) {
    for (const list of context.lists) {
      if (context.kind === 'unresolved') attribution[list] = 'unresolved';
      else if (context.kind === 'confirmed' && attribution[list] === 'none') attribution[list] = 'confirmed';
    }
  }
  return { attribution, contexts, hasVesselContext: contexts.some((context) => context.kind !== 'action'), lists, mentions };
}

/**
 * The attribution of the mention of `field` at exactly [start, end). A mention the analysis does not know (which the
 * shared recogniser rules out) is treated as unresolved, the conservative reading.
 */
export function attributionOf(analysis: VesselScopeAnalysis, field: string, span: Span): VesselAttribution {
  const mention = analysis.mentions.find((candidate) => candidate.field === field && candidate.start === span.start && candidate.end === span.end);
  return mention === undefined ? 'unresolved' : (analysis.attribution[mention.list] ?? 'unresolved');
}

/** Whether a sentence holds a confirmed or unresolved vessel context, or a mention attributed to a vessel. */
export function sentenceHasVesselScope(analysis: VesselScopeAnalysis, sentence: Span): boolean {
  if (analysis.contexts.some((context) => context.kind !== 'action' && overlaps(context.span, sentence))) return true;
  return analysis.mentions.some((mention) => mention.start >= sentence.start && mention.end <= sentence.end && analysis.attribution[mention.list] !== 'none');
}
