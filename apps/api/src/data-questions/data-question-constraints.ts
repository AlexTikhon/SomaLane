import type { ActivityType, DataQuestionActivitySource, DataQuestionDayPeriod, DataQuestionWeekPeriod } from '@running-tracker/contracts';

// Question constraints of "Ask my data" (ADR-0095; the written policy is docs/data-question-constraints-policy.md,
// `data-question-constraints-2`). Bounded English and Russian rules that read the ORIGINAL question, independently of
// what a model answered, into evidence spans with reason codes. The normalizer decides with them; they can only make a
// model proposal more conservative (a clarification or a refusal), never create, widen or repair one.
//
// Not a parser. Each rule is a closed pattern matched case-insensitively between letter/digit boundaries; any whitespace
// run is one space; `ё` reads as `е`. Numeric durations are first read WHOLE (qualifier, numbers, unit, "ago") and
// classified by meaning, so "28 days ago" is a relative day and never the 28-day window. The other temporal and window
// phrases are then matched in a fixed order; every match is MASKED, so a phrase counts once ("last week" is not also
// "week"; "the week of the selected date" is not also "the selected date"). No pattern mentions a complete evaluation
// question.

export const DATA_QUESTION_CONSTRAINTS_VERSION = 'data-question-constraints-2';

export type ConstraintCode =
  | 'instruction.code'
  | 'instruction.override'
  | 'instruction.parameter'
  | 'instruction.reveal'
  | 'instruction.role_change'
  | 'instruction.role_label'
  | 'window.28_days'
  | 'window.compare'
  | 'window.previous_period'
  | 'range.all_time'
  | 'range.month_year'
  | 'range.n_units'
  | 'temporal.calendar_date'
  | 'temporal.future'
  | 'temporal.relative_day'
  | 'temporal.vague'
  | 'temporal.weekday'
  | 'period.current_week'
  | 'period.previous_week'
  | 'period.selected_date'
  | 'period.selected_week'
  | 'period.today'
  | 'period.week_unqualified'
  | 'period.yesterday'
  | 'source.gpx'
  | 'source.manual'
  | 'source.negated'
  | 'source.recorded_run'
  | 'source.tcx'
  | `type.${ActivityType}`
  | 'focus.movement'
  | 'focus.nutrition';

/** One piece of evidence: what was recognised and where (UTF-16 offsets into the original question). */
export interface ConstraintEvidence {
  code: ConstraintCode;
  end: number;
  start: number;
}

export interface QuestionConstraints {
  /** Explicit day symbols the question names (several means a contradiction). */
  dayPeriods: ReadonlySet<DataQuestionDayPeriod>;
  evidence: readonly ConstraintEvidence[];
  focuses: ReadonlySet<'movement' | 'nutrition'>;
  /** Any `instruction.*` evidence: the question is refused as a whole. */
  instruction: boolean;
  /** A source word with a negator in front of it (within three words, same clause). */
  negatedSource: boolean;
  /** Positive, non-negated source words. */
  sources: ReadonlySet<DataQuestionActivitySource>;
  types: ReadonlySet<ActivityType>;
  /** `range.*`: a range the three views do not offer. */
  unsupportedRange: boolean;
  /** `temporal.*`: a day named another way (weekday, calendar date, relative, vague, future). */
  unsupportedTemporal: boolean;
  /** "week"/"неделя" without a this/last/selected qualifier. */
  weekUnqualified: boolean;
  /** Explicit week symbols the question names. */
  weekPeriods: ReadonlySet<DataQuestionWeekPeriod>;
  window: { compare: boolean; days28: boolean; previousPeriod: boolean };
}

const BEFORE = '(?<![\\p{L}\\p{N}_])';
const AFTER = '(?![\\p{L}\\p{N}_])';
const bounded = (body: string) => new RegExp(`${BEFORE}(?:${body})${AFTER}`, 'giu');

