import { DATA_QUESTION_TEXT_MAX, type DataQuestionActivitySource, type DataQuestionAnswer, type DataQuestionPlan } from '@running-tracker/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { activityComparisonView } from './activity-trends.js';
import {
  checkInRows,
  gpsDistanceText,
  gpsRunsSummary,
  importedActivitiesSummary,
  isNoteOnlyCheckIn,
  manualActivitiesSummary,
  movementRows,
  tcxImportedActivitiesSummary,
  type LabelledValue,
  type TodayAction,
} from './daily-overview.js';
import {
  answerProvenanceLine,
  clarificationText,
  dataQuestionSourceLabels,
  planPreview,
  PREDEFINED_QUESTIONS,
  sourceActionOf,
  sourceChoicesFor,
  unsupportedText,
} from './data-question.js';
import { DataQuestionController, type AskSnapshot, type DataQuestionApi } from './data-question-controller.js';
import { mealsSummary, mealTotalRows } from './meal-log.js';
import { answerDataQuestion, interpretDataQuestion, readDataQuestionCapabilities, resolveDataQuestionPlan, type CsrfCredentials } from './runner-api.js';
import { MEAL_COVERAGE_EXPLANATION, mealWeekRows } from './weekly-review-meals.js';
import { movementTotalRows } from './WeeklyReviewPanel.js';

// "Ask my data" on Today (ADR-0094): one question at a time over the person's own daily overview, weekly review and
// 28-day activity comparison. Predefined questions need no model; a typed question (when the server offers it) becomes a
// plan to review first. Every figure shown is a field of the existing service's answer, worded by the same helpers as
// Today, the weekly review and Trends, with its unit, coverage and source. Nothing here is stored.

