import {
  DATA_QUESTION_CONTRACT_VERSION,
  dataQuestionAnswerSchema,
  weeklyReviewStatementsFor,
  type ActivityTrends,
  type DataQuestionAnswer,
  type DataQuestionPlan,
  type DataQuestionWeeklyFocus,
  type WeeklyReview,
} from '@running-tracker/contracts';

import type { ActivityTrendsService } from '../activity-trends/activity-trends-service.js';
import type { StoredSession } from '../auth/session-store.js';
import type { DailyOverviewService } from '../daily-overview/daily-overview-service.js';
import type { WeeklyReviewService } from '../insights/weekly-review-service.js';

// The executor of a reviewed "Ask my data" plan (ADR-0094). It is the allowlist: three operations, each mapped to ONE
// existing service read, called once with the plan's own dates and zone. The services keep everything they own: the
// membership check, the REPEATABLE READ READ ONLY snapshot, row-level security, the owner predicates, the query bounds
// and their date rules (a refusal is passed on unchanged). Nothing here queries the database, calls an HTTP endpoint of
// this application, reloads records, recomputes a total or combines two reads.
//
// The answer is a projection by construction: each operation names the fields of its service's DTO it keeps, and the
// contract refuses anything else, so a field added to a service later does not reach this answer unless it is added here.

export interface DataQuestionReaders {
  overview: Pick<DailyOverviewService, 'read'>;
  review: Pick<WeeklyReviewService, 'read'>;
  trends: Pick<ActivityTrendsService, 'read'>;
}

type WeeklyAnswer = Extract<DataQuestionAnswer, { operation: 'weekly_review' }>;
type ComparisonAnswer = Extract<DataQuestionAnswer, { operation: 'activity_comparison' }>;

/** The weekly review fields a focus keeps: the week and its statements always, plus the focus's own part. */
export function weeklyAnswerResultOf(focus: DataQuestionWeeklyFocus, review: WeeklyReview): WeeklyAnswer['result'] {
  const statements = weeklyReviewStatementsFor(focus, review.statements);
  switch (focus) {
    case 'movement':
      return { focus, movement: review.movement, statements, week: review.week };
    case 'nutrition':
      return { focus, meals: review.meals, statements, week: review.week };
    case 'overview':
      return {
        coverage: review.coverage,
        dataGaps: review.dataGaps,
        focus,
        importedActivities: review.importedActivities,
        statements,
        tcxImportedActivities: review.tcxImportedActivities,
        week: review.week,
      };
  }
}

/** The comparison's range, summary and comparison for its one source: never the per-date series, never another source. */
export function comparisonAnswerResultOf(trends: ActivityTrends): ComparisonAnswer['result'] {
  if (trends.comparison === undefined || trends.applied.compare !== 'previous_period') {
    throw new Error('The activity trends answered without the requested comparison');
  }
  const applied = { ...trends.applied, compare: 'previous_period' as const };
  switch (trends.source) {
    case 'manual':
      return { applied: { ...applied, source: 'manual' }, comparison: trends.comparison, range: trends.range, source: 'manual', summary: trends.summary };
    case 'gpx':
      return { applied: { ...applied, source: 'gpx' }, comparison: trends.comparison, range: trends.range, source: 'gpx', summary: trends.summary };
    case 'tcx':
      return { applied: { ...applied, source: 'tcx' }, comparison: trends.comparison, range: trends.range, source: 'tcx', summary: trends.summary };
    case 'recorded_run':
      return {
        applied: { ...applied, source: 'recorded_run', type: 'run' },
        comparison: trends.comparison,
        range: trends.range,
        source: 'recorded_run',
        summary: trends.summary,
      };
  }
}

export class DataQuestionExecutor {
  readonly #readers: DataQuestionReaders;

  public constructor(readers: DataQuestionReaders) {
    this.#readers = readers;
  }

  /** Exactly one service read for the plan, as reviewed. Throws the service's own error when its rules refuse the plan. */
  public async answer(session: Pick<StoredSession, 'userId'>, orgId: string, plan: DataQuestionPlan): Promise<DataQuestionAnswer> {
    const version = DATA_QUESTION_CONTRACT_VERSION;
    switch (plan.operation) {
      case 'day_overview': {
        const overview = await this.#readers.overview.read(session, orgId, plan.period.localDate, { timeZone: plan.timeZone });
        return dataQuestionAnswerSchema.parse({
          operation: 'day_overview',
          plan,
          provenance: {
            answerVersion: version,
            computedAt: overview.provenance.computedAt,
            persisted: false,
            service: 'daily_overview',
            serviceVersion: overview.provenance.overviewVersion,
          },
          result: overview,
          version,
        });
      }
      case 'weekly_review': {
        const review = await this.#readers.review.read(session, orgId, { timeZone: plan.timeZone, weekStart: plan.period.weekStart });
        return dataQuestionAnswerSchema.parse({
          operation: 'weekly_review',
          plan,
          provenance: {
            answerVersion: version,
            computedAt: review.provenance.computedAt,
            persisted: false,
            service: 'weekly_review',
            serviceVersion: review.provenance.reviewVersion,
          },
          result: weeklyAnswerResultOf(plan.focus, review),
          version,
        });
      }
      case 'activity_comparison': {
        const trends = await this.#readers.trends.read(session, orgId, {
          compare: 'previous_period',
          endDate: plan.period.endDate,
          source: plan.source,
          timeZone: plan.timeZone,
          type: plan.type,
        });
        return dataQuestionAnswerSchema.parse({
          operation: 'activity_comparison',
          plan,
          provenance: {
            answerVersion: version,
            computedAt: trends.provenance.computedAt,
            persisted: false,
            service: 'activity_trends',
            serviceVersion: trends.provenance.policyVersion,
          },
          result: comparisonAnswerResultOf(trends),
          version,
        });
      }
    }
  }
}
