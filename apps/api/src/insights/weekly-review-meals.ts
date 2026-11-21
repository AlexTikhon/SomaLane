import {
  addLocalDays,
  MEAL_NUTRITION_FIELDS,
  type MealNutritionField,
  type WeeklyReviewMealDay,
  type WeeklyReviewMeals,
  type WeeklyReviewStatement,
  type WeeklyReviewStatementCode,
} from '@running-tracker/contracts';
import type { PoolClient } from 'pg';

import { mealSummaryRecordOf, type MealSummaryRecord, type MealSummaryRow } from '../meals/meal-nutrition-summary.js';

// The row parser lives in meals/meal-nutrition-summary.ts since ADR-0096 (shared with Trends); re-exported unchanged.
export { nutritionTenthsOf, type MealMetricRecord, type MealSummaryRecord } from '../meals/meal-nutrition-summary.js';

// Recorded nutrition of the week's manual meal entries in the deterministic weekly review (ADR-0093).
//
// Review-only, like movement and imports: meals are not part of the aggregate, the facts, the coverage or the data gaps
// that AI insights share, so they cannot change an insight's input hash, prompt or freshness. One statement, run in the
// review's REPEATABLE READ READ ONLY transaction, returns at most eight rows (one per stored date with an entry and one
// for the week) with every count and total computed by PostgreSQL in exact numeric arithmetic. No meal is loaded and no
// title, type, description, zone or identifier is selected. The code below only parses and checks what the database
// computed; the contract then checks that the days and the week agree.

// $1 organization, $2 owner, $3 Monday. The stored local dates Monday to Sunday inclusive: an entry belongs to the calendar
// date it was logged for, whatever zone it was saved in and whatever zone the week's activities are read in. Manual
// entries only (a later importer's rows must not be added to them). GROUPING SETS gives one row per date with an entry and
// always exactly one week row (the empty grouping set, also when there is no entry). count(col) counts the entries that
// hold a value (a recorded 0 included), count(DISTINCT date) FILTER the dates that do, and sum(col) adds exactly those
// values in numeric (no floating point, no rounding; NULL when none). The owner/date index
// (meals_owner_date_created_idx: org_id, user_id, local_date, ...) serves the range.
export const weekMealsSql = `/* weekly-review:meals */
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
   AND meal.local_date BETWEEN $3::date AND $3::date + 6
 GROUP BY GROUPING SETS ((meal.local_date), ())
 ORDER BY grouping(meal.local_date), meal.local_date`;

/** Runs the summary statement on the review's transaction client (its snapshot, its tenant context). */
export async function readWeekMeals(client: PoolClient, owner: { orgId: string; userId: string }, weekStart: string): Promise<MealSummaryRecord[]> {
  const result = await client.query<MealSummaryRow>(weekMealsSql, [owner.orgId, owner.userId, weekStart]);
  return result.rows.map(mealSummaryRecordOf);
}

const fromTenths = (tenths: number | null) => (tenths === null ? null : tenths / 10);

/**
 * The week's meal payload from the summary rows: the week as PostgreSQL computed it, and the seven stored dates from
 * Monday, a date without a row being one without entries (every metric unknown). Throws on rows that cannot come from the
 * statement (no or several week rows, a date outside the week or twice); the contract checks that days and week agree.
 */
export function mealsOf(records: readonly MealSummaryRecord[], weekStart: string): WeeklyReviewMeals {
  const weekEnd = addLocalDays(weekStart, 6);
  const weekRows = records.filter((record) => record.localDate === null);
  if (weekRows.length !== 1) throw new Error(`The weekly meal statement returned ${weekRows.length} week rows instead of one`);
  const byDate = new Map<string, MealSummaryRecord>();
  for (const record of records) {
    if (record.localDate === null) continue;
    if (record.localDate < weekStart || record.localDate > weekEnd || byDate.has(record.localDate)) {
      throw new Error(`The weekly meal statement returned an unexpected date: ${record.localDate}`);
    }
    byDate.set(record.localDate, record);
  }
  const week = weekRows[0]!;
  const days: WeeklyReviewMealDay[] = Array.from({ length: 7 }, (_, offset) => {
    const localDate = addLocalDays(weekStart, offset);
    const record = byDate.get(localDate);
    const metric = (field: MealNutritionField) => {
      const value = record?.metrics[field];
      return { recordedEntries: value?.entries ?? 0, total: fromTenths(value?.totalTenths ?? null) };
    };
    return {
      carbohydrateG: metric('carbohydrateG'),
      energyKcal: metric('energyKcal'),
      fatG: metric('fatG'),
      localDate,
      loggedEntries: record?.loggedEntries ?? 0,
      proteinG: metric('proteinG'),
    };
  });
  const weekMetric = (field: MealNutritionField) => ({
    recordedDays: week.metrics[field].days,
    recordedEntries: week.metrics[field].entries,
    total: fromTenths(week.metrics[field].totalTenths),
  });
  return {
    carbohydrateG: weekMetric('carbohydrateG'),
    days,
    daysInWeek: 7,
    daysWithEntries: week.daysWithEntries,
    energyKcal: weekMetric('energyKcal'),
    fatG: weekMetric('fatG'),
    loggedEntries: week.loggedEntries,
    proteinG: weekMetric('proteinG'),
    source: 'manual',
  };
}

