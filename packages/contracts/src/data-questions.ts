import { z } from 'zod';

import { ACTIVITY_TYPES, activityTypeSchema } from './activities.js';
import { ACTIVITY_HISTORY_SOURCES, activityHistorySourceSchema } from './activity-history.js';
import {
  activityTrendsComparisonModeSchema,
  activityTrendsRangeSchema,
  gpxActivityTrendsComparisonSchema,
  gpxActivityTrendsSummarySchema,
  manualActivityTrendsComparisonSchema,
  manualActivityTrendsSummarySchema,
  previousActivityTrendsPeriodOf,
  recordedRunTrendsComparisonSchema,
  recordedRunTrendsSummarySchema,
  tcxActivityTrendsComparisonSchema,
  tcxActivityTrendsSummarySchema,
} from './activity-trends.js';
import { addLocalDays, DAILY_METRICS_LOCAL_DATE_MIN, dailyMetricsLocalDateSchema } from './daily-metrics.js';
import { dailyOverviewSchema } from './daily-overview.js';
import { dailyTrendsRangeOf } from './daily-trends.js';
import { hasControlCharacter, ianaTimeZoneSchema, localDateSchema, parseLocalDate, timestampSchema } from './primitives.js';
import {
  weeklyReviewCoverageSchema,
  weeklyReviewImportedActivitiesSchema,
  weeklyReviewMealsSchema,
  weeklyReviewMovementSchema,
  weeklyReviewStatementSchema,
  weeklyReviewTcxImportedActivitiesSchema,
  weeklyReviewWeekSchema,
  WEEKLY_REVIEW_STATEMENTS_MAX,
} from './weekly-review.js';
import { weeklyInsightDataGapSchema } from './weekly-insights.js';

// "Ask my data" (ADR-0094): one owner-only, read-only question at a time over THREE existing deterministic reads, the
// daily overview (ADR-0082), the weekly review (ADR-0077/0079/0093) and the activity trends' previous-period comparison
// (ADR-0089/0090). Nothing here adds an analytics definition: every number in an answer is a field of one of those
// services' existing answers, read once, in that service's own snapshot.
//
// Three shapes are kept apart on purpose:
// - an INTENT is symbolic ("the selected week", "yesterday", "manual runs"): what a predefined question or a model
//   interpretation means, with no date in it;
// - a PLAN is what the server resolved the intent to, with explicit dates and the zone, for the person to review. The
//   server resolves symbolic periods with its own clock in the requested zone, never the host's and never the model's;
// - an ANSWER is the result of executing a reviewed plan: exactly one allowlisted service read, projected to an explicit
//   allowlist of that service's fields.
//
// A plan is executed as reviewed: its dates are not resolved again later, so "today" reviewed before midnight is still
// that date after it. The service's own date rules (not after today, week alignment, the 2000-01-01 bound, comparison
// eligibility) still apply when it runs. No request carries an owner, and no answer is stored, cached or logged.

/** The version of the intent, plan and answer shapes. A new meaning gets a new version; nothing is reinterpreted. */
export const DATA_QUESTION_CONTRACT_VERSION = 'data-question-1';
/** At most this many Unicode code points of question text. Longer text is refused, never cut. */
export const DATA_QUESTION_TEXT_MAX = 300;
/** The longest deadline a server may give the interpretation call; a client waits this plus a margin. */
export const DATA_QUESTION_DEADLINE_MAX_MS = 55_000;
export const DATA_QUESTION_CLIENT_WAIT_MS = DATA_QUESTION_DEADLINE_MAX_MS + 5_000;

/** The only operations: each names exactly one existing read service. */
export const DATA_QUESTION_OPERATIONS = ['day_overview', 'weekly_review', 'activity_comparison'] as const;
/** A single local calendar date, relative to the selected date or to today in the requested zone. */
export const DATA_QUESTION_DAY_PERIODS = ['selected_date', 'today', 'yesterday'] as const;
/** A Monday-to-Sunday week: the one containing the selected date, or the current or previous calendar week. */
export const DATA_QUESTION_WEEK_PERIODS = ['selected_week', 'current_week', 'previous_week'] as const;
/** Which part of the weekly review an answer shows. */
export const DATA_QUESTION_WEEKLY_FOCUSES = ['overview', 'movement', 'nutrition'] as const;
export const DATA_QUESTION_ACTIVITY_SOURCES = ACTIVITY_HISTORY_SOURCES;
export const DATA_QUESTION_ACTIVITY_TYPES = ACTIVITY_TYPES;

