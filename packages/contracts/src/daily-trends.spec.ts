import { describe, expect, it } from 'vitest';

import {
  DAILY_TRENDS_RANGE_DAYS,
  DAILY_TRENDS_VERSION,
  dailyTrendsDatesOf,
  dailyTrendsQuerySchema,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  isEmptyDailyTrends,
  openApiDocument,
  MEAL_NUTRITION_FIELDS,
  summarizeDailyTrendDays,
  type DailyTrendDay,
  type DailyTrends,
  type MealNutritionField,
} from './index.js';

const END = '2026-11-09';

/** A date's nutrition: `loggedEntries` and, per field, [recorded entries, total]; every other field unknown. */
function nutrition(loggedEntries: number, values: Partial<Record<MealNutritionField, [number, number | null]>> = {}): DailyTrendDay['nutrition'] {
  const metric = (field: MealNutritionField) => ({ recordedEntries: values[field]?.[0] ?? 0, total: values[field]?.[1] ?? null });
  return { carbohydrateG: metric('carbohydrateG'), energyKcal: metric('energyKcal'), fatG: metric('fatG'), loggedEntries, proteinG: metric('proteinG') };
}
const noFood = nutrition(0);
const unrecorded = { recordedDays: 0, recordedEntries: 0, total: null };

/** Every date of the range ending on `endDate`, without values, with `overrides` by date. */
function daysFor(endDate: string, overrides: Record<string, Partial<DailyTrendDay>> = {}): DailyTrendDay[] {
  return dailyTrendsDatesOf(dailyTrendsRangeOf(endDate)).map((localDate) => ({
    localDate,
    nutrition: noFood,
    sleepMinutes: null,
    steps: null,
    weightKg: null,
    ...overrides[localDate],
  }));
}

