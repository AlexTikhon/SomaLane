import { describe, expect, it } from 'vitest';

import {
  DATA_QUESTION_CONTRACT_VERSION,
  DATA_QUESTION_TEXT_MAX,
  dataQuestionAnswerRequestSchema,
  dataQuestionIntentSchema,
  dataQuestionInterpretationRequestSchema,
  dataQuestionInterpretationResponseSchema,
  dataQuestionPlanRequestSchema,
  dataQuestionPlanSchema,
  mondayOfLocalDate,
  resolveDataQuestionDay,
  resolveDataQuestionWeek,
  weeklyReviewStatementsFor,
} from './data-questions.js';

const version = DATA_QUESTION_CONTRACT_VERSION;
const dayPlan = { operation: 'day_overview', period: { localDate: '2026-11-18', symbol: 'selected_date' }, timeZone: 'Europe/Warsaw', version };
const weekPlan = {
  focus: 'nutrition',
  operation: 'weekly_review',
  period: { symbol: 'previous_week', weekEnd: '2026-11-15', weekStart: '2026-11-09' },
  timeZone: 'Europe/Warsaw',
  version,
};
const comparisonPlan = {
  compare: 'previous_period',
  operation: 'activity_comparison',
  period: { endDate: '2026-11-18', previousEndDate: '2026-10-21', previousStartDate: '2026-09-24', startDate: '2026-10-22', symbol: 'selected_date' },
  source: 'manual',
  timeZone: 'Europe/Warsaw',
  type: 'run',
  version,
};

