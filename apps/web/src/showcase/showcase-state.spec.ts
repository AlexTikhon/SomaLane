import { describe, expect, it, vi } from 'vitest';

import { initialShowcaseState, loadShowcaseSnapshot, offeredWeekOf, showcaseReducer, trendsEndOfWeek, type ShowcaseAction, type ShowcaseState } from './showcase-state.js';
import { committedSnapshot, snapshotJson } from './showcase-test-support.js';

const snapshot = committedSnapshot();
const run = (actions: ShowcaseAction[], from: ShowcaseState = initialShowcaseState(snapshot)) =>
  actions.reduce((state, action) => showcaseReducer(snapshot, state, action), from);

describe('the showcase navigation over the snapshot catalog', () => {
  it('opens Today on the sample date (the snapshot anchor, not the visitor’s clock) with the application’s defaults', () => {
    expect(initialShowcaseState(snapshot)).toEqual({
      activity: { source: 'manual', type: 'run' },
      backToTrends: null,
      day: '2026-11-21',
      focusKey: 0,
      mealsDate: '2026-11-21',
      measure: 'count',
      metric: 'weightKg',
      trendsEnd: '2026-11-21',
      view: 'today',
      week: '2026-11-16',
    });
  });

  it('follows the journey policy with "today" = the snapshot’s last date: an unfinished week ends its range on that date', () => {
    expect(trendsEndOfWeek(snapshot, '2026-11-16')).toEqual({ endDate: '2026-11-21', offered: true });
    const state = run([{ kind: 'review-of-day' }, { kind: 'trends-of-week' }]);
    expect(state).toMatchObject({ trendsEnd: '2026-11-21', view: 'trends', week: '2026-11-16' });
  });

  it('a completed week ends its range on its Sunday (the step-3 journey: Today 15 Nov → week 9–15 Nov → Trends ending 15 Nov)', () => {
    const state = run([{ kind: 'choose-day', localDate: '2026-11-15' }, { kind: 'review-of-day' }]);
    expect(state).toMatchObject({ view: 'review', week: '2026-11-09' });
    expect(run([{ kind: 'trends-of-week' }], state)).toMatchObject({ trendsEnd: '2026-11-15', view: 'trends' });
  });

  it('a Trends row opens the day or its meals, and Back to Trends restores that range and series', () => {
    const atTrends = run([
      { kind: 'choose-day', localDate: '2026-11-15' },
      { kind: 'review-of-day' },
      { kind: 'trends-of-week' },
      { kind: 'choose-metric', metric: 'foodEnergyKcal' },
    ]);
    const back = { endDate: '2026-11-15', metric: 'foodEnergyKcal' as const };
    const meals = run([{ kind: 'open-meals-from-trends', back, localDate: '2026-11-14' }], atTrends);
    expect(meals).toMatchObject({ backToTrends: back, mealsDate: '2026-11-14', view: 'meals' });
    // Changing the series elsewhere does not move the way back.
    const returned = run([{ kind: 'choose-metric', metric: 'steps' }, { kind: 'back-to-trends' }], meals);
    expect(returned).toMatchObject({ backToTrends: null, metric: 'foodEnergyKcal', trendsEnd: '2026-11-15', view: 'trends' });

    const day = run([{ kind: 'open-day-from-trends', back, localDate: '2026-10-29' }], atTrends);
    expect(day).toMatchObject({ backToTrends: back, day: '2026-10-29', view: 'today' });
    expect(run([{ kind: 'back-to-trends' }], day)).toMatchObject({ metric: 'foodEnergyKcal', trendsEnd: '2026-11-15', view: 'trends' });
  });

  it('ordinary navigation keeps the range and series (as the application does) and ends the detour', () => {
    const state = run([
      { kind: 'navigate', view: 'trends' },
      { kind: 'choose-trends-end', endDate: '2026-11-15' },
      { kind: 'choose-metric', metric: 'proteinG' },
      { kind: 'open-day-from-trends', back: { endDate: '2026-11-15', metric: 'proteinG' }, localDate: '2026-11-01' },
      { kind: 'navigate', view: 'trends' },
    ]);
    expect(state).toMatchObject({ backToTrends: null, metric: 'proteinG', trendsEnd: '2026-11-15', view: 'trends' });
  });

  it('ignores every selection or action outside the catalog', () => {
    const start = initialShowcaseState(snapshot);
    for (const action of [
      { kind: 'choose-day', localDate: '2026-09-30' },
      { kind: 'choose-day', localDate: '2026-11-22' },
      { kind: 'choose-week', weekStart: '2026-10-12' },
      { kind: 'choose-trends-end', endDate: '2026-11-08' },
      { kind: 'choose-metric', metric: 'heartRate' },
      { kind: 'choose-activity', selection: { source: 'tcx', type: 'run' } },
      { kind: 'open-day-from-trends', back: { endDate: '2026-11-08', metric: 'weightKg' }, localDate: '2026-11-01' },
      { kind: 'open-meals-from-trends', back: { endDate: '2026-11-21', metric: 'proteinG' }, localDate: '2026-09-01' },
      { kind: 'back-to-trends' },
      { kind: 'open-day', localDate: '2026-12-01' },
    ] satisfies ShowcaseAction[]) {
      expect(showcaseReducer(snapshot, start, action)).toBe(start);
    }
    // A week whose policy range is not in the snapshot offers no Trends action.
    const october = run([{ kind: 'choose-day', localDate: '2026-10-20' }, { kind: 'review-of-day' }]);
    expect(october.week).toBe('2026-10-19');
    expect(trendsEndOfWeek(snapshot, '2026-10-19')).toEqual({ endDate: '2026-10-25', offered: false });
    expect(showcaseReducer(snapshot, october, { kind: 'trends-of-week' })).toBe(october);
    // Today on a date that is not an offered end date offers no Trends action either.
    expect(showcaseReducer(snapshot, october, { kind: 'trends-of-day' })).toBe(october);
    expect(offeredWeekOf(snapshot, '2026-10-12')).toBeNull();
  });

  it('moves focus on every view change and never on a selection', () => {
    const state = run([{ kind: 'choose-day', localDate: '2026-11-14' }]);
    expect(state.focusKey).toBe(0);
    expect(run([{ kind: 'meals-of-day' }], state)).toMatchObject({ focusKey: 1, mealsDate: '2026-11-14', view: 'meals' });
  });
});

