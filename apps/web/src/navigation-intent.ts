import type { ActivityHistorySource, ActivityType, DailyTrendsMetric, DailyTrendsNutritionMetric } from '@running-tracker/contracts';

import type { ActivityTrendMeasure } from './activity-trends.js';
import type { TodayAction } from './daily-overview.js';

// Which view the application shows, and the two small pieces of navigation state Today needs (ADR-0082). No routing
// library: the view is component state, as before. Both pieces carry the scope (session generation, person and
// organization) they were made in and are ignored under any other scope, so a date chosen or an editor intent made by
// one person or organization never opens for another, and nothing survives a sign-out.

export type AppView = 'activity' | 'archive' | 'checkin' | 'coach' | 'meals' | 'review' | 'runner' | 'today' | 'trends';

/**
 * The view a fresh page shows (release step 3). Runner's restoration, recovery, capture, uploads and writer lease are owned
 * by App whatever view is shown, so the start view does not wait for them, and no later effect changes the view.
 */
export const START_VIEW: AppView = 'today';

export interface NavigationEntry {
  label: string;
  view: AppView;
}

/** The primary journey, first and most prominent: one day, its week, 28 dates. */
export const primaryNavigation: readonly NavigationEntry[] = [
  { label: 'Today', view: 'today' },
  { label: 'Weekly review', view: 'review' },
  { label: 'Trends', view: 'trends' },
];

/** Everything else, in two groups: where records are entered, and the run recorder with what builds on it. */
export const secondaryNavigation: readonly { label: string; entries: readonly NavigationEntry[] }[] = [
  {
    entries: [
      { label: 'Check-in', view: 'checkin' },
      { label: 'Meal log', view: 'meals' },
      { label: 'Activity', view: 'activity' },
    ],
    label: 'Records',
  },
  {
    entries: [
      { label: 'Runner', view: 'runner' },
      { label: 'Coach', view: 'coach' },
      { label: 'Archive', view: 'archive' },
    ],
    label: 'Runs',
  },
];

/** Opens an existing editor on one date: one of the Check-in tab's two editors, or the Meal log (ADR-0083). */
export interface EditorIntent {
  localDate: string;
  scope: string;
  section: 'check-in' | 'meals' | 'movement';
}

/**
 * The date Today shows, the end date of the Trends range (ADR-0084), or the Monday of the week the Weekly review shows
 * (release step 3), kept while the person navigates elsewhere and back.
 */
export interface KeptDate {
  localDate: string;
  scope: string;
}

/** The series Trends shows, kept like its range. */
export interface KeptMetric {
  metric: DailyTrendsMetric;
  scope: string;
}

/** The source, type and measure of Trends' Activity section (ADR-0089), kept like its series. */
export interface KeptActivitySelection {
  measure: ActivityTrendMeasure;
  scope: string;
  source: ActivityHistorySource;
  type: ActivityType;
}

/**
 * Opens the Activity tab's history on one Today card's items (ADR-0088): the overview's date and zone, and the card's
 * source. Single-use: the Activity screen reads it once when it mounts, as its starting filters and as the date "Back to
 * Today" returns to, and then reports it applied, which consumes it. Any ordinary navigation clears it too, so neither
 * the view switcher nor a later remount of the screen (another organization and back) ever applies it again.
 */
export interface HistoryIntent {
  localDate: string;
  scope: string;
  source: ActivityHistorySource;
  timeZone: string;
}

/**
 * The way back from the Meal log to the Trends selection it was opened from (ADR-0096): the range's end date and the
 * nutrition series of the answer whose row was used. In App memory only, tied to its scope like every intent, and cleared
 * by sign-out, by any ordinary navigation, by being used and by any change of scope, so it never returns to another
 * person, organization or session, nor resurfaces later.
 */
export interface TrendsReturn {
  endDate: string;
  metric: DailyTrendsNutritionMetric;
  scope: string;
}