export const dataQuestionOperationSchema = z.enum(DATA_QUESTION_OPERATIONS);
export const dataQuestionDayPeriodSchema = z.enum(DATA_QUESTION_DAY_PERIODS);
export const dataQuestionWeekPeriodSchema = z.enum(DATA_QUESTION_WEEK_PERIODS);
export const dataQuestionWeeklyFocusSchema = z.enum(DATA_QUESTION_WEEKLY_FOCUSES);

const recordedRunIsRun = {
  message: 'A recorded run is a run: source recorded_run supports only type run',
  path: ['type'],
};

/**
 * A symbolic intent. `activity_comparison` needs ONE explicit source and ONE activity type: the server never infers a
 * source from a type ("running" is not "recorded runs") and never combines sources. Its `period` is the END date of the
 * 28-date range the existing comparison reads.
 */
export const dataQuestionIntentSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('day_overview'), period: dataQuestionDayPeriodSchema }),
  z.strictObject({ focus: dataQuestionWeeklyFocusSchema, operation: z.literal('weekly_review'), period: dataQuestionWeekPeriodSchema }),
  z
    .strictObject({
      operation: z.literal('activity_comparison'),
      period: dataQuestionDayPeriodSchema,
      source: activityHistorySourceSchema,
      type: activityTypeSchema,
    })
    .refine((intent) => intent.source !== 'recorded_run' || intent.type === 'run', recordedRunIsRun),
]);

/** The context a symbolic intent is resolved in: Today's selected date and the zone it is viewed in. */
const contextFields = {
  /** Today's selected date; not before 2000-01-01 and, checked by the server, not after today in `timeZone`. */
  selectedDate: dailyMetricsLocalDateSchema,
  timeZone: ianaTimeZoneSchema,
};

/** Resolve a symbolic intent (a predefined question or an explicit source choice) into a plan. No model is involved. */
export const dataQuestionPlanRequestSchema = z.strictObject({
  ...contextFields,
  intent: dataQuestionIntentSchema,
  version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
});

const dataQuestionTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'The question must not be empty')
  .refine((value) => [...value].length <= DATA_QUESTION_TEXT_MAX, `The question must not exceed ${DATA_QUESTION_TEXT_MAX} characters`)
  .refine((value) => !hasControlCharacter(value), 'The question must not contain control characters')
  .refine((value) => !/\p{Cs}/u.test(value), 'The question must be well-formed Unicode text');

/** Interpret a question in English or Russian. Optional, off by default; the answer is a proposal, never a read. */
export const dataQuestionInterpretationRequestSchema = z.strictObject({
  ...contextFields,
  text: dataQuestionTextSchema,
  version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
});

/** The Monday of the Monday-to-Sunday week that contains `localDate`, by calendar arithmetic. */
export function mondayOfLocalDate(localDate: string): string {
  const parsed = parseLocalDate(localDate);
  if (parsed === null) throw new RangeError('Not a calendar date');
  const weekday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay(); // 0 = Sunday
  return addLocalDays(localDate, -((weekday + 6) % 7));
}

/** The resolved date of a day period. `today` is today's date in the requested zone by the server's clock. */
export function resolveDataQuestionDay(period: DataQuestionDayPeriod, context: { selectedDate: string; today: string }): string {
  switch (period) {
    case 'selected_date':
      return context.selectedDate;
    case 'today':
      return context.today;
    case 'yesterday':
      return addLocalDays(context.today, -1);
  }
}

/** The Monday of the resolved week. */
export function resolveDataQuestionWeek(period: DataQuestionWeekPeriod, context: { selectedDate: string; today: string }): string {
  switch (period) {
    case 'selected_week':
      return mondayOfLocalDate(context.selectedDate);
    case 'current_week':
      return mondayOfLocalDate(context.today);
    case 'previous_week':
      return addLocalDays(mondayOfLocalDate(context.today), -7);
  }
}