interface Rule {
  code: ConstraintCode;
  pattern: RegExp;
}

const rule = (code: ConstraintCode, ...alternatives: string[]): Rule => ({ code, pattern: bounded(alternatives.join('|')) });

// ---- Instruction markers (matched on the whole text; never masked) ----

const ROLE = 'system|assistant|developer|admin|administrator|root|система|ассистент|администратор|разработчик|системное|системная';
const ROLE_SUFFIX = 'note|notes|message|prompt|instruction|instructions|override|сообщение|примечание|указание|заметка';
const PARAMETER_NOUNS_EN = 'source|period|type|activity\\s+type|focus|operation|outcome|date|time\\s*zone|zone|owner|user(?:\\s*id)?';
const SYMBOLS =
  'recorded_run|selected_date|selected_week|current_week|previous_week|day_overview|weekly_review|activity_comparison|not_a_data_question|activity_source_missing|activity_type_missing|period_ambiguous|operation_ambiguous|other_person|write_action';

const INSTRUCTION_RULES: readonly Rule[] = [
  {
    code: 'instruction.role_label',
    // A role name used as a label: at the start of the text or of a sentence, followed by a colon; or in brackets.
    pattern: new RegExp(`(?:^|(?<=[.!?;\\n\\r]))\\s*(?:${ROLE})(?:\\s+(?:${ROLE_SUFFIX}))?\\s*:|[\\[<]\\s*(?:${ROLE})\\s*[\\]>]`, 'giu'),
  },
  rule(
    'instruction.override',
    '(?:ignore|disregard|forget|override)\\s+(?:(?:all|any|the|your|my|of|these|those)\\s+)*(?:(?:previous|prior|above|earlier|preceding|system)\\s+)?(?:instructions?|rules?|prompts?|directions?)',
    '(?:игнорируй\\p{L}*|забудь\\p{L}*|не\\s+обращай\\s+внимания\\s+на|отмени\\p{L}*)\\s+(?:(?:все|эти|свои|твои)\\s+)*(?:(?:предыдущ\\p{L}*|прошл\\p{L}*|прежн\\p{L}*|системн\\p{L}*)\\s+)?(?:инструкц\\p{L}*|правил\\p{L}*|указани\\p{L}*|промпт\\p{L}*)',
  ),
  rule(
    'instruction.role_change',
    'you\\s+are\\s+now',
    'act\\s+as',
    'pretend\\s+(?:to\\s+be|you\\s+are|that\\s+you)',
    'from\\s+now\\s+on,?\\s+you',
    'developer\\s+mode',
    'jailbreak',
    'ты\\s+теперь',
    'теперь\\s+ты',
    'представь,?\\s+что\\s+ты',
    'веди\\s+себя\\s+как',
    'притворись',
    'режим\\s+разработчика',
  ),
  rule(
    'instruction.reveal',
    'system\\s+prompts?',
    'your\\s+(?:instructions|rules|prompt)',
    'hidden\\s+instructions',
    'системн\\p{L}*\\s+(?:промпт\\p{L}*|инструкц\\p{L}*)',
    '(?:свои|твои|ваши)\\s+инструкц\\p{L}*',
  ),
  {
    code: 'instruction.parameter',
    pattern: new RegExp(
      [
        `${BEFORE}(?:set|use|choose|pick|select|force|change|switch)\\s+(?:the\\s+|your\\s+)?(?:${PARAMETER_NOUNS_EN})\\s*(?:to|=|:|as)${AFTER}`,
        `${BEFORE}(?:set|use|choose|pick|select|force|change|switch)\\s+(?:the\\s+|your\\s+)?(?:${PARAMETER_NOUNS_EN})\\s*[=:]`,
        `${BEFORE}(?:source|period|activitytype|activity_type|focus|operation|outcome|owner|userid|user_id|timezone|time_zone|selecteddate|selected_date)\\s*[:=]`,
        `${BEFORE}(?:${SYMBOLS})${AFTER}`,
        `${BEFORE}(?:установи|поставь|выбери|задай|укажи|смени|измени|используй)\\p{L}*\\s+(?:источник\\p{L}*|период\\p{L}*|тип\\p{L}*|фокус\\p{L}*|операци\\p{L}*|дат\\p{L}*|(?:часовой\\s+)?пояс\\p{L}*|владельц\\p{L}*|пользовател\\p{L}*)\\s*(?:на|как)${AFTER}`,
        `${BEFORE}(?:установи|поставь|выбери|задай|укажи|смени|измени|используй)\\p{L}*\\s+(?:источник\\p{L}*|период\\p{L}*|тип\\p{L}*|фокус\\p{L}*|операци\\p{L}*|дат\\p{L}*|(?:часовой\\s+)?пояс\\p{L}*)\\s*[=:]`,
      ].join('|'),
      'giu',
    ),
  },
  rule(
    'instruction.code',
    'sql',
    'select\\s+(?:\\*|[a-z_]+(?:\\s*,\\s*[a-z_]+)*)\\s+from\\s+[a-z_]+',
    'drop\\s+table',
    'insert\\s+into',
    'delete\\s+from',
    'union\\s+select',
    'выполни\\p{L}*\\s+(?:запрос\\p{L}*|код\\p{L}*|команд\\p{L}*|скрипт\\p{L}*)',
  ),
  { code: 'instruction.code', pattern: /<\s*script/giu },
];

