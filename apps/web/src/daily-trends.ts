import {
  DAILY_TRENDS_METRICS,
  DAILY_TRENDS_NUTRITION_FIELD,
  isDailyTrendsNutritionMetric,
  type DailyTrendDay,
  type DailyTrends,
  type DailyTrendsMetric,
  type DailyTrendsNutritionMetric,
  type DailyTrendsRange,
} from '@running-tracker/contracts';

import { formatCheckInDate, formatSleep } from './daily-checkin.js';
import { formatSteps } from './daily-movement.js';
import { formatNutritionNumber } from './meal-log.js';

// Presentation of the 28-day trends (ADR-0084; recorded nutrition since ADR-0096). Pure functions: every sentence, label
// and chart coordinate the screen shows comes from here, so each state can be tested without a DOM. Missing is "Not
// recorded" (unknown), never 0; a recorded 0 is shown as 0. A nutrition total covers only the logged entries that record
// it, never what was eaten. No target, judgement, balance, estimate, average, prediction, correlation or recommendation
// is ever written.

export const NOT_RECORDED = 'Not recorded';

export interface TrendMetricSpec {
  /** Short name for the selector and the table's value column. */
  label: string;
  /** The chart's title: what the series is, with its unit. */
  title: string;
  unit: string;
  /** Where the values come from, in a sentence. */
  source: string;
  /** Recorded zeros can occur and the axis starts at 0 (weight cannot be 0, so its axis follows its values). */
  zeroBaseline: boolean;
  valueOf: (day: DailyTrendDay) => number | null;
  format: (value: number) => string;
}

/** How each nutrition series is named in sentences: its name, the noun in a sentence, the short word and the unit. */
interface NutritionWording {
  name: string;
  noun: string;
  short: string;
  unit: 'g' | 'kcal';
  withValue: string;
}

const nutritionWording: Readonly<Record<DailyTrendsNutritionMetric, NutritionWording>> = {
  carbohydrateG: { name: 'Carbohydrate', noun: 'carbohydrate', short: 'carbohydrate', unit: 'g', withValue: 'a carbohydrate value' },
  fatG: { name: 'Fat', noun: 'fat', short: 'fat', unit: 'g', withValue: 'a fat value' },
  foodEnergyKcal: { name: 'Food energy', noun: 'food energy', short: 'energy', unit: 'kcal', withValue: 'an energy value' },
  proteinG: { name: 'Protein', noun: 'protein', short: 'protein', unit: 'g', withValue: 'a protein value' },
};

function nutritionSpec(metric: DailyTrendsNutritionMetric): TrendMetricSpec {
  const wording = nutritionWording[metric];
  const field = DAILY_TRENDS_NUTRITION_FIELD[metric];
  return {
    format: (value) => `${formatNutritionNumber(value)} ${wording.unit}`,
    label: wording.name,
    source: `The sum of the ${wording.noun} you recorded on the meal entries you logged for each date.`,
    title: `${wording.name} recorded (${wording.unit})`,
    unit: wording.unit,
    valueOf: (day) => day.nutrition[field].total,
    zeroBaseline: true,
  };
}

export const trendMetricSpecs: Readonly<Record<DailyTrendsMetric, TrendMetricSpec>> = {
  weightKg: {
    format: (kg) => `${String(kg)} kg`, // a stored weight has at most two decimals, so the shortest spelling is exact
    label: 'Weight',
    source: 'The weight saved in your check-in for each date.',
    title: 'Recorded weight (kg)',
    unit: 'kg',
    valueOf: (day) => day.weightKg,
    zeroBaseline: false,
  },
  sleepMinutes: {
    format: formatSleep,
    label: 'Sleep',
    source: 'The sleep duration saved in your check-in for each date.',
    title: 'Recorded sleep duration',
    unit: 'h min',
    valueOf: (day) => day.sleepMinutes,
    zeroBaseline: true,
  },
  steps: {
    format: formatSteps,
    label: 'Steps',
    source: 'The steps you entered by hand for each date.',
    title: 'Manually entered steps',
    unit: 'steps',
    valueOf: (day) => day.steps,
    zeroBaseline: true,
  },
  foodEnergyKcal: nutritionSpec('foodEnergyKcal'),
  proteinG: nutritionSpec('proteinG'),
  carbohydrateG: nutritionSpec('carbohydrateG'),
  fatG: nutritionSpec('fatG'),
};

