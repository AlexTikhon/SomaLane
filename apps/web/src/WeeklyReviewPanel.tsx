import { useEffect, useRef, useState, type ReactNode } from 'react';

import { readWeeklyReview } from './runner-api.js';
import { loadingReview, WeeklyReviewController, type ReviewSnapshot } from './weekly-review-controller.js';
import { formatWeek } from './weekly-insight.js';
import { ReviewContent } from './WeeklyReviewContent.js';

// The Weekly review: the primary, deterministic description of a week, shown by its own view (release step 3) and as a
// section of the Check-in tab. Every sentence and
// number is computed by the app from the person's own records on each read; no AI model is involved. The optional AI
// insight is a separate section below it with its own lifecycle, so its failures never hide this one. The review's
// content is WeeklyReviewContent.tsx (pure; the public showcase renders it from its snapshot).

export {
  coverageRows,
  formatReviewDay,
  isEmptyWeek,
  movementTotalRows,
  ReviewContent,
  ReviewImports,
  ReviewMeals,
  ReviewMovement,
  ReviewTcxImports,
} from './WeeklyReviewContent.js';

export interface ReviewPanelViewProps {
  /** Navigation actions of the view that shows the section (its own view's Trends action), under the week picker. */
  actions?: ReactNode;
  /** 1 when the section is a view of its own (its heading is the page's), 2 (the default) in the Check-in tab. */
  headingLevel?: 1 | 2 | undefined;
  onRefresh: () => void;
  onSelectWeek: (weekStart: string) => void;
  snapshot: ReviewSnapshot;
  weeks: readonly { label: string; weekStart: string }[];
}

/** Everything the section shows, from one snapshot. Pure, so every state is testable without a DOM. */
export function ReviewPanelView({ actions, headingLevel = 2, onRefresh, onSelectWeek, snapshot, weeks }: ReviewPanelViewProps) {
  const { load } = snapshot;
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const busy = load.kind === 'loading' || (load.kind === 'ready' && load.refreshing);
  const state = load.kind === 'ready' && load.refreshing ? 'refreshing' : load.kind;
  return (
    <section aria-labelledby="review-title" className="review-panel search-results">
      <div className="insight-panel__heading">
        <Heading id="review-title" tabIndex={-1}>Weekly review</Heading>
        <p className="insight-panel__positioning">
          <span className="review-badge">Computed by the app</span> Counted from your own check-ins, manual activities, GPS
          runs, manually entered movement and logged meals each time you open it. No AI model writes this section. It describes what was recorded; it is not medical
          advice. Only you can see it.
        </p>
      </div>
      <div className="insight-panel__controls">
        <label>
          Week
          <select onChange={(event) => onSelectWeek(event.target.value)} value={snapshot.weekStart}>
            {weeks.map((week) => (
              <option key={week.weekStart} value={week.weekStart}>{week.label}</option>
            ))}
          </select>
        </label>
        <button disabled={busy} onClick={onRefresh} type="button">{busy ? 'Updating…' : 'Refresh'}</button>
      </div>
      {actions}
      <div aria-busy={busy} aria-live="polite" className="insight-panel__body" data-review-state={state}>
        {load.kind === 'loading' && <p className="search-results__loading">Loading the review for {formatWeek(snapshot.weekStart)}…</p>}
        {(load.kind === 'error' || load.kind === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{load.message}</span>
            {load.kind === 'error' && <button onClick={onRefresh} type="button">Retry</button>}
          </div>
        )}
        {load.kind === 'ready' && <ReviewContent review={load.review} />}
      </div>
    </section>
  );
}

export interface WeeklyReviewPanelProps {
  actions?: ReactNode;
  headingLevel?: 1 | 2 | undefined;
  onSelectWeek: (weekStart: string) => void;
  orgId: string;
  /**
   * Changes whenever a check-in or a movement day of this person was saved or deleted: the section reads its week again.
   * Meals are edited on the Meal log screen; opening the Check-in tab again mounts a new section, which reads afresh.
   */
  refreshKey: number;
  signal: AbortSignal;
  timeZone: string;
  weekStart: string;
  weeks: readonly { label: string; weekStart: string }[];
}

export function WeeklyReviewPanel({ actions, headingLevel, onSelectWeek, orgId, refreshKey, signal, timeZone, weekStart, weeks }: WeeklyReviewPanelProps) {
  const controller = useRef<WeeklyReviewController | null>(null);
  const weekRef = useRef(weekStart);
  weekRef.current = weekStart;
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>(() => loadingReview(weekStart));

  useEffect(() => {
    const next = new WeeklyReviewController({ onChange: setSnapshot, orgId, read: readWeeklyReview, signal, timeZone, weekStart: weekRef.current });
    controller.current = next;
    setSnapshot(next.snapshot);
    next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal, timeZone]);

  useEffect(() => {
    controller.current?.select(weekStart);
  }, [weekStart]);

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    controller.current?.refresh();
  }, [refreshKey]);

  return (
    <ReviewPanelView
      actions={actions}
      headingLevel={headingLevel}
      onRefresh={() => controller.current?.refresh()}
      onSelectWeek={onSelectWeek}
      snapshot={snapshot}
      weeks={weeks}
    />
  );
}