describe('loading the snapshot file', () => {
  const answer = (body: BodyInit | null, status = 200) => vi.fn(() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;

  it('fetches exactly the given file, without credentials, and validates it', async () => {
    const fetchFile = answer(JSON.stringify(snapshotJson()));
    const load = await loadShowcaseSnapshot('http://127.0.0.1:4380/showcase-snapshot.json', fetchFile);
    expect(load.kind).toBe('ready');
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(fetchFile).toHaveBeenCalledWith('http://127.0.0.1:4380/showcase-snapshot.json', { cache: 'no-cache', credentials: 'omit' });
  });

  it('turns every failure into one local message and asks nothing else', async () => {
    const missing = answer('Not found', 404);
    expect(await loadShowcaseSnapshot('/s.json', missing)).toEqual({ kind: 'error', message: 'The showcase data file is not available (HTTP 404). This build may be incomplete.' });
    expect(await loadShowcaseSnapshot('/s.json', answer('{ not json'))).toEqual({ kind: 'error', message: 'The showcase data file is damaged: it is not valid JSON.' });
    const wrong = await loadShowcaseSnapshot('/s.json', answer(JSON.stringify({ format: 'other' })));
    expect(wrong).toMatchObject({ kind: 'error' });
    expect(wrong.kind === 'error' && wrong.message).toMatch(/^The showcase data file does not match the format this page expects \(/u);
    const offline = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    expect(await loadShowcaseSnapshot('/s.json', offline)).toEqual({ kind: 'error', message: 'The showcase data file could not be downloaded. Check the connection and try again.' });
    expect(missing).toHaveBeenCalledTimes(1);
  });
});