const zoneName = z.string().min(1).max(64);
// The zone a plan was resolved in (canonical spelling); a forged plan cannot name a zone the platform does not know.
const planBase = { timeZone: ianaTimeZoneSchema, version: z.literal(DATA_QUESTION_CONTRACT_VERSION) };

/** A reviewed plan for one date. */
export const dataQuestionDayPlanSchema = z.strictObject({
  ...planBase,
  operation: z.literal('day_overview'),
  period: z.strictObject({ localDate: dailyMetricsLocalDateSchema, symbol: dataQuestionDayPeriodSchema }),
});

/** A reviewed plan for one Monday-to-Sunday week (its Sunday stated, so the person reviews both ends). */
export const dataQuestionWeekPlanSchema = z.strictObject({
  ...planBase,
  focus: dataQuestionWeeklyFocusSchema,
  operation: z.literal('weekly_review'),
  period: z
    .strictObject({ symbol: dataQuestionWeekPeriodSchema, weekEnd: dailyMetricsLocalDateSchema, weekStart: dailyMetricsLocalDateSchema })
    .refine((period) => mondayOfLocalDate(period.weekStart) === period.weekStart, { message: 'The week must start on a Monday', path: ['weekStart'] })
    .refine((period) => addLocalDays(period.weekStart, 6) === period.weekEnd, { message: 'The week ends on the Sunday after its Monday', path: ['weekEnd'] }),
});

/**
 * A reviewed plan for the existing 28-date comparison: the range ending on `endDate` (cut only by 2000-01-01) beside the
 * 28 dates before it, as the activity trends define them (ADR-0090). The dates are stated so the person reviews them;
 * the server checks that they are exactly the ones the comparison reads for `endDate`.
 */
export const dataQuestionComparisonPlanSchema = z
  .strictObject({
    ...planBase,
    compare: activityTrendsComparisonModeSchema,
    operation: z.literal('activity_comparison'),
    period: z.strictObject({
      endDate: dailyMetricsLocalDateSchema,
      previousEndDate: localDateSchema,
      previousStartDate: localDateSchema,
      startDate: dailyMetricsLocalDateSchema,
      symbol: dataQuestionDayPeriodSchema,
    }),
    source: activityHistorySourceSchema,
    type: activityTypeSchema,
  })
  .refine((plan) => plan.source !== 'recorded_run' || plan.type === 'run', recordedRunIsRun)
  .refine(
    (plan) => {
      const range = dailyTrendsRangeOf(plan.period.endDate);
      const previous = previousActivityTrendsPeriodOf(plan.period.endDate);
      return (
        range.startDate === plan.period.startDate &&
        previous.requestedStartDate === plan.period.previousStartDate &&
        previous.requestedEndDate === plan.period.previousEndDate
      );
    },
    { message: 'The periods are the ones the comparison reads for this end date', path: ['period'] },
  );

/** An executable plan: exactly one operation, explicit dates and zone. Unknown fields are refused at every level. */
export const dataQuestionPlanSchema = z.discriminatedUnion('operation', [
  dataQuestionDayPlanSchema,
  dataQuestionWeekPlanSchema,
  dataQuestionComparisonPlanSchema,
]);

export const dataQuestionPlanResponseSchema = z.strictObject({
  plan: dataQuestionPlanSchema,
  version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
});

/**
 * Why a question needs the person's help before it can become a plan. The screen owns every sentence.
 * - `activity_source_missing`: an activity comparison without one explicit source (manual, GPX, TCX, recorded runs);
 * - `activity_type_missing`: an activity comparison without one activity type;
 * - `period_ambiguous`: a period that is not one of the supported symbolic periods, or none at all;
 * - `operation_ambiguous`: it could be more than one of the three operations.
 */
export const DATA_QUESTION_CLARIFICATION_REASONS = [
  'activity_source_missing',
  'activity_type_missing',
  'period_ambiguous',
  'operation_ambiguous',
] as const;

