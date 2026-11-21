import {
  DAILY_TRENDS_RANGE_DAYS,
  DAILY_TRENDS_VERSION,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  summarizeDailyTrendDays,
  type DailyTrendDay,
  type DailyTrendNutrition,
  type DailyTrends,
  type DailyTrendsNutritionSummary,
  type DailyTrendsQuery,
  type MealNutritionField,
} from '@running-tracker/contracts';
import type { Pool } from 'pg';

import type { StoredSession } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import { canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError } from '../http/errors.js';
import { mealSummaryRecordOf, type MealSummaryRecord, type MealSummaryRow } from '../meals/meal-nutrition-summary.js';
import { localDateOf } from '../runs/run-search-period.js';

// 28-day trends (ADR-0084, nutrition since ADR-0096): computed on every read, never stored, never queued, no model. It
// writes nothing.
//
// One REPEATABLE READ READ ONLY transaction holds the membership check and three range statements, one per source table
// (check-ins, manual movement, meals), each bounded by the range's first and last calendar date: a fixed number of
// statements whatever the range, never one read per date or per nutrient. The snapshot is taken by the transaction's first
// statement (setting the tenant context), so a write committed after that, also one committed between the statements, is
// not seen; nothing is read after the transaction ends. Every statement names the organization and the owner and runs with
// row-level security in force.
//
// Attribution: every source is a daily record and belongs to its stored `local_date`. The requested zone decides only
// "today" (the latest allowed end date); no statement takes it, so no record moves to another date.

/** Barriers for deterministic snapshot tests. Never set in production. */
export interface DailyTrendsTestHooks {
  /** Inside the read transaction, after the check-ins were read and before movement and meals are read. */
  afterCheckInsRead?: () => Promise<void>;
}

export interface DailyTrendsServiceOptions {
  clock: Clock;
  hooks?: DailyTrendsTestHooks;
  pool: Pick<Pool, 'connect'>;
}

interface CheckInRow {
  local_date: string;
  sleep_minutes: number | null;
  /** numeric(5,2) as text: exact. */
  weight_kg: string | null;
}

interface StepsRow {
  local_date: string;
  steps: number;
}

export interface DailyTrendsSourceRows {
  checkIns: CheckInRow[];
  /** The meal statement's rows, parsed: one per stored date with an entry, and exactly one for the range. */
  meals: MealSummaryRecord[];
  steps: StepsRow[];
}

// $1 organization, $2 owner, $3 first date, $4 last date (both inclusive). Only the two values the trends show; a check-in
// with neither (mood or a note only) has no value for them and is not selected. The note is never selected. The
// owner/date unique key serves the range.
export const dailyTrendsCheckInsSql = `/* daily-trends:check-ins */
SELECT to_char(metric.local_date, 'YYYY-MM-DD') AS local_date,
       metric.weight_kg::text AS weight_kg,
       metric.sleep_minutes
  FROM daily_metrics AS metric
 WHERE metric.org_id = $1
   AND metric.user_id = $2
   AND metric.local_date BETWEEN $3::date AND $4::date
   AND (metric.weight_kg IS NOT NULL OR metric.sleep_minutes IS NOT NULL)
 ORDER BY metric.local_date`;

// $1 organization, $2 owner, $3 first date, $4 last date. The manual row only (a later importer's rows must never be added
// to it), and only dates with a step count (a recorded 0 included). Active energy is not part of the trends.
export const dailyTrendsStepsSql = `/* daily-trends:steps */
SELECT to_char(movement.local_date, 'YYYY-MM-DD') AS local_date,
       movement.steps
  FROM daily_movement AS movement
 WHERE movement.org_id = $1
   AND movement.user_id = $2
   AND movement.source = 'manual'
   AND movement.local_date BETWEEN $3::date AND $4::date
   AND movement.steps IS NOT NULL
 ORDER BY movement.local_date`;