// ---- Temporal quantities (read whole and classified by meaning BEFORE the ordered phrase rules) ----
//
// A numeric duration is one phrase: an optional range qualifier, one number or a coordinated list of numbers ("28 or 14"),
// a unit, and an optional "ago"/"назад". It is classified by what the whole phrase means, never by which sub-pattern
// happens to run first: N days/weeks ago is a relative day (whatever N is); otherwise 28 days or 4 weeks is the
// comparison window; any other duration is a range when it has a range qualifier or is coordinated with another duration
// ("28 days versus 14 days", "за 28 дней и 14 дней", "28 or 14 days"); a bare duration with neither is no evidence. Only a
// number directly followed by a unit (or joined to one by a conjunction) is read, so other numbers are never range evidence.

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fourteen: 14,
  fifteen: 15,
  'twenty-eight': 28,
  twenty: 20,
  thirty: 30,
  sixty: 60,
  ninety: 90,
  hundred: 100,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  четырнадцать: 14,
  'двадцать-восемь': 28,
  двадцать: 20,
  тридцать: 30,
};
// Compound words first, so "twenty-eight" is never read as "twenty".
const NUMBER = `\\d{1,4}|twenty[\\s-]+eight|двадцать[\\s-]+восемь|${Object.keys(NUMBER_WORDS)
  .filter((word) => !word.includes('-'))
  .join('|')}`;
const UNIT_DAY = 'days?|dates?|дн\\p{L}*|день|дат\\p{L}*';
const UNIT_WEEK = 'weeks?|недел\\p{L}*';
const UNIT_MONTH = 'months?|месяц\\p{L}*';
const UNIT_YEAR = 'years?|год\\p{L}*|лет';
const RANGE_QUALIFIER =
  '(?:last|past|previous|next|over|for|in|during)\\s+(?:the\\s+)?(?:last\\s+|past\\s+)?' +
  '|(?:последн\\p{L}*|прошл\\p{L}*|предыдущ\\p{L}*|следующ\\p{L}*|за|в\\s+течение)\\s+(?:последн\\p{L}*\\s+)?';
// Conjunctions that coordinate two durations (and, or, versus, against, with, to, compared to/with, than; и, или, либо,
// против, с/со, до, по сравнению с, чем, а), alternatives included. "по" is not one: "за 28 дней по вчерашний день" names
// the window's end, not a second duration.
const CONJUNCTION =
  'and|or|versus|vs\\.?|against|with|to|than|plus|compared\\s+(?:to|with)|' + 'и|или|либо|против|со?|до|чем|а|по\\s+сравнению\\s+со?';
