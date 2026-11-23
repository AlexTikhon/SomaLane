import { dailyTrendsRangeOf, DAILY_TRENDS_RANGE_DAYS } from '@running-tracker/contracts';
import { compareActivitySelections, showcaseActivityKey, type ShowcaseSnapshot } from '@running-tracker/contracts/showcase';
import type { ReactNode } from 'react';

import { activityTypeLabels } from '../activity-form.js';
import { ActivityTrendsContent } from '../ActivityTrendsSection.js';
import { ACTIVITY_TREND_MEASURES, activityTrendDurationLabels, activityTrendMeasureLabels, activityTrendSourceLabels } from '../activity-trends.js';
import { formatCheckInDate } from '../daily-checkin.js';
import { rangeLabel, trendMetricOptions, trendMetricSpecs } from '../daily-trends.js';
import { isCompletedWeek } from '../journey-navigation.js';
import { MealEntryValues } from '../MealEntryValues.js';
import { OverviewContent } from '../TodayOverviewContent.js';
import { TrendsContent, type MealActionWords } from '../TrendsContent.js';
import { formatWeek } from '../weekly-insight.js';
import { ReviewContent } from '../WeeklyReviewContent.js';
import { offeredWeekOf, policyToday, trendsEndOfWeek, type ShowcaseAction, type ShowcaseState, type SnapshotLoad } from './showcase-state.js';

// The public read-only showcase (ADR-0099): every view, pure, from the snapshot and the navigation state. The content
// blocks are the application's own (Today's overview, the Weekly review, Trends and its Activity section, a meal
// entry's values) rendered without any action; this file adds only the frame, the bounded selections and the ways
// between views. There is no editing, deletion, import, recording or generation control, no sign-in and no AI output.

export const SHOWCASE_LABEL = 'Read-only showcase · synthetic data';

/** A nutrition row's second action here: a read-only list of the date's entries, never the Meal log editor. */
const readOnlyMealWords: MealActionWords = {
  aria: (dateLabel) => `Open the logged meals of ${dateLabel}`,
  note: 'Newest first. Open shows the date as Today showed it; Meals lists that date’s logged entries, read-only, with a way back here.',
  text: 'Meals',
};

type Dispatch = (action: ShowcaseAction) => void;

/** "27 Sep 2026 – 21 Nov 2026": the dataset's dates. */
function datasetSpan(snapshot: ShowcaseSnapshot): string {
  const { previous, current } = snapshot.dataset.ranges;
  return `${formatCheckInDate(previous.startDate)} to ${formatCheckInDate(current.endDate)}`;
}

export function ApplicationLink({ appUrl }: { appUrl: string | null }) {
  if (appUrl === null) {
    return <p className="showcase-banner__app" data-app-link="not-configured">The address of the invite-only application is not configured in this build.</p>;
  }
  return (
    <p className="showcase-banner__app">
      <a data-app-link="configured" href={appUrl} rel="noopener noreferrer">Open the invite-only application</a>
      <span> (sign-in by invitation only; this showcase has no sign-in)</span>
    </p>
  );
}

const NAVIGATION: readonly { label: string; view: 'review' | 'today' | 'trends' }[] = [
  { label: 'Today', view: 'today' },
  { label: 'Weekly review', view: 'review' },
  { label: 'Trends', view: 'trends' },
];

