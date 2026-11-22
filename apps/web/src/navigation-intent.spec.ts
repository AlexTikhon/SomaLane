import { describe, expect, it } from 'vitest';

import {
  afterHistoryIntentApplied,
  checkInIntentOf,
  inScope,
  mealIntentDateOf,
  navigationFor,
  navigationFromReview,
  navigationFromTrendsRow,
  primaryNavigation,
  secondaryNavigation,
  START_VIEW,
} from './navigation-intent.js';

const SCOPE = '0|user-a|org-a';

describe('application navigation (release step 3)', () => {
  it('starts on Today and leads with the primary journey', () => {
    expect(START_VIEW).toBe('today');
    expect(primaryNavigation.map((entry) => entry.view)).toEqual(['today', 'review', 'trends']);
  });

  it('keeps every other view reachable, exactly once, in two named groups', () => {
    expect(secondaryNavigation.map((group) => [group.label, group.entries.map((entry) => entry.label)])).toEqual([
      ['Records', ['Check-in', 'Meal log', 'Activity']],
      ['Runs', ['Runner', 'Coach', 'Archive']],
    ]);
    const views = [...primaryNavigation, ...secondaryNavigation.flatMap((group) => group.entries)].map((entry) => entry.view);
    expect(new Set(views).size).toBe(views.length);
    expect([...views].sort()).toEqual(['activity', 'archive', 'checkin', 'coach', 'meals', 'review', 'runner', 'today', 'trends']);
  });
});