const GAP_FILLER = 'the|a|an|my|over|for|in|during|last|past|previous|prior|preceding|first|next|following|other|за|в\\s+течение|последн\\p{L}*|предыдущ\\p{L}*|прошл\\p{L}*|первы\\p{L}*|следующ\\p{L}*|мои\\p{L}*|на';
const AGO = 'ago|back|(?:тому\\s+)?назад';

const QUANTITY = new RegExp(
  `${BEFORE}(?<qualifier>${RANGE_QUALIFIER})?(?<numbers>(?:${NUMBER})(?:\\s*,?\\s+(?:${CONJUNCTION})\\s+(?:${NUMBER}))*)\\s*-?\\s*` +
    `(?<unit>${UNIT_DAY}|${UNIT_WEEK}|${UNIT_MONTH}|${UNIT_YEAR})(?<ago>\\s+(?:${AGO}))?${AFTER}`,
  'giu',
);
const NUMBER_IN_LIST = new RegExp(`${BEFORE}(?:${NUMBER})${AFTER}`, 'giu');
/** What may stand between two coordinated durations: a conjunction and determiners or qualifiers, nothing else. */
const COORDINATION_GAP = new RegExp(`^\\s*,?\\s*(?:${CONJUNCTION})\\s+(?:(?:${GAP_FILLER})\\s+)*$`, 'iu');
/** A bare number after a duration that shares its unit ("over 28 days or 14."). */
const TRAILING_NUMBER = new RegExp(`^\\s*,?\\s*(?:${CONJUNCTION})\\s+(?:(?:${GAP_FILLER})\\s+)*(?<number>${NUMBER})(?=\\s*(?:$|[.,;:!?)]))`, 'iu');

type UnitKind = 'day' | 'month' | 'week' | 'year';

const unitKind = (unit: string): UnitKind =>
  new RegExp(`^(?:${UNIT_DAY})$`, 'iu').test(unit) ? 'day' : new RegExp(`^(?:${UNIT_WEEK})$`, 'iu').test(unit) ? 'week' : new RegExp(`^(?:${UNIT_MONTH})$`, 'iu').test(unit) ? 'month' : 'year';

const numberValue = (word: string): number => (/^\d+$/u.test(word) ? Number(word) : (NUMBER_WORDS[word.toLowerCase().replace(/[\s-]+/gu, '-')] ?? Number.NaN));

/** 28 days or 4 weeks: the comparison window. */
const isWindow = (value: number, unit: UnitKind) => (unit === 'day' && value === 28) || (unit === 'week' && value === 4);

interface Quantity {
  ago: boolean;
  end: number;
  qualified: boolean;
  start: number;
  /** Where the numbers begin (the evidence span of a window or relative day starts here, after any qualifier). */
  numbersStart: number;
  unit: UnitKind;
  values: number[];
}

function* quantities(text: string): Generator<Quantity> {
  QUANTITY.lastIndex = 0;
  for (const match of text.matchAll(QUANTITY)) {
    const groups = match.groups!;
    const qualifier = groups['qualifier'] ?? '';
    const numbers = groups['numbers']!;
    yield {
      ago: groups['ago'] !== undefined,
      end: match.index + match[0].length,
      numbersStart: match.index + qualifier.length,
      qualified: qualifier.length > 0,
      start: match.index,
      unit: unitKind(groups['unit']!),
      values: [...numbers.matchAll(NUMBER_IN_LIST)].map((entry) => numberValue(entry[0])),
    };
  }
}

/**
 * Reads every numeric duration whole and classifies it (see above). Returns the evidence; the caller masks each span.
 * Months and years are never a window or a relative day; without a qualifier or coordination they are left to
 * `range.month_year`, and an unclassified bare day/week duration is left to the phrase rules, exactly as before.
 */
