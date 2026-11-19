import {
  dataQuestionAnswerSchema,
  type ActivityTrends,
  type ActivityTrendsQuery,
  type DailyOverview,
  type DataQuestionPlan,
  type WeeklyReview,
} from '@running-tracker/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  activityTrendsComparisonWindowOf,
  buildActivityTrendsComparison,
  type ActivityTrendsActivityComparisonRow,
} from '../activity-trends/activity-trends-service.js';
import { buildDailyOverview, localDayInterval } from '../daily-overview/daily-overview-service.js';
import { aggregateWeek, resolveWeekWindow } from '../insights/weekly-aggregate.js';
import { buildWeeklyReview, reviewDetailOf } from '../insights/weekly-review.js';
import { DataQuestionExecutor, type DataQuestionReaders } from './data-question-executor.js';

// The executor of a reviewed plan (ADR-0094): exactly one allowlisted service read with the plan's own dates and zone,
// and an answer made only of that service's fields. The services here return real DTOs built by their own builders;
// the integration test proves the same against PostgreSQL and the services' own HTTP answers.

const WARSAW = 'Europe/Warsaw';
const session = { userId: '11111111-1111-4111-8111-111111111111' };
const orgId = '22222222-2222-4222-8222-222222222222';
const version = 'data-question-1' as const;

const emptyMetric = { recorded: 0, total: null };

function overviewOf(localDate: string, meals: { count: number; energy: { recorded: number; total: string | null } }): DailyOverview {
  return buildDailyOverview({
    computedAt: '2026-11-18T10:00:00.000Z',
    dayRecords: { check_in: null, movement: { activeEnergyKcal: '0', source: 'manual', steps: 0, timeZone: WARSAW } },
    interval: localDayInterval(localDate, WARSAW),
    localDate,
    meals: { carbohydrate_g: emptyMetric, count: meals.count, energy_kcal: meals.energy, fat_g: emptyMetric, protein_g: emptyMetric },
    started: { activities: [], gps_runs: { count: 0, currentDistanceM: null, withCurrentDistance: 0 }, gpx_activities: [], tcx_activities: [] },
    timeZone: WARSAW,
    today: '2026-11-18',
  });
}

function reviewOf(weekStart: string): WeeklyReview {
  const window = resolveWeekWindow({ checkIns: [], requestTimeZone: WARSAW, weekStart });
  const aggregate = aggregateWeek({ activities: [], checkIns: [], gpsRuns: [], todayLocalDate: '2026-11-18', window });
  return buildWeeklyReview({
    aggregate,
    computedAt: '2026-11-18T10:00:00.000Z',
    detail: reviewDetailOf({ activities: [], checkIns: [], window }),
    imported: [],
    meals: [
      {
        daysWithEntries: 1,
        localDate: weekStart,
        loggedEntries: 2,
        metrics: {
          carbohydrateG: { days: 0, entries: 0, totalTenths: null },
          energyKcal: { days: 1, entries: 1, totalTenths: 0 },
          fatG: { days: 0, entries: 0, totalTenths: null },
          proteinG: { days: 1, entries: 1, totalTenths: 125 },
        },
      },
      {
        daysWithEntries: 1,
        localDate: null,
        loggedEntries: 2,
        metrics: {
          carbohydrateG: { days: 0, entries: 0, totalTenths: null },
          energyKcal: { days: 1, entries: 1, totalTenths: 0 },
          fatG: { days: 0, entries: 0, totalTenths: null },
          proteinG: { days: 1, entries: 1, totalTenths: 125 },
        },
      },
    ],
    movement: [{ activeEnergyTenths: null, localDate: weekStart, source: 'manual', steps: 4200, timeZone: WARSAW }],
    tcxImported: [],
  });
}

type Row = ActivityTrendsActivityComparisonRow;
const none = { count_percent_tenths: null, distance_percent_tenths: null, duration_percent_tenths: null };
const periodRow = (kind: 'current' | 'previous', count: number, duration: string, distance: string, days: number): Row => ({
  ...none,
  count,
  day_number: null,
  days_with_distance: days,
  days_with_entries: days,
  distance_m: distance,
  duration_s: duration,
  row_kind: kind,
  with_distance: count,
});