/** "8,042": digit groups without a locale, as the other review statements write them. */
function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/** "1,061.1", "250", "0": the shortest exact spelling of integer tenths, written from integers. */
export function formatTenths(tenths: number): string {
  const whole = Math.trunc(tenths / 10);
  const tenth = tenths % 10;
  return `${groupThousands(whole)}${tenth === 0 ? '' : `.${tenth}`}`;
}

const metricWording: Readonly<
  Record<MealNutritionField, { name: string; notRecorded: WeeklyReviewStatementCode; recorded: WeeklyReviewStatementCode; unit: 'g' | 'kcal' }>
> = {
  carbohydrateG: { name: 'Carbohydrate', notRecorded: 'meals.carbohydrate_not_recorded', recorded: 'meals.carbohydrate_recorded', unit: 'g' },
  energyKcal: { name: 'Food energy', notRecorded: 'meals.energy_not_recorded', recorded: 'meals.energy_recorded', unit: 'kcal' },
  fatG: { name: 'Fat', notRecorded: 'meals.fat_not_recorded', recorded: 'meals.fat_recorded', unit: 'g' },
  proteinG: { name: 'Protein', notRecorded: 'meals.protein_not_recorded', recorded: 'meals.protein_recorded', unit: 'g' },
};

const plural = (value: number, singular: string, many: string) => `${groupThousands(value)} ${value === 1 ? singular : many}`;

/** "on 4 of 7 days", "on all 7 days". */
const onDays = (days: number) => (days === 7 ? 'on all 7 days' : `on ${days} of 7 days`);

/**
 * The meal statements, in a stable order: none; or the logged entries, one statement per metric (recorded with its total
 * and both coverages, or not recorded), and the limits of logging. Every total is called recorded and names the entries
 * it covers; entries without a value are unknown. No target, balance, average, estimate, comparison or advice.
 */
export function describeMeals(meals: WeeklyReviewMeals): WeeklyReviewStatement[] {
  if (meals.loggedEntries === 0) return [{ code: 'meals.none', text: 'No meals or snacks were logged this week.' }];
  const logged = meals.loggedEntries;
  const statements: WeeklyReviewStatement[] = [
    {
      code: 'meals.logged',
      text: `${plural(logged, 'meal entry was', 'meal entries were')} logged ${onDays(meals.daysWithEntries)}; each counts on the date it was logged for.`,
    },
  ];
  for (const field of MEAL_NUTRITION_FIELDS) {
    const metric = meals[field];
    const wording = metricWording[field];
    if (metric.total === null) {
      statements.push({
        code: wording.notRecorded,
        text: `${wording.name} was not recorded for ${logged === 1 ? 'the only logged entry' : `any of the ${groupThousands(logged)} logged entries`}.`,
      });
      continue;
    }
    const total = `${formatTenths(Math.round(metric.total * 10))} ${wording.unit}`;
    const unknown = logged - metric.recordedEntries;
    const entries =
      unknown === 0
        ? logged === 1
          ? 'the only logged entry'
          : `all ${groupThousands(logged)} logged entries`
        : `${groupThousands(metric.recordedEntries)} of ${groupThousands(logged)} logged entries`;
    const rest = unknown === 0 ? '' : `; ${plural(unknown, 'other entry is', 'other entries are')} unknown`;
    statements.push({
      code: wording.recorded,
      text: `${wording.name} was recorded for ${entries}, ${onDays(metric.recordedDays)}: ${total} in total${unknown === 0 ? '' : ' for those entries'}${rest}.`,
    });
  }
  statements.push({
    code: 'meals.logging_limits',
    text: 'Meals were entered manually. The totals add up only the values recorded on logged entries; they do not show everything eaten this week, and food energy is not combined with active energy.',
  });
  return statements;
}