describe('data question intents', () => {
  it('accepts exactly the three operations with closed enums', () => {
    expect(dataQuestionIntentSchema.safeParse({ operation: 'day_overview', period: 'yesterday' }).success).toBe(true);
    expect(dataQuestionIntentSchema.safeParse({ focus: 'movement', operation: 'weekly_review', period: 'previous_week' }).success).toBe(true);
    expect(dataQuestionIntentSchema.safeParse({ operation: 'activity_comparison', period: 'today', source: 'gpx', type: 'ride' }).success).toBe(true);
  });

  it('refuses unknown operations, tools, periods, fields and an implied source', () => {
    for (const forged of [
      { operation: 'sql', period: 'today' },
      { operation: 'run_tool', tool: 'delete_meals' },
      { operation: 'day_overview', period: 'last_30_days' },
      { operation: 'day_overview', period: 'today', url: 'https://example.invalid' },
      { operation: 'day_overview', period: 'today', ownerId: '11111111-1111-4111-8111-111111111111' },
      { focus: 'everything', operation: 'weekly_review', period: 'current_week' },
      // "running" alone never names a source.
      { operation: 'activity_comparison', period: 'today', type: 'run' },
      { operation: 'activity_comparison', period: 'today', source: 'all', type: 'run' },
      { operation: 'activity_comparison', period: 'today', source: 'recorded_run', type: 'walk' },
    ]) {
      expect(dataQuestionIntentSchema.safeParse(forged).success, JSON.stringify(forged)).toBe(false);
    }
  });

  it('a plan request carries the context and refuses a date before 2000 or an unknown zone', () => {
    const base = { intent: { operation: 'day_overview', period: 'today' }, selectedDate: '2026-11-18', timeZone: 'Europe/Warsaw', version };
    expect(dataQuestionPlanRequestSchema.safeParse(base).success).toBe(true);
    expect(dataQuestionPlanRequestSchema.safeParse({ ...base, selectedDate: '1999-12-31' }).success).toBe(false);
    expect(dataQuestionPlanRequestSchema.safeParse({ ...base, timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(dataQuestionPlanRequestSchema.safeParse({ ...base, version: 'data-question-0' }).success).toBe(false);
    expect(dataQuestionPlanRequestSchema.safeParse({ ...base, userId: 'x' }).success).toBe(false);
  });
});

describe('the interpretation request', () => {
  const base = { selectedDate: '2026-11-18', text: 'What did I record?', timeZone: 'Europe/Warsaw', version };

  it('bounds the text without cutting it', () => {
    expect(dataQuestionInterpretationRequestSchema.safeParse(base).success).toBe(true);
    expect(dataQuestionInterpretationRequestSchema.safeParse({ ...base, text: 'я'.repeat(DATA_QUESTION_TEXT_MAX) }).success).toBe(true);
    expect(dataQuestionInterpretationRequestSchema.safeParse({ ...base, text: 'я'.repeat(DATA_QUESTION_TEXT_MAX + 1) }).success).toBe(false);
    expect(dataQuestionInterpretationRequestSchema.safeParse({ ...base, text: '   ' }).success).toBe(false);
    expect(dataQuestionInterpretationRequestSchema.safeParse({ ...base, text: 'a\u0000b' }).success).toBe(false);
    expect(dataQuestionInterpretationRequestSchema.safeParse({ ...base, history: [] }).success).toBe(false);
  });
});

describe('executable plans', () => {
  it('accepts consistent plans of each operation', () => {
    for (const plan of [dayPlan, weekPlan, comparisonPlan]) {
      expect(dataQuestionPlanSchema.safeParse(plan).success, plan.operation).toBe(true);
      expect(dataQuestionAnswerRequestSchema.safeParse({ plan, version }).success).toBe(true);
    }
  });

  it('refuses forged plans: misaligned weeks, other comparison periods, unknown fields, owners and tools', () => {
    const forged = [
      { ...weekPlan, period: { ...weekPlan.period, weekEnd: '2026-11-16', weekStart: '2026-11-10' } },
      { ...weekPlan, period: { ...weekPlan.period, weekEnd: '2026-11-22' } },
      { ...comparisonPlan, period: { ...comparisonPlan.period, startDate: '2026-10-01' } },
      { ...comparisonPlan, period: { ...comparisonPlan.period, previousStartDate: '2026-09-01' } },
      { ...comparisonPlan, compare: 'previous_year' },
      { ...comparisonPlan, source: 'recorded_run', type: 'ride' },
      { ...dayPlan, ownerId: '11111111-1111-4111-8111-111111111111' },
      { ...dayPlan, sql: 'select 1' },
      { ...dayPlan, period: { ...dayPlan.period, localDate: '1999-12-31' } },
      { ...dayPlan, period: { ...dayPlan.period, endDate: '2026-11-19' } },
      { ...dayPlan, operation: 'daily_trends' },
      { ...dayPlan, version: 'data-question-2' },
    ];
    for (const plan of forged) expect(dataQuestionPlanSchema.safeParse(plan).success, JSON.stringify(plan)).toBe(false);
  });

  it('keeps a comparison range cut by 2000-01-01 as the activity trends define it', () => {
    const early = {
      ...comparisonPlan,
      period: { endDate: '2000-01-10', previousEndDate: '1999-12-13', previousStartDate: '1999-11-16', startDate: '2000-01-01', symbol: 'selected_date' },
    };
    expect(dataQuestionPlanSchema.safeParse(early).success).toBe(true);
  });
});

describe('the interpretation response', () => {
  it('a source clarification may offer a choice; nothing else carries values', () => {
    const clarify = { outcome: 'clarify', reason: 'activity_source_missing', sourceChoice: { operation: 'activity_comparison', period: 'today', type: 'run' }, version };
    expect(dataQuestionInterpretationResponseSchema.safeParse(clarify).success).toBe(true);
    expect(dataQuestionInterpretationResponseSchema.safeParse({ ...clarify, sourceChoice: { ...clarify.sourceChoice, source: 'manual' } }).success).toBe(false);
    expect(dataQuestionInterpretationResponseSchema.safeParse({ outcome: 'unsupported', reason: 'diagnosis', version }).success).toBe(false);
    expect(dataQuestionInterpretationResponseSchema.safeParse({ outcome: 'unsupported', reason: 'other_person', text: 'model prose', version }).success).toBe(false);
    expect(dataQuestionInterpretationResponseSchema.safeParse({ outcome: 'answer', version }).success).toBe(false);
  });
});

describe('symbolic resolution', () => {
  const context = { selectedDate: '2026-11-04', today: '2026-11-18' };

  it('resolves day periods from the selected date or from today in the requested zone', () => {
    expect(resolveDataQuestionDay('selected_date', context)).toBe('2026-11-04');
    expect(resolveDataQuestionDay('today', context)).toBe('2026-11-18');
    expect(resolveDataQuestionDay('yesterday', context)).toBe('2026-11-17');
    expect(resolveDataQuestionDay('yesterday', { selectedDate: '2026-03-01', today: '2026-03-01' })).toBe('2026-02-28');
  });

  it('resolves Monday-to-Sunday weeks, across month and year boundaries', () => {
    expect(resolveDataQuestionWeek('selected_week', context)).toBe('2026-11-02');
    expect(resolveDataQuestionWeek('current_week', context)).toBe('2026-11-16');
    expect(resolveDataQuestionWeek('previous_week', context)).toBe('2026-11-09');
    // A Sunday belongs to the week that started six days earlier; a Monday starts its own week.
    expect(mondayOfLocalDate('2026-11-22')).toBe('2026-11-16');
    expect(mondayOfLocalDate('2026-11-16')).toBe('2026-11-16');
    expect(resolveDataQuestionWeek('previous_week', { selectedDate: '2027-01-01', today: '2027-01-01' })).toBe('2026-12-21');
    expect(mondayOfLocalDate('2027-01-03')).toBe('2026-12-28');
  });
});

describe('weekly review statements by focus', () => {
  const statements = [
    { code: 'week.in_progress' },
    { code: 'check_ins.recorded_days' },
    { code: 'movement.steps_total' },
    { code: 'meals.logging_limits' },
  ];

  it('keeps the week statements with each focus and only the focus part', () => {
    expect(weeklyReviewStatementsFor('movement', statements).map((s) => s.code)).toEqual(['week.in_progress', 'movement.steps_total']);
    expect(weeklyReviewStatementsFor('nutrition', statements).map((s) => s.code)).toEqual(['week.in_progress', 'meals.logging_limits']);
    expect(weeklyReviewStatementsFor('overview', statements).map((s) => s.code)).toEqual(['week.in_progress', 'check_ins.recorded_days']);
  });
});