function comparisonOf(query: ActivityTrendsQuery, today: string): ActivityTrends {
  return buildActivityTrendsComparison({
    computedAt: '2026-11-18T10:00:00.000Z',
    query,
    rows: {
      activities: [
        { ...periodRow('current', 3, '5400', '30000', 1), day_number: 3, days_with_distance: null, days_with_entries: null, row_kind: 'day' },
        periodRow('current', 3, '5400', '30000', 1),
        periodRow('previous', 2, '3600', '24000', 1),
        {
          ...none,
          count: 1,
          count_percent_tenths: '500',
          day_number: null,
          days_with_distance: null,
          days_with_entries: null,
          distance_m: '6000',
          distance_percent_tenths: '250',
          duration_percent_tenths: '500',
          duration_s: '1800',
          row_kind: 'change',
          with_distance: null,
        },
      ],
    },
    timeZone: WARSAW,
    today,
    window: activityTrendsComparisonWindowOf(query.endDate, WARSAW),
  });
}

function readers() {
  return {
    overview: {
      read: vi.fn<DataQuestionReaders['overview']['read']>((_s, _o, localDate) => Promise.resolve(overviewOf(localDate, { count: 2, energy: { recorded: 1, total: '0' } }))),
    },
    review: { read: vi.fn<DataQuestionReaders['review']['read']>((_s, _o, query) => Promise.resolve(reviewOf(query.weekStart))) },
    trends: { read: vi.fn<DataQuestionReaders['trends']['read']>((_s, _o, query) => Promise.resolve(comparisonOf(query, '2026-11-18'))) },
  };
}

const calls = (spy: { read: { mock: { calls: unknown[] } } }) => spy.read.mock.calls.length;