export const trendMetricOptions = DAILY_TRENDS_METRICS.map((metric) => ({ label: trendMetricSpecs[metric].label, metric }));

export function isTrendsMetric(value: string): value is DailyTrendsMetric {
  return (DAILY_TRENDS_METRICS as readonly string[]).includes(value);
}

/** True for food energy, protein, carbohydrate and fat: the series read from the meal log, with a Meal log action. */
export const isNutritionTrendsMetric = isDailyTrendsNutritionMetric;

const grouped = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const count = (value: number) => grouped.format(value);
const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;
const days = (value: number) => plural(value, 'day', 'days');
const entries = (value: number) => plural(value, 'entry', 'entries');
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The range's figures for one nutrition series and the date counts they are read against. */
function nutritionOf(trends: DailyTrends, metric: DailyTrendsNutritionMetric) {
  const { nutrition } = trends.summary;
  return { metric: nutrition[DAILY_TRENDS_NUTRITION_FIELD[metric]], nutrition, wording: nutritionWording[metric] };
}

/** "28 days, Tue, 13 Oct 2026 to Mon, 9 Nov 2026", and why it is shorter when the lower bound cut it. */
export function rangeLabel(range: Pick<DailyTrendsRange, 'days' | 'endDate' | 'shortenedByLowerBound' | 'startDate'> & { requestedDays: number }): string {
  const span = range.days === 1 ? `1 day, ${formatCheckInDate(range.startDate)}` : `${days(range.days)}, ${formatCheckInDate(range.startDate)} to ${formatCheckInDate(range.endDate)}`;
  return range.shortenedByLowerBound ? `${span} (shortened from ${range.requestedDays}: records start on 1 January 2000)` : span;
}

/** How many dates hold a value for the metric, against the range's actual length, and what the others are. */
export function coverageLine(trends: DailyTrends, metric: DailyTrendsMetric): string {
  const total = trends.range.days;
  const { summary } = trends;
  const recorded = isNutritionTrendsMetric(metric)
    ? nutritionOf(trends, metric).metric.recordedDays
    : metric === 'weightKg'
      ? summary.weight.daysRecorded
      : metric === 'sleepMinutes'
        ? summary.sleep.daysRecorded
        : summary.steps.daysRecorded;
  const missing = total - recorded;
  const head = recorded === total ? `Recorded on all ${days(total)}.` : `Recorded on ${recorded} of ${days(total)}.`;
  const tail = missing === 0 ? '' : ` The other ${missing === 1 ? 'day has' : `${missing} days have`} no value: unknown, not zero.`;
  if (!isNutritionTrendsMetric(metric)) return `${head}${tail}`;
  const { metric: figures, nutrition, wording } = nutritionOf(trends, metric);
  const entryPart =
    nutrition.loggedEntries === 0
      ? ' No meal entry was logged in this range.'
      : ` ${capitalized(wording.short)} is recorded on ${count(figures.recordedEntries)} of ${plural(nutrition.loggedEntries, 'logged entry', 'logged entries')}.`;
  return `${head}${entryPart}${tail}`;
}

/** What a missing value means for the metric, said once beside the chart and the table. */
export function missingExplanation(metric: DailyTrendsMetric): string {
  if (isNutritionTrendsMetric(metric)) {
    const { noun } = nutritionWording[metric];
    return `A date without a value has no logged entry with ${noun} recorded. Food you did not log is unknown, so even a date where every entry records ${noun} is not a complete food diary, and a partial date's total covers only the entries that record it. Unknown values add nothing to the total.`;
  }
  return 'A date without a value was not recorded. It is unknown, not zero, and is left out of every total and average. The chart leaves a gap there and never joins values across it.';
}