/**
 * A nutrition row's "Meal log" action on Trends: the Meal log intent for the row's stored date, and the way back to the
 * range and series the row belongs to.
 */
export function navigationFromTrendsRow(
  localDate: string,
  back: { endDate: string; metric: DailyTrendsNutritionMetric },
  scope: string,
): { editor: EditorIntent; trendsReturn: TrendsReturn; view: AppView } {
  return { editor: { localDate, scope, section: 'meals' }, trendsReturn: { endDate: back.endDate, metric: back.metric, scope }, view: 'meals' };
}

/**
 * The Weekly review's Trends action: Trends with the range ending on `endDate`, which the review chose by the journey's
 * date policy (journey-navigation.ts, never after today). The series and Activity choices kept for Trends stay as they are.
 */
export function navigationFromReview(endDate: string, scope: string): { trendsEnd: KeptDate; view: AppView } {
  return { trendsEnd: { localDate: endDate, scope }, view: 'trends' };
}

/**
 * The view a Today action opens and, for the editors, the intent that carries the selected date. The Trends action
 * carries the selected date as the end of its range instead (`trendsEnd`); it opens no editor. A history action carries
 * the date, zone and source the Activity history opens on (`history`). The weekly review action opens the Weekly review
 * view on its week (`reviewWeek`), which becomes the week kept for that view.
 */
export function navigationFor(
  action: TodayAction,
  scope: string,
): {
  editor: EditorIntent | null;
  history?: HistoryIntent;
  reviewWeek?: KeptDate;
  trendsActivity?: KeptActivitySelection;
  trendsEnd?: KeptDate;
  view: AppView;
} {
  switch (action.kind) {
    case 'check-in':
      return { editor: { localDate: action.localDate, scope, section: 'check-in' }, view: 'checkin' };
    case 'movement':
      return { editor: { localDate: action.localDate, scope, section: 'movement' }, view: 'checkin' };
    case 'meals':
      return { editor: { localDate: action.localDate, scope, section: 'meals' }, view: 'meals' };
    case 'activities':
      return { editor: null, view: 'activity' };
    case 'runner':
      return { editor: null, view: 'runner' };
    case 'trends':
      return { editor: null, trendsEnd: { localDate: action.localDate, scope }, view: 'trends' };
    case 'weekly-review':
      return { editor: null, reviewWeek: { localDate: action.weekStart, scope }, view: 'review' };
    case 'activity-trends':
      return {
        editor: null,
        trendsActivity: { measure: 'count', scope, source: action.source, type: action.type },
        trendsEnd: { localDate: action.localDate, scope },
        view: 'trends',
      };
    case 'history':
      return {
        editor: null,
        history: { localDate: action.localDate, scope, source: action.source, timeZone: action.timeZone },
        view: 'activity',
      };
  }
}

/** The intent for the Check-in tab only (its two editors); a Meal log intent is not one. */
export function checkInIntentOf(
  intent: EditorIntent | null,
): { localDate: string; section: 'check-in' | 'movement' } | undefined {
  if (intent === null || intent.section === 'meals') return undefined;
  return { localDate: intent.localDate, section: intent.section };
}

/** The date a Meal log intent opens, or null. */
export function mealIntentDateOf(intent: EditorIntent | null): string | null {
  return intent !== null && intent.section === 'meals' ? intent.localDate : null;
}

/**
 * What remains once `applied` has been applied: nothing if it is still the current intent, otherwise the current one
 * untouched. Compared by identity, since every Today action makes a new intent: a late report from a screen that
 * applied an earlier intent never consumes a newer one, even for the same day.
 */
export function afterHistoryIntentApplied(current: HistoryIntent | null, applied: HistoryIntent): HistoryIntent | null {
  return current === applied ? null : current;
}

/** The intent or kept date, only under the scope it was made in. */
export function inScope<Value extends { scope: string }>(value: Value | null, scope: string | null): Value | null {
  return value !== null && scope !== null && value.scope === scope ? value : null;
}