function quantityEvidence(text: string): Array<{ code: ConstraintCode; end: number; maskStart: number; start: number }> {
  const found = [...quantities(text)];
  const coordinated = new Set<Quantity>();
  for (let index = 1; index < found.length; index += 1) {
    const [left, right] = [found[index - 1]!, found[index]!];
    if (left.ago || right.ago) continue;
    if (COORDINATION_GAP.test(text.slice(left.end, right.start))) coordinated.add(left).add(right);
  }
  const evidence: Array<{ code: ConstraintCode; end: number; maskStart: number; start: number }> = [];
  for (const quantity of found) {
    const { end, numbersStart, start, unit, values } = quantity;
    const dayOrWeek = unit === 'day' || unit === 'week';
    if (quantity.ago && dayOrWeek) {
      evidence.push({ code: 'temporal.relative_day', end, maskStart: start, start: numbersStart });
      continue;
    }
    const window = values.every((value) => isWindow(value, unit));
    if (window && !quantity.ago) {
      evidence.push({ code: 'window.28_days', end, maskStart: start, start: numbersStart });
    } else if (quantity.qualified || values.length > 1 || coordinated.has(quantity)) {
      evidence.push({ code: 'range.n_units', end, maskStart: start, start });
    }
    if (quantity.ago) continue;
    // A bare number after the duration takes its unit: "over 28 days or 14" is two durations.
    const trailing = TRAILING_NUMBER.exec(text.slice(end));
    if (trailing !== null && !isWindow(numberValue(trailing.groups!['number']!), unit)) {
      const numberEnd = end + trailing[0].length;
      const numberStart = numberEnd - trailing.groups!['number']!.length;
      evidence.push({ code: 'range.n_units', end: numberEnd, maskStart: numberStart, start: numberStart });
    }
  }
  return evidence;
}

// ---- Temporal and window phrases (matched in this order; each match is masked) ----

const DAY_OF_MONTH = '(?:0?[1-9]|[12]\\d|3[01])';
const MONTHS_EN = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const MONTHS_RU_GENITIVE = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';

