import { z } from 'zod';

import { activityTypeSchema, ACTIVITY_TYPES } from './activities.js';
import { activityHistorySourceSchema } from './activity-history.js';
import { ACTIVITY_TRENDS_VERSION, activityTrendsSchema } from './activity-trends.js';
import { addLocalDays } from './daily-metrics.js';
import { DAILY_OVERVIEW_VERSION, dailyOverviewSchema } from './daily-overview.js';
import { DAILY_TRENDS_METRICS, DAILY_TRENDS_VERSION, dailyTrendsDatesOf, dailyTrendsRangeOf, dailyTrendsSchema } from './daily-trends.js';
import { mealListResponseSchema } from './meals.js';
import { ianaTimeZoneSchema, localDateSchema, timestampSchema } from './primitives.js';
import { WEEKLY_REVIEW_VERSION, weeklyReviewSchema } from './weekly-review.js';

// The public read-only showcase's snapshot (portfolio v1 release step 5, ADR-0099). One static JSON document, exported
// from the isolated synthetic dataset by `npm run portfolio:showcase:export` and served as a file next to the showcase
// page: no API, no sign-in. Every response in it is a real response of the application's own read service, validated
// here by that response's existing contract schema; this module adds only the envelope (versioned provenance, the
// bounded catalog of selections) and the cross-checks that tie each response to its catalog entry.
//
// Imported through the separate subpath `@running-tracker/contracts/showcase`, never from the package index, so the
// authenticated application's bundle never contains it.

export const SHOWCASE_SNAPSHOT_FORMAT = 'somalane-showcase-snapshot';
export const SHOWCASE_SNAPSHOT_VERSION = 1;
/**
 * How volatile values are made deterministic (docs/runbooks/showcase.md): every read runs with one injected clock, so
 * each `provenance.computedAt` is `snapshot.readAt`; a meal entry's database-generated `mealId` is replaced by a UUID
 * derived from its date and position, and its wall-clock `createdAt`/`updatedAt` by `snapshot.readAt`; a meal page's
 * opaque `nextCursor` must be null (every date fits one page). Nothing else is changed.
 */
export const SHOWCASE_NORMALIZATION_VERSION = 'showcase-snapshot-normalization-v1';

/** The application's default Trends series (App.tsx), which the showcase opens with too. */
export const SHOWCASE_DEFAULT_METRIC = 'weightKg';

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const dateKey = z.string().regex(datePattern);
const rangeSchema = z.strictObject({ endDate: localDateSchema, startDate: localDateSchema });

export const showcaseActivitySelectionSchema = z
  .strictObject({ source: activityHistorySourceSchema, type: activityTypeSchema })
  .refine((selection) => selection.source !== 'recorded_run' || selection.type === 'run', {
    message: 'A recorded run is a run',
    path: ['type'],
  });

export type ShowcaseActivitySelection = z.infer<typeof showcaseActivitySelectionSchema>;

/** The key of one activity-trends response: `<endDate>|<source>|<type>`. */
export function showcaseActivityKey(endDate: string, selection: ShowcaseActivitySelection): string {
  return `${endDate}|${selection.source}|${selection.type}`;
}

const sourceOrder = ['manual', 'gpx', 'tcx', 'recorded_run'] as const;
/** Catalog order: by source as Trends lists them, then by type as the contracts list them. */
export function compareActivitySelections(left: ShowcaseActivitySelection, right: ShowcaseActivitySelection): number {
  return sourceOrder.indexOf(left.source) - sourceOrder.indexOf(right.source) || ACTIVITY_TYPES.indexOf(left.type) - ACTIVITY_TYPES.indexOf(right.type);
}