describe('executing a reviewed plan', () => {
  it('a day plan reads the daily overview once, for its own date and zone, and answers it unchanged', async () => {
    const r = readers();
    const plan: DataQuestionPlan = { operation: 'day_overview', period: { localDate: '2026-11-03', symbol: 'today' }, timeZone: WARSAW, version };
    const answer = await new DataQuestionExecutor(r).answer(session, orgId, plan);
    expect([calls(r.overview), calls(r.review), calls(r.trends)]).toEqual([1, 0, 0]);
    expect(r.overview.read).toHaveBeenCalledWith(session, orgId, '2026-11-03', { timeZone: WARSAW });
    expect(dataQuestionAnswerSchema.parse(answer)).toEqual(answer);
    if (answer.operation !== 'day_overview') throw new Error('expected a day answer');
    // The reviewed "today" is executed as its reviewed date, never re-resolved.
    expect(answer.plan).toEqual(plan);
    expect(answer.result).toEqual(await r.overview.read.mock.results[0]!.value);
    // A recorded zero stays zero; an unrecorded metric stays unknown.
    expect(answer.result.movement).toMatchObject({ activeEnergyKcal: 0, recorded: true, steps: 0 });
    expect(answer.result.meals.energyKcal).toEqual({ recordedEntries: 1, total: 0 });
    expect(answer.result.meals.proteinG).toEqual({ recordedEntries: 0, total: null });
    expect(answer.provenance).toEqual({
      answerVersion: version,
      computedAt: '2026-11-18T10:00:00.000Z',
      persisted: false,
      service: 'daily_overview',
      serviceVersion: answer.result.provenance.overviewVersion,
    });
  });

  it('a week plan reads the weekly review once and keeps only the focus part', async () => {
    const r = readers();
    const plan: DataQuestionPlan = {
      focus: 'nutrition',
      operation: 'weekly_review',
      period: { symbol: 'previous_week', weekEnd: '2026-11-15', weekStart: '2026-11-09' },
      timeZone: WARSAW,
      version,
    };
    const answer = await new DataQuestionExecutor(r).answer(session, orgId, plan);
    expect([calls(r.overview), calls(r.review), calls(r.trends)]).toEqual([0, 1, 0]);
    expect(r.review.read).toHaveBeenCalledWith(session, orgId, { timeZone: WARSAW, weekStart: '2026-11-09' });
    const review = (await r.review.read.mock.results[0]!.value) as WeeklyReview;
    if (answer.operation !== 'weekly_review' || answer.result.focus !== 'nutrition') throw new Error('expected nutrition');
    expect(answer.result.meals).toEqual(review.meals);
    expect(answer.result.week).toEqual(review.week);
    expect(Object.keys(answer.result).sort()).toEqual(['focus', 'meals', 'statements', 'week']);
    expect(answer.result.statements.every((s) => s.code.startsWith('meals.') || s.code.startsWith('week.'))).toBe(true);
    expect(answer.result.meals.energyKcal.total).toBe(0);
    expect(answer.provenance.service).toBe('weekly_review');
    expect(answer.provenance.serviceVersion).toBe(review.provenance.reviewVersion);
  });

  it('the movement and overview focuses carry their own parts and never the meal part', async () => {
    const r = readers();
    const base = { operation: 'weekly_review', period: { symbol: 'selected_week', weekEnd: '2026-11-08', weekStart: '2026-11-02' }, timeZone: WARSAW, version } as const;
    const movement = await new DataQuestionExecutor(r).answer(session, orgId, { ...base, focus: 'movement' });
    const overview = await new DataQuestionExecutor(r).answer(session, orgId, { ...base, focus: 'overview' });
    if (movement.operation !== 'weekly_review' || movement.result.focus !== 'movement') throw new Error('expected movement');
    if (overview.operation !== 'weekly_review' || overview.result.focus !== 'overview') throw new Error('expected overview');
    expect(movement.result.movement.days[0]).toMatchObject({ recorded: true, steps: 4200 });
    expect('meals' in movement.result).toBe(false);
    expect(Object.keys(overview.result).sort()).toEqual(['coverage', 'dataGaps', 'focus', 'importedActivities', 'statements', 'tcxImportedActivities', 'week']);
  });

  it('a comparison plan reads the activity trends once with previous_period, for its one source and type', async () => {
    const r = readers();
    const plan: DataQuestionPlan = {
      compare: 'previous_period',
      operation: 'activity_comparison',
      period: { endDate: '2026-11-11', previousEndDate: '2026-10-14', previousStartDate: '2026-09-17', startDate: '2026-10-15', symbol: 'selected_date' },
      source: 'manual',
      timeZone: WARSAW,
      type: 'run',
      version,
    };
    const answer = await new DataQuestionExecutor(r).answer(session, orgId, plan);
    expect([calls(r.overview), calls(r.review), calls(r.trends)]).toEqual([0, 0, 1]);
    expect(r.trends.read).toHaveBeenCalledWith(session, orgId, { compare: 'previous_period', endDate: '2026-11-11', source: 'manual', timeZone: WARSAW, type: 'run' });
    const trends = (await r.trends.read.mock.results[0]!.value) as ActivityTrends;
    if (answer.operation !== 'activity_comparison' || answer.result.source !== 'manual' || trends.source !== 'manual') throw new Error('expected manual');
    expect(answer.result.comparison).toEqual(trends.comparison);
    expect(answer.result.summary).toEqual(trends.summary);
    expect(answer.result.range).toEqual(trends.range);
    expect('days' in answer.result).toBe(false);
    expect(answer.result.comparison.metrics.enteredDuration.change).toMatchObject({ absolute: 1800, percent: 50, status: 'available' });
    expect(answer.provenance).toMatchObject({ service: 'activity_trends', serviceVersion: trends.provenance.policyVersion });
  });

  it('keeps the existing suppression reasons of a comparison whose range includes today', async () => {
    const r = readers();
    r.trends.read.mockImplementation((_s, _o, query) => Promise.resolve(comparisonOf(query, query.endDate)));
    const plan: DataQuestionPlan = {
      compare: 'previous_period',
      operation: 'activity_comparison',
      period: { endDate: '2026-11-18', previousEndDate: '2026-10-21', previousStartDate: '2026-09-24', startDate: '2026-10-22', symbol: 'today' },
      source: 'manual',
      timeZone: WARSAW,
      type: 'run',
      version,
    };
    const answer = await new DataQuestionExecutor(r).answer(session, orgId, plan);
    if (answer.operation !== 'activity_comparison') throw new Error('expected comparison');
    expect(answer.result.comparison.periodReasons).toEqual(['current_period_in_progress']);
    expect(answer.result.comparison.metrics.count.change).toEqual({ reasons: ['current_period_in_progress'], status: 'unavailable' });
  });

  it('propagates a service refusal unchanged and reads nothing else', async () => {
    const r = readers();
    const refusal = new Error('the week cannot start after today');
    r.review.read.mockRejectedValue(refusal);
    const plan: DataQuestionPlan = {
      focus: 'overview',
      operation: 'weekly_review',
      period: { symbol: 'selected_week', weekEnd: '2026-11-08', weekStart: '2026-11-02' },
      timeZone: WARSAW,
      version,
    };
    await expect(new DataQuestionExecutor(r).answer(session, orgId, plan)).rejects.toBe(refusal);
    expect([calls(r.overview), calls(r.review), calls(r.trends)]).toEqual([0, 1, 0]);
  });

  it('refuses a service answer that is not the one the plan asked for', async () => {
    const r = readers();
    r.overview.read.mockResolvedValue(overviewOf('2026-11-04', { count: 0, energy: emptyMetric }));
    const plan: DataQuestionPlan = { operation: 'day_overview', period: { localDate: '2026-11-03', symbol: 'selected_date' }, timeZone: WARSAW, version };
    await expect(new DataQuestionExecutor(r).answer(session, orgId, plan)).rejects.toThrow();
  });
});
