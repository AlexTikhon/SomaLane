import { dataQuestionPlanSchema, type DataQuestionIntent } from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import { resolveDataQuestionPlan } from './data-question-plan.js';

const clockAt = (iso: string): Pick<Clock, 'utcNow'> => ({ utcNow: () => new Date(iso) });

const resolve = (intent: DataQuestionIntent, selectedDate: string, timeZone: string, now: string) =>
  resolveDataQuestionPlan(intent, { selectedDate, timeZone }, clockAt(now));

function refusal(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('resolving a symbolic intent into a plan', () => {
  it('uses the requested zone and the injected clock, never the host zone', () => {
    // 23:30 UTC on 18 November is already the 19th in Auckland and still the 18th in Los Angeles.
    const now = '2026-11-18T23:30:00.000Z';
    expect(resolve({ operation: 'day_overview', period: 'today' }, '2026-11-18', 'Pacific/Auckland', now).period).toEqual({
      localDate: '2026-11-19',
      symbol: 'today',
    });
    expect(resolve({ operation: 'day_overview', period: 'today' }, '2026-11-18', 'America/Los_Angeles', now).period).toEqual({
      localDate: '2026-11-18',
      symbol: 'today',
    });
    expect((resolve({ operation: 'day_overview', period: 'yesterday' }, '2026-11-18', 'Pacific/Auckland', now).period as { localDate: string }).localDate).toBe('2026-11-18');
  });

  it('keeps the selected date apart from today', () => {
    const plan = resolve({ operation: 'day_overview', period: 'selected_date' }, '2026-11-02', 'Europe/Warsaw', '2026-11-18T10:00:00.000Z');
    expect(plan).toEqual({ operation: 'day_overview', period: { localDate: '2026-11-02', symbol: 'selected_date' }, timeZone: 'Europe/Warsaw', version: 'data-question-1' });
    expect(dataQuestionPlanSchema.parse(plan)).toEqual(plan);
  });

  it('writes the zone in its canonical spelling', () => {
    expect(resolve({ operation: 'day_overview', period: 'today' }, '2026-11-18', 'europe/warsaw', '2026-11-18T10:00:00.000Z').timeZone).toBe('Europe/Warsaw');
  });

  it('resolves weeks Monday to Sunday in the requested zone, across a week boundary at local midnight', () => {
    // Sunday 22 November 23:30 UTC is Monday 23 November 00:30 in Warsaw: a new current week there, not in UTC.
    const now = '2026-11-22T23:30:00.000Z';
    const warsaw = resolve({ focus: 'movement', operation: 'weekly_review', period: 'current_week' }, '2026-11-22', 'Europe/Warsaw', now);
    expect(warsaw.period).toEqual({ symbol: 'current_week', weekEnd: '2026-11-29', weekStart: '2026-11-23' });
    const utc = resolve({ focus: 'movement', operation: 'weekly_review', period: 'current_week' }, '2026-11-22', 'UTC', now);
    expect(utc.period).toEqual({ symbol: 'current_week', weekEnd: '2026-11-22', weekStart: '2026-11-16' });
    const previous = resolve({ focus: 'nutrition', operation: 'weekly_review', period: 'previous_week' }, '2026-11-22', 'Europe/Warsaw', now);
    expect(previous.period).toEqual({ symbol: 'previous_week', weekEnd: '2026-11-22', weekStart: '2026-11-16' });
    const selected = resolve({ focus: 'overview', operation: 'weekly_review', period: 'selected_week' }, '2026-11-04', 'Europe/Warsaw', now);
    expect(selected.period).toEqual({ symbol: 'selected_week', weekEnd: '2026-11-08', weekStart: '2026-11-02' });
  });

  it('resolves dates around a daylight saving change by calendar, not by subtracting 24 hours', () => {
    // 8 March 2026, 12:30 in New York (after the spring-forward at 02:00): yesterday is the 7th.
    const spring = resolve({ operation: 'day_overview', period: 'yesterday' }, '2026-03-08', 'America/New_York', '2026-03-08T16:30:00.000Z');
    expect((spring.period as { localDate: string }).localDate).toBe('2026-03-07');
    // 1 November 2026, 00:30 in New York, before the fall-back hour repeats: today is the 1st, yesterday the 31st.
    const fall = resolve({ operation: 'day_overview', period: 'yesterday' }, '2026-11-01', 'America/New_York', '2026-11-01T04:30:00.000Z');
    expect((fall.period as { localDate: string }).localDate).toBe('2026-10-31');
  });

  it('states the comparison periods the activity trends read for the end date', () => {
    const plan = resolve({ operation: 'activity_comparison', period: 'yesterday', source: 'gpx', type: 'ride' }, '2026-11-18', 'Europe/Warsaw', '2026-11-18T10:00:00.000Z');
    expect(plan).toEqual({
      compare: 'previous_period',
      operation: 'activity_comparison',
      period: { endDate: '2026-11-17', previousEndDate: '2026-10-20', previousStartDate: '2026-09-23', startDate: '2026-10-21', symbol: 'yesterday' },
      source: 'gpx',
      timeZone: 'Europe/Warsaw',
      type: 'ride',
      version: 'data-question-1',
    });
  });

  it('refuses a selected date after today in the requested zone', () => {
    const error = refusal(() => resolve({ operation: 'day_overview', period: 'today' }, '2026-11-19', 'America/Los_Angeles', '2026-11-18T23:30:00.000Z'));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(error.details)).toContain('selectedDate');
  });

  it('refuses a resolved period before the earliest supported date', () => {
    const yesterday = refusal(() => resolve({ operation: 'day_overview', period: 'yesterday' }, '2000-01-01', 'UTC', '2000-01-01T10:00:00.000Z'));
    expect(yesterday.statusCode).toBe(400);
    expect(JSON.stringify(yesterday.details)).toContain('period');
    // 2000-01-01 is a Saturday: its week starts on 27 December 1999.
    const week = refusal(() => resolve({ focus: 'overview', operation: 'weekly_review', period: 'selected_week' }, '2000-01-01', 'UTC', '2000-01-05T10:00:00.000Z'));
    expect(week.statusCode).toBe(400);
  });
});
