import { DAILY_TRENDS_VERSION, dailyTrendsSchema, MEAL_NUTRITION_FIELDS } from '@running-tracker/contracts';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import { mealSummaryRecordOf, type MealSummaryRow } from '../meals/meal-nutrition-summary.js';
import {
  buildDailyTrends,
  DailyTrendsService,
  dailyTrendsCheckInsSql,
  dailyTrendsMealsSql,
  dailyTrendsStepsSql,
  mealRowsOf,
  trendDaysOf,
  type DailyTrendsSourceRows,
} from './daily-trends-service.js';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Column = 'carbohydrate_g' | 'energy_kcal' | 'fat_g' | 'protein_g';
type ColumnValues = Partial<Record<Column, { days?: number; entries: number; total: string | null }>>;

/** A row as the meal statement returns it: counts as integers, sums as numeric text (null when none). */
function mealRow(localDate: string | null, loggedEntries: number, daysWithEntries: number, values: ColumnValues = {}): MealSummaryRow {
  const column = (name: Column) => {
    const value = values[name] ?? { entries: 0, total: null };
    return { [`${name}_days`]: value.days ?? (value.entries > 0 ? 1 : 0), [`${name}_entries`]: value.entries, [`${name}_total`]: value.total };
  };
  return {
    ...column('energy_kcal'),
    ...column('protein_g'),
    ...column('carbohydrate_g'),
    ...column('fat_g'),
    days_with_entries: daysWithEntries,
    local_date: localDate,
    logged_entries: loggedEntries,
  } as unknown as MealSummaryRow;
}

const emptyMealRange = mealRow(null, 0, 0);
const noRawRows = { checkIns: [], meals: [emptyMealRange], steps: [] };
const noRows: DailyTrendsSourceRows = { checkIns: [], meals: [mealSummaryRecordOf(emptyMealRange)], steps: [] };
const parsed = (raw: { checkIns: DailyTrendsSourceRows['checkIns']; meals: MealSummaryRow[]; steps: DailyTrendsSourceRows['steps'] }): DailyTrendsSourceRows => ({
  ...raw,
  meals: raw.meals.map(mealSummaryRecordOf),
});
const base = { computedAt: '2026-11-09T10:00:00.000Z', endDate: '2026-11-09', rows: noRows, timeZone: 'Europe/Warsaw', today: '2026-11-09' };

const clockAt = (iso: string): Clock => ({
  clearTimeout: (handle) => clearTimeout(handle),
  monotonicNow: () => 0,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  utcNow: () => new Date(iso),
});

