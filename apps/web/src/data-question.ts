import type {
  ActivityHistorySource,
  ActivityType,
  DataQuestionAnswer,
  DataQuestionClarificationReason,
  DataQuestionIntent,
  DataQuestionPlan,
  DataQuestionUnsupportedReason,
} from '@running-tracker/contracts';

import { activityTrendTypesFor, selectionLabel } from './activity-trends.js';
import { formatCheckInDate } from './daily-checkin.js';
import type { TodayAction } from './daily-overview.js';

// Pure helpers of "Ask my data" on Today (ADR-0094): the predefined questions, the plan preview, the fixed wording of
// every reason code, and the typed source action of an answer. No model text ever reaches the screen; every sentence here
// is fixed and reviewed.

export interface PredefinedQuestion {
  id: string;
  intent: DataQuestionIntent;
  label: string;
}

/** Work without any model: each is a symbolic intent the server resolves and executes on the same validated path. */
export const PREDEFINED_QUESTIONS: readonly PredefinedQuestion[] = [
  { id: 'selected-day', intent: { operation: 'day_overview', period: 'selected_date' }, label: 'What did I record for the selected day?' },
  { id: 'week-nutrition', intent: { focus: 'nutrition', operation: 'weekly_review', period: 'current_week' }, label: 'Show my recorded nutrition for this week.' },
  { id: 'last-week-steps', intent: { focus: 'movement', operation: 'weekly_review', period: 'previous_week' }, label: 'How many steps did I log last week?' },
  { id: 'selected-week', intent: { focus: 'overview', operation: 'weekly_review', period: 'selected_week' }, label: 'Show the review of the selected week.' },
  {
    id: 'manual-running',
    intent: { operation: 'activity_comparison', period: 'selected_date', source: 'manual', type: 'run' },
    label: 'Compare my manually entered running with the previous 28 days.',
  },
];

const periodWords = {
  current_week: 'this week',
  previous_week: 'last week',
  selected_date: 'the selected date',
  selected_week: 'the week of the selected date',
  today: 'today',
  yesterday: 'yesterday',
} as const;

const focusWords = { movement: 'steps and active energy', nutrition: 'recorded nutrition', overview: 'the whole week' } as const;

/** The four sources by name, plural: each is kept apart and never combined with another. */
export const dataQuestionSourceLabels: Readonly<Record<ActivityHistorySource, string>> = {
  gpx: 'GPX imports',
  manual: 'Manual entries',
  recorded_run: 'Recorded runs',
  tcx: 'TCX imports',
};

export interface PlanPreview {
  /** What will be read, in words. */
  subject: string;
  /** The resolved period with explicit dates and the zone. */
  period: string;
  /** Where the answer comes from. */
  source: string;
}

/** The plan in words, with every resolved date and the zone stated, for the person to review before anything is read. */
export function planPreview(plan: DataQuestionPlan): PlanPreview {
  switch (plan.operation) {
    case 'day_overview':
      return {
        period: `${formatCheckInDate(plan.period.localDate)} (${periodWords[plan.period.symbol]}), time zone ${plan.timeZone}`,
        source: 'Your daily overview (Today), read once and not stored',
        subject: 'Everything you recorded for one day',
      };
    case 'weekly_review':
      return {
        period: `${formatCheckInDate(plan.period.weekStart)} – ${formatCheckInDate(plan.period.weekEnd)} (${periodWords[plan.period.symbol]}, Monday to Sunday), time zone ${plan.timeZone}`,
        source: 'Your weekly review, read once and not stored',
        subject: `The weekly review: ${focusWords[plan.focus]}`,
      };
    case 'activity_comparison':
      return {
        period: `${formatCheckInDate(plan.period.startDate)} – ${formatCheckInDate(plan.period.endDate)} (28 dates ending ${periodWords[plan.period.symbol]}), compared with ${formatCheckInDate(plan.period.previousStartDate)} – ${formatCheckInDate(plan.period.previousEndDate)}, time zone ${plan.timeZone}`,
        source: `Your 28-day activity trends, ${dataQuestionSourceLabels[plan.source]} only, never combined with another source`,
        subject: `Comparison: ${selectionLabel(plan.source, plan.type)}`,
      };
  }
}

export const clarificationText: Readonly<Record<DataQuestionClarificationReason, string>> = {
  activity_source_missing:
    'Which records should be compared? Manual entries, GPX imports, TCX imports and recorded runs are kept apart and never combined, so choose one.',
  activity_type_missing: 'Which activity type should be compared? Name one, such as running or walking, or use a predefined question.',
  operation_ambiguous: 'This could mean more than one view. Ask about one day, one week, or a 28-day comparison of one activity.',
  period_ambiguous:
    'Which day or week? Questions can use the selected date, today, yesterday, this week, last week or the week of the selected date. Choose a date above and ask about "the selected day".',
};

export const unsupportedText: Readonly<Record<DataQuestionUnsupportedReason, string>> = {
  estimation_or_prediction: 'Estimates, energy balance, predictions and explanations of why are not offered. Answers show only what you recorded.',
  medical_or_coaching: 'Diagnoses, treatment, dietary targets and coaching advice are not offered. Answers show only what you recorded.',
  not_a_data_question: 'This is not a question about your recorded data. Try one of the questions below.',
  other_person: 'Only your own records can be asked about.',
  unsupported_calculation: 'Only one day, one week, or the 28-day comparison of one activity can be answered. Other ranges and calculations are not offered.',
  write_action: 'Ask my data only reads. To add, change or delete records, use the editors.',
};

/** The sources a person can choose for a type: recorded runs are runs only. */
export function sourceChoicesFor(type: ActivityType): readonly ActivityHistorySource[] {
  return (['manual', 'gpx', 'tcx', 'recorded_run'] as const).filter((source) => activityTrendTypesFor(source).includes(type));
}

/** The existing view that shows an answer's figures, as a typed internal action (never a server-provided URL). */
export function sourceActionOf(answer: DataQuestionAnswer): { action: TodayAction | { kind: 'select-date'; localDate: string }; label: string } {
  switch (answer.operation) {
    case 'day_overview':
      return { action: { kind: 'select-date', localDate: answer.plan.period.localDate }, label: `Show ${formatCheckInDate(answer.plan.period.localDate)} on Today` };
    case 'weekly_review':
      return { action: { kind: 'weekly-review', weekStart: answer.plan.period.weekStart }, label: 'Open the weekly review' };
    case 'activity_comparison':
      return {
        action: { kind: 'activity-trends', localDate: answer.plan.period.endDate, source: answer.plan.source, type: answer.plan.type },
        label: 'Open in Trends',
      };
  }
}

/** "Computed 18 Nov 2026, 13:00 by the app from your records; not stored (daily-overview-4)." */
export function answerProvenanceLine(answer: DataQuestionAnswer, timeZone: string): string {
  const computed = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(answer.provenance.computedAt));
  return `Computed ${computed} by the app from your own records; not stored. Source rules ${answer.provenance.serviceVersion}, answer ${answer.provenance.answerVersion}.`;
}
