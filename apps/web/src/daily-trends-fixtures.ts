import {
  DAILY_TRENDS_RANGE_DAYS,
  DAILY_TRENDS_VERSION,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  summarizeDailyTrendDays,
  type DailyTrendDay,
  type DailyTrends,
  type MealNutritionField,
} from '@running-tracker/contracts';

/** A date's recorded nutrition: logged entries and, per field, [recorded entries, total]; the other fields unknown. */
export function nutritionOf(loggedEntries: number, values: Partial<Record<MealNutritionField, [number, number]>> = {}): DailyTrendDay['nutrition'] {
  const metric = (field: MealNutritionField) => ({ recordedEntries: values[field]?.[0] ?? 0, total: values[field]?.[1] ?? null });
  return { carbohydrateG: metric('carbohydrateG'), energyKcal: metric('energyKcal'), fatG: metric('fatG'), loggedEntries, proteinG: metric('proteinG') };
}

/** A valid trends answer for the range ending on `endDate`, every date empty except `values` (by date). */
export function trendsFixture(endDate: string = '2026-11-09', values: Record<string, Partial<DailyTrendDay>> = {}, today: string = endDate): DailyTrends {
  const range = dailyTrendsRangeOf(endDate);
  const days: DailyTrendDay[] = dailyTrendsDatesOf(range).map((localDate) => ({
    localDate,
    nutrition: nutritionOf(0),
    sleepMinutes: null,
    steps: null,
    weightKg: null,
    ...values[localDate],
  }));
  return dailyTrendsSchema.parse({
    days,
    provenance: {
      computedAt: '2026-11-09T09:00:00.000Z',
      persisted: false,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
      trendsVersion: DAILY_TRENDS_VERSION,
    },
    range: {
      days: range.days,
      endDate,
      includesToday: endDate === today,
      requestedDays: DAILY_TRENDS_RANGE_DAYS,
      shortenedByLowerBound: range.shortenedByLowerBound,
      startDate: range.startDate,
      timeZone: 'Europe/Warsaw',
      today,
    },
    summary: summarizeDailyTrendDays(days),
  });
}

/** A sparse range: a recorded zero, gaps between values, a title-only meal day and partial energy coverage. */
export const sparseTrends = () =>
  trendsFixture('2026-11-09', {
    '2026-10-13': { sleepMinutes: 420, steps: 8042, weightKg: 72.35 },
    '2026-10-14': { sleepMinutes: 450, steps: 0 },
    '2026-10-20': { nutrition: nutritionOf(2) },
    '2026-11-02': { nutrition: nutritionOf(3, { energyKcal: [2, 760.9], proteinG: [1, 20] }), steps: 5000 },
    '2026-11-08': { weightKg: 72.3 },
  });

/**
 * The required evidence fixture (ADR-0096). Date A (2026-11-02): (100.1, 10.1, -, 0), (-, 0, 20.2, -) and a title-only
 * entry. Date B (2026-11-03): (0, -, 0, 5.3). Date C (2026-11-04): no entries.
 */
export const NUTRITION_A = '2026-11-02';
export const NUTRITION_B = '2026-11-03';
export const NUTRITION_C = '2026-11-04';
export const nutritionTrends = (endDate: string = '2026-11-09', today: string = endDate) =>
  trendsFixture(
    endDate,
    {
      [NUTRITION_A]: { nutrition: nutritionOf(3, { carbohydrateG: [1, 20.2], energyKcal: [1, 100.1], fatG: [1, 0], proteinG: [2, 10.1] }) },
      [NUTRITION_B]: { nutrition: nutritionOf(1, { carbohydrateG: [1, 0], energyKcal: [1, 0], fatG: [1, 5.3] }) },
    },
    today,
  );