function trendsFor(endDate: string, days: DailyTrendDay[], today: string = endDate): DailyTrends {
  const range = dailyTrendsRangeOf(endDate);
  return {
    days,
    provenance: {
      computedAt: '2026-11-09T10:00:00.000Z',
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
  };
}

const issuesOf = (value: unknown) => {
  const parsed = dailyTrendsSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('daily trends range', () => {
  it('is the 28 calendar dates ending on the end date, inclusive, oldest first', () => {
    const range = dailyTrendsRangeOf(END);
    expect(range).toEqual({ days: 28, endDate: END, shortenedByLowerBound: false, startDate: '2026-10-13' });
    const dates = dailyTrendsDatesOf(range);
    expect(dates).toHaveLength(28);
    expect(dates[0]).toBe('2026-10-13');
    expect(dates.at(-1)).toBe(END);
  });

  it('has every date exactly once across both daylight saving changes and a leap day', () => {
    // 2026-10-25 (fall back, 25 hours in Warsaw) and 2026-03-29 (spring forward, 23 hours) are ordinary calendar dates.
    for (const [endDate, inside] of [
      ['2026-11-05', '2026-10-25'],
      ['2026-04-10', '2026-03-29'],
      ['2024-03-10', '2024-02-29'],
    ] as const) {
      const dates = dailyTrendsDatesOf(dailyTrendsRangeOf(endDate));
      expect(dates).toHaveLength(28);
      expect(new Set(dates).size).toBe(28);
      expect(dates).toContain(inside);
      for (let index = 1; index < dates.length; index += 1) {
        expect(Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`)).toBe(86_400_000);
      }
    }
    expect(dailyTrendsDatesOf(dailyTrendsRangeOf('2026-03-01'))[0]).toBe('2026-02-02');
  });

  it('is shortened only by the lower bound 2000-01-01, and says so', () => {
    expect(dailyTrendsRangeOf('2000-01-01')).toEqual({ days: 1, endDate: '2000-01-01', shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(dailyTrendsRangeOf('2000-01-10')).toEqual({ days: 10, endDate: '2000-01-10', shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(dailyTrendsRangeOf('2000-01-27')).toMatchObject({ days: 27, shortenedByLowerBound: true });
    expect(dailyTrendsRangeOf('2000-01-28')).toEqual({ days: 28, endDate: '2000-01-28', shortenedByLowerBound: false, startDate: '2000-01-01' });
  });
});

describe('daily trends summary', () => {
  it('has no value and no total for an empty range: null, never zero', () => {
    expect(summarizeDailyTrendDays(daysFor(END))).toEqual({
      nutrition: {
        carbohydrateG: unrecorded,
        daysInRange: 28,
        daysWithEntries: 0,
        energyKcal: unrecorded,
        fatG: unrecorded,
        loggedEntries: 0,
        proteinG: unrecorded,
        source: 'manual',
      },
      sleep: { averageMinutes: null, daysRecorded: 0, recordedTotalMinutes: null },
      steps: { daysRecorded: 0, recordedTotal: null, source: 'manual' },
      weight: { changeKg: null, daysRecorded: 0, first: null, last: null },
    });
  });

  it('keeps recorded zeros as values: totals and averages of 0 over the recorded dates', () => {
    const days = daysFor(END, {
      '2026-11-01': { nutrition: nutrition(2, { energyKcal: [2, 0], fatG: [1, 0] }), sleepMinutes: 0, steps: 0 },
      '2026-11-02': { sleepMinutes: 0, steps: 0 },
    });
    const summary = summarizeDailyTrendDays(days);
    expect(summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 0, source: 'manual' });
    expect(summary.sleep).toEqual({ averageMinutes: 0, daysRecorded: 2, recordedTotalMinutes: 0 });
    expect(summary.nutrition.energyKcal).toEqual({ recordedDays: 1, recordedEntries: 2, total: 0 });
    expect(summary.nutrition.fatG).toEqual({ recordedDays: 1, recordedEntries: 1, total: 0 });
    expect(summary.nutrition.proteinG).toEqual(unrecorded);
  });

  it('gives each series its own coverage, and averages sleep over the recorded dates only', () => {
    const days = daysFor(END, {
      '2026-10-13': { sleepMinutes: 420, steps: 8042 },
      '2026-10-20': { sleepMinutes: 450 },
      '2026-11-09': { steps: 0, weightKg: 72.4 },
    });
    const summary = summarizeDailyTrendDays(days);
    expect(summary.sleep).toEqual({ averageMinutes: 435, daysRecorded: 2, recordedTotalMinutes: 870 });
    expect(summary.steps).toEqual({ daysRecorded: 2, recordedTotal: 8042, source: 'manual' });
    expect(summary.weight.daysRecorded).toBe(1);
  });

  it('rounds the sleep average to the nearest minute with halves up, in integers', () => {
    const average = (...minutes: number[]) =>
      summarizeDailyTrendDays(daysFor(END, Object.fromEntries(minutes.map((value, index) => [dailyTrendsDatesOf(dailyTrendsRangeOf(END))[index]!, { sleepMinutes: value }]))))
        .sleep.averageMinutes;
    expect(average(421, 422)).toBe(422); // 421.5
    expect(average(420, 421, 421)).toBe(421); // 420.67
    expect(average(420, 420, 421)).toBe(420); // 420.33
    expect(average(1, 0)).toBe(1); // 0.5
    expect(average(1_440)).toBe(1_440);
  });

  it('has no first, last or change for a single weight; with two or more recorded dates the exact change', () => {
    const single = summarizeDailyTrendDays(daysFor(END, { '2026-10-20': { weightKg: 72.35 } }));
    expect(single.weight).toEqual({ changeKg: null, daysRecorded: 1, first: null, last: null });

    const several = summarizeDailyTrendDays(
      daysFor(END, { '2026-10-14': { weightKg: 72.35 }, '2026-10-30': { weightKg: 90 }, '2026-11-08': { weightKg: 72.3 } }),
    );
    // 72.3 - 72.35 in binary floating point is -0.04999999999999716.
    expect(several.weight).toEqual({
      changeKg: -0.05,
      daysRecorded: 3,
      first: { kg: 72.35, localDate: '2026-10-14' },
      last: { kg: 72.3, localDate: '2026-11-08' },
    });
    expect(summarizeDailyTrendDays(daysFor(END, { '2026-10-14': { weightKg: 70.1 }, '2026-10-15': { weightKg: 70.3 } })).weight.changeKg).toBe(0.2);
  });

  it('adds nutrition exactly, with day and entry coverage kept apart for each metric independently', () => {
    const days = daysFor(END, {
      '2026-10-13': { nutrition: nutrition(1, { energyKcal: [1, 0.1], proteinG: [1, 0.1] }) },
      '2026-10-14': { nutrition: nutrition(3, { carbohydrateG: [3, 0.2], energyKcal: [1, 0.2] }) },
      // A title-only day: entries logged, no metric recorded.
      '2026-10-15': { nutrition: nutrition(2) },
      '2026-10-16': { nutrition: nutrition(2, { energyKcal: [2, 1061.1], fatG: [2, 0] }) },
    });
    expect(summarizeDailyTrendDays(days).nutrition).toEqual({
      carbohydrateG: { recordedDays: 1, recordedEntries: 3, total: 0.2 },
      daysInRange: 28,
      daysWithEntries: 4,
      energyKcal: { recordedDays: 3, recordedEntries: 4, total: 1061.4 }, // 0.1 + 0.2 + 1061.1, never 1061.3999999999999
      fatG: { recordedDays: 1, recordedEntries: 2, total: 0 },
      loggedEntries: 8,
      proteinG: { recordedDays: 1, recordedEntries: 1, total: 0.1 },
      source: 'manual',
    });
  });

  it('keeps the required fixture (ADR-0096): independent coverage, a recorded zero, a title-only entry, a date without entries', () => {
    // A: (100.1, 10.1, null, 0), (null, 0, 20.2, null), title only. B: (0, null, 0, 5.3). C: no entries.
    const days = daysFor(END, {
      '2026-11-02': { nutrition: nutrition(3, { carbohydrateG: [1, 20.2], energyKcal: [1, 100.1], fatG: [1, 0], proteinG: [2, 10.1] }) },
      '2026-11-03': { nutrition: nutrition(1, { carbohydrateG: [1, 0], energyKcal: [1, 0], fatG: [1, 5.3] }) },
    });
    expect(summarizeDailyTrendDays(days).nutrition).toEqual({
      carbohydrateG: { recordedDays: 2, recordedEntries: 2, total: 20.2 },
      daysInRange: 28,
      daysWithEntries: 2,
      energyKcal: { recordedDays: 2, recordedEntries: 2, total: 100.1 },
      fatG: { recordedDays: 2, recordedEntries: 2, total: 5.3 },
      loggedEntries: 4,
      proteinG: { recordedDays: 1, recordedEntries: 2, total: 10.1 },
      source: 'manual',
    });
    expect(dailyTrendsSchema.safeParse(trendsFor(END, days)).success).toBe(true);
  });

  it('adds ten recorded 0.1 values to exactly 1, and the largest range total exactly', () => {
    const dates = dailyTrendsDatesOf(dailyTrendsRangeOf(END));
    const spread = summarizeDailyTrendDays(daysFor(END, Object.fromEntries(dates.slice(0, 10).map((date) => [date, { nutrition: nutrition(1, { fatG: [1, 0.1] }) }]))));
    expect(spread.nutrition.fatG).toEqual({ recordedDays: 10, recordedEntries: 10, total: 1 }); // never 0.9999999999999999
    const full = daysFor(END, Object.fromEntries(dates.map((date) => [date, { nutrition: nutrition(10_000, { energyKcal: [10_000, 200_000_000] }) }])));
    const trends = trendsFor(END, full);
    expect(trends.summary.nutrition.energyKcal.total).toBe(5_600_000_000);
    expect(dailyTrendsSchema.safeParse(trends).success).toBe(true);
  });
});

describe('daily trends contract', () => {
  it('accepts a consistent response and pins the version', () => {
    const days = daysFor(END, { '2026-11-01': { nutrition: nutrition(2, { energyKcal: [1, 350.5] }), steps: 0, weightKg: 72.4 } });
    expect(dailyTrendsSchema.parse(trendsFor(END, days))).toEqual(trendsFor(END, days));
    expect(DAILY_TRENDS_VERSION).toBe('daily-trends-2');
    const shortened = trendsFor('2000-01-03', daysFor('2000-01-03'), '2026-11-09');
    expect(dailyTrendsSchema.parse(shortened).range).toMatchObject({ days: 3, includesToday: false, shortenedByLowerBound: true, startDate: '2000-01-01' });
  });

  it('refuses a summary that is not computed from the days', () => {
    const days = daysFor(END, { '2026-11-01': { steps: 100 } });
    const trends = trendsFor(END, days);
    expect(issuesOf({ ...trends, summary: { ...trends.summary, steps: { daysRecorded: 1, recordedTotal: 101, source: 'manual' } } })).toContain(
      'the summary is computed from the days by summarizeDailyTrendDays (range nutrition = the sum of the dates)',
    );
    // A single measurement presented as a change.
    const one = trendsFor(END, daysFor(END, { '2026-11-01': { weightKg: 70 } }));
    const asChange = { ...one.summary, weight: { changeKg: 0, daysRecorded: 1, first: { kg: 70, localDate: '2026-11-01' }, last: { kg: 70, localDate: '2026-11-01' } } };
    expect(issuesOf({ ...one, summary: asChange })).toContain('the summary is computed from the days by summarizeDailyTrendDays (range nutrition = the sum of the dates)');
    // A missing value counted as zero.
    expect(issuesOf({ ...trends, summary: { ...trends.summary, sleep: { averageMinutes: 0, daysRecorded: 28, recordedTotalMinutes: 0 } } })).not.toEqual([]);
  });

  it('refuses days that are not every date of the range, oldest first, once each', () => {
    const days = daysFor(END);
    expect(issuesOf(trendsFor(END, days.slice(1)))).toContain('days are every date of the range, oldest first, once each');
    expect(issuesOf(trendsFor(END, days.toReversed()))).toContain('days are every date of the range, oldest first, once each');
    const duplicated = [...days.slice(0, 27), days[26]!];
    expect(issuesOf(trendsFor(END, duplicated))).toContain('days are every date of the range, oldest first, once each');
  });

  it('refuses inconsistent date nutrition for every metric, and a total of 0 that nobody recorded', () => {
    const bad = (value: unknown) => issuesOf(trendsFor(END, daysFor(END, { '2026-11-01': { nutrition: value as DailyTrendDay['nutrition'] } })));
    for (const field of MEAL_NUTRITION_FIELDS) {
      const max = field === 'energyKcal' ? 20_000 : 2_000;
      expect(bad({ ...nutrition(2), [field]: { recordedEntries: 0, total: 0 } }), field).toContain('a total exists exactly when at least one entry records the value');
      expect(bad({ ...nutrition(1), [field]: { recordedEntries: 1, total: null } }), field).toContain('a total exists exactly when at least one entry records the value');
      expect(bad({ ...nutrition(2), [field]: { recordedEntries: 3, total: 5 } }), field).toContain('a metric cannot be recorded for more entries than were logged');
      expect(bad({ ...nutrition(1), [field]: { recordedEntries: 1, total: 0.05 } }), field).toContain('A recorded total has at most one decimal');
      expect(bad({ ...nutrition(2), [field]: { recordedEntries: 1, total: max + 0.1 } }), field).toContain('a total cannot exceed what its recorded entries can hold');
      expect(bad({ ...nutrition(1), [field]: { recordedEntries: 1, total: -0.1 } }), field).not.toEqual([]);
      expect(bad({ ...nutrition(10_001), [field]: { recordedEntries: 1, total: 1 } }), field).not.toEqual([]);
    }
    // One metric's values say nothing about the others.
    expect(bad(nutrition(3, { fatG: [1, 0] }))).toEqual([]);
  });

  it('refuses an inconsistent range summary for every metric, and a denominator that is not the range', () => {
    const days = daysFor(END, {
      '2026-11-02': { nutrition: nutrition(3, { carbohydrateG: [1, 20.2], energyKcal: [1, 100.1], fatG: [1, 0], proteinG: [2, 10.1] }) },
      '2026-11-03': { nutrition: nutrition(1, { carbohydrateG: [1, 0], energyKcal: [1, 0], fatG: [1, 5.3] }) },
    });
    const trends = trendsFor(END, days);
    const withNutrition = (change: Record<string, unknown>) => issuesOf({ ...trends, summary: { ...trends.summary, nutrition: { ...trends.summary.nutrition, ...change } } });
    const summaryRule = 'the summary is computed from the days by summarizeDailyTrendDays (range nutrition = the sum of the dates)';
    expect(withNutrition({ daysInRange: 27 })).toContain('the nutrition denominator is the actual number of dates in the range');
    expect(withNutrition({ daysWithEntries: 29 })).not.toEqual([]);
    expect(withNutrition({ daysWithEntries: 0 })).toContain('a date has entries exactly when entries were logged for it');
    expect(withNutrition({ daysWithEntries: 3 })).toContain(summaryRule);
    expect(withNutrition({ loggedEntries: 5 })).toContain(summaryRule);
    for (const field of MEAL_NUTRITION_FIELDS) {
      const metric = trends.summary.nutrition[field];
      const change = (value: Record<string, unknown>) => withNutrition({ [field]: { ...metric, ...value } });
      expect(change({ recordedDays: 2, recordedEntries: 5 }), field).toContain('a metric cannot be recorded for more entries than were logged');
      expect(change({ recordedDays: 3, recordedEntries: 4 }), field).toContain('a metric cannot be recorded on more dates than have entries');
      expect(change({ recordedDays: 0 }), field).toContain('a date records the value exactly when one of its entries does');
      expect(change({ total: null }), field).toContain('a total exists exactly when at least one entry records the value');
      expect(change({ total: (metric.total ?? 0) + 0.1 }), field).toContain(summaryRule);
    }
  });

  it('refuses personal text and unknown fields anywhere', () => {
    const trends = trendsFor(END, daysFor(END));
    expect(issuesOf({ ...trends, days: [{ ...trends.days[0], note: 'x' }, ...trends.days.slice(1)] })).not.toEqual([]);
    expect(issuesOf({ ...trends, days: [{ ...trends.days[0], nutrition: { ...noFood, titles: ['Soup'] } }, ...trends.days.slice(1)] })).not.toEqual([]);
    // The daily-trends-1 shape is refused, never read with another meaning.
    const legacy = { entriesWithEnergy: 0, loggedEntries: 0, recordedKcal: null };
    expect(issuesOf({ ...trends, days: [{ ...trends.days[0], foodEnergy: legacy }, ...trends.days.slice(1)] })).not.toEqual([]);
    expect(issuesOf({ ...trends, extra: true })).not.toEqual([]);
  });

  it('refuses a range that is not the 28 dates ending on the end date, ends after today, or misstates today', () => {
    const trends = trendsFor(END, daysFor(END));
    expect(issuesOf({ ...trends, range: { ...trends.range, shortenedByLowerBound: true } })).toContain(
      'the range is the 28 dates ending on endDate, cut only by 2000-01-01',
    );
    expect(issuesOf({ ...trends, range: { ...trends.range, today: '2026-11-08' } })).toContain(
      'the range cannot end after today, and includesToday says whether it ends today',
    );
    expect(issuesOf({ ...trends, range: { ...trends.range, includesToday: false } })).toContain(
      'the range cannot end after today, and includesToday says whether it ends today',
    );
  });

  it('calls a range empty only when no series has a value and no entry was logged (a title-only or macro-only range is not empty)', () => {
    expect(isEmptyDailyTrends(trendsFor(END, daysFor(END)))).toBe(true);
    expect(isEmptyDailyTrends(trendsFor(END, daysFor(END, { '2026-11-01': { steps: 0 } })))).toBe(false);
    expect(isEmptyDailyTrends(trendsFor(END, daysFor(END, { '2026-11-01': { nutrition: nutrition(1) } })))).toBe(false);
    expect(isEmptyDailyTrends(trendsFor(END, daysFor(END, { '2026-11-01': { nutrition: nutrition(1, { proteinG: [1, 12] }) } })))).toBe(false);
  });
});

describe('daily trends query', () => {
  it('takes exactly an end date not before 2000-01-01 and an IANA zone', () => {
    expect(dailyTrendsQuerySchema.parse({ endDate: END, timeZone: 'Europe/Warsaw' })).toEqual({ endDate: END, timeZone: 'Europe/Warsaw' });
    expect(dailyTrendsQuerySchema.parse({ endDate: '2000-01-01', timeZone: 'UTC' }).endDate).toBe('2000-01-01');
    for (const query of [
      {},
      { endDate: END },
      { timeZone: 'UTC' },
      { endDate: '1999-12-31', timeZone: 'UTC' },
      { endDate: '2026-02-30', timeZone: 'UTC' },
      { endDate: END, timeZone: '+01:00' },
      { endDate: END, timeZone: 'Mars/Olympus_Mons' },
      { endDate: END, timeZone: 'UTC', days: '7' },
      { endDate: [END, END], timeZone: 'UTC' },
    ]) {
      expect(dailyTrendsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('is documented in OpenAPI with its two query parameters and schema', () => {
    const path = openApiDocument.paths['/api/orgs/{orgId}/daily-trends'] as unknown as { get: { parameters: Array<{ $ref: string }>; tags: string[] } };
    expect(path.get.tags).toEqual(['Daily trends']);
    expect(path.get.parameters.map((parameter) => parameter.$ref)).toEqual([
      '#/components/parameters/OrgId',
      '#/components/parameters/TrendsEndDate',
      '#/components/parameters/TrendsTimeZone',
    ]);
    expect(openApiDocument.components.schemas).toHaveProperty('DailyTrends');
  });
});
