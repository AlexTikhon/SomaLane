import type {
  DataQuestionActivitySource,
  DataQuestionClarificationReason,
  DataQuestionIntent,
  DataQuestionSourceChoice,
  DataQuestionUnsupportedReason,
} from '@running-tracker/contracts';

import type { DataQuestionWireAnswer } from './data-question-wire.js';

// Deterministic normalization of a model interpretation (ADR-0094). The model chose closed symbols; this code decides
// whether they make a complete intent. It never fills a gap with a default: a missing period, type or source becomes a
// clarification with a bounded reason. In particular an activity source is accepted only when the question itself names
// it ("manually entered", "GPX", "TCX", "recorded"/"GPS", and the Russian equivalents): "running" never means a source,
// so a source the model picked without such a word is treated as not given. The lexicon is a bounded guard, not a
// parser: it can only turn a proposal into a clarification, never create one.

export type NormalizedQuestion =
  | { intent: DataQuestionIntent; outcome: 'intent' }
  | { outcome: 'clarify'; reason: DataQuestionClarificationReason; sourceChoice: DataQuestionSourceChoice | null }
  | { outcome: 'unsupported'; reason: DataQuestionUnsupportedReason };

const NOT_LETTER_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_LETTER_AFTER = '(?![\\p{L}\\p{N}])';

const SOURCE_WORDS: Readonly<Record<DataQuestionActivitySource, RegExp>> = {
  manual: new RegExp(
    `${NOT_LETTER_BEFORE}(?:manual(?:ly)?|by${'\\s+'}hand|hand-?entered|typed(?:${'\\s+'}in)?|вручную|ручн\\p{L}*|введ[её]нн\\p{L}*|внес[её]нн\\p{L}*)${NOT_LETTER_AFTER}`,
    'iu',
  ),
  gpx: new RegExp(`${NOT_LETTER_BEFORE}gpx${NOT_LETTER_AFTER}`, 'iu'),
  tcx: new RegExp(`${NOT_LETTER_BEFORE}tcx${NOT_LETTER_AFTER}`, 'iu'),
  recorded_run: new RegExp(
    `${NOT_LETTER_BEFORE}(?:recorded|gps|tracked|записанн\\p{L}*|записал\\p{L}*|gps-?\\p{L}*|жпс|отслеженн\\p{L}*)${NOT_LETTER_AFTER}`,
    'iu',
  ),
};

/** Whether the question names this activity source in words. */
export function sourceNamedIn(text: string, source: DataQuestionActivitySource): boolean {
  return SOURCE_WORDS[source].test(text);
}

const clarify = (reason: DataQuestionClarificationReason, sourceChoice: DataQuestionSourceChoice | null = null): NormalizedQuestion => ({
  outcome: 'clarify',
  reason,
  sourceChoice,
});

export function normalizeDataQuestion(text: string, answer: DataQuestionWireAnswer): NormalizedQuestion {
  switch (answer.outcome) {
    case 'unsupported':
      return { outcome: 'unsupported', reason: answer.reason };
    case 'clarify':
      return clarify(answer.reason);
    case 'day_overview':
      if (answer.period === null) return clarify('period_ambiguous');
      return { intent: { operation: 'day_overview', period: answer.period }, outcome: 'intent' };
    case 'weekly_review':
      if (answer.period === null) return clarify('period_ambiguous');
      return { intent: { focus: answer.focus, operation: 'weekly_review', period: answer.period }, outcome: 'intent' };
    case 'activity_comparison': {
      // Precedence: the type, then the source, then the period (one fixed order, so the expected answer is unique).
      if (answer.activityType === null) return clarify('activity_type_missing');
      const type = answer.activityType;
      const sourceUsable =
        answer.source !== null && sourceNamedIn(text, answer.source) && (answer.source !== 'recorded_run' || type === 'run');
      if (!sourceUsable) {
        return clarify('activity_source_missing', answer.period === null ? null : { operation: 'activity_comparison', period: answer.period, type });
      }
      if (answer.period === null) return clarify('period_ambiguous');
      return { intent: { operation: 'activity_comparison', period: answer.period, source: answer.source!, type }, outcome: 'intent' };
    }
  }
}
