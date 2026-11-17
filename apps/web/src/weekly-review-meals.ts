import {
  MEAL_NUTRITION_FIELDS,
  type MealNutritionField,
  type WeeklyReviewMealDay,
  type WeeklyReviewMeals,
} from '@running-tracker/contracts';

import { formatNutritionValue } from './meal-log.js';

// Recorded nutrition in the Weekly review (ADR-0093). Pure functions: every label and value the "Recorded nutrition"
// block shows comes from here, so each state can be tested without a DOM. The numbers are the server's (computed by
// PostgreSQL); nothing here adds, averages, estimates or compares. A value nobody recorded is "Not recorded", never 0, and
// food energy is always labelled as food energy, apart from movement's active energy.

const metricNames: Readonly<Record<MealNutritionField, string>> = {
  carbohydrateG: 'Carbohydrate',
  energyKcal: 'Food energy',
  fatG: 'Fat',
  proteinG: 'Protein',
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "on 3 of 7 days", "on all 7 days". */
const onWeekDays = (days: number, daysInWeek: number) => (days === daysInWeek ? `on all ${daysInWeek} days` : `on ${days} of ${daysInWeek} days`);

export interface MealReviewRow {
  label: string;
  value: string;
}

/**
 * The week's rows: the logged entries with the days they fall on, then each metric's recorded total with both of its
 * coverages (entries and days), or that no logged entry records it. Empty when nothing was logged.
 */
export function mealWeekRows(meals: WeeklyReviewMeals): MealReviewRow[] {
  if (meals.loggedEntries === 0) return [];
  const logged = meals.loggedEntries;
  const rows: MealReviewRow[] = [
    { label: 'Logged entries', value: `${plural(logged, 'entry', 'entries')} ${onWeekDays(meals.daysWithEntries, meals.daysInWeek)}` },
  ];
  const entries = (recorded: number) =>
    recorded === logged ? (logged === 1 ? 'the only entry' : `all ${logged} entries`) : `${recorded} of ${plural(logged, 'entry', 'entries')}`;
  for (const field of MEAL_NUTRITION_FIELDS) {
    const metric = meals[field];
    const label = `${metricNames[field]}, recorded total`;
    rows.push(
      metric.total === null
        ? { label, value: logged === 1 ? 'Not recorded for the only entry' : `Not recorded for any of the ${logged} entries` }
        : {
            label,
            value: `${formatNutritionValue(field, metric.total)} for ${entries(metric.recordedEntries)}, ${onWeekDays(metric.recordedDays, meals.daysInWeek)}`,
          },
    );
  }
  return rows;
}

/** One date's rows: its entries, then each metric as recorded with the entries it covers, or "Not recorded". */
export function mealDayRows(day: WeeklyReviewMealDay): MealReviewRow[] {
  return [
    { label: 'Entries', value: String(day.loggedEntries) },
    ...MEAL_NUTRITION_FIELDS.map((field) => {
      const metric = day[field];
      return {
        label: metricNames[field],
        value:
          metric.total === null
            ? 'Not recorded'
            : `${formatNutritionValue(field, metric.total)} (${metric.recordedEntries} of ${plural(day.loggedEntries, 'entry', 'entries')})`,
      };
    }),
  ];
}

/** The incomplete-logging explanation shown with every non-empty week. */
export const MEAL_COVERAGE_EXPLANATION =
  'Totals add up only the values you recorded. Coverage counts the logged entries and days that hold a value; it does not mean every meal or snack was logged, and a day without entries is unknown.';