export interface TrendFigure {
  label: string;
  value: string;
}

/**
 * The compact figures of a nutrition series for the range: the recorded total, the dates with a value against the
 * actual range, the entries with a value against the logged entries, and the dates with any logged entry.
 */
export function nutritionFigures(trends: DailyTrends, metric: DailyTrendsNutritionMetric): TrendFigure[] {
  const { metric: figures, nutrition, wording } = nutritionOf(trends, metric);
  const range = trends.range.days;
  return [
    { label: 'Recorded total', value: figures.total === null ? NOT_RECORDED : `${formatNutritionNumber(figures.total)} ${wording.unit}` },
    { label: 'Days with a value', value: `${count(figures.recordedDays)} of ${days(range)}` },
    { label: 'Entries with a value', value: nutrition.loggedEntries === 0 ? 'No entries logged' : `${count(figures.recordedEntries)} of ${plural(nutrition.loggedEntries, 'logged entry', 'logged entries')}` },
    { label: 'Days with logged entries', value: `${count(nutrition.daysWithEntries)} of ${days(range)}` },
  ];
}

/** The modest, defined statistics of the metric, each naming the dates or entries it covers. */
export function summaryLines(trends: DailyTrends, metric: DailyTrendsMetric): string[] {
  const { sleep, steps, weight } = trends.summary;
  if (isNutritionTrendsMetric(metric)) {
    const { metric: figures, nutrition, wording } = nutritionOf(trends, metric);
    if (nutrition.loggedEntries === 0) return ['No meal entry was logged in this range.'];
    if (figures.total === null) {
      return [`${entries(nutrition.loggedEntries)} logged on ${days(nutrition.daysWithEntries)}, none with ${wording.noun} recorded.`];
    }
    const without = nutrition.daysWithEntries - figures.recordedDays;
    return [
      `${wording.name} recorded: ${formatNutritionNumber(figures.total)} ${wording.unit} from ${count(figures.recordedEntries)} of ${plural(nutrition.loggedEntries, 'logged entry', 'logged entries')}, on ${days(figures.recordedDays)}.`,
      `Meal entries were logged on ${count(nutrition.daysWithEntries)} of ${days(trends.range.days)}${
        without === 0 ? '' : `; ${without === 1 ? '1 of those days has' : `${count(without)} of those days have`} no ${wording.noun} recorded`
      }.`,
      `The total covers only what you logged with ${wording.withValue}; it is not a complete food diary.`,
    ];
  }
  switch (metric) {
    case 'weightKg': {
      if (weight.first === null || weight.last === null || weight.changeKg === null) {
        return weight.daysRecorded === 0
          ? ['No weight was recorded in this range.']
          : ['A change needs a weight on at least two dates; only 1 date in this range has one.'];
      }
      const sign = weight.changeKg > 0 ? '+' : weight.changeKg < 0 ? '−' : '';
      return [
        `First recorded weight ${String(weight.first.kg)} kg on ${formatCheckInDate(weight.first.localDate)}; last recorded ${String(weight.last.kg)} kg on ${formatCheckInDate(weight.last.localDate)}.`,
        `Difference between those two dates: ${sign}${String(Math.abs(weight.changeKg))} kg (${weight.daysRecorded} dates have a weight).`,
      ];
    }
    case 'sleepMinutes':
      return sleep.averageMinutes === null
        ? ['No sleep duration was recorded in this range.']
        : [
            `Average ${formatSleep(sleep.averageMinutes)} over the ${plural(sleep.daysRecorded, 'date', 'dates')} with a recorded duration, rounded to the nearest minute (halves up).`,
          ];
    case 'steps':
      return steps.recordedTotal === null
        ? ['No steps were entered in this range.']
        : [`Recorded total ${formatSteps(steps.recordedTotal)} on ${days(steps.daysRecorded)}; the total covers only those days.`];
  }
}