/**
 * Why a question is not something this feature does at all.
 * - `other_person`: another person's records;
 * - `medical_or_coaching`: a diagnosis, treatment, dietary target, plan or recommendation;
 * - `estimation_or_prediction`: estimating calories, energy balance, a prediction or a causal explanation;
 * - `unsupported_calculation`: a time range or a calculation outside the three supported reads;
 * - `write_action`: creating, changing, deleting, importing or sharing anything;
 * - `not_a_data_question`: anything else, an instruction to the system included.
 */
export const DATA_QUESTION_UNSUPPORTED_REASONS = [
  'other_person',
  'medical_or_coaching',
  'estimation_or_prediction',
  'unsupported_calculation',
  'write_action',
  'not_a_data_question',
] as const;

export const dataQuestionClarificationReasonSchema = z.enum(DATA_QUESTION_CLARIFICATION_REASONS);
export const dataQuestionUnsupportedReasonSchema = z.enum(DATA_QUESTION_UNSUPPORTED_REASONS);

/**
 * A source choice the screen can offer after `activity_source_missing`: what the question did establish (the type and
 * the symbolic end period). Choosing a source sends a complete intent to the plan route; nothing is read before the
 * person reviews that plan.
 */
export const dataQuestionSourceChoiceSchema = z.strictObject({
  operation: z.literal('activity_comparison'),
  period: dataQuestionDayPeriodSchema,
  type: activityTypeSchema,
});

const interpretationBase = { version: z.literal(DATA_QUESTION_CONTRACT_VERSION) };

/**
 * The interpretation of a question: a plan to REVIEW (nothing was read), a clarification, or a refusal. A proposal's
 * plan was resolved by the same server code as a predefined question's, from symbolic values only.
 */
export const dataQuestionInterpretationResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...interpretationBase, outcome: z.literal('proposal'), plan: dataQuestionPlanSchema }),
  z.strictObject({
    ...interpretationBase,
    outcome: z.literal('clarify'),
    reason: dataQuestionClarificationReasonSchema,
    /** Present only for `activity_source_missing` when the question named a type and a supported period. */
    sourceChoice: dataQuestionSourceChoiceSchema.nullable(),
  }),
  z.strictObject({ ...interpretationBase, outcome: z.literal('unsupported'), reason: dataQuestionUnsupportedReasonSchema }),
]);

/** Execute a reviewed plan. */
export const dataQuestionAnswerRequestSchema = z.strictObject({
  plan: dataQuestionPlanSchema,
  version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
});

/** Where an answer comes from: one existing service, read once, in its own snapshot; never stored. */
export const dataQuestionAnswerProvenanceSchema = z.strictObject({
  answerVersion: z.literal(DATA_QUESTION_CONTRACT_VERSION),
  /** The underlying service's computation time. */
  computedAt: timestampSchema,
  persisted: z.literal(false),
  /** Exactly one existing read service. */
  service: z.enum(['daily_overview', 'weekly_review', 'activity_trends']),
  /** The underlying contract/policy version (overview, review or trends policy). */
  serviceVersion: z.string().min(1).max(64),
});

const statementCodePrefixes = ['week.', 'movement.', 'meals.'] as const;

/** The statements of the weekly review that belong to a focus: always the week's own, plus the focus's part. */
export function weeklyReviewStatementsFor<Statement extends { code: string }>(
  focus: DataQuestionWeeklyFocus,
  statements: readonly Statement[],
): Statement[] {
  return statements.filter((statement) => {
    if (statement.code.startsWith('week.')) return true;
    if (focus === 'movement') return statement.code.startsWith('movement.');
    if (focus === 'nutrition') return statement.code.startsWith('meals.');
    return !statementCodePrefixes.some((prefix) => statement.code.startsWith(prefix));
  });
}

const weekDays = (start: string) => Array.from({ length: 7 }, (_, index) => addLocalDays(start, index));