/** The frame of every state and view: the persistent label, what the data is, the application link, the navigation. */
export function ShowcaseFrame({
  appUrl,
  children,
  dispatch,
  snapshot,
  view,
}: {
  appUrl: string | null;
  children: ReactNode;
  dispatch?: Dispatch | undefined;
  snapshot: ShowcaseSnapshot | null;
  view: ShowcaseState['view'] | null;
}) {
  return (
    <div className="showcase">
      {/* A direct child of the page container, so it stays in view for the whole page, not only while the header does. */}
      <p className="showcase-label" data-showcase-label="">
        <strong>{SHOWCASE_LABEL}</strong>
      </p>
      <header className="showcase-banner" data-showcase-banner="">
        <p className="showcase-banner__data">
          {snapshot === null
            ? 'Generated data of one fictional person; nothing here belongs to a real person.'
            : `Generated data of one fictional person, ${datasetSpan(snapshot)} in ${snapshot.dataset.timeZone}; sample date ${formatCheckInDate(snapshot.selections.sampleDate)}. Nothing here belongs to a real person, and nothing can be changed.`}
        </p>
        <ApplicationLink appUrl={appUrl} />
      </header>
      {snapshot !== null && view !== null && dispatch !== undefined && (
        <nav aria-label="Showcase view" className="view-switcher showcase-navigation">
          <div className="view-switcher__primary">
            {NAVIGATION.map((item) => {
              const current = item.view === view;
              return (
                <button aria-current={current ? 'page' : undefined} key={item.view} onClick={() => dispatch({ kind: 'navigate', view: item.view })} type="button">
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>
      )}
      <main className="showcase-main">{children}</main>
      {snapshot !== null && <ShowcaseProvenance snapshot={snapshot} />}
    </div>
  );
}

/** Where the numbers come from, in plain words, with the identities a reviewer can check. */
export function ShowcaseProvenance({ snapshot }: { snapshot: ShowcaseSnapshot }) {
  const { dataset } = snapshot;
  return (
    <footer className="showcase-provenance">
      <h2>About this snapshot</h2>
      <p>
        Every figure was computed by the application&apos;s own read services from the synthetic dataset and exported unchanged
        into a static file: this page sends no request to the application and cannot change anything. Optional AI features
        are off by default and are not part of this showcase.
      </p>
      <dl>
        <div><dt>Dataset</dt><dd>{`${dataset.datasetVersion}, seed ${dataset.seed}, last date ${formatCheckInDate(dataset.anchorDate)}`}</dd></div>
        <div><dt>Dataset digest</dt><dd><code>{dataset.digest}</code></dd></div>
        <div><dt>Read at</dt><dd>{`${snapshot.snapshot.readAt.slice(0, 16).replace('T', ' ')} UTC (the fixed instant every read was given)`}</dd></div>
        <div><dt>Snapshot digest</dt><dd><code>{snapshot.contentDigest}</code></dd></div>
      </dl>
    </footer>
  );
}

/** Loading and failure of the snapshot file: local, with the label and link still shown, and no other source. */
export function ShowcaseLoadState({ load, onRetry }: { load: Exclude<SnapshotLoad, { kind: 'ready' }>; onRetry: () => void }) {
  if (load.kind === 'loading') {
    return (
      <p aria-busy="true" className="search-results__loading" role="status">
        Loading the synthetic snapshot…
      </p>
    );
  }
  return (
    <div className="run-share__failure showcase-failure" role="alert">
      <span>{load.message}</span>
      <span>The showcase shows only this static file; it never asks the application for data.</span>
      <button onClick={onRetry} type="button">Try again</button>
    </div>
  );
}

function Heading({ eyebrow, id, title }: { eyebrow: string; id: string; title: string }) {
  return (
    <div className="search-panel__heading">
      <p className="eyebrow">{eyebrow}</p>
      <h1 id={id} tabIndex={-1}>{title}</h1>
    </div>
  );
}

function BackToTrends({ dispatch, state }: { dispatch: Dispatch; state: ShowcaseState }) {
  if (state.backToTrends === null) return null;
  const { endDate, metric } = state.backToTrends;
  return (
    <button
      aria-label={`Back to Trends ending ${formatCheckInDate(endDate)}, ${trendMetricSpecs[metric].label}`}
      onClick={() => dispatch({ kind: 'back-to-trends' })}
      type="button"
    >
      Back to Trends
    </button>
  );
}

/** A note for an action the snapshot does not include, so it is never a dead control. */
function NotIncluded({ children }: { children: ReactNode }) {
  return <p className="today-note showcase-not-included">{children}</p>;
}

function offeredEnds(snapshot: ShowcaseSnapshot): string {
  return snapshot.selections.trendsEndDates.map(formatCheckInDate).join(' and ');
}

export function ShowcaseToday({ dispatch, snapshot, state }: { dispatch: Dispatch; snapshot: ShowcaseSnapshot; state: ShowcaseState }) {
  const overview = snapshot.responses.dailyOverview[state.day];
  const dateLabel = formatCheckInDate(state.day);
  const week = offeredWeekOf(snapshot, state.day);
  const trendsOffered = snapshot.selections.trendsEndDates.includes(state.day);
  return (
    <section aria-labelledby="today-title" className="activity-shell today-shell">
      <Heading eyebrow="Daily overview" id="today-title" title="Today" />
      <p>One day of the synthetic person&apos;s check-in, movement, meals, manual activities, imports and GPS runs, as the application&apos;s Today view showed it. It describes what was recorded; a value that was not recorded is shown as not recorded, never as zero. The text of a check-in note is not part of the snapshot.</p>
      <div className="today-controls">
        <label>
          Date
          <select onChange={(event) => dispatch({ kind: 'choose-day', localDate: event.target.value })} value={state.day}>
            {snapshot.selections.days.map((day) => (
              <option key={day} value={day}>{formatCheckInDate(day)}{day === snapshot.selections.sampleDate ? ' (sample date)' : ''}</option>
            ))}
          </select>
        </label>
        <button
          aria-label={week === null ? 'Weekly review' : `Weekly review of ${formatWeek(week)}`}
          disabled={week === null}
          onClick={() => dispatch({ kind: 'review-of-day' })}
          type="button"
        >
          Weekly review
        </button>
        {trendsOffered && (
          <button aria-label={`Open 28-day trends ending on ${dateLabel}`} onClick={() => dispatch({ kind: 'trends-of-day' })} type="button">
            28-day trends
          </button>
        )}
        <button aria-label={`Logged meals of ${dateLabel}`} onClick={() => dispatch({ kind: 'meals-of-day' })} type="button">
          Logged meals
        </button>
        <BackToTrends dispatch={dispatch} state={state} />
      </div>
      {!trendsOffered && <NotIncluded>28-day trends in this showcase end on {offeredEnds(snapshot)}; open them from the Trends view.</NotIncluded>}
      <p className="today-day">
        Showing <strong>{dateLabel}</strong>
        {state.day === snapshot.selections.sampleDate ? ' (sample date)' : ''} in the time zone {snapshot.dataset.timeZone}.
      </p>
      <div className="today-body" data-showcase-day={state.day}>
        {overview === undefined ? <MissingResponse what={`the overview of ${dateLabel}`} /> : <OverviewContent overview={overview} />}
      </div>
    </section>
  );
}

function MissingResponse({ what }: { what: string }) {
  return <p className="run-share__failure" role="alert">This snapshot does not include {what}.</p>;
}

export function ShowcaseReview({ dispatch, snapshot, state }: { dispatch: Dispatch; snapshot: ShowcaseSnapshot; state: ShowcaseState }) {
  const review = snapshot.responses.weeklyReview[state.week];
  const trends = trendsEndOfWeek(snapshot, state.week);
  const endLabel = formatCheckInDate(trends.endDate);
  const lastDate = formatCheckInDate(policyToday(snapshot));
  return (
    <section aria-labelledby="review-title" className="activity-shell review-shell">
      <div className="review-panel search-results">
        <Heading eyebrow="Monday to Sunday" id="review-title" title="Weekly review" />
        <p className="insight-panel__positioning">
          <span className="review-badge">Computed by the app</span> Counted from the synthetic person&apos;s check-ins, manual activities,
          GPS runs, manually entered movement and logged meals. No AI model writes this section. It describes what was recorded; it
          is not medical advice.
        </p>
        <div className="insight-panel__controls">
          <label>
            Week
            <select onChange={(event) => dispatch({ kind: 'choose-week', weekStart: event.target.value })} value={state.week}>
              {snapshot.selections.weeks.map((week) => (
                <option key={week} value={week}>{formatWeek(week)}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="review-journey">
          {trends.offered ? (
            <button aria-label={`Open 28-day trends ending on ${endLabel}`} onClick={() => dispatch({ kind: 'trends-of-week' })} type="button">
              {`28-day trends ending ${endLabel}`}
            </button>
          ) : (
            <NotIncluded>
              This week&apos;s 28-day trends would end on {endLabel}; this showcase includes the ranges ending on {offeredEnds(snapshot)}.
            </NotIncluded>
          )}
          <p className="today-note">
            {isCompletedWeek(state.week, policyToday(snapshot))
              ? 'The range ends on this week’s Sunday.'
              : `This week continues after the snapshot’s last date, ${lastDate}, so the range ends on that date.`}
          </p>
        </div>
        <p className="today-day">
          Showing <strong>{formatWeek(state.week)}</strong>.
        </p>
        <div className="insight-panel__body" data-showcase-week={state.week}>
          {review === undefined ? <MissingResponse what={`the review of ${formatWeek(state.week)}`} /> : <ReviewContent review={review} />}
        </div>
      </div>
    </section>
  );
}

export function ShowcaseTrends({ dispatch, snapshot, state }: { dispatch: Dispatch; snapshot: ShowcaseSnapshot; state: ShowcaseState }) {
  const trends = snapshot.responses.dailyTrends[state.trendsEnd];
  const range = trends?.range ?? { ...dailyTrendsRangeOf(state.trendsEnd), requestedDays: DAILY_TRENDS_RANGE_DAYS };
  const back = { endDate: state.trendsEnd, metric: state.metric };
  return (
    <section aria-labelledby="trends-title" className="activity-shell today-shell trends-shell">
      <Heading eyebrow="28-day view" id="trends-title" title="Trends" />
      <p>
        The synthetic person&apos;s recorded weight, sleep duration, steps, food energy, protein, carbohydrate and fat, and the activity
        they logged, for the 28 calendar dates ending on the chosen date. It shows what was recorded and how much of the range that
        covers; it sets no targets, makes no predictions and gives no advice.
      </p>
      <div className="today-controls">
        <label>
          End date
          <select onChange={(event) => dispatch({ kind: 'choose-trends-end', endDate: event.target.value })} value={state.trendsEnd}>
            {snapshot.selections.trendsEndDates.map((endDate) => (
              <option key={endDate} value={endDate}>{formatCheckInDate(endDate)}</option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="trends-metrics">
        <legend>Series</legend>
        {trendMetricOptions.map((option) => (
          <label key={option.metric}>
            <input checked={option.metric === state.metric} name="trends-metric" onChange={() => dispatch({ kind: 'choose-metric', metric: option.metric })} type="radio" value={option.metric} />
            {option.label}
          </label>
        ))}
      </fieldset>
      <p className="today-day">
        Range: <strong>{rangeLabel(range)}</strong>. Every record counts on the calendar date it was saved for.
      </p>
      <div className="today-body" data-showcase-trends={state.trendsEnd}>
        {trends === undefined ? (
          <MissingResponse what={`the range ending ${formatCheckInDate(state.trendsEnd)}`} />
        ) : (
          <TrendsContent
            mealAction={readOnlyMealWords}
            metric={state.metric}
            onOpenDay={(localDate) => dispatch({ kind: 'open-day-from-trends', back, localDate })}
            onOpenMealLog={(localDate, from) => dispatch({ kind: 'open-meals-from-trends', back: from, localDate })}
            timeZone={snapshot.dataset.timeZone}
            trends={trends}
          />
        )}
      </div>
      <ShowcaseActivity dispatch={dispatch} snapshot={snapshot} state={state} />
    </section>
  );
}

/** Trends' Activity section, offering only the sources and types the snapshot includes. */
function ShowcaseActivity({ dispatch, snapshot, state }: { dispatch: Dispatch; snapshot: ShowcaseSnapshot; state: ShowcaseState }) {
  const { activity, measure } = state;
  const offered = [...snapshot.selections.activity].sort(compareActivitySelections);
  const sources = [...new Set(offered.map((selection) => selection.source))];
  const types = offered.filter((selection) => selection.source === activity.source).map((selection) => selection.type);
  const trends = snapshot.responses.activityTrends[showcaseActivityKey(state.trendsEnd, activity)];
  const labels = activityTrendMeasureLabels(activity.source);
  const chooseSource = (source: string) => {
    const first = offered.find((selection) => selection.source === source);
    if (first !== undefined) dispatch({ kind: 'choose-activity', selection: first });
  };
  return (
    <section aria-labelledby="activity-trends-title" className="today-card trends-card activity-trends">
      <h2 id="activity-trends-title">Activity</h2>
      <p>
        What was logged of one source and one activity type on each date of the same range, compared with the 28 dates before it.
        An item counts on the date it started in {snapshot.dataset.timeZone}. Sources are never added together.
      </p>
      <div className="today-controls activity-trends__filters">
        <label>
          Source
          <select onChange={(event) => chooseSource(event.target.value)} value={activity.source}>
            {sources.map((source) => (
              <option key={source} value={source}>{activityTrendSourceLabels[source]}</option>
            ))}
          </select>
        </label>
        <label>
          Activity type
          <select
            disabled={types.length === 1}
            onChange={(event) => dispatch({ kind: 'choose-activity', selection: { source: activity.source, type: event.target.value as typeof activity.type } })}
            value={activity.type}
          >
            {types.map((type) => (
              <option key={type} value={type}>{activityTypeLabels[type]}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="today-note">
        Only the sources and types with entries in the synthetic dataset are offered. {activityTrendDurationLabels[activity.source]} is
        this source&apos;s own duration.
      </p>
      <fieldset className="trends-metrics">
        <legend>Measure</legend>
        {ACTIVITY_TREND_MEASURES.map((option) => (
          <label key={option}>
            <input checked={option === measure} name="activity-trends-measure" onChange={() => dispatch({ kind: 'choose-measure', measure: option })} type="radio" value={option} />
            {labels[option]}
          </label>
        ))}
      </fieldset>
      <div className="today-body" data-showcase-activity={`${activity.source}|${activity.type}`}>
        {trends === undefined ? <MissingResponse what="this activity selection" /> : <ActivityTrendsContent measure={measure} trends={trends} />}
      </div>
    </section>
  );
}

export function ShowcaseMeals({ dispatch, snapshot, state }: { dispatch: Dispatch; snapshot: ShowcaseSnapshot; state: ShowcaseState }) {
  const page = snapshot.responses.meals[state.mealsDate];
  const dateLabel = formatCheckInDate(state.mealsDate);
  return (
    <section aria-labelledby="meals-title" className="activity-shell meal-log">
      <Heading eyebrow="Nutrition, read-only" id="meals-title" title="Logged meals" />
      <p>
        The meal entries logged for one date, as the application&apos;s Meal log lists them. The values are totals for the whole entry
        and every value is optional: an empty value is not recorded (unknown), a 0 was recorded as 0. Nothing is estimated.
      </p>
      <div className="meal-log__back">
        <BackToTrends dispatch={dispatch} state={state} />
        <button aria-label={`Open Today on ${dateLabel}`} onClick={() => dispatch({ kind: 'open-day', localDate: state.mealsDate })} type="button">
          Open Today on this date
        </button>
      </div>
      <p className="today-day">
        Showing <strong>{dateLabel}</strong>.
      </p>
      <section aria-labelledby="meal-list-title" className="search-results" data-showcase-meals={state.mealsDate}>
        <h2 id="meal-list-title">Entries for {dateLabel}</h2>
        {page === undefined && <MissingResponse what={`the meals of ${dateLabel}`} />}
        {page !== undefined && page.items.length === 0 && (
          <p className="search-results__empty">Nothing is logged for {dateLabel}. That is unknown, not zero: no entry was made.</p>
        )}
        {page !== undefined && page.items.length > 0 && (
          <ul aria-label={`Entries for ${dateLabel}`} className="run-cards">
            {page.items.map((view) => (
              <li className="run-card" key={view.mealId}>
                <MealEntryValues view={view} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