export const showcaseSnapshotSchema = z.strictObject({
  format: z.literal(SHOWCASE_SNAPSHOT_FORMAT),
  version: z.literal(SHOWCASE_SNAPSHOT_VERSION),
  normalization: z.literal(SHOWCASE_NORMALIZATION_VERSION),
  /** SHA-256 over the normalisation version and the canonical JSON of the document without this field. */
  contentDigest: sha256Schema,
  /** Which dataset the responses were read from: the manifest's identity, checked against the stored data. */
  dataset: z.strictObject({
    anchorDate: localDateSchema,
    datasetVersion: z.string().min(1).max(64),
    digest: sha256Schema,
    digestNormalization: z.string().min(1).max(64),
    ranges: z.strictObject({ current: rangeSchema, previous: rangeSchema }),
    seed: z.string().min(1).max(64),
    synthetic: z.literal(true),
    timeZone: ianaTimeZoneSchema,
  }),
  /** The one instant every read service was given as "now", and the last date of the dataset the snapshot shows. */
  snapshot: z.strictObject({ asOfDate: localDateSchema, readAt: timestampSchema }),
  /** The response contract versions the snapshot was read with; a snapshot of another version is refused. */
  contracts: z.strictObject({
    activityTrends: z.literal(ACTIVITY_TRENDS_VERSION),
    dailyOverview: z.literal(DAILY_OVERVIEW_VERSION),
    dailyTrends: z.literal(DAILY_TRENDS_VERSION),
    weeklyReview: z.literal(WEEKLY_REVIEW_VERSION),
  }),
  /** The bounded catalog: the showcase offers exactly these selections and nothing else. */
  selections: z.strictObject({
    activity: z.array(showcaseActivitySelectionSchema).min(1).max(32),
    days: z.array(localDateSchema).min(1).max(120),
    defaultActivity: showcaseActivitySelectionSchema,
    defaultMetric: z.enum(DAILY_TRENDS_METRICS),
    defaultTrendsEndDate: localDateSchema,
    defaultWeekStart: localDateSchema,
    sampleDate: localDateSchema,
    trendsEndDates: z.array(localDateSchema).min(1).max(8),
    weeks: z.array(localDateSchema).min(1).max(20),
  }),
  responses: z.strictObject({
    activityTrends: z.record(z.string().min(1).max(64), activityTrendsSchema),
    dailyOverview: z.record(dateKey, dailyOverviewSchema),
    dailyTrends: z.record(dateKey, dailyTrendsSchema),
    meals: z.record(dateKey, mealListResponseSchema),
    weeklyReview: z.record(dateKey, weeklyReviewSchema),
  }),
});

export type ShowcaseSnapshot = z.infer<typeof showcaseSnapshotSchema>;

const sortedUnique = (values: readonly string[]) => values.every((value, index) => index === 0 || values[index - 1]! < value);
const sameKeys = (record: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(record).toSorted();
  const wanted = [...expected].toSorted();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
};
const mondayOf = (localDate: string) => {
  const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  return addLocalDays(localDate, -((weekday + 6) % 7));
};

/**
 * Everything the schemas cannot say on their own: each response belongs to its catalog entry (same date, week, range,
 * filters and zone), the catalog is closed (every date a Trends row opens is in it, every response is offered and
 * nothing else is present), and the volatile values follow the normalisation. Empty when the snapshot is consistent.
 */