// $1 organization, $2 owner, $3 first date, $4 last date (ADR-0096). Manual entries only (a later importer's rows must not
// be added to them), on their stored local dates, whatever zone each was saved in. GROUPING SETS gives one row per date
// with an entry and always exactly one range row (the empty grouping set, also when there is no entry): at most 29 rows.
// For each nutrient independently, count(col) counts the entries that hold a value (a recorded 0 included), count(DISTINCT
// date) FILTER the dates that do, and sum(col) adds exactly those values in numeric (no floating point, no rounding; NULL
// when none). No title, type, description, zone, identifier or single value is selected. The owner/date index
// (meals_owner_date_created_idx: org_id, user_id, local_date, ...) serves the range.
export const dailyTrendsMealsSql = `/* daily-trends:meals */
SELECT CASE WHEN grouping(meal.local_date) = 0 THEN to_char(meal.local_date, 'YYYY-MM-DD') END AS local_date,
       count(*)::integer AS logged_entries,
       count(DISTINCT meal.local_date)::integer AS days_with_entries,
       count(meal.energy_kcal)::integer AS energy_kcal_entries,
       (count(DISTINCT meal.local_date) FILTER (WHERE meal.energy_kcal IS NOT NULL))::integer AS energy_kcal_days,
       sum(meal.energy_kcal)::text AS energy_kcal_total,
       count(meal.protein_g)::integer AS protein_g_entries,
       (count(DISTINCT meal.local_date) FILTER (WHERE meal.protein_g IS NOT NULL))::integer AS protein_g_days,
       sum(meal.protein_g)::text AS protein_g_total,
       count(meal.carbohydrate_g)::integer AS carbohydrate_g_entries,
       (count(DISTINCT meal.local_date) FILTER (WHERE meal.carbohydrate_g IS NOT NULL))::integer AS carbohydrate_g_days,
       sum(meal.carbohydrate_g)::text AS carbohydrate_g_total,
       count(meal.fat_g)::integer AS fat_g_entries,
       (count(DISTINCT meal.local_date) FILTER (WHERE meal.fat_g IS NOT NULL))::integer AS fat_g_days,
       sum(meal.fat_g)::text AS fat_g_total
  FROM meals AS meal
 WHERE meal.org_id = $1
   AND meal.user_id = $2
   AND meal.source = 'manual'
   AND meal.local_date BETWEEN $3::date AND $4::date
 GROUP BY GROUPING SETS ((meal.local_date), ())
 ORDER BY grouping(meal.local_date), meal.local_date`;

/** A numeric's text as a number. A weight has at most two decimals, so it is exact. */
function exactNumber(text: string, what: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`PostgreSQL returned a ${what} that is not a finite number`);
  return value;
}

function assertEndNotAfterToday(endDate: string, timeZone: string, nowMs: number): string {
  const today = localDateOf(nowMs, timeZone);
  if (endDate > today) {
    throw new ApiError(400, 'INVALID_REQUEST', `The end date cannot be after today (${today} in ${timeZone})`, {
      fields: [{ message: `Must not be after ${today}`, path: ['endDate'] }],
    });
  }
  return today;
}

const fromTenths = (tenths: number | null) => (tenths === null ? null : tenths / 10);

/** A date's nutrition from its summary row, or every metric unknown for a date without entries (no row). */
function dayNutritionOf(record: MealSummaryRecord | undefined): DailyTrendNutrition {
  const metric = (field: MealNutritionField) => ({
    recordedEntries: record?.metrics[field].entries ?? 0,
    total: fromTenths(record?.metrics[field].totalTenths ?? null),
  });
  return {
    carbohydrateG: metric('carbohydrateG'),
    energyKcal: metric('energyKcal'),
    fatG: metric('fatG'),
    loggedEntries: record?.loggedEntries ?? 0,
    proteinG: metric('proteinG'),
  };
}

/**
 * Splits the meal statement's rows into the dates and the single range row. Throws on rows the statement cannot produce
 * (no or several range rows, a date outside the range or twice), so a defect is never shown as a number.
 */
export function mealRowsOf(dates: readonly string[], records: readonly MealSummaryRecord[]): { byDate: Map<string, MealSummaryRecord>; range: MealSummaryRecord } {
  const ranges = records.filter((record) => record.localDate === null);
  if (ranges.length !== 1) throw new Error(`The trends meal statement returned ${ranges.length} range rows instead of one`);
  const known = new Set(dates);
  const byDate = new Map<string, MealSummaryRecord>();
  for (const record of records) {
    if (record.localDate === null) continue;
    if (!known.has(record.localDate) || byDate.has(record.localDate)) throw new Error(`The trends meal statement returned an unexpected date: ${record.localDate}`);
    byDate.set(record.localDate, record);
  }
  return { byDate, range: ranges[0]! };
}

