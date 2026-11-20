import {
  ACTIVITY_TYPES,
  DATA_QUESTION_ACTIVITY_SOURCES,
  DATA_QUESTION_DAY_PERIODS,
  DATA_QUESTION_OPERATIONS,
  DATA_QUESTION_WEEK_PERIODS,
  DATA_QUESTION_WEEKLY_FOCUSES,
  dataQuestionIntentSchema,
  type ActivityType,
  type DataQuestionActivitySource,
  type DataQuestionClarificationReason,
  type DataQuestionDayPeriod,
  type DataQuestionIntent,
  type DataQuestionOperation,
  type DataQuestionSourceChoice,
  type DataQuestionWeekPeriod,
  type DataQuestionWeeklyFocus,
} from '@running-tracker/contracts';

import { activityTrendTypesFor } from './activity-trends.js';

// The guided question builder of "Ask my data" (ADR-0095), as pure rules. A draft holds the person's closed choices and
// nothing else: every field starts empty, nothing is defaulted, the source is never inferred, and an incomplete or
// incompatible draft is never an intent. The complete intent is checked against the contract before it may be sent.

export type GuidedField = 'focus' | 'operation' | 'period' | 'source' | 'type';

export interface GuidedDraft {
  focus: DataQuestionWeeklyFocus | null;
  operation: DataQuestionOperation | null;
  period: DataQuestionDayPeriod | DataQuestionWeekPeriod | null;
  source: DataQuestionActivitySource | null;
  type: ActivityType | null;
}

export const EMPTY_GUIDED_DRAFT: GuidedDraft = Object.freeze({ focus: null, operation: null, period: null, source: null, type: null });

/** What the draft still needs, in the order of the form; `type_incompatible` is recorded runs with another type. */
export type GuidedProblem = 'focus' | 'operation' | 'period' | 'source' | 'type' | 'type_incompatible';

/** The periods a view takes: a day (or a comparison's last date) or a Monday-to-Sunday week. */
export function periodChoicesFor(operation: DataQuestionOperation | null): readonly (DataQuestionDayPeriod | DataQuestionWeekPeriod)[] {
  if (operation === null) return [];
  return operation === 'weekly_review' ? DATA_QUESTION_WEEK_PERIODS : DATA_QUESTION_DAY_PERIODS;
}

/** Every type, with the ones the chosen source does not have disabled (recorded runs are runs only). */
export function guidedTypeChoices(source: DataQuestionActivitySource | null): Array<{ enabled: boolean; type: ActivityType }> {
  const allowed: readonly ActivityType[] = source === null ? ACTIVITY_TYPES : activityTrendTypesFor(source);
  return ACTIVITY_TYPES.map((type) => ({ enabled: allowed.includes(type), type }));
}

const periodFits = (draft: GuidedDraft) => draft.period !== null && (periodChoicesFor(draft.operation) as readonly string[]).includes(draft.period);

export function guidedProblems(draft: GuidedDraft): GuidedProblem[] {
  if (draft.operation === null) return ['operation'];
  const problems: GuidedProblem[] = [];
  if (!periodFits(draft)) problems.push('period');
  if (draft.operation === 'weekly_review' && draft.focus === null) problems.push('focus');
  if (draft.operation === 'activity_comparison') {
    if (draft.source === null) problems.push('source');
    if (draft.type === null) problems.push('type');
    else if (draft.source !== null && !activityTrendTypesFor(draft.source).includes(draft.type)) problems.push('type_incompatible');
  }
  return problems;
}

/** The intent of a complete draft, accepted by the contract; null otherwise. Never fills a field. */
export function guidedIntentOf(draft: GuidedDraft): DataQuestionIntent | null {
  if (guidedProblems(draft).length > 0) return null;
  const candidate =
    draft.operation === 'day_overview'
      ? { operation: draft.operation, period: draft.period }
      : draft.operation === 'weekly_review'
        ? { focus: draft.focus, operation: draft.operation, period: draft.period }
        : { operation: draft.operation, period: draft.period, source: draft.source, type: draft.type };
  const parsed = dataQuestionIntentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const CHOICES: Record<GuidedField, readonly string[]> = {
  focus: DATA_QUESTION_WEEKLY_FOCUSES,
  operation: DATA_QUESTION_OPERATIONS,
  period: [...DATA_QUESTION_DAY_PERIODS, ...DATA_QUESTION_WEEK_PERIODS],
  source: DATA_QUESTION_ACTIVITY_SOURCES,
  type: ACTIVITY_TYPES,
};

/**
 * One field changed. A new view clears the fields of the other views (the period is kept only where the new view takes
 * it); any other field changes alone. A value that is not a choice of the field (or a period of another view) is ignored,
 * and the same draft object is returned so the caller can tell nothing changed.
 */
export function updateGuidedDraft(draft: GuidedDraft, field: GuidedField, value: string | null): GuidedDraft {
  const choices = Object.hasOwn(CHOICES, field) ? CHOICES[field] : undefined;
  if (choices === undefined || (value !== null && !choices.includes(value))) return draft;
  if (field === 'operation') {
    const operation = value as DataQuestionOperation | null;
    const period = draft.period !== null && (periodChoicesFor(operation) as readonly string[]).includes(draft.period) ? draft.period : null;
    return { ...EMPTY_GUIDED_DRAFT, operation, period };
  }
  if (field === 'period' && value !== null && !(periodChoicesFor(draft.operation) as readonly string[]).includes(value)) return draft;
  return { ...draft, [field]: value };
}

/**
 * Where a clarification sends the person: the builder at the field to choose, prefilled only with what the reason itself
 * implies (a source or type clarification is about a comparison) and with the server-verified source choice. An ambiguous
 * field is never prefilled with what the model guessed.
 */
export function draftFromClarification(reason: DataQuestionClarificationReason, sourceChoice: DataQuestionSourceChoice | null): { draft: GuidedDraft; focus: GuidedField } {
  switch (reason) {
    case 'activity_source_missing':
      return {
        draft: sourceChoice === null ? { ...EMPTY_GUIDED_DRAFT, operation: 'activity_comparison' } : { ...EMPTY_GUIDED_DRAFT, operation: 'activity_comparison', period: sourceChoice.period, type: sourceChoice.type },
        focus: 'source',
      };
    case 'activity_type_missing':
      return { draft: { ...EMPTY_GUIDED_DRAFT, operation: 'activity_comparison' }, focus: 'type' };
    case 'period_ambiguous':
    case 'operation_ambiguous':
      return { draft: EMPTY_GUIDED_DRAFT, focus: 'operation' };
  }
}
