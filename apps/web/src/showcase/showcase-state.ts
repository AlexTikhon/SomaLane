import type { DailyTrendsMetric } from '@running-tracker/contracts';
import { parseShowcaseSnapshot, ShowcaseSnapshotError, type ShowcaseActivitySelection, type ShowcaseSnapshot } from '@running-tracker/contracts/showcase';

import type { ActivityTrendMeasure } from '../activity-trends.js';
import { isTrendsMetric } from '../daily-trends.js';
import { trendsEndForWeek } from '../journey-navigation.js';
import { mondayOf } from '../weekly-insight.js';

// The showcase's navigation (ADR-0099): pure state over the snapshot's bounded catalog. Every selection and action is
// checked against the catalog, so the page can only show what the snapshot holds; a value outside it is ignored. The date
// policy is the application's own (journey-navigation.ts) with "today" set to the snapshot's last date, never the
// visitor's clock. Nothing here reads or writes storage, the URL or the network.

export type ShowcaseView = 'meals' | 'review' | 'today' | 'trends';

/** The range and series a Trends row was opened from: "Back to Trends" returns to exactly these. */
export interface TrendsReturn {
  endDate: string;
  metric: DailyTrendsMetric;
}

export interface ShowcaseState {
  activity: ShowcaseActivitySelection;
  /** Set when Today or the meal list was opened from a Trends row. */
  backToTrends: TrendsReturn | null;
  day: string;
  /** Increased on every view change, so the new view can move focus to its heading. */
  focusKey: number;
  mealsDate: string;
  measure: ActivityTrendMeasure;
  metric: DailyTrendsMetric;
  trendsEnd: string;
  view: ShowcaseView;
  week: string;
}

export type ShowcaseAction =
  | { kind: 'navigate'; view: 'review' | 'today' | 'trends' }
  | { kind: 'choose-day'; localDate: string }
  | { kind: 'choose-week'; weekStart: string }
  | { kind: 'choose-trends-end'; endDate: string }
  | { kind: 'choose-metric'; metric: string }
  | { kind: 'choose-activity'; selection: ShowcaseActivitySelection }
  | { kind: 'choose-measure'; measure: ActivityTrendMeasure }
  | { kind: 'review-of-day' }
  | { kind: 'trends-of-day' }
  | { kind: 'meals-of-day' }
  | { kind: 'trends-of-week' }
  | { kind: 'open-day-from-trends'; localDate: string; back: TrendsReturn }
  | { kind: 'open-meals-from-trends'; localDate: string; back: TrendsReturn }
  | { kind: 'back-to-trends' }
  | { kind: 'open-day'; localDate: string };

/** The snapshot's last date: the "today" of the date policy. */
export const policyToday = (snapshot: ShowcaseSnapshot) => snapshot.snapshot.asOfDate;

export function initialShowcaseState(snapshot: ShowcaseSnapshot): ShowcaseState {
  const { selections } = snapshot;
  return {
    activity: selections.defaultActivity,
    backToTrends: null,
    day: selections.sampleDate,
    focusKey: 0,
    mealsDate: selections.sampleDate,
    measure: 'count',
    metric: selections.defaultMetric,
    trendsEnd: selections.defaultTrendsEndDate,
    view: 'today',
    week: selections.defaultWeekStart,
  };
}

/** The offered week that contains a date, or null. */
export function offeredWeekOf(snapshot: ShowcaseSnapshot, localDate: string): string | null {
  const week = mondayOf(localDate);
  return snapshot.selections.weeks.includes(week) ? week : null;
}

/** The end date the application's policy gives a week's Trends action, and whether the snapshot offers that range. */
export function trendsEndOfWeek(snapshot: ShowcaseSnapshot, weekStart: string): { endDate: string; offered: boolean } {
  const endDate = trendsEndForWeek(weekStart, policyToday(snapshot));
  return { endDate, offered: snapshot.selections.trendsEndDates.includes(endDate) };
}

const sameSelection = (left: ShowcaseActivitySelection, right: ShowcaseActivitySelection) => left.source === right.source && left.type === right.type;

