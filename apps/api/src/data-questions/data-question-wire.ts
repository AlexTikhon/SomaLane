import {
  DATA_QUESTION_ACTIVITY_SOURCES,
  DATA_QUESTION_ACTIVITY_TYPES,
  DATA_QUESTION_CLARIFICATION_REASONS,
  DATA_QUESTION_DAY_PERIODS,
  DATA_QUESTION_UNSUPPORTED_REASONS,
  DATA_QUESTION_WEEK_PERIODS,
  DATA_QUESTION_WEEKLY_FOCUSES,
} from '@running-tracker/contracts';
import { z } from 'zod';

// What the local model is asked to return for "Ask my data" (ADR-0094). A WIRE shape of closed symbols only: no text, no
// date, no number, no tool name, no URL, no identifier. The first field names the outcome, so once the model has chosen
// one it can only fill that outcome's symbols. The server normalizes it (data-question-normalizer.ts) and resolves the
// period itself; schema validity says the answer has a legal shape, not that it is the right interpretation.

export const DATA_QUESTION_WIRE_SCHEMA_NAME = 'data_question_interpretation_v1';

const dayPeriod = z.enum(DATA_QUESTION_DAY_PERIODS);
const weekPeriod = z.enum(DATA_QUESTION_WEEK_PERIODS);

export const dataQuestionWireSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('day_overview'), period: dayPeriod.nullable() }),
  z.strictObject({ outcome: z.literal('weekly_review'), period: weekPeriod.nullable(), focus: z.enum(DATA_QUESTION_WEEKLY_FOCUSES) }),
  z.strictObject({
    outcome: z.literal('activity_comparison'),
    period: dayPeriod.nullable(),
    source: z.enum(DATA_QUESTION_ACTIVITY_SOURCES).nullable(),
    activityType: z.enum(DATA_QUESTION_ACTIVITY_TYPES).nullable(),
  }),
  z.strictObject({ outcome: z.literal('clarify'), reason: z.enum(DATA_QUESTION_CLARIFICATION_REASONS) }),
  z.strictObject({ outcome: z.literal('unsupported'), reason: z.enum(DATA_QUESTION_UNSUPPORTED_REASONS) }),
]);
export type DataQuestionWireAnswer = z.infer<typeof dataQuestionWireSchema>;

const nullableEnum = (values: readonly string[], description: string) => ({ description, enum: [...values, null], type: ['string', 'null'] });

// Written out rather than generated, so exactly what is sent is visible in review; the specification validates the same
// answers with this and with `dataQuestionWireSchema`. Only keywords the runtime's schema-to-grammar conversion is known
// to take (type, enum, properties, required, additionalProperties, oneOf), as for the meal draft schema.
export const dataQuestionWireJsonSchema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        outcome: { description: 'What the person recorded for one local calendar date.', enum: ['day_overview'], type: 'string' },
        period: nullableEnum(DATA_QUESTION_DAY_PERIODS, 'Which date.'),
      },
      required: ['outcome', 'period'],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: { description: "The person's Monday-to-Sunday weekly review.", enum: ['weekly_review'], type: 'string' },
        period: nullableEnum(DATA_QUESTION_WEEK_PERIODS, 'Which week.'),
        focus: { description: 'Which part of the review.', enum: [...DATA_QUESTION_WEEKLY_FOCUSES], type: 'string' },
      },
      required: ['outcome', 'period', 'focus'],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: {
          description: 'One activity source and type over the 28 dates ending on a date, compared with the 28 dates before.',
          enum: ['activity_comparison'],
          type: 'string',
        },
        period: nullableEnum(DATA_QUESTION_DAY_PERIODS, 'The last date of the 28-date range.'),
        source: nullableEnum(DATA_QUESTION_ACTIVITY_SOURCES, 'Only a source the question names explicitly; otherwise null.'),
        activityType: nullableEnum(DATA_QUESTION_ACTIVITY_TYPES, 'The activity type the question names; otherwise null.'),
      },
      required: ['outcome', 'period', 'source', 'activityType'],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: { description: 'A supported question that needs one more choice from the person.', enum: ['clarify'], type: 'string' },
        reason: { enum: [...DATA_QUESTION_CLARIFICATION_REASONS], type: 'string' },
      },
      required: ['outcome', 'reason'],
      type: 'object',
    },
    {
      additionalProperties: false,
      properties: {
        outcome: { description: 'Not a question these three read-only views can answer.', enum: ['unsupported'], type: 'string' },
        reason: { enum: [...DATA_QUESTION_UNSUPPORTED_REASONS], type: 'string' },
      },
      required: ['outcome', 'reason'],
      type: 'object',
    },
  ],
} as const;
