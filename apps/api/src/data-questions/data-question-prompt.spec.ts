import { readFileSync } from 'node:fs';

import {
  DATA_QUESTION_ACTIVITY_SOURCES,
  DATA_QUESTION_ACTIVITY_TYPES,
  DATA_QUESTION_CLARIFICATION_REASONS,
  DATA_QUESTION_DAY_PERIODS,
  DATA_QUESTION_UNSUPPORTED_REASONS,
  DATA_QUESTION_WEEK_PERIODS,
  DATA_QUESTION_WEEKLY_FOCUSES,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { DATA_QUESTION_DATASET_VERSIONS, DATA_QUESTION_EVAL_SETS, loadDataQuestionDataset } from '../evaluation/data-question-evaluation.js';
import { decideDataQuestion } from './data-question-normalizer.js';
import { buildDataQuestionMessages, DATA_QUESTION_INSTRUCTIONS, DATA_QUESTION_PROMPT_VERSION, dataQuestionPromptDigest } from './data-question-prompt.js';
import { dataQuestionWireSchema } from './data-question-wire.js';

// The interpretation prompt, version 2 (ADR-0095): aligned with the written constraints policy, closed symbols only, and
// synthetic examples that appear in no evaluation set and that the deterministic policy itself accepts as written.

const savedV1 = JSON.parse(
  readFileSync(new URL('../../../../docs/reports/artifacts/ask-my-data-2026-11-19/qwen3-8b-development.json', import.meta.url), 'utf8'),
) as { promptDigest: string; promptVersion: string };

/** The examples of the instructions: each question with the JSON answer that follows it. */
function examples(): Array<{ answer: unknown; question: string }> {
  return [...DATA_QUESTION_INSTRUCTIONS.matchAll(/Question: "(?<question>[^"\n]+)"\nAnswer: (?<answer>\{[^\n]+\})/gu)].map((match) => ({
    answer: JSON.parse(match.groups!.answer!) as unknown,
    question: match.groups!.question!,
  }));
}

describe('prompt version 2', () => {
  it('is a new version with a new digest; version 1 is not reinterpreted', () => {
    expect(DATA_QUESTION_PROMPT_VERSION).toBe('data-question-prompt-2');
    expect(savedV1.promptVersion).toBe('data-question-prompt-1');
    expect(dataQuestionPromptDigest()).not.toBe(savedV1.promptDigest);
    expect(dataQuestionPromptDigest()).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('names every closed symbol and asks for nothing outside them: no dates, numbers, SQL, tools, owners or prose', () => {
    for (const symbol of [
      'day_overview',
      'weekly_review',
      'activity_comparison',
      ...DATA_QUESTION_DAY_PERIODS,
      ...DATA_QUESTION_WEEK_PERIODS,
      ...DATA_QUESTION_WEEKLY_FOCUSES,
      ...DATA_QUESTION_ACTIVITY_SOURCES,
      ...DATA_QUESTION_ACTIVITY_TYPES,
      // A missing source or type is answered with nulls in the comparison (as in version 1), never as a clarify reason.
      ...DATA_QUESTION_CLARIFICATION_REASONS.filter((reason) => reason !== 'activity_source_missing' && reason !== 'activity_type_missing'),
      ...DATA_QUESTION_UNSUPPORTED_REASONS,
    ]) {
      expect(DATA_QUESTION_INSTRUCTIONS, symbol).toContain(`"${symbol}"`);
    }
    expect(DATA_QUESTION_INSTRUCTIONS).toMatch(/null for what is missing; do not answer "clarify"/u);
    expect(DATA_QUESTION_INSTRUCTIONS).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    expect(DATA_QUESTION_INSTRUCTIONS).toMatch(/never write dates or numbers/u);
    expect(DATA_QUESTION_INSTRUCTIONS).toMatch(/not_a_data_question/u);
  });

  it('has synthetic examples whose answers are valid wire answers that the deterministic policy accepts unchanged', () => {
    const found = examples();
    expect(found.length).toBeGreaterThanOrEqual(6);
    for (const { answer, question } of found) {
      const wire = dataQuestionWireSchema.parse(answer);
      const decision = decideDataQuestion(question, wire);
      // A proposal example is accepted as written; a refusal or clarification example keeps its outcome and reason.
      if (wire.outcome === 'clarify' || wire.outcome === 'unsupported') {
        expect(decision.normalized, question).toMatchObject({ outcome: wire.outcome, reason: wire.reason });
      } else {
        expect(decision.rule, question).toBe('accepted');
      }
    }
    // Both languages, every view, an instruction-bearing refusal and a period clarification are shown.
    const answers = found.map(({ answer }) => JSON.stringify(answer));
    for (const fragment of ['"day_overview"', '"weekly_review"', '"activity_comparison"', '"not_a_data_question"', '"period_ambiguous"']) {
      expect(answers.some((answer) => answer.includes(fragment)), fragment).toBe(true);
    }
    expect(found.some(({ question }) => /[а-яё]/iu.test(question))).toBe(true);
  });

  it('shares no example with any evaluation set of any version', () => {
    const questions = examples().map(({ question }) => question.toLowerCase());
    for (const version of DATA_QUESTION_DATASET_VERSIONS) {
      for (const set of DATA_QUESTION_EVAL_SETS) {
        for (const entry of loadDataQuestionDataset(set, undefined, version).dataset.cases) {
          expect(questions, entry.id).not.toContain(entry.text.toLowerCase());
        }
      }
    }
  });

  it('sends only the instructions, the validated context line and the question', () => {
    const messages = buildDataQuestionMessages('  What did I record?  ', { selectedDate: '2026-11-11', timeZone: 'Europe/Warsaw' });
    expect(Object.keys(messages).toSorted()).toEqual(['system', 'user']);
    expect(messages.user).toBe('What did I record?');
    expect(messages.system).toBe(
      `${DATA_QUESTION_INSTRUCTIONS}\n\nContext: the selected date is 2026-11-11; the time zone is Europe/Warsaw. Choose symbolic periods only; never write a date.`,
    );
  });
});
