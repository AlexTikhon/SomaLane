import {
  addLocalDays,
  DATA_QUESTION_CONTRACT_VERSION,
  DATA_QUESTION_DATE_MIN,
  dailyTrendsRangeOf,
  dataQuestionPlanSchema,
  previousActivityTrendsPeriodOf,
  resolveDataQuestionDay,
  resolveDataQuestionWeek,
  type DataQuestionIntent,
  type DataQuestionPlan,
} from '@running-tracker/contracts';

import type { Clock } from '../clock.js';
import { canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { ApiError } from '../http/errors.js';
import { localDateOf } from '../runs/run-search-period.js';

// Resolution of a symbolic intent into a reviewable plan (ADR-0094). Deterministic and local: the injected clock and the
// requested zone decide "today", with the platform's own zone rules (`localDateOf`, never the host zone); weeks and the
// comparison's periods come from the existing calendar helpers (Monday-to-Sunday weeks; the activity trends' 28-date
// range and previous period), so no date arithmetic is defined twice. Nothing is read from the database here.

function refused(message: string, path: string[]): ApiError {
  return new ApiError(400, 'INVALID_REQUEST', message, { fields: [{ message, path }] });
}

export function resolveDataQuestionPlan(
  intent: DataQuestionIntent,
  context: { selectedDate: string; timeZone: string },
  clock: Pick<Clock, 'utcNow'>,
): DataQuestionPlan {
  const timeZone = canonicalTimeZone(context.timeZone);
  const today = localDateOf(clock.utcNow().getTime(), timeZone);
  if (context.selectedDate > today) {
    throw refused(`The selected date cannot be after today (${today} in ${timeZone})`, ['selectedDate']);
  }
  const dates = { selectedDate: context.selectedDate, today };
  const base = { timeZone, version: DATA_QUESTION_CONTRACT_VERSION } as const;
  const tooEarly = (date: string) => {
    if (date < DATA_QUESTION_DATE_MIN) throw refused(`The period cannot start before ${DATA_QUESTION_DATE_MIN}`, ['intent', 'period']);
  };

  let plan: DataQuestionPlan;
  switch (intent.operation) {
    case 'day_overview': {
      const localDate = resolveDataQuestionDay(intent.period, dates);
      tooEarly(localDate);
      plan = { ...base, operation: 'day_overview', period: { localDate, symbol: intent.period } };
      break;
    }
    case 'weekly_review': {
      const weekStart = resolveDataQuestionWeek(intent.period, dates);
      tooEarly(weekStart);
      plan = {
        ...base,
        focus: intent.focus,
        operation: 'weekly_review',
        period: { symbol: intent.period, weekEnd: addLocalDays(weekStart, 6), weekStart },
      };
      break;
    }
    case 'activity_comparison': {
      const endDate = resolveDataQuestionDay(intent.period, dates);
      tooEarly(endDate);
      const range = dailyTrendsRangeOf(endDate);
      const previous = previousActivityTrendsPeriodOf(endDate);
      plan = {
        ...base,
        compare: 'previous_period',
        operation: 'activity_comparison',
        period: {
          endDate,
          previousEndDate: previous.requestedEndDate,
          previousStartDate: previous.requestedStartDate,
          startDate: range.startDate,
          symbol: intent.period,
        },
        source: intent.source,
        type: intent.type,
      };
      break;
    }
  }
  // The contract's own consistency rules, as a last check of what this code built.
  return dataQuestionPlanSchema.parse(plan);
}
