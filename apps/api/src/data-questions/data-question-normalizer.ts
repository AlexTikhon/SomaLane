import type {
  DataQuestionActivitySource,
  DataQuestionClarificationReason,
  DataQuestionDayPeriod,
  DataQuestionIntent,
  DataQuestionSourceChoice,
  DataQuestionUnsupportedReason,
  DataQuestionWeekPeriod,
} from '@running-tracker/contracts';

import { analyzeQuestionConstraints, type QuestionConstraints } from './data-question-constraints.js';
import type { DataQuestionWireAnswer } from './data-question-wire.js';

// Deterministic normalization of a model interpretation (ADR-0094; question constraints ADR-0095). The model chose closed
// symbols; this code decides whether they make a complete intent that AGREES WITH THE QUESTION ITSELF. The question is
// analysed independently of the answer (data-question-constraints.ts), and a fixed decision order — the written policy,
// docs/data-question-constraints-policy.md — turns any missing, ungrounded or contradictory choice into a bounded
// clarification or refusal. It never fills a gap with a default and never turns a refusal or clarification into a
// proposal: the rules can only make an answer more conservative.

export type NormalizedQuestion =
  | { intent: DataQuestionIntent; outcome: 'intent' }
  | { outcome: 'clarify'; reason: DataQuestionClarificationReason; sourceChoice: DataQuestionSourceChoice | null }
  | { outcome: 'unsupported'; reason: DataQuestionUnsupportedReason };

/** Which rule of the policy decided (for tests and diagnostics; never logged with the question). */
export type DataQuestionDecisionRule = 'accepted' | 'focus' | 'instruction' | 'model' | 'period' | 'range' | 'source' | 'temporal' | 'type' | 'view';

export interface DataQuestionDecision {
  normalized: NormalizedQuestion;
  rule: DataQuestionDecisionRule;
}

/** Whether the question names this activity source in words (not negated). Used by the deterministic fake provider. */
export function sourceNamedIn(text: string, source: DataQuestionActivitySource): boolean {
  return analyzeQuestionConstraints(text).sources.has(source);
}

const clarify = (reason: DataQuestionClarificationReason, sourceChoice: DataQuestionSourceChoice | null = null): NormalizedQuestion => ({
  outcome: 'clarify',
  reason,
  sourceChoice,
});

/**
 * Policy rule 8: the proposed symbol is the one the question requests at the view's granularity. Exactly one explicit
 * symbol must be carried as such (even when another would resolve to the same dates); several, or evidence of the other
 * granularity, contradict each other; the selected context is permitted only without any temporal evidence.
 */
function periodAccepted(constraints: QuestionConstraints, granularity: 'day' | 'week', symbol: DataQuestionDayPeriod | DataQuestionWeekPeriod | null): boolean {
  if (symbol === null) return false;
  if (constraints.unsupportedTemporal || constraints.unsupportedRange) return false;
  const requested: ReadonlySet<string> = granularity === 'day' ? constraints.dayPeriods : constraints.weekPeriods;
  const otherGranularity = granularity === 'day' ? constraints.weekPeriods.size > 0 || constraints.weekUnqualified : constraints.dayPeriods.size > 0;
  if (otherGranularity || requested.size > 1) return false;
  if (requested.size === 1) return requested.has(symbol);
  return symbol === (granularity === 'day' ? 'selected_date' : 'selected_week');
}

/** Applies the policy's decision order (docs/data-question-constraints-policy.md §2) and names the rule that decided. */
export function decideDataQuestion(text: string, answer: DataQuestionWireAnswer): DataQuestionDecision {
  const constraints = analyzeQuestionConstraints(text);
  const decided = (rule: DataQuestionDecisionRule, normalized: NormalizedQuestion): DataQuestionDecision => ({ normalized, rule });

  // 1. An instruction-bearing question is refused as a whole, whatever the model answered.
  if (constraints.instruction) return decided('instruction', { outcome: 'unsupported', reason: 'not_a_data_question' });
  // 2. A model refusal or clarification passes through with its own reason.
  if (answer.outcome === 'unsupported') return decided('model', { outcome: 'unsupported', reason: answer.reason });
  if (answer.outcome === 'clarify') return decided('model', clarify(answer.reason));
  // 3. A range the three views do not offer.
  if (constraints.unsupportedRange) return decided('range', { outcome: 'unsupported', reason: 'unsupported_calculation' });
  // 4. A day named another way (weekday, calendar date, relative, vague, future).
  if (constraints.unsupportedTemporal) return decided('temporal', clarify('period_ambiguous'));

  // 5. The view must agree with the question.
  const { window } = constraints;
  const comparisonWindow = window.days28 || window.previousPeriod;
  if (answer.outcome !== 'activity_comparison' && comparisonWindow) return decided('view', clarify('operation_ambiguous'));
  if (answer.outcome === 'activity_comparison' && !comparisonWindow && !window.compare) return decided('view', clarify('operation_ambiguous'));
  if (answer.outcome === 'weekly_review' && constraints.types.size > 0) return decided('view', clarify('operation_ambiguous'));
  if (answer.outcome === 'weekly_review' && constraints.weekPeriods.size === 0 && !constraints.weekUnqualified) return decided('view', clarify('operation_ambiguous'));

  switch (answer.outcome) {
    case 'day_overview':
      if (!periodAccepted(constraints, 'day', answer.period)) return decided('period', clarify('period_ambiguous'));
      return decided('accepted', { intent: { operation: 'day_overview', period: answer.period! }, outcome: 'intent' });
    case 'weekly_review': {
      if (!periodAccepted(constraints, 'week', answer.period)) return decided('period', clarify('period_ambiguous'));
      // 9. The focus agrees with the nutrition/movement words: one requires itself, both are two views, none is overview.
      const { focuses } = constraints;
      const required = focuses.size === 0 ? 'overview' : focuses.size === 1 ? [...focuses][0]! : null;
      if (required !== answer.focus) return decided('focus', clarify('operation_ambiguous'));
      return decided('accepted', { intent: { focus: answer.focus, operation: 'weekly_review', period: answer.period! }, outcome: 'intent' });
    }
    case 'activity_comparison': {
      // 6. Exactly one explicit type, the model's: no "other" guess for an unknown activity, no choice between two.
      const type = answer.activityType;
      if (type === null || constraints.types.size !== 1 || !constraints.types.has(type)) return decided('type', clarify('activity_type_missing'));
      // 7. Exactly one named, non-negated source, the model's, and a supported pair. "Running" alone is no source.
      const periodOk = periodAccepted(constraints, 'day', answer.period);
      const source = answer.source;
      const sourceOk =
        source !== null &&
        !constraints.negatedSource &&
        constraints.sources.size === 1 &&
        constraints.sources.has(source) &&
        (source !== 'recorded_run' || type === 'run');
      if (!sourceOk) {
        const choice = periodOk ? { operation: 'activity_comparison' as const, period: answer.period!, type } : null;
        return decided('source', clarify('activity_source_missing', choice));
      }
      // 8. The period.
      if (!periodOk) return decided('period', clarify('period_ambiguous'));
      return decided('accepted', { intent: { operation: 'activity_comparison', period: answer.period!, source, type }, outcome: 'intent' });
    }
  }
}

export function normalizeDataQuestion(text: string, answer: DataQuestionWireAnswer): NormalizedQuestion {
  return decideDataQuestion(text, answer).normalized;
}
