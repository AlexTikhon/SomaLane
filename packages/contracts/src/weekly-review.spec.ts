import { describe, expect, it } from 'vitest';

import {
  openApiDocument,
  weeklyReviewMealDaySchema,
  weeklyReviewMovementDaySchema,
  weeklyReviewQuerySchema,
  weeklyReviewSchema,
  WEEKLY_REVIEW_MEAL_ENTRIES_PER_DAY_MAX,
  WEEKLY_REVIEW_VERSION,
} from './index.js';

const unknown = { recordedEntries: 0, total: null };
const mealDay = (localDate: string, loggedEntries = 0, values: Record<string, { recordedEntries: number; total: number | null }> = {}) => ({
  carbohydrateG: unknown,
  energyKcal: unknown,
  fatG: unknown,
  localDate,
  loggedEntries,
  proteinG: unknown,
  ...values,
});

const review = {
  coverage: {
    daysInWeek: 7,
    daysWithCheckInRecord: 5,
    daysWithCheckInValues: 4,
    gpsRuns: { count: 2, withCurrentDistance: 1, withoutCurrentDistance: 1 },
    manualActivities: { count: 3, withDistance: 2 },
    metrics: {
      mood: { daysRecorded: 2 },
      sleepDuration: { daysRecorded: 3 },
      sleepQuality: { daysRecorded: 1 },
      soreness: { daysRecorded: 0 },
      weight: { daysRecorded: 4 },
    },
    noteOnlyDays: 1,
    sleepQualityWithoutDurationDays: 1,
  },
  dataGaps: [{ code: 'missing_check_in_days', text: 'No check-in values on 3 of 7 days.' }],
  facts: [{ day: 'none', direction: 'none', id: 'sleep.nights_reported', label: 'Nights with sleep logged', text: 'Nights with sleep logged: 3 days', unit: 'days', value: 3 }],
  importedActivities: {
    byType: [
      { count: 2, distanceM: 26_097, elapsedDurationS: 9_065, type: 'run' },
      { count: 1, distanceM: 40_250, elapsedDurationS: 5_400, type: 'ride' },
    ],
    count: 3,
    distanceM: 66_347,
    elapsedDurationS: 14_465,
    source: 'gpx',
  },
  tcxImportedActivities: {
    byType: [
      { count: 1, distanceM: 30_000, reportedDurationS: 3_600, type: 'ride' },
      { count: 1, distanceM: 1_500, reportedDurationS: 2_400, type: 'swim' },
    ],
    count: 2,
    distanceM: 31_500,
    reportedDurationS: 6_000,
    source: 'tcx',
  },
  // The required regression: Monday steps 0, Tuesday both values, Wednesday energy only, the other days missing.
  movement: {
    activeEnergyKcal: { daysRecorded: 2, recordedTotal: 662.5 },
    days: [
      { activeEnergyKcal: null, localDate: '2026-11-02', recorded: true, source: 'manual', steps: 0, timeZone: 'Europe/Warsaw' },
      { activeEnergyKcal: 412.5, localDate: '2026-11-03', recorded: true, source: 'manual', steps: 8042, timeZone: 'Europe/Warsaw' },
      { activeEnergyKcal: 250, localDate: '2026-11-04', recorded: true, source: 'manual', steps: null, timeZone: 'America/New_York' },
      { localDate: '2026-11-05', recorded: false },
      { localDate: '2026-11-06', recorded: false },
      { localDate: '2026-11-07', recorded: false },
      { localDate: '2026-11-08', recorded: false },
    ],
    daysInWeek: 7,
    daysWithRecord: 3,
    source: 'manual',
    steps: { daysRecorded: 2, recordedTotal: 8042 },
  },
  // Monday: three entries (energy on two, protein on one, one title-only); Wednesday: one with recorded zeros; Saturday:
  // one with energy 0 and protein. Each metric has its own entry and day coverage.
  meals: {
    carbohydrateG: { recordedDays: 1, recordedEntries: 1, total: 0 },
    days: [
      mealDay('2026-11-02', 3, { energyKcal: { recordedEntries: 2, total: 1061.1 }, proteinG: { recordedEntries: 1, total: 30 } }),
      mealDay('2026-11-03'),
      mealDay('2026-11-04', 1, { carbohydrateG: { recordedEntries: 1, total: 0 }, fatG: { recordedEntries: 1, total: 0 } }),
      mealDay('2026-11-05'),
      mealDay('2026-11-06'),
      mealDay('2026-11-07', 1, { energyKcal: { recordedEntries: 1, total: 0 }, proteinG: { recordedEntries: 1, total: 12.5 } }),
      mealDay('2026-11-08'),
    ],
    daysInWeek: 7,
    daysWithEntries: 3,
    energyKcal: { recordedDays: 2, recordedEntries: 3, total: 1061.1 },
    fatG: { recordedDays: 1, recordedEntries: 1, total: 0 },
    loggedEntries: 5,
    proteinG: { recordedDays: 2, recordedEntries: 2, total: 42.5 },
    source: 'manual',
  },
  provenance: {
    computedAt: '2026-11-20T10:00:00.000Z',
    persisted: false,
    policyVersion: 'weekly-insight-policy-2',
    reviewVersion: WEEKLY_REVIEW_VERSION,
    snapshot: 'single_read_only_transaction',
    source: 'computed_by_app',
  },
  statements: [{ code: 'sleep_duration.coverage', text: 'Sleep duration was recorded on 3 of 4 days with check-in values.' }],
  week: { end: '2026-11-08', inProgress: false, start: '2026-11-02', timeZone: 'Europe/Warsaw', timeZoneSource: 'check_ins', zonesOnCheckIns: ['Europe/Warsaw'] },
};