/** The weekly review parts a focus allows, and nothing else: every other field is left out by construction. */
const weeklyAnswerResultSchema = z.discriminatedUnion('focus', [
  z.strictObject({
    coverage: weeklyReviewCoverageSchema,
    dataGaps: z.array(weeklyInsightDataGapSchema).max(10),
    focus: z.literal('overview'),
    importedActivities: weeklyReviewImportedActivitiesSchema,
    statements: z.array(weeklyReviewStatementSchema).max(WEEKLY_REVIEW_STATEMENTS_MAX),
    tcxImportedActivities: weeklyReviewTcxImportedActivitiesSchema,
    week: weeklyReviewWeekSchema,
  }),
  z
    .strictObject({
      focus: z.literal('movement'),
      movement: weeklyReviewMovementSchema,
      statements: z.array(weeklyReviewStatementSchema).max(WEEKLY_REVIEW_STATEMENTS_MAX),
      week: weeklyReviewWeekSchema,
    })
    .refine((result) => result.movement.days.every((day, index) => day.localDate === weekDays(result.week.start)[index]), {
      message: 'movement days are the week from Monday to Sunday',
      path: ['movement', 'days'],
    }),
  z
    .strictObject({
      focus: z.literal('nutrition'),
      meals: weeklyReviewMealsSchema,
      statements: z.array(weeklyReviewStatementSchema).max(WEEKLY_REVIEW_STATEMENTS_MAX),
      week: weeklyReviewWeekSchema,
    })
    .refine((result) => result.meals.days.every((day, index) => day.localDate === weekDays(result.week.start)[index]), {
      message: 'meal days are the week from Monday to Sunday',
      path: ['meals', 'days'],
    }),
]);

const comparisonApplied = (source: z.ZodType, type: z.ZodType) =>
  z.strictObject({ compare: z.literal('previous_period'), endDate: localDateSchema, source, timeZone: zoneName, type });

/** The comparison of one source and type: its range, summary and comparison (no per-date series), never combined. */
const comparisonAnswerResultSchema = z.discriminatedUnion('source', [
  z.strictObject({
    applied: comparisonApplied(z.literal('manual'), activityTypeSchema),
    comparison: manualActivityTrendsComparisonSchema,
    range: activityTrendsRangeSchema,
    source: z.literal('manual'),
    summary: manualActivityTrendsSummarySchema,
  }),
  z.strictObject({
    applied: comparisonApplied(z.literal('gpx'), activityTypeSchema),
    comparison: gpxActivityTrendsComparisonSchema,
    range: activityTrendsRangeSchema,
    source: z.literal('gpx'),
    summary: gpxActivityTrendsSummarySchema,
  }),
  z.strictObject({
    applied: comparisonApplied(z.literal('tcx'), activityTypeSchema),
    comparison: tcxActivityTrendsComparisonSchema,
    range: activityTrendsRangeSchema,
    source: z.literal('tcx'),
    summary: tcxActivityTrendsSummarySchema,
  }),
  z.strictObject({
    applied: comparisonApplied(z.literal('recorded_run'), z.literal('run')),
    comparison: recordedRunTrendsComparisonSchema,
    range: activityTrendsRangeSchema,
    source: z.literal('recorded_run'),
    summary: recordedRunTrendsSummarySchema,
  }),
]);

/** The answer to an executed plan: the plan as executed, one allowlisted result, and its provenance. */
export const dataQuestionAnswerSchema = z
  .discriminatedUnion('operation', [
    z.strictObject({
      operation: z.literal('day_overview'),
      plan: dataQuestionDayPlanSchema,
      provenance: dataQuestionAnswerProvenanceSchema,
      result: dailyOverviewSchema,
      version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
    }),
    z.strictObject({
      operation: z.literal('weekly_review'),
      plan: dataQuestionWeekPlanSchema,
      provenance: dataQuestionAnswerProvenanceSchema,
      result: weeklyAnswerResultSchema,
      version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
    }),
    z.strictObject({
      operation: z.literal('activity_comparison'),
      plan: dataQuestionComparisonPlanSchema,
      provenance: dataQuestionAnswerProvenanceSchema,
      result: comparisonAnswerResultSchema,
      version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
    }),
  ])
  .refine(
    (answer) => {
      switch (answer.operation) {
        case 'day_overview':
          return answer.result.day.localDate === answer.plan.period.localDate;
        case 'weekly_review':
          return answer.result.focus === answer.plan.focus && answer.result.week.start === answer.plan.period.weekStart;
        case 'activity_comparison':
          return (
            answer.result.source === answer.plan.source &&
            answer.result.applied.type === answer.plan.type &&
            answer.result.range.endDate === answer.plan.period.endDate
          );
      }
    },
    { message: 'The result is the one the plan asked for', path: ['result'] },
  );