/** How the entries of one date relate to a nutrition series: none logged, none recording it, some (partial) or all. */
export type TrendNutritionCoverage = 'all' | 'no-entries' | 'none' | 'partial';

export interface TrendTableRow {
  /** Nutrition series only: how the date's logged entries cover the series (null for the other series). */
  coverage: TrendNutritionCoverage | null;
  dateLabel: string;
  /** Nutrition series only: which entries the value covers. */
  detail: string | null;
  localDate: string;
  recorded: boolean;
  value: string;
}

function nutritionCoverageOf(day: DailyTrendDay, metric: DailyTrendsNutritionMetric): { coverage: TrendNutritionCoverage; detail: string } {
  const { loggedEntries } = day.nutrition;
  const { recordedEntries } = day.nutrition[DAILY_TRENDS_NUTRITION_FIELD[metric]];
  const { short } = nutritionWording[metric];
  if (loggedEntries === 0) return { coverage: 'no-entries', detail: 'No entry logged' };
  if (recordedEntries === 0) return { coverage: 'none', detail: `${entries(loggedEntries)} logged, no ${short} recorded` };
  if (recordedEntries === loggedEntries) {
    return { coverage: 'all', detail: `${loggedEntries === 1 ? '1 logged entry' : `All ${count(loggedEntries)} logged entries`} with ${short}` };
  }
  return { coverage: 'partial', detail: `Partial: ${count(recordedEntries)} of ${entries(loggedEntries)} with ${short}` };
}

/** One row per date of the range, newest first, with the metric's value or "Not recorded". */
export function tableRows(trends: DailyTrends, metric: DailyTrendsMetric): TrendTableRow[] {
  const spec = trendMetricSpecs[metric];
  return trends.days
    .map((day) => {
      const value = spec.valueOf(day);
      const nutrition = isNutritionTrendsMetric(metric) ? nutritionCoverageOf(day, metric) : null;
      return {
        coverage: nutrition?.coverage ?? null,
        dateLabel: formatCheckInDate(day.localDate),
        detail: nutrition?.detail ?? null,
        localDate: day.localDate,
        recorded: value !== null,
        value: value === null ? NOT_RECORDED : spec.format(value),
      };
    })
    .toReversed();
}

export interface ChartPoint {
  label: string;
  localDate: string;
  value: number;
  x: number;
  y: number;
}

export interface TrendChartGeometry {
  height: number;
  /** Dates without a value: a small mark under the axis, never a point. */
  missing: Array<{ localDate: string; x: number }>;
  plot: { bottom: number; left: number; right: number; top: number };
  points: ChartPoint[];
  /** Runs of consecutive recorded dates; a line is drawn only within a run, so a gap is never bridged. */
  segments: ChartPoint[][];
  width: number;
  xLabels: Array<{ anchor: 'end' | 'middle' | 'start'; text: string; x: number }>;
  yTicks: Array<{ label: string; y: number }>;
}

export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 220;

const shortDate = (localDate: string) => {
  const [, month, day] = localDate.split('-');
  return `${Number(day)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1] ?? ''}`;
};

/** The vertical extent: from 0 for counts and durations, around the values for weight; never a zero-height scale. */
function extentOf(values: number[], zeroBaseline: boolean): { max: number; min: number } {
  if (values.length === 0) return { max: 1, min: 0 };
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (zeroBaseline) return { max: high === 0 ? 1 : high, min: 0 };
  const pad = high === low ? 1 : (high - low) * 0.15;
  return { max: high + pad, min: Math.max(0, low - pad) };
}

