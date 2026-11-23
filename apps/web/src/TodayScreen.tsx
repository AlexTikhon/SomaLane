import { DAILY_METRICS_LOCAL_DATE_MIN } from '@running-tracker/contracts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { AskMyDataSection } from './AskMyDataSection.js';

import { checkInDateProblem, formatCheckInDate, localDateIn } from './daily-checkin.js';
import type { TodayAction } from './daily-overview.js';
import { DailyOverviewController, loadingOverview, type OverviewReader, type OverviewSnapshot } from './daily-overview-controller.js';
import { weekContaining } from './journey-navigation.js';
import { OverviewContent } from './TodayOverviewContent.js';
import { formatWeek } from './weekly-insight.js';
import { readDailyOverview, type CsrfCredentials } from './runner-api.js';

// The Today screen (ADR-0082): a read-only overview of one day of the person's own records, recomputed by the server on
// every read. It shows what was recorded and nothing else: no target, judgement, trend or recommendation. Editing happens
// in the existing editors, which the actions open for the selected date. The overview's content is TodayOverviewContent.tsx
// (pure; the public showcase renders it without actions).

export { OverviewContent } from './TodayOverviewContent.js';

export interface TodayViewProps {
  /** "Ask my data" (ADR-0094), rendered below the overview. */
  ask?: ReactNode;
  dateInput: string;
  onAction: (action: TodayAction) => void;
  onChooseDate: (value: string) => void;
  onRefresh: () => void;
  snapshot: OverviewSnapshot;
  timeZone: string;
  today: string;
}

/** Everything the screen shows, from one snapshot. Pure, so every state is testable without a DOM. */
export function TodayView({ ask, dateInput, onAction, onChooseDate, onRefresh, snapshot, timeZone, today }: TodayViewProps) {
  const { load } = snapshot;
  const busy = load.kind === 'loading' || (load.kind === 'ready' && load.refreshing);
  const state = load.kind === 'ready' && load.refreshing ? 'refreshing' : load.kind;
  const dateProblem = checkInDateProblem(dateInput, today);
  const dateLabel = formatCheckInDate(snapshot.localDate);
  const week = weekContaining(snapshot.localDate, today);
  return (
    <section aria-labelledby="today-title" className="activity-shell today-shell">
      <div className="search-panel__heading">
        <p className="eyebrow">Daily overview</p>
        <h1 id="today-title" tabIndex={-1}>Today</h1>
        <p>
          What your own check-in, movement, meals, manual activities and GPS runs hold for one day, read again each time you open
          this view or press Refresh. It describes what was recorded; it sets no targets and gives no advice. Only you can see
          it.
        </p>
      </div>

      <div className="today-controls">
        <label>
          Date
          <input
            max={today}
            min={DAILY_METRICS_LOCAL_DATE_MIN}
            onChange={(event) => onChooseDate(event.target.value)}
            type="date"
            value={dateInput}
          />
        </label>
        <button disabled={snapshot.localDate === today && dateProblem === null} onClick={() => onChooseDate(today)} type="button">
          Go to today
        </button>
        <button disabled={busy} onClick={onRefresh} type="button">{busy ? 'Updating…' : 'Refresh'}</button>
        {/* The week that contains the shown date (journey-navigation.ts), in the Weekly review view. */}
        <button
          aria-label={week === null ? 'Weekly review' : `Weekly review of ${formatWeek(week)}`}
          disabled={dateProblem !== null || week === null}
          onClick={() => { if (week !== null) onAction({ kind: 'weekly-review', weekStart: week }); }}
          type="button"
        >
          Weekly review
        </button>
        <button
          aria-label={`Open 28-day trends ending on ${dateLabel}`}
          disabled={dateProblem !== null}
          onClick={() => onAction({ kind: 'trends', localDate: snapshot.localDate })}
          type="button"
        >
          28-day trends
        </button>
      </div>
      {dateProblem !== null && <p className="activity-form__failure" role="alert">{dateProblem}</p>}
      <p className="today-day">
        Showing <strong>{dateLabel}</strong>{snapshot.localDate === today ? ' (today)' : ''} in the time zone {timeZone}.
      </p>

      <div aria-busy={busy} aria-live="polite" className="today-body" data-overview-state={state}>
        {load.kind === 'loading' && <p className="search-results__loading">Loading {dateLabel}…</p>}
        {(load.kind === 'error' || load.kind === 'access-denied') && (
          <div className="run-share__failure" role="alert">
            <span>{load.message}</span>
            {load.kind === 'error' && <button onClick={onRefresh} type="button">Retry</button>}
          </div>
        )}
        {load.kind === 'ready' && <OverviewContent onAction={onAction} overview={load.overview} />}
      </div>
      {ask}
    </section>
  );
}

export interface TodayScreenProps {
  /** The session's CSRF credentials, for "Ask my data" (its routes are POSTs). */
  csrf: CsrfCredentials;
  onAction: (action: TodayAction) => void;
  /** Called with every valid date the person selects, so the parent can keep it during ordinary navigation. */
  onSelectDate: (localDate: string) => void;
  orgId: string;
  /** The date to open with (kept by the parent); null or a date after today opens today. */
  selectedDate: string | null;
  // The session's signal: ending or replacing the session silences every request of this screen.
  signal: AbortSignal;
  timeZone: string;
  // For tests: the instant whose date in `timeZone` is "today". Defaults to the time the screen opens.
  nowMs?: number;
  read?: OverviewReader;
}

// The parent keys this screen by session, person and organization and mounts it only while Today is open, so each
// opening reads the day again (after an edit or a deletion elsewhere too) and no answer crosses a change of scope.
export function TodayScreen({ csrf, nowMs, onAction, onSelectDate, orgId, read = readDailyOverview, selectedDate, signal, timeZone }: TodayScreenProps) {
  const today = useMemo(() => localDateIn(timeZone, nowMs ?? Date.now()), [nowMs, timeZone]);
  const initialDate = selectedDate !== null && checkInDateProblem(selectedDate, today) === null ? selectedDate : today;
  const initialRef = useRef(initialDate);
  const readRef = useRef(read);
  const [dateInput, setDateInput] = useState(initialDate);
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>(() => loadingOverview(initialDate));
  const controller = useRef<DailyOverviewController | null>(null);

  useEffect(() => {
    const next = new DailyOverviewController({ localDate: initialRef.current, onChange: setSnapshot, orgId, read: readRef.current, signal, timeZone });
    controller.current = next;
    setSnapshot(next.snapshot);
    next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal, timeZone]);

  const chooseDate = (value: string) => {
    setDateInput(value);
    if (checkInDateProblem(value, today) !== null) return;
    onSelectDate(value);
    controller.current?.select(value);
  };

  return (
    <TodayView
      ask={
        // The selected date of the overview (not the unvalidated input) and the view zone are the question's context.
        <AskMyDataSection
          csrf={csrf}
          onAction={onAction}
          onSelectDate={chooseDate}
          orgId={orgId}
          selectedDate={snapshot.localDate}
          signal={signal}
          timeZone={timeZone}
        />
      }
      dateInput={dateInput}
      onAction={onAction}
      onChooseDate={chooseDate}
      onRefresh={() => controller.current?.refresh()}
      snapshot={snapshot}
      timeZone={timeZone}
      today={today}
    />
  );
}