describe('Today navigation', () => {
  it('opens the check-in and movement editors of the Check-in tab with the selected date', () => {
    expect(navigationFor({ kind: 'check-in', localDate: '2026-11-05' }, SCOPE)).toEqual({
      editor: { localDate: '2026-11-05', scope: SCOPE, section: 'check-in' },
      view: 'checkin',
    });
    expect(navigationFor({ kind: 'movement', localDate: '2026-11-04' }, SCOPE)).toEqual({
      editor: { localDate: '2026-11-04', scope: SCOPE, section: 'movement' },
      view: 'checkin',
    });
  });

  it('opens the Meal log on the selected date, and keeps its intent away from the Check-in tab (ADR-0083)', () => {
    const next = navigationFor({ kind: 'meals', localDate: '2026-11-03' }, SCOPE);
    expect(next).toEqual({ editor: { localDate: '2026-11-03', scope: SCOPE, section: 'meals' }, view: 'meals' });
    expect(checkInIntentOf(next.editor)).toBeUndefined();
    expect(mealIntentDateOf(next.editor)).toBe('2026-11-03');
    const checkIn = navigationFor({ kind: 'movement', localDate: '2026-11-04' }, SCOPE).editor;
    expect(checkInIntentOf(checkIn)).toEqual({ localDate: '2026-11-04', section: 'movement' });
    expect(mealIntentDateOf(checkIn)).toBeNull();
    expect(checkInIntentOf(null)).toBeUndefined();
    expect(mealIntentDateOf(null)).toBeNull();
  });

  it('opens Trends with the selected date as the end of its range, scoped, and without an editor intent (ADR-0084)', () => {
    const next = navigationFor({ kind: 'trends', localDate: '2026-11-02' }, SCOPE);
    expect(next).toEqual({ editor: null, trendsEnd: { localDate: '2026-11-02', scope: SCOPE }, view: 'trends' });
    expect(inScope(next.trendsEnd ?? null, SCOPE)).toEqual({ localDate: '2026-11-02', scope: SCOPE });
    expect(inScope(next.trendsEnd ?? null, '0|user-b|org-a')).toBeNull();
    expect(inScope({ metric: 'steps' as const, scope: SCOPE }, '0|user-a|org-b')).toBeNull();
  });

  it('opens the Activity history on the overview’s date, zone and source, scoped, without an editor intent (ADR-0088)', () => {
    for (const source of ['manual', 'gpx', 'recorded_run'] as const) {
      const next = navigationFor({ kind: 'history', localDate: '2026-03-29', source, timeZone: 'Europe/Warsaw' }, SCOPE);
      expect(next).toEqual({
        editor: null,
        history: { localDate: '2026-03-29', scope: SCOPE, source, timeZone: 'Europe/Warsaw' },
        view: 'activity',
      });
      expect(inScope(next.history ?? null, SCOPE)).toEqual(next.history);
      for (const other of ['1|user-a|org-a', '0|user-b|org-a', '0|user-a|org-b', null]) {
        expect(inScope(next.history ?? null, other), String(other)).toBeNull();
      }
    }
    // The plain Activities action carries no history intent: the whole history opens.
    expect(navigationFor({ kind: 'activities' }, SCOPE).history).toBeUndefined();
  });

  it('opens Activities and Runner without any intent', () => {
    expect(navigationFor({ kind: 'activities' }, SCOPE)).toEqual({ editor: null, view: 'activity' });
    expect(navigationFor({ kind: 'runner' }, SCOPE)).toEqual({ editor: null, view: 'runner' });
  });

  it('applies an intent or a kept date only under the scope it was made in', () => {
    const kept = { localDate: '2026-11-05', scope: SCOPE };
    expect(inScope(kept, SCOPE)).toBe(kept);
    for (const other of ['1|user-a|org-a', '0|user-b|org-a', '0|user-a|org-b', null]) {
      expect(inScope(kept, other), String(other)).toBeNull();
    }
    expect(inScope(null, SCOPE)).toBeNull();
  });

  it('opens the Weekly review view on the week of Today or an answer, and Trends on its source and type (ADR-0094)', () => {
    const review = navigationFor({ kind: 'weekly-review', weekStart: '2026-11-09' }, SCOPE);
    // Its own view now (release step 3), with the week kept for it under this scope; no Check-in editor is involved.
    expect(review).toEqual({ editor: null, reviewWeek: { localDate: '2026-11-09', scope: SCOPE }, view: 'review' });
    expect(checkInIntentOf(review.editor)).toBeUndefined();
    expect(mealIntentDateOf(review.editor)).toBeNull();
    for (const other of ['1|user-a|org-a', '0|user-b|org-a', '0|user-a|org-b', null]) {
      expect(inScope(review.reviewWeek ?? null, other), String(other)).toBeNull();
    }
    expect(navigationFor({ kind: 'activity-trends', localDate: '2026-11-17', source: 'gpx', type: 'ride' }, SCOPE)).toEqual({
      editor: null,
      trendsActivity: { measure: 'count', scope: SCOPE, source: 'gpx', type: 'ride' },
      trendsEnd: { localDate: '2026-11-17', scope: SCOPE },
      view: 'trends',
    });
  });

  it('opens the Meal log from a Trends nutrition row with a scoped way back to the range and series (ADR-0096)', () => {
    const next = navigationFromTrendsRow('2026-11-02', { endDate: '2026-11-09', metric: 'proteinG' }, SCOPE);
    expect(next).toEqual({
      editor: { localDate: '2026-11-02', scope: SCOPE, section: 'meals' },
      trendsReturn: { endDate: '2026-11-09', metric: 'proteinG', scope: SCOPE },
      view: 'meals',
    });
    expect(mealIntentDateOf(next.editor)).toBe('2026-11-02');
    expect(checkInIntentOf(next.editor)).toBeUndefined();
    // Never under another session, person or organization.
    expect(inScope(next.trendsReturn, SCOPE)).toBe(next.trendsReturn);
    for (const other of ['1|user-a|org-a', '0|user-b|org-a', '0|user-a|org-b']) expect(inScope(next.trendsReturn, other)).toBeNull();
    expect(inScope(next.trendsReturn, null)).toBeNull();
  });

  it('opens Trends from the Weekly review on the end date it names, scoped, without touching the kept series', () => {
    expect(navigationFromReview('2026-11-15', SCOPE)).toEqual({ trendsEnd: { localDate: '2026-11-15', scope: SCOPE }, view: 'trends' });
    expect(inScope(navigationFromReview('2026-11-15', SCOPE).trendsEnd, '0|user-a|org-b')).toBeNull();
  });

  it('consumes a history intent once applied, and never a newer one, even for the same day (ADR-0088)', () => {
    const action = { kind: 'history', localDate: '2026-03-29', source: 'manual', timeZone: 'Europe/Warsaw' } as const;
    const first = navigationFor(action, SCOPE).history!;
    expect(afterHistoryIntentApplied(first, first)).toBeNull();
    // Reported twice (StrictMode's second effect run): still consumed.
    expect(afterHistoryIntentApplied(afterHistoryIntentApplied(first, first), first)).toBeNull();
    // A late report of the first application after a new Today action leaves the new intent in place.
    const second = navigationFor(action, SCOPE).history!;
    expect(afterHistoryIntentApplied(second, first)).toBe(second);
    expect(afterHistoryIntentApplied(null, first)).toBeNull();
  });
});