export function showcaseSnapshotProblems(snapshot: ShowcaseSnapshot): string[] {
  const problems: string[] = [];
  const { dataset, responses, selections } = snapshot;
  const { readAt, asOfDate } = snapshot.snapshot;
  const zone = dataset.timeZone;
  const problem = (message: string) => problems.push(message);

  if (asOfDate !== dataset.anchorDate) problem('snapshot.asOfDate must be the dataset anchor');
  for (const [name, list] of [['days', selections.days], ['weeks', selections.weeks], ['trendsEndDates', selections.trendsEndDates]] as const) {
    if (!sortedUnique(list)) problem(`selections.${name} must be sorted and unique`);
    if (list.some((date) => date > asOfDate)) problem(`selections.${name} must not go past ${asOfDate}`);
  }
  if (selections.weeks.some((week) => mondayOf(week) !== week)) problem('every week must start on a Monday');
  const activityKeys = selections.activity.map((selection) => `${selection.source}|${selection.type}`);
  if (new Set(activityKeys).size !== activityKeys.length) problem('selections.activity must be unique');
  if (selections.activity.some((selection, index) => index > 0 && compareActivitySelections(selections.activity[index - 1]!, selection) >= 0)) {
    problem('selections.activity must be in catalog order');
  }
  if (!selections.days.includes(selections.sampleDate)) problem('the sample date must be an offered day');
  if (selections.sampleDate !== asOfDate) problem('the sample date must be the snapshot date');
  if (!selections.weeks.includes(selections.defaultWeekStart) || mondayOf(selections.sampleDate) !== selections.defaultWeekStart) {
    problem('the default week must be the offered week of the sample date');
  }
  if (!selections.trendsEndDates.includes(selections.defaultTrendsEndDate)) problem('the default Trends end date must be offered');
  if (!activityKeys.includes(`${selections.defaultActivity.source}|${selections.defaultActivity.type}`)) problem('the default activity selection must be offered');
  for (const endDate of selections.trendsEndDates) {
    const missing = dailyTrendsDatesOf(dailyTrendsRangeOf(endDate)).filter((date) => !selections.days.includes(date));
    if (missing.length > 0) problem(`the Trends range ending ${endDate} opens dates that are not offered: ${missing.join(', ')}`);
  }
  for (const day of selections.days) {
    if (!selections.weeks.includes(mondayOf(day))) problem(`the week of ${day} is not offered`);
  }

  if (!sameKeys(responses.dailyOverview, selections.days)) problem('dailyOverview responses must be exactly the offered days');
  if (!sameKeys(responses.meals, selections.days)) problem('meal responses must be exactly the offered days');
  if (!sameKeys(responses.weeklyReview, selections.weeks)) problem('weeklyReview responses must be exactly the offered weeks');
  if (!sameKeys(responses.dailyTrends, selections.trendsEndDates)) problem('dailyTrends responses must be exactly the offered end dates');
  const expectedActivity = selections.trendsEndDates.flatMap((endDate) => selections.activity.map((selection) => showcaseActivityKey(endDate, selection)));
  if (!sameKeys(responses.activityTrends, expectedActivity)) problem('activityTrends responses must be exactly the offered end dates × selections');

  for (const [date, overview] of Object.entries(responses.dailyOverview)) {
    if (overview.day.localDate !== date || overview.day.timeZone !== zone) problem(`the overview under ${date} is for another date or zone`);
    if (overview.provenance.computedAt !== readAt) problem(`the overview of ${date} was not computed at snapshot.readAt`);
  }
  for (const [date, page] of Object.entries(responses.meals)) {
    if (page.nextCursor !== null) problem(`the meals of ${date} do not fit one page`);
    for (const item of page.items) {
      if (item.localDate !== date) problem(`a meal under ${date} belongs to ${item.localDate}`);
      if (item.createdAt !== readAt || item.updatedAt !== readAt) problem(`a meal of ${date} keeps a wall-clock timestamp`);
    }
  }
  for (const [week, review] of Object.entries(responses.weeklyReview)) {
    if (review.week.start !== week) problem(`the review under ${week} is for week ${review.week.start}`);
    if (review.provenance.computedAt !== readAt) problem(`the review of ${week} was not computed at snapshot.readAt`);
  }
  for (const [endDate, trends] of Object.entries(responses.dailyTrends)) {
    if (trends.range.endDate !== endDate || trends.range.includesToday) problem(`the trends under ${endDate} are for another or an unfinished range`);
    if (trends.provenance.computedAt !== readAt) problem(`the trends ending ${endDate} were not computed at snapshot.readAt`);
  }
  for (const [key, trends] of Object.entries(responses.activityTrends)) {
    const { applied } = trends;
    if (key !== `${applied.endDate}|${applied.source}|${applied.type}` || applied.timeZone !== zone || applied.compare !== 'previous_period' || trends.comparison === undefined) {
      problem(`the activity trends under ${key} answer other filters or have no comparison`);
    }
    if (trends.provenance.computedAt !== readAt) problem(`the activity trends ${key} were not computed at snapshot.readAt`);
  }
  return problems;
}

export class ShowcaseSnapshotError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ShowcaseSnapshotError';
  }
}

/** Parses and cross-checks a snapshot; throws a ShowcaseSnapshotError that says what is wrong. */
export function parseShowcaseSnapshot(input: unknown): ShowcaseSnapshot {
  const parsed = showcaseSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? 'the document' : first.path.join('.');
    throw new ShowcaseSnapshotError(`${where}: ${first?.message ?? 'invalid'}`);
  }
  const problems = showcaseSnapshotProblems(parsed.data);
  if (problems.length > 0) throw new ShowcaseSnapshotError(problems[0]!);
  return parsed.data;
}
