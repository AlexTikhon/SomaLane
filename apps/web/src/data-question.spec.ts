import {
  DATA_QUESTION_CLARIFICATION_REASONS,
  DATA_QUESTION_UNSUPPORTED_REASONS,
  dataQuestionIntentSchema,
  type DataQuestionAnswer,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { clarificationText, PREDEFINED_QUESTIONS, sourceActionOf, sourceChoicesFor, unsupportedText } from './data-question.js';
import { overviewFixture } from './daily-overview-fixtures.js';

describe('Ask my data helpers (ADR-0094)', () => {
  it('every predefined question is a valid intent, and the representative requests are among them', () => {
    for (const question of PREDEFINED_QUESTIONS) expect(dataQuestionIntentSchema.safeParse(question.intent).success, question.id).toBe(true);
    expect(PREDEFINED_QUESTIONS.map((question) => question.label)).toEqual(
      expect.arrayContaining([
        'What did I record for the selected day?',
        'Show my recorded nutrition for this week.',
        'How many steps did I log last week?',
        'Compare my manually entered running with the previous 28 days.',
      ]),
    );
  });

  it('has fixed wording for every clarification and refusal code', () => {
    for (const reason of DATA_QUESTION_CLARIFICATION_REASONS) expect(clarificationText[reason].length).toBeGreaterThan(10);
    for (const reason of DATA_QUESTION_UNSUPPORTED_REASONS) expect(unsupportedText[reason].length).toBeGreaterThan(10);
  });

  it('offers recorded runs only for running', () => {
    expect(sourceChoicesFor('run')).toEqual(['manual', 'gpx', 'tcx', 'recorded_run']);
    expect(sourceChoicesFor('walk')).toEqual(['manual', 'gpx', 'tcx']);
  });

  it('opens the existing view through a typed action, never a URL', () => {
    const answer = {
      operation: 'day_overview',
      plan: { operation: 'day_overview', period: { localDate: '2026-11-05', symbol: 'selected_date' }, timeZone: 'Europe/Warsaw', version: 'data-question-1' },
      provenance: { answerVersion: 'data-question-1', computedAt: '2026-11-08T10:00:00.000Z', persisted: false, service: 'daily_overview', serviceVersion: 'daily-overview-4' },
      result: overviewFixture(),
      version: 'data-question-1',
    } satisfies DataQuestionAnswer;
    expect(sourceActionOf(answer).action).toEqual({ kind: 'select-date', localDate: '2026-11-05' });
    expect(JSON.stringify(sourceActionOf(answer))).not.toMatch(/https?:|\/api\//u);
  });
});
