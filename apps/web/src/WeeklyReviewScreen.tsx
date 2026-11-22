import { useEffect, useMemo, useState } from 'react';

import { localDateIn } from './daily-checkin.js';
import { isReviewWeekStart, openingReviewWeek, reviewWeekOptions, trendsActionLabel, trendsEndForWeek } from './journey-navigation.js';
import { WeeklyReviewPanel } from './WeeklyReviewPanel.js';

// The Weekly review as a view of its own (release step 3): the existing section and its controller, without the Check-in
// editors around it, so a week can be read straight from the primary navigation or from Today. Nothing is computed here:
// the review is the server's, read again on every opening, and the optional AI insight stays in the Check-in tab.

/** The way on from the review to Trends, naming the end date the policy chooses (journey-navigation.ts). */
export function ReviewJourneyActions({ onOpenTrends, today, weekStart }: { onOpenTrends: (endDate: string) => void; today: string; weekStart: string }) {
  const label = trendsActionLabel(weekStart, today);
  return (
    <div className="review-journey">
      <button aria-label={label.aria} onClick={() => onOpenTrends(trendsEndForWeek(weekStart, today))} type="button">
        {label.text}
      </button>
      <p className="today-note">{label.note}</p>
    </div>
  );
}

export interface WeeklyReviewScreenProps {
  /** Move focus to the heading when the view opens: set for a contextual opening (Today, an "Ask my data" answer). */
  focusOnOpen: boolean;
  /** The week to open (kept by the parent, or chosen by the action that opened the view); null or invalid: this week. */
  initialWeek: string | null;
  /** Opens Trends with its range ending on the given date. */
  onOpenTrends: (endDate: string) => void;
  /** Called with every week the person selects, so the parent can keep it during ordinary navigation. */
  onSelectWeek: (weekStart: string) => void;
  orgId: string;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
  timeZone: string;
  // For tests: the instant whose date in `timeZone` is "today". Defaults to the time the screen opens.
  nowMs?: number;
}

// The parent keys this screen by session, person and organization and mounts it only while the view is open, so each
// opening reads the week again (after an edit elsewhere too) and no answer crosses a change of scope.
export function WeeklyReviewScreen({ focusOnOpen, initialWeek, nowMs, onOpenTrends, onSelectWeek, orgId, signal, timeZone }: WeeklyReviewScreenProps) {
  const today = useMemo(() => localDateIn(timeZone, nowMs ?? Date.now()), [nowMs, timeZone]);
  // Read once, when the view opens; the offered weeks keep that week even when it is older than the usual list.
  const [opening] = useState(() => openingReviewWeek(initialWeek, today));
  const weeks = useMemo(() => reviewWeekOptions(opening, today), [opening, today]);
  const [weekStart, setWeekStart] = useState(opening);
  const [focus] = useState(focusOnOpen);

  useEffect(() => {
    if (focus) document.getElementById('review-title')?.focus();
  }, [focus]);

  const chooseWeek = (value: string) => {
    if (!isReviewWeekStart(value, today)) return;
    setWeekStart(value);
    onSelectWeek(value);
  };

  return (
    <div className="activity-shell review-shell">
      <WeeklyReviewPanel
        actions={<ReviewJourneyActions onOpenTrends={onOpenTrends} today={today} weekStart={weekStart} />}
        headingLevel={1}
        onSelectWeek={chooseWeek}
        orgId={orgId}
        refreshKey={0}
        signal={signal}
        timeZone={timeZone}
        weekStart={weekStart}
        weeks={weeks}
      />
    </div>
  );
}