function Rows({ label, rows }: { label: string; rows: LabelledValue[] }) {
  return (
    <dl aria-label={label} className="today-rows">
      {rows.map((row) => (
        <div className={row.value === 'Not recorded' ? 'today-rows__missing' : undefined} key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PlanPreviewView({ plan }: { plan: DataQuestionPlan }) {
  const preview = planPreview(plan);
  return (
    <dl aria-label="Question plan" className="ask-plan">
      <div><dt>What</dt><dd>{preview.subject}</dd></div>
      <div><dt>Period</dt><dd>{preview.period}</dd></div>
      <div><dt>Source</dt><dd>{preview.source}</dd></div>
    </dl>
  );
}

function DayAnswer({ answer }: { answer: Extract<DataQuestionAnswer, { operation: 'day_overview' }> }) {
  const overview = answer.result;
  const { checkIn, gpsRuns, importedActivities, meals, movement, tcxImportedActivities } = overview;
  const distance = gpsDistanceText(gpsRuns);
  return (
    <>
      <h4>Check-in</h4>
      {!checkIn.recorded && <p className="today-missing">No check-in for this day.</p>}
      {checkIn.recorded && isNoteOnlyCheckIn(checkIn) && <p>Only a note was saved for this day; it has no values.</p>}
      {checkIn.recorded && !isNoteOnlyCheckIn(checkIn) && <Rows label="Check-in values" rows={checkInRows(checkIn)} />}
      <h4>Steps and active energy (entered by hand)</h4>
      {movement.recorded ? <Rows label="Movement values" rows={movementRows(movement)} /> : <p className="today-missing">No movement recorded for this day.</p>}
      <h4>Meals (logged by hand)</h4>
      <p className={meals.count === 0 ? 'today-missing' : undefined}>{mealsSummary(meals)}</p>
      {mealTotalRows(meals).length > 0 && (
        <dl aria-label="Recorded meal totals" className="today-meal-totals">
          {mealTotalRows(meals).map((row) => (
            <div className={row.recorded ? undefined : 'today-meal-totals__missing'} key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
              <dd className="today-meal-totals__coverage">{row.coverage}</dd>
            </div>
          ))}
        </dl>
      )}
      <h4>Activities and GPS runs</h4>
      <ul className="ask-list">
        <li>{manualActivitiesSummary(overview)}</li>
        {importedActivities.count > 0 && <li>{importedActivitiesSummary(overview)}</li>}
        {tcxImportedActivities.count > 0 && <li>{tcxImportedActivitiesSummary(overview)}</li>}
        <li>{gpsRunsSummary(gpsRuns)}{distance === null ? '' : ` ${distance}`}</li>
      </ul>
      <p className="today-note">
        Each source is shown on its own and never added to another; food energy is not combined with active energy. A value
        that was not recorded is unknown, not zero.
      </p>
    </>
  );
}

function WeekAnswer({ answer }: { answer: Extract<DataQuestionAnswer, { operation: 'weekly_review' }> }) {
  const { result } = answer;
  const zoneNote =
    result.week.timeZoneSource === 'check_ins'
      ? `The week's days begin and end in ${result.week.timeZone}, the zone saved on your check-ins.`
      : `The week's days begin and end in ${result.week.timeZone}.`;
  return (
    <>
      {result.week.inProgress && <p className="today-note">The week is still in progress; Refresh shows what was added since.</p>}
      {result.focus === 'nutrition' && (
        <>
          <h4>Recorded nutrition (logged by hand)</h4>
          {result.meals.loggedEntries === 0 ? (
            <p className="today-missing">No meals were logged in this week.</p>
          ) : (
            <>
              <Rows label="Recorded nutrition of the week" rows={mealWeekRows(result.meals)} />
              <p className="today-note">{MEAL_COVERAGE_EXPLANATION}</p>
            </>
          )}
        </>
      )}
      {result.focus === 'movement' && (
        <>
          <h4>Steps and active energy (entered by hand)</h4>
          <Rows label="Movement of the week" rows={movementTotalRows(result.movement)} />
          <p className="today-note">A day without a value is unknown, not zero. Movement is never added to activities or GPS runs.</p>
        </>
      )}
      {result.focus === 'overview' && (
        <Rows
          label="Coverage of the week"
          rows={[
            { label: 'Days with check-in values', value: `${result.coverage.daysWithCheckInValues} of 7` },
            { label: 'Manual activities', value: String(result.coverage.manualActivities.count) },
            { label: 'GPX imports', value: String(result.importedActivities.count) },
            { label: 'TCX imports', value: String(result.tcxImportedActivities.count) },
            { label: 'GPS runs', value: `${result.coverage.gpsRuns.count} (${result.coverage.gpsRuns.withCurrentDistance} with a current distance)` },
          ]}
        />
      )}
      {result.statements.length > 0 && (
        <ul aria-label="What the review says" className="ask-list">
          {result.statements.map((statement) => (
            <li key={statement.code}>{statement.text}</li>
          ))}
        </ul>
      )}
      <p className="today-note">{zoneNote}</p>
    </>
  );
}

function ComparisonAnswer({ answer }: { answer: Extract<DataQuestionAnswer, { operation: 'activity_comparison' }> }) {
  const view = activityComparisonView(answer.result);
  if (view === null) return null;
  return (
    <>
      <p>
        <span className="review-badge">{dataQuestionSourceLabels[answer.result.source]}</span> This period: {view.periods.current}.
        Previous: {view.periods.previous}.
      </p>
      <dl aria-label="Comparison with the previous 28 days" className="ask-comparison">
        {view.rows.map((row) => (
          <div key={row.measure}>
            <dt>{row.label}</dt>
            <dd>
              This period: {row.current.value}
              {row.current.detail === null ? '' : ` (${row.current.detail})`}
            </dd>
            <dd>
              Previous: {row.previous.value}
              {row.previous.detail === null ? '' : ` (${row.previous.detail})`}
            </dd>
            <dd>
              Change: {row.change.value}
              {row.change.detail === null ? '' : ` — ${row.change.detail}`}
            </dd>
          </div>
        ))}
      </dl>
      {view.notes.map((note) => (
        <p className="today-note" key={note}>{note}</p>
      ))}
    </>
  );
}

export function AnswerView({ answer, timeZone }: { answer: DataQuestionAnswer; timeZone: string }) {
  return (
    <div className="ask-answer">
      {answer.operation === 'day_overview' && <DayAnswer answer={answer} />}
      {answer.operation === 'weekly_review' && <WeekAnswer answer={answer} />}
      {answer.operation === 'activity_comparison' && <ComparisonAnswer answer={answer} />}
      <p className="today-meta">{answerProvenanceLine(answer, timeZone)}</p>
    </div>
  );
}

export interface AskMyDataHandlers {
  ask: (id: string) => void;
  cancel: () => void;
  chooseSource: (source: DataQuestionActivitySource) => void;
  dismiss: () => void;
  execute: () => void;
  interpret: () => void;
  openSource: (answer: DataQuestionAnswer) => void;
  refresh: () => void;
  retry: () => void;
  textChange: (text: string) => void;
}

export interface AskMyDataViewProps {
  handlers: AskMyDataHandlers;
  snapshot: AskSnapshot;
  text: string;
}

/** Everything the section shows, from one snapshot. Pure, so every state is testable without a DOM. */
export function AskMyDataView({ handlers, snapshot, text }: AskMyDataViewProps) {
  const { capability, context, state } = snapshot;
  const busy = state.kind === 'interpreting' || state.kind === 'answering' || (state.kind === 'ready' && state.refreshing);
  const textLength = [...text].length;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && text.trim() !== '' && textLength <= DATA_QUESTION_TEXT_MAX) handlers.interpret();
  };
  return (
    <section aria-labelledby="ask-title" className="today-card ask-card" data-ask-state={state.kind}>
      <h2 id="ask-title">Ask my data</h2>
      <p>
        Questions about your own records for {context.selectedDate} or its week, in {context.timeZone}. Answers are counted by
        the app from what you recorded; they give no advice, estimates or predictions, and nothing is stored.
      </p>

      {capability === 'available' && (
        <form className="ask-form" onSubmit={submit}>
          <label htmlFor="ask-text">Ask in your own words (English or Russian)</label>
          <input
            aria-describedby="ask-text-help"
            disabled={busy}
            id="ask-text"
            maxLength={DATA_QUESTION_TEXT_MAX}
            onChange={(event) => handlers.textChange(event.target.value)}
            type="text"
            value={text}
          />
          <p className="today-note" id="ask-text-help">
            Only your question, the selected date and the time zone are used to interpret it; your records are not. You review
            what will be read before anything is read. {textLength}/{DATA_QUESTION_TEXT_MAX}
          </p>
          <button disabled={busy || text.trim() === ''} type="submit">Interpret question</button>
        </form>
      )}
      {(capability === 'off' || capability === 'unavailable') && (
        <p className="today-note">Typed questions are not available here right now; the questions below work without them.</p>
      )}

      <div aria-label="Predefined questions" className="ask-questions" role="group">
        {PREDEFINED_QUESTIONS.map((question) => (
          <button disabled={busy} key={question.id} onClick={() => handlers.ask(question.id)} type="button">
            {question.label}
          </button>
        ))}
      </div>

      <div aria-busy={busy} aria-live="polite" className="ask-status">
        {state.kind === 'interpreting' && (
          <div className="ask-row">
            <p className="search-results__loading">Interpreting your question…</p>
            <button onClick={handlers.cancel} type="button">Cancel</button>
          </div>
        )}
        {state.kind === 'proposal' && (
          <section aria-label="Review the question before reading" className="ask-review">
            <h3>Check what will be read</h3>
            <p>Nothing has been read yet.</p>
            <PlanPreviewView plan={state.plan} />
            <div className="run-card__actions">
              <button onClick={handlers.execute} type="button">Get answer</button>
              <button onClick={handlers.dismiss} type="button">Discard</button>
            </div>
          </section>
        )}
        {state.kind === 'answering' && (
          <div className="ask-review">
            {state.plan !== null && <PlanPreviewView plan={state.plan} />}
            <div className="ask-row">
              <p className="search-results__loading">Reading your records…</p>
              <button onClick={handlers.cancel} type="button">Cancel</button>
            </div>
          </div>
        )}
        {state.kind === 'ready' && (
          <section aria-label="Answer" className="ask-review">
            <h3>{planPreview(state.answer.plan).subject}</h3>
            <PlanPreviewView plan={state.answer.plan} />
            <AnswerView answer={state.answer} timeZone={context.timeZone} />
            <div className="run-card__actions">
              <button onClick={() => handlers.openSource(state.answer)} type="button">{sourceActionOf(state.answer).label}</button>
              <button disabled={state.refreshing} onClick={handlers.refresh} type="button">{state.refreshing ? 'Updating…' : 'Refresh answer'}</button>
              {state.refreshing && <button onClick={handlers.cancel} type="button">Cancel</button>}
              <button onClick={handlers.dismiss} type="button">New question</button>
            </div>
          </section>
        )}
        {state.kind === 'clarify' && (
          <div className="ask-review" role="status">
            <p>{clarificationText[state.reason]}</p>
            {state.reason === 'activity_source_missing' && state.sourceChoice !== null && (
              <div aria-label="Choose one source" className="ask-questions" role="group">
                {sourceChoicesFor(state.sourceChoice.type).map((source) => (
                  <button key={source} onClick={() => handlers.chooseSource(source)} type="button">
                    {dataQuestionSourceLabels[source]}
                  </button>
                ))}
              </div>
            )}
            <button onClick={handlers.dismiss} type="button">Discard</button>
          </div>
        )}
        {state.kind === 'unsupported' && (
          <div className="ask-review" role="status">
            <p>{unsupportedText[state.reason]}</p>
            <button onClick={handlers.dismiss} type="button">Discard</button>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="run-share__failure" role="alert">
            <span>{state.message}</span>
            {state.retryable && <button onClick={handlers.retry} type="button">Retry</button>}
            <button onClick={handlers.dismiss} type="button">Dismiss</button>
          </div>
        )}
      </div>
    </section>
  );
}

export interface AskMyDataSectionProps {
  /** For tests: replaces the HTTP routes. */
  api?: DataQuestionApi;
  csrf: CsrfCredentials;
  onAction: (action: TodayAction) => void;
  /** Shows a date on Today (an answer's "Show on Today"). */
  onSelectDate: (localDate: string) => void;
  orgId: string;
  selectedDate: string;
  signal: AbortSignal;
  timeZone: string;
}

/**
 * The section and its controller. Today mounts it keyed by session, person and organization; a new selected date or zone
 * clears the question's state, and the controller dies with the screen or the session.
 */
export function AskMyDataSection({ api, csrf, onAction, onSelectDate, orgId, selectedDate, signal, timeZone }: AskMyDataSectionProps) {
  const csrfRef = useRef(csrf);
  csrfRef.current = csrf;
  const apiRef = useRef<DataQuestionApi>(
    api ?? {
      answer: (plan, requestSignal) => answerDataQuestion(orgId, plan, csrfRef.current, requestSignal),
      capabilities: (org, requestSignal) => readDataQuestionCapabilities(org, requestSignal),
      interpret: (context, text, requestSignal) => interpretDataQuestion({ ...context, orgId }, text, csrfRef.current, requestSignal),
      plan: (context, intent, requestSignal) => resolveDataQuestionPlan({ ...context, orgId }, intent, csrfRef.current, requestSignal),
    },
  );
  const contextRef = useRef({ selectedDate, timeZone });
  contextRef.current = { selectedDate, timeZone };
  const controller = useRef<DataQuestionController | null>(null);
  const [snapshot, setSnapshot] = useState<AskSnapshot>(() => ({ capability: 'checking', context: { selectedDate, timeZone }, state: { kind: 'idle' } }));
  const [text, setText] = useState('');

  useEffect(() => {
    const next = new DataQuestionController({ api: apiRef.current, context: contextRef.current, onChange: setSnapshot, orgId, signal });
    controller.current = next;
    setSnapshot(next.snapshot);
    next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [orgId, signal]);

  useEffect(() => {
    controller.current?.setContext({ selectedDate, timeZone });
  }, [selectedDate, timeZone]);

  const handlers: AskMyDataHandlers = {
    ask: (id) => {
      const question = PREDEFINED_QUESTIONS.find((candidate) => candidate.id === id);
      if (question !== undefined) controller.current?.ask(question.intent);
    },
    cancel: () => controller.current?.cancel(),
    chooseSource: (source) => controller.current?.chooseSource(source),
    dismiss: () => controller.current?.dismiss(),
    execute: () => controller.current?.execute(),
    interpret: () => controller.current?.interpret(text),
    openSource: (answer) => {
      const { action } = sourceActionOf(answer);
      if (action.kind === 'select-date') onSelectDate(action.localDate);
      else onAction(action);
    },
    refresh: () => controller.current?.refresh(),
    retry: () => controller.current?.retry(),
    textChange: setText,
  };

  return <AskMyDataView handlers={handlers} snapshot={snapshot} text={text} />;
}