const TEMPORAL_RULES: readonly Rule[] = [
  // Numeric durations ("28 days", "4 weeks ago", "over 14 days") were already read above; "previous period" is not
  // "previous week".
  rule('window.previous_period', '(?:the\\s+)?(?:previous|prior|last|preceding)\\s+period', '(?:предыдущ|прошл|прежн)\\p{L}*\\s+период\\p{L}*'),
  rule(
    'temporal.relative_day',
    '(?:the\\s+)?day\\s+before\\s+yesterday',
    `(?:a\\s+few|several)\\s+(?:days?|weeks?)\\s+(?:${AGO})`,
    `a\\s+week\\s+(?:${AGO})`,
    'the\\s+other\\s+day',
    'позавчера',
    'позавчерашн\\p{L}*',
    `несколько\\s+(?:дн\\p{L}*|день|недел\\p{L}*)\\s+(?:${AGO})`,
    `неделю\\s+(?:${AGO})`,
    'на\\s+днях',
  ),
  rule('period.yesterday', '(?:the\\s+)?day\\s+before\\s+today'),
  rule(
    'temporal.vague',
    'recently',
    'lately',
    'last\\s+time',
    'earlier',
    'the\\s+other\\s+week',
    '(?:this\\s+|last\\s+|the\\s+)?weekends?',
    'this\\s+(?:morning|afternoon|evening)',
    'tonight',
    'last\\s+night',
    '(?:this\\s+|the\\s+)?past\\s+week',
    'недавно',
    'в\\s+последнее\\s+время',
    'в\\s+прошлый\\s+раз',
    '(?:на\\s+)?выходны\\p{L}*',
    '(?:сегодня\\s+|вчера\\s+)?(?:утром|вечером)',
    'прошлой\\s+ночью',
  ),
  rule(
    'period.selected_week',
    '(?:the\\s+)?week\\s+(?:of|containing|with|around)\\s+(?:the\\s+)?(?:selected|chosen)\\s+(?:day|date)',
    "(?:the\\s+)?(?:selected|chosen)\\s+(?:day|date)['’]s\\s+week",
    '(?:the\\s+)?(?:selected|chosen)\\s+week',
    'недел\\p{L}*\\s+выбранн\\p{L}*\\s+(?:дн\\p{L}*|день|дат\\p{L}*)',
    'выбранн\\p{L}*\\s+недел\\p{L}*',
  ),
  rule(
    'temporal.future',
    'tomorrow',
    'next\\s+(?:week|month|year|time)',
    '(?:coming|upcoming)\\s+week',
    'завтра',
    'завтрашн\\p{L}*',
    'послезавтра',
    '(?:следующ|будущ)\\p{L}*\\s+(?:недел\\p{L}*|месяц\\p{L}*|год\\p{L}*)',
  ),
  rule('period.current_week', 'this\\s+week', '(?:the\\s+)?current\\s+week', '(?:эта|эту|этой|этот|текущ\\p{L}*|нынешн\\p{L}*)\\s+недел\\p{L}*'),
  rule('period.previous_week', 'last\\s+week', '(?:the\\s+)?(?:previous|prior)\\s+week', '(?:прошл|предыдущ|минувш)\\p{L}*\\s+недел\\p{L}*'),
  rule('period.today', "today(?:['’]s)?", 'сегодня', 'сегодняшн\\p{L}*'),
  rule('period.yesterday', "yesterday(?:['’]s)?", 'вчера', 'вчерашн\\p{L}*'),
  rule(
    'period.selected_date',
    '(?:the\\s+)?(?:selected|chosen)\\s+(?:day|date)',
    'this\\s+day',
    'that\\s+day',
    'выбранн\\p{L}*\\s+(?:дн\\p{L}*|день|дат\\p{L}*)',
    '(?:этот|тот|этого|того)\\s+д(?:ень|ня)',
  ),
  rule('temporal.weekday', '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?', 'понедельник\\p{L}*', 'вторник\\p{L}*', 'сред[аеуы]', 'четверг\\p{L}*', 'пятниц\\p{L}*', 'суббот\\p{L}*', 'воскресень\\p{L}*'),
  rule(
    'temporal.calendar_date',
    '\\d{4}-\\d{1,2}-\\d{1,2}',
    `${DAY_OF_MONTH}[./](?:0?[1-9]|1[0-2])(?:[./]\\d{2,4})?`,
    `${DAY_OF_MONTH}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS_EN})`,
    `(?:${MONTHS_EN})\\s+${DAY_OF_MONTH}(?:st|nd|rd|th)?`,
    `${DAY_OF_MONTH}\\s+(?:${MONTHS_RU_GENITIVE})`,
  ),
  rule(
    'range.month_year',
    'months?',
    'monthly',
    'years?',
    'yearly',
    'annual(?:ly)?',
    // A month by name without a day; "may" and "march" are left out (ordinary verbs).
    'january|february|april|june|july|august|september|october|november|december',
    'месяц\\p{L}*',
    'год|года|году|годом|годов\\p{L}*',
    'январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|июн\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*',
  ),
  rule('range.all_time', 'ever', 'all[\\s-]+time', 'since', 'за\\s+все\\s+время', 'когда-?либо', 'с\\s+тех\\s+пор'),
  rule('period.week_unqualified', 'weeks?', 'weekly', 'недел\\p{L}*', 'недельн\\p{L}*', 'еженедельн\\p{L}*'),
];

// ---- Words matched on the whole text (not masked) ----

const COMPARE_RULE = rule('window.compare', 'compar\\p{L}*', 'versus', 'vs', 'сравн\\p{L}*', 'соотнос\\p{L}*', 'по\\s+сравнению');