/** Coordinates for a simple line chart of one metric: one x slot per date, points only where a value exists. */
export function chartGeometry(trends: DailyTrends, metric: DailyTrendsMetric): TrendChartGeometry {
  const spec = trendMetricSpecs[metric];
  const count = trends.days.length;
  const values = trends.days.flatMap((day) => {
    const value = spec.valueOf(day);
    return value === null ? [] : [value];
  });
  const { max, min } = extentOf(values, spec.zeroBaseline);
  // The axis shows the scale's bottom and top: the largest value itself for counts, durations and nutrition (exact, in
  // its own precision), and a padded value to one decimal for weight.
  const tickValue = (value: number) =>
    metric === 'sleepMinutes'
      ? formatSleep(Math.round(value))
      : metric === 'weightKg'
        ? `${value.toFixed(1)} kg`
        : isNutritionTrendsMetric(metric)
          ? formatNutritionNumber(value)
          : grouped.format(Math.round(value));
  const tickLabels = values.length === 0 ? [] : [tickValue(min), tickValue(max)];
  // The left margin follows the longest axis label (about 10 units per character at the tick size, generous for wide
  // fonts), so a label is never cut off at the chart's edge.
  const longest = Math.max(1, ...tickLabels.map((label) => label.length));
  const plot = { bottom: CHART_HEIGHT - 30, left: Math.min(160, Math.max(40, 18 + longest * 10)), right: CHART_WIDTH - 16, top: 14 };
  const xOf = (index: number) => (count === 1 ? (plot.left + plot.right) / 2 : plot.left + (index * (plot.right - plot.left)) / (count - 1));
  const yOf = (value: number) => plot.bottom - ((value - min) / (max - min)) * (plot.bottom - plot.top);
  const points: ChartPoint[] = [];
  const missing: TrendChartGeometry['missing'] = [];
  const segments: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  trends.days.forEach((day, index) => {
    const value = spec.valueOf(day);
    if (value === null) {
      missing.push({ localDate: day.localDate, x: xOf(index) });
      if (run.length > 0) segments.push(run);
      run = [];
      return;
    }
    // The dot's title names the series, the date and the value with its unit ("Protein, Mon, 2 Nov 2026: 10.1 g").
    const point = { label: `${spec.label}, ${formatCheckInDate(day.localDate)}: ${spec.format(value)}`, localDate: day.localDate, value, x: xOf(index), y: yOf(value) };
    points.push(point);
    run.push(point);
  });
  if (run.length > 0) segments.push(run);
  const yTicks = tickLabels.length === 0 ? [] : [{ label: tickLabels[0]!, y: plot.bottom }, { label: tickLabels[1]!, y: plot.top }];
  const first = trends.days[0]!.localDate;
  const last = trends.days.at(-1)!.localDate;
  const xLabels: TrendChartGeometry['xLabels'] =
    count === 1
      ? [{ anchor: 'middle', text: shortDate(first), x: xOf(0) }]
      : [
          { anchor: 'start', text: shortDate(first), x: plot.left },
          { anchor: 'end', text: shortDate(last), x: plot.right },
        ];
  return { height: CHART_HEIGHT, missing, plot, points, segments, width: CHART_WIDTH, xLabels, yTicks };
}

/** The chart's accessible description: what it shows and where to read every value. */
export function chartDescription(trends: DailyTrends, metric: DailyTrendsMetric): string {
  const spec = trendMetricSpecs[metric];
  const recorded = trends.days.filter((day) => spec.valueOf(day) !== null).length;
  return `${spec.title}, ${rangeLabel(trends.range)}: ${recorded} of ${days(trends.range.days)} have a value. The table below lists every date.`;
}

/** "Computed on Mon, 9 Nov 2026 at 10:00 from your own records; nothing is stored." */
export function computedLine(trends: DailyTrends, timeZone: string): string {
  const at = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(trends.provenance.computedAt));
  return `Computed ${at} from your own records in one consistent read; nothing is stored.`;
}
