import {
  ACTIVITY_TYPES,
  DATA_QUESTION_ACTIVITY_SOURCES,
  DATA_QUESTION_CLARIFICATION_REASONS,
  DATA_QUESTION_DAY_PERIODS,
  DATA_QUESTION_WEEK_PERIODS,
  DATA_QUESTION_WEEKLY_FOCUSES,
  dataQuestionIntentSchema,
  type DataQuestionIntent,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import {
  draftFromClarification,
  EMPTY_GUIDED_DRAFT,
  guidedIntentOf,
  guidedProblems,
  guidedTypeChoices,
  periodChoicesFor,
  updateGuidedDraft,
  type GuidedDraft,
} from './data-question-guided.js';

// The guided question builder's pure rules (ADR-0095): a draft of closed choices, never a hidden default; an intent only
// when every field the view needs is chosen and the contract accepts it.

const draft = (patch: Partial<GuidedDraft>): GuidedDraft => ({ ...EMPTY_GUIDED_DRAFT, ...patch });

describe('every combination the contracts accept is reachable, and nothing else', () => {
  it('3 day, 9 week and 66 comparison intents', () => {
    const intents: DataQuestionIntent[] = [];
    for (const operation of ['day_overview', 'weekly_review', 'activity_comparison'] as const) {
      for (const period of periodChoicesFor(operation)) {
        if (operation === 'day_overview') intents.push(guidedIntentOf(draft({ operation, period }))!);
        if (operation === 'weekly_review') for (const focus of DATA_QUESTION_WEEKLY_FOCUSES) intents.push(guidedIntentOf(draft({ focus, operation, period }))!);
        if (operation === 'activity_comparison') {
          for (const source of DATA_QUESTION_ACTIVITY_SOURCES) {
            for (const type of guidedTypeChoices(source).filter((choice) => choice.enabled).map((choice) => choice.type)) {
              intents.push(guidedIntentOf(draft({ operation, period, source, type }))!);
            }
          }
        }
      }
    }
    expect(intents).toHaveLength(78);
    expect(new Set(intents.map((intent) => JSON.stringify(intent))).size).toBe(78);
    for (const intent of intents) expect(dataQuestionIntentSchema.safeParse(intent).success, JSON.stringify(intent)).toBe(true);
  });

  it('offers the periods each view takes: day symbols for a day and a comparison end, week symbols for a week', () => {
    expect(periodChoicesFor('day_overview')).toEqual(DATA_QUESTION_DAY_PERIODS);
    expect(periodChoicesFor('activity_comparison')).toEqual(DATA_QUESTION_DAY_PERIODS);
    expect(periodChoicesFor('weekly_review')).toEqual(DATA_QUESTION_WEEK_PERIODS);
    expect(periodChoicesFor(null)).toEqual([]);
  });

  it('offers every type for manual, GPX and TCX, and only run for recorded runs (the others shown disabled)', () => {
    for (const source of ['manual', 'gpx', 'tcx'] as const) expect(guidedTypeChoices(source).every((choice) => choice.enabled)).toBe(true);
    expect(guidedTypeChoices('recorded_run').filter((choice) => choice.enabled).map((choice) => choice.type)).toEqual(['run']);
    expect(guidedTypeChoices('recorded_run').map((choice) => choice.type)).toEqual(ACTIVITY_TYPES);
    expect(guidedTypeChoices(null).every((choice) => choice.enabled)).toBe(true);
  });
});

describe('incomplete and incompatible drafts stay local and are never an intent', () => {
  it('names what is still missing, in the order of the form', () => {
    expect(guidedProblems(EMPTY_GUIDED_DRAFT)).toEqual(['operation']);
    expect(guidedProblems(draft({ operation: 'day_overview' }))).toEqual(['period']);
    expect(guidedProblems(draft({ operation: 'weekly_review' }))).toEqual(['period', 'focus']);
    expect(guidedProblems(draft({ operation: 'weekly_review', period: 'current_week' }))).toEqual(['focus']);
    expect(guidedProblems(draft({ operation: 'activity_comparison' }))).toEqual(['period', 'source', 'type']);
    expect(guidedProblems(draft({ operation: 'activity_comparison', period: 'today', source: 'gpx' }))).toEqual(['type']);
    for (const incomplete of [EMPTY_GUIDED_DRAFT, draft({ operation: 'weekly_review', period: 'current_week' }), draft({ operation: 'activity_comparison', period: 'today', type: 'run' })]) {
      expect(guidedIntentOf(incomplete)).toBeNull();
    }
  });

  it('refuses recorded runs with another type instead of changing either choice', () => {
    const recordedWalk = draft({ operation: 'activity_comparison', period: 'selected_date', source: 'recorded_run', type: 'walk' });
    expect(guidedProblems(recordedWalk)).toEqual(['type_incompatible']);
    expect(guidedIntentOf(recordedWalk)).toBeNull();
    expect(guidedIntentOf({ ...recordedWalk, type: 'run' })).toEqual({ operation: 'activity_comparison', period: 'selected_date', source: 'recorded_run', type: 'run' });
  });

  it('never accepts a period of the wrong view, even if one is somehow present', () => {
    expect(guidedIntentOf(draft({ focus: 'overview', operation: 'weekly_review', period: 'today' }))).toBeNull();
    expect(guidedProblems(draft({ focus: 'overview', operation: 'weekly_review', period: 'today' }))).toEqual(['period']);
    expect(guidedIntentOf(draft({ operation: 'day_overview', period: 'current_week' }))).toBeNull();
  });
});

describe('changing the draft', () => {
  it('a new view clears the fields of the other views and keeps the period only where the new view takes it', () => {
    const comparison = draft({ operation: 'activity_comparison', period: 'today', source: 'gpx', type: 'walk' });
    expect(updateGuidedDraft(comparison, 'operation', 'day_overview')).toEqual(draft({ operation: 'day_overview', period: 'today' }));
    expect(updateGuidedDraft(comparison, 'operation', 'weekly_review')).toEqual(draft({ operation: 'weekly_review' }));
    const weekly = draft({ focus: 'nutrition', operation: 'weekly_review', period: 'previous_week' });
    expect(updateGuidedDraft(weekly, 'operation', 'activity_comparison')).toEqual(draft({ operation: 'activity_comparison' }));
    expect(updateGuidedDraft(weekly, 'operation', null)).toEqual(EMPTY_GUIDED_DRAFT);
  });

  it('changes exactly one field otherwise; choosing a source never chooses a type, nor the reverse', () => {
    const base = draft({ operation: 'activity_comparison', period: 'today' });
    expect(updateGuidedDraft(base, 'source', 'recorded_run')).toEqual({ ...base, source: 'recorded_run' });
    expect(updateGuidedDraft({ ...base, type: 'walk' }, 'source', 'recorded_run')).toEqual({ ...base, source: 'recorded_run', type: 'walk' });
    expect(updateGuidedDraft(base, 'type', 'swim')).toEqual({ ...base, type: 'swim' });
    expect(updateGuidedDraft(base, 'period', null)).toEqual({ ...base, period: null });
  });

  it('ignores a value that is not a choice of that field', () => {
    const base = draft({ operation: 'weekly_review' });
    expect(updateGuidedDraft(base, 'period', 'today')).toBe(base);
    expect(updateGuidedDraft(base, 'focus', 'sleep')).toBe(base);
    expect(updateGuidedDraft(base, 'operation', 'drop_table')).toBe(base);
    expect(updateGuidedDraft(base, 'owner' as never, 'someone')).toBe(base);
    expect(updateGuidedDraft(base, '__proto__' as never, null)).toBe(base);
    expect(updateGuidedDraft(draft({ operation: 'activity_comparison' }), 'source', 'strava')).toEqual(draft({ operation: 'activity_comparison' }));
  });
});

describe('a clarification opens the builder at the field to choose', () => {
  it('prefills only what the reason implies and the server-verified source choice; never a guess', () => {
    expect(draftFromClarification('activity_source_missing', { operation: 'activity_comparison', period: 'yesterday', type: 'swim' })).toEqual({
      draft: draft({ operation: 'activity_comparison', period: 'yesterday', type: 'swim' }),
      focus: 'source',
    });
    expect(draftFromClarification('activity_source_missing', null)).toEqual({ draft: draft({ operation: 'activity_comparison' }), focus: 'source' });
    expect(draftFromClarification('activity_type_missing', null)).toEqual({ draft: draft({ operation: 'activity_comparison' }), focus: 'type' });
    expect(draftFromClarification('period_ambiguous', null)).toEqual({ draft: EMPTY_GUIDED_DRAFT, focus: 'operation' });
    expect(draftFromClarification('operation_ambiguous', null)).toEqual({ draft: EMPTY_GUIDED_DRAFT, focus: 'operation' });
    for (const reason of DATA_QUESTION_CLARIFICATION_REASONS) expect(guidedIntentOf(draftFromClarification(reason, null).draft), reason).toBeNull();
  });
});
