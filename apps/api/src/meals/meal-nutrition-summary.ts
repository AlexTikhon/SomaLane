import type { MealNutritionField } from '@running-tracker/contracts';

// The parsing boundary of the meal nutrition aggregates that PostgreSQL computes (ADR-0093 weekly review, ADR-0096
// Trends). Both statements select the same columns per nutrient — the entries that hold a value, the dates that do, and
// the exact numeric sum as text — for one row per stored date and one row for the whole period (GROUPING SETS). This
// module turns such a row into integer counts and integer tenths and adds no arithmetic of its own. Moved unchanged out
// of `insights/weekly-review-meals.ts` (which re-exports it) so the Trends read does not depend on the insights folder.

/** One metric of one summary row: entries and dates that hold a value, and the exact sum in integer tenths. */
export interface MealMetricRecord {
  days: number;
  entries: number;
  /** Integer tenths (1061.1 kcal is 10611), or null when no entry holds a value. */
  totalTenths: number | null;
}

/** One row of a summary statement: a stored date (`localDate`) or the whole period (`localDate` null). */
export interface MealSummaryRecord {
  daysWithEntries: number;
  localDate: string | null;
  loggedEntries: number;
  metrics: Readonly<Record<MealNutritionField, MealMetricRecord>>;
}

/** The columns every meal summary statement selects (no title, type, description, zone or identifier). */
export interface MealSummaryRow {
  carbohydrate_g_days: number;
  carbohydrate_g_entries: number;
  carbohydrate_g_total: string | null;
  days_with_entries: number;
  energy_kcal_days: number;
  energy_kcal_entries: number;
  energy_kcal_total: string | null;
  fat_g_days: number;
  fat_g_entries: number;
  fat_g_total: string | null;
  local_date: string | null;
  logged_entries: number;
  protein_g_days: number;
  protein_g_entries: number;
  protein_g_total: string | null;
}

/**
 * Exact integer tenths from PostgreSQL's text form of a non-negative numeric sum ("1061.1", "0.0", "250", "250.30").
 * Every stored value has at most one meaningful decimal (CHECK constraints of migration 0039), so a sum has too; anything
 * else is a defect and throws rather than being rounded. Ten integer digits hold the largest total either read can
 * produce (a week: 1.4e9 kcal; a 28-date range: 5.6e9 kcal).
 */
export function nutritionTenthsOf(text: string): number {
  const matched = /^(\d{1,10})(?:\.(\d)0*)?$/u.exec(text);
  if (!matched) throw new Error('PostgreSQL returned a nutrition total that is not a non-negative number with at most one meaningful decimal');
  return Number(matched[1]) * 10 + Number(matched[2] ?? '0');
}

const columns: Readonly<Record<MealNutritionField, 'carbohydrate_g' | 'energy_kcal' | 'fat_g' | 'protein_g'>> = {
  carbohydrateG: 'carbohydrate_g',
  energyKcal: 'energy_kcal',
  fatG: 'fat_g',
  proteinG: 'protein_g',
};

/** One summary row as counts and integer tenths. */
export function mealSummaryRecordOf(row: MealSummaryRow): MealSummaryRecord {
  const metric = (field: MealNutritionField): MealMetricRecord => {
    const column = columns[field];
    const total = row[`${column}_total`];
    return { days: row[`${column}_days`], entries: row[`${column}_entries`], totalTenths: total === null ? null : nutritionTenthsOf(total) };
  };
  return {
    daysWithEntries: row.days_with_entries,
    localDate: row.local_date,
    loggedEntries: row.logged_entries,
    metrics: { carbohydrateG: metric('carbohydrateG'), energyKcal: metric('energyKcal'), fatG: metric('fatG'), proteinG: metric('proteinG') },
  };
}