const SOURCE_RULES: ReadonlyArray<{ pattern: RegExp; source: DataQuestionActivitySource }> = [
  {
    pattern: bounded('manual(?:ly)?|by\\s+hand|hand-?entered|typed(?:\\s+in)?|вручную|ручн\\p{L}*|введенн\\p{L}*|внесенн\\p{L}*'),
    source: 'manual',
  },
  { pattern: bounded('gpx'), source: 'gpx' },
  { pattern: bounded('tcx'), source: 'tcx' },
  { pattern: bounded('recorded|gps(?:-\\p{L}+)?|tracked|записанн\\p{L}*|записал\\p{L}*|жпс|отслеженн\\p{L}*'), source: 'recorded_run' },
];

const NEGATOR = bounded('not|no|without|except|excluding|exclude|other\\s+than|rather\\s+than|instead\\s+of|non|never|не|без|кроме|исключая|вместо');
/** Between a negator and the word it negates: at most three words, no clause punctuation. */
const NEGATION_GAP = /^[\s\-–—]*(?:[\p{L}\p{N}]+[\s\-–—]+){0,3}$/u;

const TYPE_RULES: ReadonlyArray<{ pattern: RegExp; type: ActivityType }> = [
  { pattern: bounded('run|runs|running|ran|jog|jogs|jogging|бег|бега|бегу|бегом|беге|бегал\\p{L}*|бегов\\p{L}*|пробежк\\p{L}*'), type: 'run' },
  { pattern: bounded('walk|walks|walking|walked|ходьб\\p{L}*|прогулк\\p{L}*'), type: 'walk' },
  {
    pattern: bounded('ride|rides|riding|rode|cycling|cycled|bike|bikes|biking|bicycl\\p{L}*|велосипед\\p{L}*|велотренировк\\p{L}*|велопрогулк\\p{L}*|велозаезд\\p{L}*'),
    type: 'ride',
  },
  { pattern: bounded('hike|hikes|hiking|hiked|поход\\p{L}*|хайкинг\\p{L}*'), type: 'hike' },
  { pattern: bounded('swim|swims|swimming|swam|плавани\\p{L}*|плавал\\p{L}*|заплыв\\p{L}*'), type: 'swim' },
  { pattern: bounded('strength(?:\\s+training)?|weight\\s+training|weight\\s*lifting|силов\\p{L}*'), type: 'strength' },
  {
    pattern: bounded(
      'other\\s+(?:activities|activity|types?|workouts?)|type\\s+other|(?:друг|проч)\\p{L}*\\s+(?:активност\\p{L}*|заняти\\p{L}*|тренировк\\p{L}*)|тип\\p{L}*\\s+[«"]?друго\\p{L}*',
    ),
    type: 'other',
  },
];

const FOCUS_RULES: ReadonlyArray<{ focus: 'movement' | 'nutrition'; pattern: RegExp }> = [
  {
    focus: 'nutrition',
    pattern: bounded(
      'nutrition|meals?|foods?|eat|eats|ate|eaten|eating|calories|calorie|kcal|proteins?|carbohydrates?|carbs?|fats?|питани\\p{L}*|еда|еды|еду|едой|ел|ела|ели|съел\\p{L}*|калори\\p{L}*|ккал|белок|белка|белков\\p{L}*|углевод\\p{L}*|жир\\p{L}*|прием\\p{L}*\\s+пищи',
    ),
  },
  { focus: 'movement', pattern: bounded('steps?|active\\s+energy|movement|шаг\\p{L}*|активн\\p{L}*\\s+энерги\\p{L}*|движени\\p{L}*') },
];

const PERIOD_SYMBOLS: Partial<Record<ConstraintCode, DataQuestionDayPeriod | DataQuestionWeekPeriod>> = {
  'period.current_week': 'current_week',
  'period.previous_week': 'previous_week',
  'period.selected_date': 'selected_date',
  'period.selected_week': 'selected_week',
  'period.today': 'today',
  'period.yesterday': 'yesterday',
};
const DAY_SYMBOLS = new Set<string>(['selected_date', 'today', 'yesterday']);