/** Whether question interpretation is available on this server. Implementation details are not part of it. */
export const dataQuestionCapabilitiesSchema = z.strictObject({
  interpretation: z.enum(['available', 'off']),
  version: z.literal(DATA_QUESTION_CONTRACT_VERSION),
});

/** Why the interpretation service, not the question, failed. Carried in `details.reason` of 502 DATA_QUESTION_FAILED. */
export const DATA_QUESTION_FAILURE_REASONS = ['incomplete', 'invalid_output', 'oversized', 'provider_error', 'provider_unavailable'] as const;
export const dataQuestionFailureReasonSchema = z.enum(DATA_QUESTION_FAILURE_REASONS);

export const DATA_QUESTION_ERROR_CODES = {
  aborted: 'DATA_QUESTION_ABORTED',
  budgetExhausted: 'DATA_QUESTION_BUDGET_EXHAUSTED',
  busy: 'DATA_QUESTION_BUSY',
  disabled: 'DATA_QUESTION_INTERPRETATION_DISABLED',
  failed: 'DATA_QUESTION_FAILED',
  inProgress: 'DATA_QUESTION_IN_PROGRESS',
  rateLimited: 'DATA_QUESTION_RATE_LIMITED',
  timeout: 'DATA_QUESTION_TIMEOUT',
} as const;

/** The earliest date any operation can resolve to (the data foundation's lower bound). */
export const DATA_QUESTION_DATE_MIN = DAILY_METRICS_LOCAL_DATE_MIN;

export type DataQuestionOperation = z.infer<typeof dataQuestionOperationSchema>;
export type DataQuestionDayPeriod = z.infer<typeof dataQuestionDayPeriodSchema>;
export type DataQuestionWeekPeriod = z.infer<typeof dataQuestionWeekPeriodSchema>;
export type DataQuestionWeeklyFocus = z.infer<typeof dataQuestionWeeklyFocusSchema>;
export type DataQuestionIntent = z.infer<typeof dataQuestionIntentSchema>;
export type DataQuestionPlanRequest = z.infer<typeof dataQuestionPlanRequestSchema>;
export type DataQuestionInterpretationRequest = z.infer<typeof dataQuestionInterpretationRequestSchema>;
export type DataQuestionPlan = z.infer<typeof dataQuestionPlanSchema>;
export type DataQuestionDayPlan = z.infer<typeof dataQuestionDayPlanSchema>;
export type DataQuestionWeekPlan = z.infer<typeof dataQuestionWeekPlanSchema>;
export type DataQuestionComparisonPlan = z.infer<typeof dataQuestionComparisonPlanSchema>;
export type DataQuestionPlanResponse = z.infer<typeof dataQuestionPlanResponseSchema>;
export type DataQuestionClarificationReason = z.infer<typeof dataQuestionClarificationReasonSchema>;
export type DataQuestionUnsupportedReason = z.infer<typeof dataQuestionUnsupportedReasonSchema>;
export type DataQuestionSourceChoice = z.infer<typeof dataQuestionSourceChoiceSchema>;
export type DataQuestionInterpretationResponse = z.infer<typeof dataQuestionInterpretationResponseSchema>;
export type DataQuestionAnswerRequest = z.infer<typeof dataQuestionAnswerRequestSchema>;
export type DataQuestionAnswer = z.infer<typeof dataQuestionAnswerSchema>;
export type DataQuestionAnswerProvenance = z.infer<typeof dataQuestionAnswerProvenanceSchema>;
export type DataQuestionCapabilities = z.infer<typeof dataQuestionCapabilitiesSchema>;
export type DataQuestionFailureReason = z.infer<typeof dataQuestionFailureReasonSchema>;
export type DataQuestionActivitySource = (typeof DATA_QUESTION_ACTIVITY_SOURCES)[number];