/** The range's nutrition exactly as PostgreSQL aggregated it; the contract checks it against the sum of the dates. */
export function rangeNutritionOf(range: MealSummaryRecord, daysInRange: number): DailyTrendsNutritionSummary {
  const metric = (field: MealNutritionField) => ({
    recordedDays: range.metrics[field].days,
    recordedEntries: range.metrics[field].entries,
    total: fromTenths(range.metrics[field].totalTenths),
  });
  return {
    carbohydrateG: metric('carbohydrateG'),
    daysInRange,
    daysWithEntries: range.daysWithEntries,
    energyKcal: metric('energyKcal'),
    fatG: metric('fatG'),
    loggedEntries: range.loggedEntries,
    proteinG: metric('proteinG'),
    source: 'manual',
  };
}

/** Every date of the range with the values its records hold; a date without a value is null, never zero. */
export function trendDaysOf(dates: readonly string[], rows: DailyTrendsSourceRows): DailyTrendDay[] {
  const checkIns = new Map(rows.checkIns.map((row) => [row.local_date, row]));
  const steps = new Map(rows.steps.map((row) => [row.local_date, row.steps]));
  const { byDate: meals } = mealRowsOf(dates, rows.meals);
  const known = new Set(dates);
  for (const row of [...rows.checkIns, ...rows.steps]) {
    if (!known.has(row.local_date)) throw new Error(`A trends statement returned a date outside the range: ${row.local_date}`);
  }
  return dates.map((localDate) => {
    const checkIn = checkIns.get(localDate);
    return {
      localDate,
      nutrition: dayNutritionOf(meals.get(localDate)),
      sleepMinutes: checkIn?.sleep_minutes ?? null,
      steps: steps.get(localDate) ?? null,
      weightKg: checkIn?.weight_kg === null || checkIn?.weight_kg === undefined ? null : exactNumber(checkIn.weight_kg, 'weight'),
    };
  });
}

export function buildDailyTrends(input: {
  computedAt: string;
  endDate: string;
  rows: DailyTrendsSourceRows;
  timeZone: string;
  today: string;
}): DailyTrends {
  const range = dailyTrendsRangeOf(input.endDate);
  const dates = dailyTrendsDatesOf(range);
  const days = trendDaysOf(dates, input.rows);
  const { range: mealRange } = mealRowsOf(dates, input.rows.meals);
  // Weight, sleep and steps are summarized from the dates; nutrition is PostgreSQL's range row, which the strict schema
  // refuses unless it equals the sum of the dates (summarizeDailyTrendDays).
  const summary = { ...summarizeDailyTrendDays(days), nutrition: rangeNutritionOf(mealRange, range.days) };
  return dailyTrendsSchema.parse({
    days,
    provenance: {
      computedAt: input.computedAt,
      persisted: false,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
      trendsVersion: DAILY_TRENDS_VERSION,
    },
    range: {
      days: range.days,
      endDate: range.endDate,
      includesToday: range.endDate === input.today,
      requestedDays: DAILY_TRENDS_RANGE_DAYS,
      shortenedByLowerBound: range.shortenedByLowerBound,
      startDate: range.startDate,
      timeZone: input.timeZone,
      today: input.today,
    },
    summary,
  });
}

export class DailyTrendsService {
  readonly #clock: Clock;
  readonly #hooks: DailyTrendsTestHooks | undefined;
  readonly #pool: Pick<Pool, 'connect'>;

  public constructor(options: DailyTrendsServiceOptions) {
    this.#clock = options.clock;
    this.#hooks = options.hooks;
    this.#pool = options.pool;
  }

  public async read(session: Pick<StoredSession, 'userId'>, orgId: string, query: DailyTrendsQuery): Promise<DailyTrends> {
    const timeZone = canonicalTimeZone(query.timeZone);
    const now = this.#clock.utcNow();
    const today = assertEndNotAfterToday(query.endDate, timeZone, now.getTime());
    const range = dailyTrendsRangeOf(query.endDate);
    const parameters = [orgId, session.userId, range.startDate, range.endDate];
    const rows = await withAuthenticatedTenantTransaction(
      this.#pool,
      session,
      orgId,
      async (client) => {
        const checkIns = (await client.query<CheckInRow>(dailyTrendsCheckInsSql, parameters)).rows;
        await this.#hooks?.afterCheckInsRead?.();
        const steps = (await client.query<StepsRow>(dailyTrendsStepsSql, parameters)).rows;
        const meals = (await client.query<MealSummaryRow>(dailyTrendsMealsSql, parameters)).rows.map(mealSummaryRecordOf);
        return { checkIns, meals, steps };
      },
      { snapshot: 'read-only snapshot' },
    );
    return buildDailyTrends({ computedAt: now.toISOString(), endDate: query.endDate, rows, timeZone, today });
  }
}