function* matches(pattern: RegExp, text: string): Generator<{ end: number; start: number }> {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    // A leading-whitespace role label still reports where the label itself starts.
    const leading = match[0].length - match[0].trimStart().length;
    yield { end: match.index + match[0].length, start: match.index + leading };
  }
}

/** Analyses one question. Pure and deterministic; the result depends on the text only. */
export function analyzeQuestionConstraints(question: string): QuestionConstraints {
  // `ё` reads as `е`; one code unit for another, so every offset stays an offset into the original text.
  const text = question.replace(/ё/gu, 'е').replace(/Ё/gu, 'Е');
  const evidence: ConstraintEvidence[] = [];
  const add = (code: ConstraintCode, span: { end: number; start: number }) => evidence.push({ code, ...span });

  for (const { code, pattern } of INSTRUCTION_RULES) for (const span of matches(pattern, text)) add(code, span);

  const mask = (from: string, span: { end: number; start: number }) => `${from.slice(0, span.start)}${' '.repeat(span.end - span.start)}${from.slice(span.end)}`;
  let masked = text;
  for (const { code, end, maskStart, start } of quantityEvidence(text)) {
    add(code, { end, start });
    masked = mask(masked, { end, start: maskStart });
  }
  const dayPeriods = new Set<DataQuestionDayPeriod>();
  const weekPeriods = new Set<DataQuestionWeekPeriod>();
  for (const { code, pattern } of TEMPORAL_RULES) {
    for (const span of matches(pattern, masked)) {
      add(code, span);
      masked = mask(masked, span);
      const symbol = PERIOD_SYMBOLS[code];
      if (symbol === undefined) continue;
      if (DAY_SYMBOLS.has(symbol)) dayPeriods.add(symbol as DataQuestionDayPeriod);
      else weekPeriods.add(symbol as DataQuestionWeekPeriod);
    }
  }
  for (const span of matches(COMPARE_RULE.pattern, text)) add(COMPARE_RULE.code, span);

  const negators = [...matches(NEGATOR, text)];
  const sources = new Set<DataQuestionActivitySource>();
  let negatedSource = false;
  for (const { pattern, source } of SOURCE_RULES) {
    for (const span of matches(pattern, text)) {
      const negated = negators.some((negator) => negator.end <= span.start && NEGATION_GAP.test(text.slice(negator.end, span.start)));
      if (negated) {
        negatedSource = true;
        add('source.negated', span);
      } else {
        sources.add(source);
        add(`source.${source}`, span);
      }
    }
  }

  const types = new Set<ActivityType>();
  for (const { pattern, type } of TYPE_RULES) {
    for (const span of matches(pattern, text)) {
      types.add(type);
      add(`type.${type}`, span);
    }
  }
  const focuses = new Set<'movement' | 'nutrition'>();
  for (const { focus, pattern } of FOCUS_RULES) {
    for (const span of matches(pattern, text)) {
      focuses.add(focus);
      add(`focus.${focus}`, span);
    }
  }

  const has = (prefix: string) => evidence.some((entry) => entry.code.startsWith(prefix));
  const hasCode = (code: ConstraintCode) => evidence.some((entry) => entry.code === code);
  return {
    dayPeriods,
    evidence: evidence.toSorted((left, right) => left.start - right.start || left.code.localeCompare(right.code)),
    focuses,
    instruction: has('instruction.'),
    negatedSource,
    sources,
    types,
    unsupportedRange: has('range.'),
    unsupportedTemporal: has('temporal.'),
    weekPeriods,
    weekUnqualified: hasCode('period.week_unqualified'),
    window: { compare: hasCode('window.compare'), days28: hasCode('window.28_days'), previousPeriod: hasCode('window.previous_period') },
  };
}