export function showcaseReducer(snapshot: ShowcaseSnapshot, state: ShowcaseState, action: ShowcaseAction): ShowcaseState {
  const { selections } = snapshot;
  const isDay = (date: string) => selections.days.includes(date);
  const isEnd = (date: string) => selections.trendsEndDates.includes(date);
  const go = (view: ShowcaseView, change: Partial<ShowcaseState> = {}): ShowcaseState => ({ ...state, ...change, focusKey: state.focusKey + 1, view });
  switch (action.kind) {
    case 'navigate':
      // Ordinary navigation keeps every selection (as the application does) and ends a "Back to Trends" detour.
      return go(action.view, { backToTrends: null });
    case 'choose-day':
      return isDay(action.localDate) ? { ...state, day: action.localDate } : state;
    case 'choose-week':
      return selections.weeks.includes(action.weekStart) ? { ...state, week: action.weekStart } : state;
    case 'choose-trends-end':
      return isEnd(action.endDate) ? { ...state, trendsEnd: action.endDate } : state;
    case 'choose-metric':
      return isTrendsMetric(action.metric) ? { ...state, metric: action.metric } : state;
    case 'choose-activity':
      return selections.activity.some((selection) => sameSelection(selection, action.selection)) ? { ...state, activity: action.selection } : state;
    case 'choose-measure':
      return { ...state, measure: action.measure };
    case 'review-of-day': {
      const week = offeredWeekOf(snapshot, state.day);
      return week === null ? state : go('review', { backToTrends: null, week });
    }
    case 'trends-of-day':
      return isEnd(state.day) ? go('trends', { backToTrends: null, trendsEnd: state.day }) : state;
    case 'meals-of-day':
      return go('meals', { mealsDate: state.day });
    case 'trends-of-week': {
      const { endDate, offered } = trendsEndOfWeek(snapshot, state.week);
      return offered ? go('trends', { backToTrends: null, trendsEnd: endDate }) : state;
    }
    case 'open-day-from-trends':
      return isDay(action.localDate) && isEnd(action.back.endDate) ? go('today', { backToTrends: action.back, day: action.localDate }) : state;
    case 'open-meals-from-trends':
      return isDay(action.localDate) && isEnd(action.back.endDate) ? go('meals', { backToTrends: action.back, mealsDate: action.localDate }) : state;
    case 'back-to-trends':
      return state.backToTrends === null
        ? state
        : go('trends', { backToTrends: null, metric: state.backToTrends.metric, trendsEnd: state.backToTrends.endDate });
    case 'open-day':
      return isDay(action.localDate) ? go('today', { day: action.localDate }) : state;
  }
}

// --- Loading the snapshot ------------------------------------------------------------------------------------------

/** The snapshot file next to the page (the build copies it there). Never an API route. */
export const SNAPSHOT_FILE = 'showcase-snapshot.json';

export type SnapshotLoad = { kind: 'error'; message: string } | { kind: 'loading' } | { kind: 'ready'; snapshot: ShowcaseSnapshot };

/**
 * Fetches and validates the static snapshot. Every failure (missing file, a server error, invalid JSON, a document the
 * contract schemas refuse) becomes one local message; there is no fallback to any other source.
 */
export async function loadShowcaseSnapshot(url: string, fetchFile: typeof fetch, signal?: AbortSignal): Promise<SnapshotLoad> {
  let response: Response;
  try {
    response = await fetchFile(url, { cache: 'no-cache', credentials: 'omit', ...(signal === undefined ? {} : { signal }) });
  } catch {
    return { kind: 'error', message: 'The showcase data file could not be downloaded. Check the connection and try again.' };
  }
  if (!response.ok) {
    return { kind: 'error', message: `The showcase data file is not available (HTTP ${String(response.status)}). This build may be incomplete.` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'error', message: 'The showcase data file is damaged: it is not valid JSON.' };
  }
  try {
    return { kind: 'ready', snapshot: parseShowcaseSnapshot(body) };
  } catch (error) {
    const detail = error instanceof ShowcaseSnapshotError ? error.message : 'unexpected content';
    return { kind: 'error', message: `The showcase data file does not match the format this page expects (${detail}).` };
  }
}