/** A pool whose one client answers the membership check, records every statement and returns the given raw rows. */
function recordingPool(rows: { checkIns: unknown[]; meals: MealSummaryRow[]; steps: unknown[] } = noRawRows) {
  const statements: Array<{ parameters: unknown[] | undefined; text: string }> = [];
  const client = {
    query: (text: string, parameters?: unknown[]) => {
      statements.push({ parameters, text });
      if (text.includes('FROM memberships')) return Promise.resolve({ rows: [{ allowed: true }] });
      if (text === dailyTrendsCheckInsSql) return Promise.resolve({ rows: rows.checkIns });
      if (text === dailyTrendsStepsSql) return Promise.resolve({ rows: rows.steps });
      if (text === dailyTrendsMealsSql) return Promise.resolve({ rows: rows.meals });
      if (text === 'COMMIT') return Promise.resolve({ command: 'COMMIT', rows: [] });
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pick<Pool, 'connect'>;
  return { pool, statements };
}

describe('daily trends statements', () => {
  const sources = [dailyTrendsCheckInsSql, dailyTrendsStepsSql, dailyTrendsMealsSql];

  it('name the organization, the owner and the inclusive date range in every statement, and take no zone', () => {
    for (const sql of sources) {
      expect(sql).toMatch(/\.org_id = \$1/u);
      expect(sql).toMatch(/\.user_id = \$2/u);
      expect(sql).toMatch(/\.local_date BETWEEN \$3::date AND \$4::date/u);
      expect(sql).not.toMatch(/\$5|time_zone|timestamptz|AT TIME ZONE/u);
    }
  });

  it('read manual movement and meals only, and select no free text', () => {
    expect(dailyTrendsStepsSql).toContain("movement.source = 'manual'");
    expect(dailyTrendsMealsSql).toContain("meal.source = 'manual'");
    expect(dailyTrendsCheckInsSql).not.toMatch(/note/u);
    expect(dailyTrendsStepsSql).not.toMatch(/active_energy/u);
    const selectList = dailyTrendsMealsSql.slice(dailyTrendsMealsSql.indexOf('SELECT'), dailyTrendsMealsSql.indexOf('FROM meals'));
    expect(selectList).not.toMatch(/title|meal_type|description|note|time_zone|meal\.id|idempotency|creation_digest|created_at/u);
  });

  it('aggregate all four nutrients in numeric arithmetic, per date and for the range, in one GROUPING SETS statement', () => {
    for (const column of ['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g']) {
      expect(dailyTrendsMealsSql).toContain(`count(meal.${column})::integer AS ${column}_entries`);
      expect(dailyTrendsMealsSql).toContain(`(count(DISTINCT meal.local_date) FILTER (WHERE meal.${column} IS NOT NULL))::integer AS ${column}_days`);
      expect(dailyTrendsMealsSql).toContain(`sum(meal.${column})::text AS ${column}_total`);
    }
    expect(dailyTrendsMealsSql).toContain('GROUP BY GROUPING SETS ((meal.local_date), ())');
    expect(dailyTrendsMealsSql).not.toMatch(/float|double|real|round\(/iu);
  });
});

describe('trend days', () => {
  it('lists every date, a date without a value as null and a recorded zero as zero', () => {
    const days = trendDaysOf(
      ['2026-11-07', '2026-11-08', '2026-11-09'],
      parsed({
        checkIns: [{ local_date: '2026-11-08', sleep_minutes: 0, weight_kg: null }],
        meals: [mealRow('2026-11-07', 2, 1), mealRow(null, 2, 1)],
        steps: [{ local_date: '2026-11-08', steps: 0 }],
      }),
    );
    const unknown = { recordedEntries: 0, total: null };
    const nutrition = (loggedEntries: number) => ({ carbohydrateG: unknown, energyKcal: unknown, fatG: unknown, loggedEntries, proteinG: unknown });
    expect(days).toEqual([
      { localDate: '2026-11-07', nutrition: nutrition(2), sleepMinutes: null, steps: null, weightKg: null },
      { localDate: '2026-11-08', nutrition: nutrition(0), sleepMinutes: 0, steps: 0, weightKg: null },
      { localDate: '2026-11-09', nutrition: nutrition(0), sleepMinutes: null, steps: null, weightKg: null },
    ]);
  });

  it('parses numeric text exactly into tenths and refuses a row outside the range', () => {
    const [day] = trendDaysOf(
      ['2026-11-09'],
      parsed({
        checkIns: [{ local_date: '2026-11-09', sleep_minutes: null, weight_kg: '72.35' }],
        meals: [mealRow('2026-11-09', 3, 1, { energy_kcal: { entries: 2, total: '1061.10' }, fat_g: { entries: 1, total: '0' } }), mealRow(null, 3, 1)],
        steps: [],
      }),
    );
    expect(day).toMatchObject({ nutrition: { energyKcal: { recordedEntries: 2, total: 1061.1 }, fatG: { recordedEntries: 1, total: 0 } }, weightKg: 72.35 });
    expect(() => trendDaysOf(['2026-11-09'], { ...noRows, steps: [{ local_date: '2026-11-10', steps: 1 }] })).toThrow('outside the range');
  });

  it('refuses meal rows the statement cannot produce: no or two range rows, a date outside the range or twice', () => {
    const dates = ['2026-11-08', '2026-11-09'];
    const records = (rows: MealSummaryRow[]) => rows.map(mealSummaryRecordOf);
    expect(() => mealRowsOf(dates, records([]))).toThrow('0 range rows');
    expect(() => mealRowsOf(dates, records([emptyMealRange, emptyMealRange]))).toThrow('2 range rows');
    expect(() => mealRowsOf(dates, records([mealRow('2026-11-10', 1, 1), mealRow(null, 1, 1)]))).toThrow('unexpected date: 2026-11-10');
    expect(() => mealRowsOf(dates, records([mealRow('2026-11-09', 1, 1), mealRow('2026-11-09', 1, 1), mealRow(null, 2, 1)]))).toThrow('unexpected date: 2026-11-09');
    expect(() => mealSummaryRecordOf(mealRow(null, 1, 1, { protein_g: { entries: 1, total: '0.15' } }))).toThrow('at most one meaningful decimal');
  });
});

// The required evidence fixture (ADR-0096), as the statement returns it for dates A and B (C has no entries).
const A = '2026-11-02';
const B = '2026-11-03';
const C = '2026-11-04';
const fixtureMeals = [
  // A: (100.1, 10.1, null, 0), (null, 0, 20.2, null), title only.
  mealRow(A, 3, 1, {
    carbohydrate_g: { entries: 1, total: '20.2' },
    energy_kcal: { entries: 1, total: '100.1' },
    fat_g: { entries: 1, total: '0' },
    protein_g: { entries: 2, total: '10.1' },
  }),
  // B: (0, null, 0, 5.3).
  mealRow(B, 1, 1, { carbohydrate_g: { entries: 1, total: '0' }, energy_kcal: { entries: 1, total: '0' }, fat_g: { entries: 1, total: '5.3' } }),
  mealRow(null, 4, 2, {
    carbohydrate_g: { days: 2, entries: 2, total: '20.2' },
    energy_kcal: { days: 2, entries: 2, total: '100.1' },
    fat_g: { days: 2, entries: 2, total: '5.3' },
    protein_g: { days: 1, entries: 2, total: '10.1' },
  }),
];

describe('buildDailyTrends', () => {
  it('answers an empty range: 28 dates, every value null, no totals, app-computed provenance', () => {
    const trends = buildDailyTrends(base);
    expect(trends.range).toEqual({
      days: 28,
      endDate: '2026-11-09',
      includesToday: true,
      requestedDays: 28,
      shortenedByLowerBound: false,
      startDate: '2026-10-13',
      timeZone: 'Europe/Warsaw',
      today: '2026-11-09',
    });
    expect(trends.days).toHaveLength(28);
    expect(trends.summary.steps.recordedTotal).toBeNull();
    expect(trends.summary.nutrition).toMatchObject({ daysInRange: 28, daysWithEntries: 0, loggedEntries: 0, source: 'manual' });
    for (const field of MEAL_NUTRITION_FIELDS) expect(trends.summary.nutrition[field]).toEqual({ recordedDays: 0, recordedEntries: 0, total: null });
    expect(trends.provenance).toEqual({
      computedAt: base.computedAt,
      persisted: false,
      snapshot: 'single_read_only_transaction',
      source: 'computed_by_app',
      trendsVersion: DAILY_TRENDS_VERSION,
    });
    expect(DAILY_TRENDS_VERSION).toBe('daily-trends-2');
    expect(dailyTrendsSchema.parse(trends)).toEqual(trends);
  });

  it('shortens the range at the lower bound and uses the actual day count as the nutrition denominator', () => {
    const trends = buildDailyTrends({ ...base, endDate: '2000-01-05', rows: { ...noRows, steps: [{ local_date: '2000-01-01', steps: 10 }] } });
    expect(trends.range).toMatchObject({ days: 5, includesToday: false, shortenedByLowerBound: true, startDate: '2000-01-01' });
    expect(trends.days.map((day) => day.localDate)).toEqual(['2000-01-01', '2000-01-02', '2000-01-03', '2000-01-04', '2000-01-05']);
    expect(trends.summary.steps).toEqual({ daysRecorded: 1, recordedTotal: 10, source: 'manual' });
    expect(trends.summary.nutrition.daysInRange).toBe(5);
  });

  it('keeps the required fixture: independent coverage, recorded zeros, a title-only entry and a date without entries', () => {
    const trends = buildDailyTrends({ ...base, rows: parsed({ checkIns: [], meals: fixtureMeals, steps: [] }) });
    const day = (date: string) => trends.days.find((entry) => entry.localDate === date)!.nutrition;
    expect(day(A)).toEqual({
      carbohydrateG: { recordedEntries: 1, total: 20.2 },
      energyKcal: { recordedEntries: 1, total: 100.1 },
      fatG: { recordedEntries: 1, total: 0 }, // a recorded zero, covering 1 of 3 entries
      loggedEntries: 3,
      proteinG: { recordedEntries: 2, total: 10.1 },
    });
    expect(day(B)).toMatchObject({ loggedEntries: 1, proteinG: { recordedEntries: 0, total: null } });
    expect(day(C)).toEqual({
      carbohydrateG: { recordedEntries: 0, total: null },
      energyKcal: { recordedEntries: 0, total: null },
      fatG: { recordedEntries: 0, total: null },
      loggedEntries: 0,
      proteinG: { recordedEntries: 0, total: null },
    });
    expect(trends.summary.nutrition).toEqual({
      carbohydrateG: { recordedDays: 2, recordedEntries: 2, total: 20.2 },
      daysInRange: 28,
      daysWithEntries: 2,
      energyKcal: { recordedDays: 2, recordedEntries: 2, total: 100.1 },
      fatG: { recordedDays: 2, recordedEntries: 2, total: 5.3 },
      loggedEntries: 4,
      proteinG: { recordedDays: 1, recordedEntries: 2, total: 10.1 },
      source: 'manual',
    });
  });

  it('refuses a range row that disagrees with its dates (the two computations check each other)', () => {
    const range = fixtureMeals[2]!;
    expect(() => buildDailyTrends({ ...base, rows: parsed({ checkIns: [], meals: fixtureMeals, steps: [] }) })).not.toThrow();
    // Each variant is internally consistent (passes the metric rules) and differs from the sum of the dates in one field.
    const disagreeing: MealSummaryRow[] = [
      { ...range, logged_entries: 5 },
      { ...range, days_with_entries: 3 },
      { ...range, energy_kcal_total: '100.2' },
      { ...range, protein_g_days: 2 },
      { ...range, fat_g_entries: 3 },
      { ...range, carbohydrate_g_total: '20.3' },
    ];
    for (const variant of disagreeing) {
      expect(() => buildDailyTrends({ ...base, rows: parsed({ checkIns: [], meals: [fixtureMeals[0]!, fixtureMeals[1]!, variant], steps: [] }) })).toThrow(
        /summarizeDailyTrendDays/u,
      );
    }
  });

  it('summarizes sparse values with their own coverage and exact arithmetic', () => {
    const trends = buildDailyTrends({
      ...base,
      rows: parsed({
        checkIns: [
          { local_date: '2026-10-14', sleep_minutes: 421, weight_kg: '72.35' },
          { local_date: '2026-10-20', sleep_minutes: 422, weight_kg: null },
          { local_date: '2026-11-08', sleep_minutes: null, weight_kg: '72.30' },
        ],
        meals: [
          mealRow('2026-10-14', 1, 1, { energy_kcal: { entries: 1, total: '0.1' } }),
          mealRow('2026-10-15', 2, 1, { energy_kcal: { entries: 1, total: '0.2' } }),
          mealRow('2026-10-16', 1, 1),
          mealRow(null, 4, 3, { energy_kcal: { days: 2, entries: 2, total: '0.3' } }),
        ],
        steps: [{ local_date: '2026-10-20', steps: 0 }],
      }),
    });
    expect(trends.summary).toMatchObject({
      nutrition: { daysWithEntries: 3, energyKcal: { recordedDays: 2, recordedEntries: 2, total: 0.3 }, loggedEntries: 4 },
      sleep: { averageMinutes: 422, daysRecorded: 2, recordedTotalMinutes: 843 },
      steps: { daysRecorded: 1, recordedTotal: 0, source: 'manual' },
      weight: { changeKg: -0.05, daysRecorded: 2, first: { kg: 72.35, localDate: '2026-10-14' }, last: { kg: 72.3, localDate: '2026-11-08' } },
    });
  });
});

describe('DailyTrendsService', () => {
  it('reads three range statements and nothing per date or per nutrient, after the membership check, with the range bounds', async () => {
    const { pool, statements } = recordingPool();
    const service = new DailyTrendsService({ clock: clockAt('2026-11-09T10:00:00.000Z'), pool });
    const trends = await service.read({ userId: USER }, ORG, { endDate: '2026-11-09', timeZone: 'Europe/Warsaw' });
    expect(trends.days).toHaveLength(28);
    const sources = statements.filter((statement) => statement.text.includes('/* daily-trends:'));
    expect(sources.map((statement) => statement.text)).toEqual([dailyTrendsCheckInsSql, dailyTrendsStepsSql, dailyTrendsMealsSql]);
    for (const statement of sources) expect(statement.parameters).toEqual([ORG, USER, '2026-10-13', '2026-11-09']);
    const membership = statements.findIndex((statement) => statement.text.includes('FROM memberships'));
    expect(membership).toBeGreaterThanOrEqual(0);
    expect(membership).toBeLessThan(statements.indexOf(sources[0]!));
    expect(statements.some((statement) => /REPEATABLE READ/u.test(statement.text) && /READ ONLY/u.test(statement.text))).toBe(true);
    expect(statements.some((statement) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(statement.text))).toBe(false);
  });

  it('refuses an end date after today in the requested zone by the injected clock, before reading', async () => {
    const { pool, statements } = recordingPool();
    // 2026-11-09T10:30Z: already 10 November in Kiritimati (UTC+14), still 9 November in Warsaw.
    const service = new DailyTrendsService({ clock: clockAt('2026-11-09T10:30:00.000Z'), pool });
    await expect(service.read({ userId: USER }, ORG, { endDate: '2026-11-10', timeZone: 'Pacific/Kiritimati' })).resolves.toMatchObject({
      range: { includesToday: true, today: '2026-11-10' },
    });
    const before = statements.length;
    const refusal = await service.read({ userId: USER }, ORG, { endDate: '2026-11-10', timeZone: 'Europe/Warsaw' }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ code: 'INVALID_REQUEST', message: 'The end date cannot be after today (2026-11-09 in Europe/Warsaw)', statusCode: 400 });
    expect(statements.length).toBe(before);
  });

  it('follows the zone across a daylight saving midnight for "today" without moving any record', async () => {
    // 2026-03-28T23:30Z is 00:30 on 29 March in Warsaw (CET, before the 02:00 change) and still 28 March in London.
    const { pool } = recordingPool({ ...noRawRows, steps: [{ local_date: '2026-03-29', steps: 5 }] });
    const service = new DailyTrendsService({ clock: clockAt('2026-03-28T23:30:00.000Z'), pool });
    const warsaw = await service.read({ userId: USER }, ORG, { endDate: '2026-03-29', timeZone: 'Europe/Warsaw' });
    expect(warsaw.range).toMatchObject({ includesToday: true, today: '2026-03-29' });
    expect(warsaw.days.at(-1)).toMatchObject({ localDate: '2026-03-29', steps: 5 });
    await expect(service.read({ userId: USER }, ORG, { endDate: '2026-03-29', timeZone: 'Europe/London' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
