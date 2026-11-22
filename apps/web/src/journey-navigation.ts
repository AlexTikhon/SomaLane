import { addLocalDays } from '@running-tracker/contracts';

import { checkInDateProblem, formatCheckInDate } from './daily-checkin.js';
import { formatWeek, mondayOf, recentWeeks } from './weekly-insight.js';

// The date policy of the primary journey (release step 3): daily records → Today → Weekly review → Trends → records.
// Pure calendar arithmetic over local dates (YYYY-MM-DD), with the same validation the screens already use; no time zone
// is applied here. "today" is always the caller's date in the view's zone, so nothing here can choose a future date.
//
//  - Today → Weekly review opens the Monday-to-Sunday week that contains Today's selected date (`weekContaining`).
//  - A direct opening of the Weekly review (the navigation button) uses the week kept for the current scope when it is
//    still valid, otherwise the existing default: the current week (`openingReviewWeek`).
//  - Weekly review → Trends ends the 28-date range on the week's Sunday when the week is complete, and on today while the
//    week is still in progress (`trendsEndForWeek`): never a future date.

/** A week start the review may show: a real Monday, not before the first allowed date and not after today. */
export function isReviewWeekStart(weekStart: string, today: string): boolean {
  return checkInDateProblem(weekStart, today) === null && mondayOf(weekStart) === weekStart;
}

/**
 * The Monday of the week containing `localDate`, or null for a date the views would not accept (invalid or future), and
 * for an allowed date whose Monday the review does not support (1–2 Jan 2000 fall in the week from Monday 27 Dec 1999).
 */
export function weekContaining(localDate: string, today: string): string | null {
  if (checkInDateProblem(localDate, today) !== null) return null;
  const monday = mondayOf(localDate);
  return isReviewWeekStart(monday, today) ? monday : null;
}

/** The week a Weekly review opening shows: the kept week if it is still valid, otherwise the current week. */
export function openingReviewWeek(kept: string | null, today: string): string {
  return kept !== null && isReviewWeekStart(kept, today) ? kept : mondayOf(today);
}

/**
 * The weeks the review's picker offers: the usual recent weeks (current first) and, when the shown week is older, that
 * week too, so a week opened from a Today date or an "Ask my data" answer can be shown and kept selected.
 */
export function reviewWeekOptions(weekStart: string | null, today: string): { label: string; weekStart: string }[] {
  const recent = recentWeeks(today);
  return weekStart === null || recent.some((week) => week.weekStart === weekStart)
    ? recent
    : [...recent, { label: `Week: ${formatWeek(weekStart)}`, weekStart }];
}

/** Whether the week has ended: its Sunday is before today. */
export function isCompletedWeek(weekStart: string, today: string): boolean {
  return addLocalDays(weekStart, 6) < today;
}

/** The end date of the Trends range a week's review opens: its Sunday when complete, otherwise today. */
export function trendsEndForWeek(weekStart: string, today: string): string {
  const sunday = addLocalDays(weekStart, 6);
  return sunday < today ? sunday : today;
}

/** The words of the review's Trends action, naming the end date it will use. */
export function trendsActionLabel(weekStart: string, today: string): { aria: string; note: string; text: string } {
  const end = trendsEndForWeek(weekStart, today);
  const endLabel = formatCheckInDate(end);
  return {
    aria: `Open 28-day trends ending on ${endLabel}`,
    note: isCompletedWeek(weekStart, today)
      ? 'The range ends on this week’s Sunday.'
      : 'This week is still in progress, so the range ends today.',
    text: `28-day trends ending ${endLabel}`,
  };
}