describe('weekly review contract', () => {
  it('accepts a consistent review', () => {
    expect(weeklyReviewSchema.parse(review)).toEqual(review);
  });

  it('refuses inconsistent denominators', () => {
    const coverage = (patch: Record<string, unknown>) => weeklyReviewSchema.safeParse({ ...review, coverage: { ...review.coverage, ...patch } }).success;
    expect(coverage({ daysWithCheckInValues: 6 })).toBe(false);
    expect(coverage({ noteOnlyDays: 0 })).toBe(false);
    expect(coverage({ metrics: { ...review.coverage.metrics, sleepDuration: { daysRecorded: 5 } } })).toBe(false);
    expect(coverage({ sleepQualityWithoutDurationDays: 2 })).toBe(false);
    expect(coverage({ gpsRuns: { count: 2, withCurrentDistance: 2, withoutCurrentDistance: 1 } })).toBe(false);
    expect(coverage({ manualActivities: { count: 1, withDistance: 2 } })).toBe(false);
  });

  it('names the version that added recorded meal nutrition (after TCX imports)', () => {
    expect(WEEKLY_REVIEW_VERSION).toBe('weekly-review-5');
  });

  it('refuses an inconsistent TCX import part, and one named as GPX (ADR-0091)', () => {
    const tcx = (patch: Record<string, unknown>) =>
      weeklyReviewSchema.safeParse({ ...review, tcxImportedActivities: { ...review.tcxImportedActivities, ...patch } }).success;
    expect(tcx({})).toBe(true);
    expect(tcx({ count: 3 })).toBe(false);
    expect(tcx({ distanceM: 1 })).toBe(false);
    expect(tcx({ reportedDurationS: 1 })).toBe(false);
    expect(tcx({ source: 'gpx' })).toBe(false);
    expect(tcx({ byType: [...review.tcxImportedActivities.byType].reverse() })).toBe(false);
    expect(tcx({ byType: [], count: 0, distanceM: 0, reportedDurationS: 0 })).toBe(true);
    expect(tcx({ byType: [{ count: 1, distanceM: 1, elapsedDurationS: 1, type: 'run' }], count: 1, distanceM: 1, reportedDurationS: 1 })).toBe(false);
  });

  it('refuses an inconsistent GPX import part (ADR-0086)', () => {
    const imported = (patch: Record<string, unknown>) =>
      weeklyReviewSchema.safeParse({ ...review, importedActivities: { ...review.importedActivities, ...patch } }).success;
    expect(imported({})).toBe(true);
    expect(imported({ count: 4 })).toBe(false);
    expect(imported({ distanceM: 1 })).toBe(false);
    expect(imported({ elapsedDurationS: 1 })).toBe(false);
    expect(imported({ source: 'manual' })).toBe(false);
    expect(imported({ byType: [...review.importedActivities.byType].reverse() })).toBe(false);
    expect(imported({ byType: [], count: 0, distanceM: 0, elapsedDurationS: 0 })).toBe(true);
    expect(imported({ byType: [{ count: 0, distanceM: 0, elapsedDurationS: 0, type: 'run' }], count: 0, distanceM: 0, elapsedDurationS: 0 })).toBe(false);
  });

  describe('movement', () => {
    type Movement = typeof review.movement;
    const days = review.movement.days;
    const accepts = (movement: Record<string, unknown>) => weeklyReviewSchema.safeParse({ ...review, movement }).success;
    const patched = (patch: Partial<Record<keyof Movement, unknown>>) => accepts({ ...review.movement, ...patch });

    it('refuses counts and totals that do not match the days', () => {
      expect(patched({ daysWithRecord: 2 })).toBe(false);
      expect(patched({ steps: { daysRecorded: 3, recordedTotal: 8042 } })).toBe(false);
      expect(patched({ steps: { daysRecorded: 2, recordedTotal: 8043 } })).toBe(false);
      expect(patched({ steps: { daysRecorded: 2, recordedTotal: null } })).toBe(false);
      expect(patched({ activeEnergyKcal: { daysRecorded: 1, recordedTotal: 662.5 } })).toBe(false);
      expect(patched({ activeEnergyKcal: { daysRecorded: 2, recordedTotal: 662.6 } })).toBe(false);
      expect(patched({ activeEnergyKcal: { daysRecorded: 2, recordedTotal: 662.55 } })).toBe(false);
    });

    it('distinguishes a metric never recorded (null total) from one recorded as zero (0 total)', () => {
      const zeros = [
        { activeEnergyKcal: null, localDate: '2026-11-02', recorded: true, source: 'manual', steps: 0, timeZone: 'UTC' },
        ...days.slice(1).map((day) => ({ localDate: day.localDate, recorded: false })),
      ];
      const base = { ...review.movement, daysWithRecord: 1, days: zeros };
      expect(accepts({ ...base, activeEnergyKcal: { daysRecorded: 0, recordedTotal: null }, steps: { daysRecorded: 1, recordedTotal: 0 } })).toBe(true);
      expect(accepts({ ...base, activeEnergyKcal: { daysRecorded: 0, recordedTotal: 0 }, steps: { daysRecorded: 1, recordedTotal: 0 } })).toBe(false);
      expect(accepts({ ...base, activeEnergyKcal: { daysRecorded: 0, recordedTotal: null }, steps: { daysRecorded: 1, recordedTotal: null } })).toBe(false);
    });

    it('needs the seven days of the week, in order, and a missing day without values', () => {
      expect(patched({ days: days.slice(0, 6) })).toBe(false);
      expect(patched({ days: [...days.slice(1), days[0]] })).toBe(false);
      expect(weeklyReviewSchema.safeParse({ ...review, week: { ...review.week, end: '2026-11-15', start: '2026-11-09' } }).success).toBe(false);
      expect(patched({ days: [...days.slice(0, 3), { localDate: '2026-11-05', recorded: false, steps: null }, ...days.slice(4)] })).toBe(false);
      expect(patched({ days: [...days.slice(0, 3), { activeEnergyKcal: null, localDate: '2026-11-05', recorded: true, source: 'manual', steps: null, timeZone: 'UTC' }, ...days.slice(4)] })).toBe(false);
    });

    it('names the manual source only, with energy to one decimal and no extra fields', () => {
      expect(patched({ source: 'apple_health' })).toBe(false);
      expect(patched({ days: [{ ...days[0], source: 'apple_health' }, ...days.slice(1)] })).toBe(false);
      expect(weeklyReviewMovementDaySchema.safeParse({ ...days[1], activeEnergyKcal: 412.55 }).success).toBe(false);
      expect(weeklyReviewMovementDaySchema.safeParse({ ...days[1], activeEnergyKcal: 412.5 }).success).toBe(true);
      expect(patched({ calories: 1 } as never)).toBe(false);
    });

    it('is part of the OpenAPI document', () => {
      expect(JSON.stringify(openApiDocument.components.schemas.WeeklyReview)).toContain('daysWithRecord');
    });
  });

  describe('meals (ADR-0093)', () => {
    type Meals = typeof review.meals;
    const days = review.meals.days;
    const accepts = (meals: Record<string, unknown>) => weeklyReviewSchema.safeParse({ ...review, meals }).success;
    const patched = (patch: Partial<Record<keyof Meals, unknown>>) => accepts({ ...review.meals, ...patch });
    const withDay = (index: number, day: unknown) => days.map((entry, position) => (position === index ? day : entry));
    const dayAccepted = (day: unknown) => weeklyReviewMealDaySchema.safeParse(day).success;

    it('refuses weekly counts and totals that do not match the days', () => {
      expect(patched({})).toBe(true);
      expect(patched({ loggedEntries: 4 })).toBe(false);
      expect(patched({ daysWithEntries: 2 })).toBe(false);
      expect(patched({ energyKcal: { recordedDays: 2, recordedEntries: 2, total: 1061.1 } })).toBe(false);
      expect(patched({ energyKcal: { recordedDays: 1, recordedEntries: 3, total: 1061.1 } })).toBe(false);
      expect(patched({ energyKcal: { recordedDays: 2, recordedEntries: 3, total: 1061.2 } })).toBe(false);
      expect(patched({ proteinG: { recordedDays: 2, recordedEntries: 2, total: null } })).toBe(false);
      expect(patched({ carbohydrateG: { recordedDays: 0, recordedEntries: 0, total: null } })).toBe(false);
    });

    it('keeps null (unknown) and 0 (recorded zero) apart, per day and for the week', () => {
      expect(patched({ fatG: { recordedDays: 1, recordedEntries: 1, total: null } })).toBe(false);
      const nulled = mealDay('2026-11-04', 1, { carbohydrateG: { recordedEntries: 1, total: null }, fatG: { recordedEntries: 1, total: 0 } });
      expect(patched({ days: withDay(2, nulled) })).toBe(false);
      expect(dayAccepted(mealDay('2026-11-03', 0, { energyKcal: { recordedEntries: 0, total: 0 } }))).toBe(false);
      expect(dayAccepted(mealDay('2026-11-03', 1, { energyKcal: { recordedEntries: 1, total: 0 } }))).toBe(true);
      // A title-only entry: logged, every metric unknown.
      expect(dayAccepted(mealDay('2026-11-03', 1))).toBe(true);
    });

    it('keeps the null/count relationships of a week: a recorded day needs a recorded entry and the reverse', () => {
      const titleOnly = {
        ...review.meals,
        carbohydrateG: { recordedDays: 0, recordedEntries: 0, total: null },
        days: [mealDay('2026-11-02', 1), ...days.slice(1).map((entry) => mealDay(entry.localDate))],
        daysWithEntries: 1,
        energyKcal: { recordedDays: 0, recordedEntries: 0, total: null },
        fatG: { recordedDays: 0, recordedEntries: 0, total: null },
        loggedEntries: 1,
        proteinG: { recordedDays: 0, recordedEntries: 0, total: null },
      };
      expect(accepts(titleOnly)).toBe(true);
      expect(accepts({ ...titleOnly, energyKcal: { recordedDays: 1, recordedEntries: 0, total: null } })).toBe(false);
      expect(accepts({ ...titleOnly, energyKcal: { recordedDays: 0, recordedEntries: 1, total: 0 } })).toBe(false);
      expect(accepts({ ...titleOnly, energyKcal: { recordedDays: 2, recordedEntries: 1, total: 0 } })).toBe(false);
    });

    it('refuses a day metric recorded for more entries than were logged, or a total its entries cannot hold', () => {
      expect(dayAccepted(mealDay('2026-11-03', 1, { proteinG: { recordedEntries: 2, total: 2 } }))).toBe(false);
      expect(dayAccepted(mealDay('2026-11-03', 1, { energyKcal: { recordedEntries: 1, total: 20_000 } }))).toBe(true);
      expect(dayAccepted(mealDay('2026-11-03', 1, { energyKcal: { recordedEntries: 1, total: 20_000.1 } }))).toBe(false);
      expect(dayAccepted(mealDay('2026-11-03', 1, { fatG: { recordedEntries: 1, total: 2_000.1 } }))).toBe(false);
      expect(dayAccepted(mealDay('2026-11-03', 1, { fatG: { recordedEntries: 1, total: 12.55 } }))).toBe(false);
      expect(dayAccepted(mealDay('2026-11-03', 1, { fatG: { recordedEntries: 1, total: -0.1 } }))).toBe(false);
      expect(dayAccepted(mealDay('2026-11-03', WEEKLY_REVIEW_MEAL_ENTRIES_PER_DAY_MAX))).toBe(true);
      expect(dayAccepted(mealDay('2026-11-03', WEEKLY_REVIEW_MEAL_ENTRIES_PER_DAY_MAX + 1))).toBe(false);
    });

    it('holds weekly totals within weekly bounds exactly (seven days at the per-day bound)', () => {
      const max = WEEKLY_REVIEW_MEAL_ENTRIES_PER_DAY_MAX;
      const full = days.map((entry) => mealDay(entry.localDate, max, { energyKcal: { recordedEntries: max, total: max * 20_000 } }));
      const week = {
        ...review.meals,
        carbohydrateG: { recordedDays: 0, recordedEntries: 0, total: null },
        days: full,
        daysWithEntries: 7,
        energyKcal: { recordedDays: 7, recordedEntries: 7 * max, total: 7 * max * 20_000 },
        fatG: { recordedDays: 0, recordedEntries: 0, total: null },
        loggedEntries: 7 * max,
        proteinG: { recordedDays: 0, recordedEntries: 0, total: null },
      };
      expect(accepts(week)).toBe(true);
      expect(accepts({ ...week, energyKcal: { recordedDays: 7, recordedEntries: 7 * max, total: 7 * max * 20_000 + 0.1 } })).toBe(false);
    });

    it('needs the seven days of the week in order, the manual source and no extra fields', () => {
      expect(patched({ days: days.slice(0, 6) })).toBe(false);
      expect(patched({ days: [...days.slice(1), days[0]] })).toBe(false);
      expect(patched({ source: 'apple_health' })).toBe(false);
      expect(accepts({ ...review.meals, titles: ['Chicken and rice'] })).toBe(false);
      expect(patched({ days: withDay(1, { ...days[1], title: 'x' }) })).toBe(false);
      expect(patched({ energyKcal: { recordedDays: 2, recordedEntries: 3, target: 2000, total: 1061.1 } })).toBe(false);
      // Days that are not the review's week are refused even when the movement days match it.
      const nextWeek = days.map((entry, index) => ({ ...entry, localDate: `2026-11-${String(9 + index).padStart(2, '0')}` }));
      expect(patched({ days: nextWeek })).toBe(false);
    });

    it('is part of the OpenAPI document', () => {
      const schema = JSON.stringify(openApiDocument.components.schemas.WeeklyReview);
      expect(schema).toContain('daysWithEntries');
      expect(schema).toContain('recordedDays');
      expect(JSON.stringify(openApiDocument.paths['/api/orgs/{orgId}/weekly-review'])).toContain('weekly-review-5');
    });
  });

  it('can only say it was computed by the app and not stored', () => {
    const provenance = (patch: Record<string, unknown>) =>
      weeklyReviewSchema.safeParse({ ...review, provenance: { ...review.provenance, ...patch } }).success;
    expect(provenance({ source: 'model' })).toBe(false);
    expect(provenance({ persisted: true })).toBe(false);
    expect(weeklyReviewSchema.safeParse({ ...review, model: 'qwen3:8b' }).success).toBe(false);
  });

  it('refuses unknown statement codes and needs a Monday and an IANA zone', () => {
    expect(weeklyReviewSchema.safeParse({ ...review, statements: [{ code: 'sleep.every_day', text: 'x' }] }).success).toBe(false);
    expect(weeklyReviewQuerySchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-02' }).success).toBe(true);
    expect(weeklyReviewQuerySchema.safeParse({ timeZone: 'Europe/Warsaw', weekStart: '2026-11-03' }).success).toBe(false);
    expect(weeklyReviewQuerySchema.safeParse({ timeZone: 'UTC+1', weekStart: '2026-11-02' }).success).toBe(false);
  });

  it('is documented in OpenAPI', () => {
    expect(openApiDocument.paths['/api/orgs/{orgId}/weekly-review'].get.responses['200']).toBeDefined();
    expect(openApiDocument.components.schemas.WeeklyReview).toBeDefined();
  });
});
