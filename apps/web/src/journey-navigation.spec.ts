import { describe, expect, it } from 'vitest';

import {
  isCompletedWeek,
  isReviewWeekStart,
  openingReviewWeek,
  reviewWeekOptions,
  trendsActionLabel,
  trendsEndForWeek,
  weekContaining,
} from './journey-navigation.js';

// 2026-11-22 is a Sunday; its week is Monday 2026-11-16 .. Sunday 2026-11-22.
const SUNDAY_TODAY = '2026-11-22';
// 2026-11-18 is a Wednesday in the same week.
const WEDNESDAY_TODAY = '2026-11-18';

describe('Today → Weekly review: the week containing the selected date', () => {
  it('maps every day of a week to its Monday, across a month and a year boundary', () => {
    for (const day of ['2026-11-09', '2026-11-12', '2026-11-15']) expect(weekContaining(day, SUNDAY_TODAY)).toBe('2026-11-09');
    expect(weekContaining('2026-11-01', SUNDAY_TODAY)).toBe('2026-10-26');
    expect(weekContaining('2026-01-01', SUNDAY_TODAY)).toBe('2025-12-29');
    // Calendar arithmetic only: a daylight-saving change (25 Oct 2026 in Europe) does not move a date.
    expect(weekContaining('2026-10-25', SUNDAY_TODAY)).toBe('2026-10-19');
    expect(weekContaining('2026-10-26', SUNDAY_TODAY)).toBe('2026-10-26');
  });

  it('refuses a date the views would not accept: invalid, before 2000 or after today', () => {
    expect(weekContaining('2026-11-23', SUNDAY_TODAY)).toBeNull();
    expect(weekContaining('2026-02-30', SUNDAY_TODAY)).toBeNull();
    expect(weekContaining('1999-12-31', SUNDAY_TODAY)).toBeNull();
    expect(weekContaining('', SUNDAY_TODAY)).toBeNull();
  });

  it('refuses an allowed date whose Monday falls before 2000, and opens the first supported week from 3 Jan 2000', () => {
    // 1 and 2 Jan 2000 (Saturday, Sunday) are allowed daily dates, but their week starts on Monday 27 Dec 1999.
    expect(weekContaining('2000-01-01', SUNDAY_TODAY)).toBeNull();
    expect(weekContaining('2000-01-02', SUNDAY_TODAY)).toBeNull();
    expect(isReviewWeekStart('1999-12-27', SUNDAY_TODAY)).toBe(false);
    expect(weekContaining('2000-01-03', SUNDAY_TODAY)).toBe('2000-01-03');
    expect(weekContaining('2000-01-09', SUNDAY_TODAY)).toBe('2000-01-03');
  });
});

describe('a direct Weekly review opening', () => {
  it('uses the kept week when it is still a valid Monday, otherwise the current week (the existing default)', () => {
    expect(openingReviewWeek('2026-11-09', SUNDAY_TODAY)).toBe('2026-11-09');
    expect(openingReviewWeek('2025-06-02', SUNDAY_TODAY)).toBe('2025-06-02');
    expect(openingReviewWeek(null, SUNDAY_TODAY)).toBe('2026-11-16');
    expect(openingReviewWeek(null, WEDNESDAY_TODAY)).toBe('2026-11-16');
    // Not a Monday, a future week, or not a date: the default, never a guess.
    expect(openingReviewWeek('2026-11-10', SUNDAY_TODAY)).toBe('2026-11-16');
    expect(openingReviewWeek('2026-11-23', SUNDAY_TODAY)).toBe('2026-11-16');
    expect(openingReviewWeek('not-a-date', SUNDAY_TODAY)).toBe('2026-11-16');
  });

  it('accepts as a week start only a real Monday from 2000 to today', () => {
    expect(isReviewWeekStart('2026-11-16', SUNDAY_TODAY)).toBe(true);
    expect(isReviewWeekStart('2026-11-16', '2026-11-16')).toBe(true);
    expect(isReviewWeekStart('2026-11-23', SUNDAY_TODAY)).toBe(false);
    expect(isReviewWeekStart('2026-11-17', SUNDAY_TODAY)).toBe(false);
  });

  it('offers the recent weeks, and an older opened week as well', () => {
    const recent = reviewWeekOptions(null, SUNDAY_TODAY);
    expect(recent).toHaveLength(8);
    expect(recent[0]).toEqual({ label: 'This week: 16 Nov – 22 Nov 2026', weekStart: '2026-11-16' });
    expect(reviewWeekOptions('2026-11-09', SUNDAY_TODAY)).toEqual(recent);
    const older = reviewWeekOptions('2026-06-01', SUNDAY_TODAY);
    expect(older).toHaveLength(9);
    expect(older.at(-1)).toEqual({ label: 'Week: 1 Jun – 7 Jun 2026', weekStart: '2026-06-01' });
  });
});

describe('Weekly review → Trends: the end date', () => {
  it('ends on Sunday for a completed week', () => {
    expect(isCompletedWeek('2026-11-09', SUNDAY_TODAY)).toBe(true);
    expect(trendsEndForWeek('2026-11-09', SUNDAY_TODAY)).toBe('2026-11-15');
    expect(trendsEndForWeek('2025-12-29', SUNDAY_TODAY)).toBe('2026-01-04');
  });

  it('ends today for the current week, including on its Sunday, and never on a future date', () => {
    expect(isCompletedWeek('2026-11-16', WEDNESDAY_TODAY)).toBe(false);
    expect(trendsEndForWeek('2026-11-16', WEDNESDAY_TODAY)).toBe(WEDNESDAY_TODAY);
    expect(isCompletedWeek('2026-11-16', SUNDAY_TODAY)).toBe(false);
    expect(trendsEndForWeek('2026-11-16', SUNDAY_TODAY)).toBe(SUNDAY_TODAY);
    // Whatever the week, the end is never after today.
    for (const today of ['2026-11-16', WEDNESDAY_TODAY, SUNDAY_TODAY, '2026-11-23']) {
      expect(trendsEndForWeek('2026-11-16', today) <= today).toBe(true);
    }
  });

  it('names the end date it will use', () => {
    // The weekday may carry a comma, depending on the runtime's locale data (as in daily-checkin.spec.ts).
    const completed = trendsActionLabel('2026-11-09', SUNDAY_TODAY);
    expect(completed.aria).toMatch(/^Open 28-day trends ending on Sun,? 15 Nov 2026$/u);
    expect(completed.text).toMatch(/^28-day trends ending Sun,? 15 Nov 2026$/u);
    expect(completed.note).toBe('The range ends on this week’s Sunday.');
    const current = trendsActionLabel('2026-11-16', WEDNESDAY_TODAY);
    expect(current.aria).toMatch(/^Open 28-day trends ending on Wed,? 18 Nov 2026$/u);
    expect(current.text).toMatch(/^28-day trends ending Wed,? 18 Nov 2026$/u);
    expect(current.note).toBe('This week is still in progress, so the range ends today.');
  });
});
