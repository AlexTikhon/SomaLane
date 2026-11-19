import { describe, expect, it } from 'vitest';

import { normalizeDataQuestion, sourceNamedIn } from './data-question-normalizer.js';

// The deterministic step between the model's symbols and a plan (ADR-0094). It never invents a value: a missing or
// ungrounded choice becomes a clarification, and only a complete intent can become a plan.

describe('normalizing the model answer into an intent', () => {
  it('passes complete day and week intents through', () => {
    expect(normalizeDataQuestion('What did I record?', { outcome: 'day_overview', period: 'selected_date' })).toEqual({
      intent: { operation: 'day_overview', period: 'selected_date' },
      outcome: 'intent',
    });
    expect(normalizeDataQuestion('Steps last week', { focus: 'movement', outcome: 'weekly_review', period: 'previous_week' })).toEqual({
      intent: { focus: 'movement', operation: 'weekly_review', period: 'previous_week' },
      outcome: 'intent',
    });
  });

  it('turns a missing period into a clarification, never a default', () => {
    expect(normalizeDataQuestion('Show me a day', { outcome: 'day_overview', period: null })).toEqual({ outcome: 'clarify', reason: 'period_ambiguous', sourceChoice: null });
    expect(normalizeDataQuestion('Weekly food', { focus: 'nutrition', outcome: 'weekly_review', period: null })).toEqual({
      outcome: 'clarify',
      reason: 'period_ambiguous',
      sourceChoice: null,
    });
  });

  it('accepts a comparison only with a source the question names explicitly', () => {
    expect(
      normalizeDataQuestion('Compare my manually entered running with the previous 28 days', {
        activityType: 'run',
        outcome: 'activity_comparison',
        period: 'selected_date',
        source: 'manual',
      }),
    ).toEqual({ intent: { operation: 'activity_comparison', period: 'selected_date', source: 'manual', type: 'run' }, outcome: 'intent' });
    expect(
      normalizeDataQuestion('Сравни мои пробежки из GPX с предыдущими 28 днями', { activityType: 'run', outcome: 'activity_comparison', period: 'today', source: 'gpx' }),
    ).toEqual({ intent: { operation: 'activity_comparison', period: 'today', source: 'gpx', type: 'run' }, outcome: 'intent' });
  });

  it('never infers a source from "running": a model-chosen source the question does not name is a source clarification', () => {
    expect(
      normalizeDataQuestion('Compare my running with the previous 28 days', { activityType: 'run', outcome: 'activity_comparison', period: 'selected_date', source: 'recorded_run' }),
    ).toEqual({ outcome: 'clarify', reason: 'activity_source_missing', sourceChoice: { operation: 'activity_comparison', period: 'selected_date', type: 'run' } });
    expect(
      normalizeDataQuestion('Сравни мой бег за 28 дней', { activityType: 'run', outcome: 'activity_comparison', period: 'selected_date', source: null }),
    ).toEqual({ outcome: 'clarify', reason: 'activity_source_missing', sourceChoice: { operation: 'activity_comparison', period: 'selected_date', type: 'run' } });
  });

  it('asks for the type first, and offers no source choice without a period', () => {
    expect(normalizeDataQuestion('Compare my GPX imports', { activityType: null, outcome: 'activity_comparison', period: 'today', source: 'gpx' })).toEqual({
      outcome: 'clarify',
      reason: 'activity_type_missing',
      sourceChoice: null,
    });
    expect(normalizeDataQuestion('Compare walking', { activityType: 'walk', outcome: 'activity_comparison', period: null, source: null })).toEqual({
      outcome: 'clarify',
      reason: 'activity_source_missing',
      sourceChoice: null,
    });
    expect(normalizeDataQuestion('Compare manual walking', { activityType: 'walk', outcome: 'activity_comparison', period: null, source: 'manual' })).toEqual({
      outcome: 'clarify',
      reason: 'period_ambiguous',
      sourceChoice: null,
    });
  });

  it('recorded runs are runs: another type with recorded runs is a source clarification for that type', () => {
    expect(
      normalizeDataQuestion('Compare my recorded cycling', { activityType: 'ride', outcome: 'activity_comparison', period: 'selected_date', source: 'recorded_run' }),
    ).toEqual({ outcome: 'clarify', reason: 'activity_source_missing', sourceChoice: { operation: 'activity_comparison', period: 'selected_date', type: 'ride' } });
  });

  it('passes clarifications and refusals through as bounded codes', () => {
    expect(normalizeDataQuestion('x', { outcome: 'clarify', reason: 'operation_ambiguous' })).toEqual({ outcome: 'clarify', reason: 'operation_ambiguous', sourceChoice: null });
    expect(normalizeDataQuestion('x', { outcome: 'unsupported', reason: 'other_person' })).toEqual({ outcome: 'unsupported', reason: 'other_person' });
  });
});

describe('explicit source words', () => {
  it('recognizes each source in English and Russian, and nothing from an activity word alone', () => {
    expect(sourceNamedIn('runs I entered by hand', 'manual')).toBe(true);
    expect(sourceNamedIn('бег, внесённый вручную', 'manual')).toBe(true);
    expect(sourceNamedIn('ручные записи бега', 'manual')).toBe(true);
    expect(sourceNamedIn('my GPX imports', 'gpx')).toBe(true);
    expect(sourceNamedIn('импорт из TCX', 'tcx')).toBe(true);
    expect(sourceNamedIn('runs I recorded with GPS', 'recorded_run')).toBe(true);
    expect(sourceNamedIn('мои записанные пробежки', 'recorded_run')).toBe(true);
    expect(sourceNamedIn('my running', 'recorded_run')).toBe(false);
    expect(sourceNamedIn('my running', 'manual')).toBe(false);
    expect(sourceNamedIn('What did I record?', 'recorded_run')).toBe(false);
    expect(sourceNamedIn('the gpxfile', 'gpx')).toBe(false);
  });
});
