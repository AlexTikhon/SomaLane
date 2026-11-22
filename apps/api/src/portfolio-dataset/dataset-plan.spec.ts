import {
  addLocalDays,
  createActivityRequestSchema,
  createMealRequestSchema,
  ingestPointsRequestSchema,
  previousActivityTrendsPeriodOf,
  putDailyMetricsRequestSchema,
  putDailyMovementRequestSchema,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { readGpxActivity } from '../activities/gpx-activity.js';
import { readTcxActivity } from '../activities/tcx-activity.js';
import { localDateOf } from '../runs/run-search-period.js';
import {
  assertAnchorCompleted,
  defaultAnchorDate,
  expectedManualSide,
  planDataset,
  PORTFOLIO_DEFAULT_SEED,
  resolveParameters,
  reviewWeekOf,
  UNLOGGED_OFFSETS,
  zonedInstantMs,
  type DatasetParameters,
  type DatasetPlan,
} from './dataset-plan.js';

const autumn: DatasetParameters = { anchorDate: '2026-11-21', seed: PORTFOLIO_DEFAULT_SEED, timeZone: 'Europe/Warsaw' };
const spring: DatasetParameters = { anchorDate: '2026-04-12', seed: 'spring-check', timeZone: 'Europe/Warsaw' };

/** Every planned instant with the date and local hour it must fall on. */
function plannedInstants(plan: DatasetPlan): Array<{ instant: string; localDate: string }> {
  return [
    ...plan.manualActivities.map((item) => ({ instant: item.request.startedAt, localDate: item.localDate })),
    ...plan.imports.map((item) => ({ instant: item.expected.startedAt, localDate: item.localDate })),
    ...plan.runs.map((item) => ({ instant: item.startedAt, localDate: item.localDate })),
    ...plan.runs.map((item) => ({ instant: item.batches.at(-1)!.at(-1)!.recordedAt, localDate: item.localDate })),
  ];
}

describe('portfolio dataset planner', () => {
  it('is a pure function of version, seed, anchor and zone', () => {
    expect(planDataset(autumn)).toEqual(planDataset({ ...autumn }));
    expect(JSON.stringify(planDataset(autumn))).toBe(JSON.stringify(planDataset(autumn)));
    const otherSeed = planDataset({ ...autumn, seed: 'another-seed' });
    expect(otherSeed.dates).toEqual(planDataset(autumn).dates);
    expect(otherSeed.checkIns.map((item) => item.request.weightKg)).not.toEqual(planDataset(autumn).checkIns.map((item) => item.request.weightKg));
    expect(otherSeed.manualActivities.map((item) => item.activityId)).not.toEqual(planDataset(autumn).manualActivities.map((item) => item.activityId));
    // The operation keys depend on the anchor too, so a different anchor never reuses a key.
    const otherAnchor = planDataset({ ...autumn, anchorDate: '2026-11-20' });
    const keys = new Set(planDataset(autumn).meals.map((meal) => meal.request.idempotencyKey));
    expect(otherAnchor.meals.filter((meal) => keys.has(meal.request.idempotencyKey))).toEqual([]);
  });

  it('covers exactly 56 consecutive local dates: the 28-date range ending on the anchor and the 28 before it', () => {
    for (const parameters of [autumn, spring, { ...autumn, anchorDate: '2028-03-01' }]) {
      const plan = planDataset(parameters);
      expect(plan.dates).toHaveLength(56);
      plan.dates.forEach((date, index) => expect(date).toBe(addLocalDays(parameters.anchorDate, index - 55)));
      expect(plan.ranges.current).toEqual({ endDate: parameters.anchorDate, startDate: addLocalDays(parameters.anchorDate, -27) });
      expect(plan.ranges.previous).toEqual({ endDate: addLocalDays(parameters.anchorDate, -28), startDate: addLocalDays(parameters.anchorDate, -55) });
      const contract = previousActivityTrendsPeriodOf(parameters.anchorDate).period!;
      expect(plan.ranges.previous).toEqual({ endDate: contract.endDate, startDate: contract.startDate });
      const all = [...plan.checkIns, ...plan.movement, ...plan.meals, ...plan.manualActivities, ...plan.imports, ...plan.runs];
      expect(all.every((record) => record.localDate >= plan.dates[0]! && record.localDate <= parameters.anchorDate)).toBe(true);
    }
  });

  it.each([
    ['autumn (2026-10-25, CEST to CET)', autumn, '2026-10-25'],
    ['spring (2026-03-29, CET to CEST)', spring, '2026-03-29'],
    ['New York (2026-11-01)', { anchorDate: '2026-11-20', seed: 'ny', timeZone: 'America/New_York' }, '2026-11-01'],
  ] as const)('places every instant on its local date across a daylight-saving change: %s', (_name, parameters, transition) => {
    const plan = planDataset(parameters);
    expect(plan.dates).toContain(transition);
    for (const { instant, localDate } of plannedInstants(plan)) expect(localDateOf(Date.parse(instant), parameters.timeZone)).toBe(localDate);
    // Wall-clock times keep their local hour on both sides of the change (never "start of day + N hours").
    const before = zonedInstantMs(addLocalDays(transition, -1), 7, 0, parameters.timeZone);
    const after = zonedInstantMs(addLocalDays(transition, 1), 7, 0, parameters.timeZone);
    expect(Math.abs(after - before - 2 * 86_400_000)).toBe(3_600_000);
  });

  it('refuses a wall time the zone skips', () => {
    expect(() => zonedInstantMs('2026-03-29', 2, 30, 'Europe/Warsaw')).toThrow(/does not exist/u);
    expect(new Date(zonedInstantMs('2026-03-29', 7, 0, 'Europe/Warsaw')).toISOString()).toBe('2026-03-29T05:00:00.000Z');
    expect(new Date(zonedInstantMs('2026-10-25', 7, 0, 'Europe/Warsaw')).toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });

  it('only plans requests the contracts accept', () => {
    const plan = planDataset(autumn);
    for (const item of plan.checkIns) expect(putDailyMetricsRequestSchema.safeParse(item.request).success).toBe(true);
    for (const item of plan.movement) expect(putDailyMovementRequestSchema.safeParse(item.request).success).toBe(true);
    for (const item of plan.manualActivities) expect(createActivityRequestSchema.safeParse(item.request).success).toBe(true);
    for (const item of plan.meals) expect(createMealRequestSchema.safeParse(item.request).success).toBe(true);
    for (const run of plan.runs) {
      for (const batch of run.batches) expect(ingestPointsRequestSchema.safeParse({ points: batch }).success).toBe(true);
      expect(run.batches.flat().map((point) => Number(point.seq))).toEqual(Array.from({ length: run.pointCount }, (_, index) => index + 1));
    }
  });

  it('has deliberate gaps, missing values, recorded zeros, title-only and partial meals', () => {
    const plan = planDataset(autumn);
    const unlogged = [...UNLOGGED_OFFSETS].map((k) => addLocalDays(autumn.anchorDate, -k));
    expect(plan.gaps.unlogged).toEqual(unlogged.sort());
    expect(plan.gaps.unlogged.some((date) => date >= plan.ranges.current.startDate)).toBe(true);
    expect(plan.gaps.unlogged.some((date) => date <= plan.ranges.previous.endDate)).toBe(true);
    expect(plan.gaps.checkIn.length).toBeGreaterThan(plan.gaps.unlogged.length);
    expect(plan.gaps.movement.length).toBeGreaterThan(plan.gaps.unlogged.length);
    expect(plan.gaps.meals.length).toBeGreaterThan(plan.gaps.unlogged.length);
    expect(plan.checkIns.some((item) => item.request.weightKg === null)).toBe(true);
    expect(plan.checkIns.some((item) => item.request.sleepMinutes === null)).toBe(true);
    expect(plan.checkIns.some((item) => typeof item.request.note === 'string')).toBe(true);
    expect(plan.movement.some((item) => item.request.steps === 0 && item.request.activeEnergyKcal === 0)).toBe(true);
    expect(plan.movement.some((item) => item.request.steps === null)).toBe(true);
    expect(plan.movement.some((item) => item.request.activeEnergyKcal === null)).toBe(true);
    const values = (meal: DatasetPlan['meals'][number]) => [meal.request.energyKcal, meal.request.proteinG, meal.request.carbohydrateG, meal.request.fatG];
    expect(plan.meals.some((meal) => values(meal).every((value) => typeof value === 'number' && value > 0))).toBe(true);
    expect(plan.meals.some((meal) => values(meal).every((value) => value === 0))).toBe(true);
    expect(plan.meals.some((meal) => values(meal).every((value) => value === null))).toBe(true);
    expect(plan.meals.some((meal) => values(meal).some((value) => value === null) && values(meal).some((value) => typeof value === 'number'))).toBe(true);
  });

  it('gives manual runs a defined comparison and leaves other sources partial', () => {
    const plan = planDataset(autumn);
    const current = expectedManualSide(plan, 'run', plan.ranges.current);
    const previous = expectedManualSide(plan, 'run', plan.ranges.previous);
    for (const side of [current, previous]) {
      expect(side.count).toBeGreaterThan(0);
      expect(side.withDistance).toBe(side.count);
    }
    expect(current.count).not.toBe(previous.count);
    expect(expectedManualSide(plan, 'strength', plan.ranges.current).withDistance).toBe(0);
    expect(expectedManualSide(plan, 'walk', plan.ranges.previous).count).toBe(0);
    expect(plan.imports.filter((item) => item.kind === 'gpx').every((item) => item.localDate >= plan.ranges.current.startDate)).toBe(true);
    expect(plan.imports.filter((item) => item.kind === 'tcx').map((item) => item.localDate >= plan.ranges.current.startDate)).toEqual([false, true]);
    expect(plan.runs.filter((run) => run.localDate >= plan.ranges.current.startDate)).toHaveLength(3);
    expect(plan.runs.filter((run) => run.localDate <= plan.ranges.previous.endDate)).toHaveLength(3);
    // Today (the anchor) has a check-in, movement, a manual activity, meals and a finished run shared with the coach.
    const anchor = autumn.anchorDate;
    for (const records of [plan.checkIns, plan.movement, plan.manualActivities, plan.meals, plan.runs]) {
      expect(records.some((record) => record.localDate === anchor)).toBe(true);
    }
    expect(plan.runs.find((run) => run.localDate === anchor)!.share).toEqual({ canReadHistory: true, canReadLive: false, granteeUserId: plan.identities.coach });
  });

  it('builds synthetic GPX and TCX files the real importers read, with the planned summaries', () => {
    const plan = planDataset(autumn);
    for (const item of plan.imports) {
      const bytes = Buffer.from(item.document, 'utf8');
      const parsed = item.kind === 'gpx' ? readGpxActivity(bytes, item.importedAtMs) : readTcxActivity(bytes, item.importedAtMs);
      const durationS = 'elapsedDurationS' in parsed.summary ? parsed.summary.elapsedDurationS : parsed.summary.reportedDurationS;
      expect(parsed.summary.startedAt).toBe(item.expected.startedAt);
      expect(durationS).toBe(item.expected.durationS);
      expect(Math.abs(parsed.summary.distanceM - item.expected.distanceM)).toBeLessThanOrEqual(item.expected.distanceToleranceM);
      expect(item.document).toContain('synthetic');
    }
  });

  it('stays a quick demo: bounded volumes', () => {
    const plan = planDataset(autumn);
    expect(plan.meals.length).toBeLessThan(160);
    expect(plan.manualActivities.length).toBeLessThan(40);
    expect(plan.runs.reduce((sum, run) => sum + run.pointCount, 0)).toBeLessThan(3_000);
    expect(plan.imports.every((item) => item.document.length < 100_000)).toBe(true);
  });

  it('defaults to the last completed date and refuses unfinished anchors and bad parameters', () => {
    const now = Date.parse('2026-11-22T00:30:00Z'); // 01:30 on 2026-11-22 in Warsaw, still 2026-11-21 in UTC
    expect(defaultAnchorDate(now, 'Europe/Warsaw')).toBe('2026-11-21');
    expect(resolveParameters({}, now)).toEqual({ anchorDate: '2026-11-21', seed: PORTFOLIO_DEFAULT_SEED, timeZone: 'Europe/Warsaw' });
    expect(() => assertAnchorCompleted('2026-11-22', 'Europe/Warsaw', now)).toThrow(/completed date/u);
    expect(() => resolveParameters({ anchorDate: '2026-11-23' }, now)).toThrow(/completed date/u);
    expect(() => resolveParameters({ anchorDate: '2026-02-30' }, now)).toThrow(/calendar date/u);
    expect(() => resolveParameters({ anchorDate: '2000-01-10' }, now)).toThrow(/2000-01-01/u);
    expect(() => resolveParameters({ seed: 'with space' }, now)).toThrow(/seed/u);
    expect(() => resolveParameters({ timeZone: 'Mars/Olympus' }, now)).toThrow(/time zone/u);
  });

  it('selects the last complete Monday-to-Sunday week for the weekly review', () => {
    expect(reviewWeekOf(planDataset(autumn))).toEqual({ end: '2026-11-15', start: '2026-11-09' });
    expect(reviewWeekOf(planDataset({ ...autumn, anchorDate: '2026-11-15' }))).toEqual({ end: '2026-11-15', start: '2026-11-09' });
  });
});
