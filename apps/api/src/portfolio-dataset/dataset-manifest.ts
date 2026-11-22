import { activityTrendsPercentTenths, addLocalDays } from '@running-tracker/contracts';

import {
  expectedManualSide,
  expectedNutrition,
  reviewWeekOf,
  type DatasetPlan,
  type ManualComparisonSide,
  type NutritionExpectation,
} from './dataset-plan.js';
import { DIGEST_NORMALIZATION_VERSION, type SnapshotReport } from './dataset-snapshot.js';

// The compact manifest of one seeded dataset: parameters, ranges, logical counts, the deliberate gaps, the expected
// analytics of the named selections (computed from the PLAN, independently of the read models that later display them),
// and the canonical digest of what was stored. Written to .local/portfolio-dataset/manifest.json by the CLI.

export interface DatasetManifest {
  counts: Record<string, number>;
  datasetVersion: string;
  digest: string;
  digestNormalization: string;
  expected: {
    activityComparison: { change: { count: number; countPercent: number | null; distanceM: number | null; durationS: number | null }; current: ManualComparisonSide; previous: ManualComparisonSide; source: 'manual'; type: 'run' };
    finishedRun: { distanceM: string; localDate: string; observedDurationS: string; pointCount: number; runId: string; sharedWithCoach: boolean };
    nutritionTrends: {
      dates: Record<'missing' | 'partial' | 'recordedZeros' | 'titleOnly', NutritionExpectation & { localDate: string; what: string }>; range: NutritionExpectation & { daysWithEntries: number } };
    recordedRunComparison: { current: { count: number; distanceM: number }; previous: { count: number; distanceM: number } };
    today: {
      checkIn: Record<string, unknown> | null;
      manualActivities: Record<string, number>;
      meals: NutritionExpectation;
      movement: { activeEnergyKcal: number | null; steps: number | null } | null;
      recordedRuns: number;
    };
    weeklyReview: {
      checkInDays: number;
      manualActivities: { count: number; withDistance: number };
      meals: NutritionExpectation & { daysWithEntries: number };
      movement: { activeEnergyKcal: { daysRecorded: number; total: number | null }; daysWithRecord: number; steps: { daysRecorded: number; total: number | null } };
      recordedRuns: number;
      week: { end: string; start: string };
    };
  };
  gaps: DatasetPlan['gaps'];
  parameters: DatasetPlan['parameters'];
  ranges: DatasetPlan['ranges'];
  selections: Record<string, string>;
}

const within = (date: string, range: { end: string; start: string }) => date >= range.start && date <= range.end;
const tenthsSum = (values: readonly number[]) => values.reduce((sum, value) => sum + Math.round(value * 10), 0) / 10;

export function buildManifest(plan: DatasetPlan, report: SnapshotReport, digest: string): DatasetManifest {
  const anchor = plan.parameters.anchorDate;
  const currentDates = plan.dates.slice(28);
  const week = reviewWeekOf(plan);
  const weekDates = Array.from({ length: 7 }, (_, index) => addLocalDays(week.start, index));

  const anchorCheckIn = plan.checkIns.find((item) => item.localDate === anchor) ?? null;
  const anchorMovement = plan.movement.find((item) => item.localDate === anchor) ?? null;
  const manualByType: Record<string, number> = {};
  for (const item of plan.manualActivities.filter((entry) => entry.localDate === anchor)) {
    manualByType[item.request.type] = (manualByType[item.request.type] ?? 0) + 1;
  }

  const weekMovement = plan.movement.filter((item) => within(item.localDate, week));
  const steps = weekMovement.map((item) => item.request.steps).filter((value): value is number => value !== null && value !== undefined);
  const energy = weekMovement.map((item) => item.request.activeEnergyKcal).filter((value): value is number => value !== null && value !== undefined);
  const weekManual = plan.manualActivities.filter((item) => within(item.localDate, week));

  const current = expectedManualSide(plan, 'run', plan.ranges.current);
  const previous = expectedManualSide(plan, 'run', plan.ranges.previous);
  const change = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

  const summaries = new Map(report.snapshot.runSummaries.map((summary) => [summary.runId, summary]));
  const runsIn = (range: { endDate: string; startDate: string }) => plan.runs.filter((run) => run.localDate >= range.startDate && run.localDate <= range.endDate);
  const anchorRun = plan.runs.find((run) => run.localDate === anchor)!;
  const anchorSummary = summaries.get(anchorRun.runId);

  // Named nutrition dates of the current range: a date without entries, a date with partial values, the anchor (recorded
  // zeros next to full entries), and a date with a title-only entry.
  const kOf = (date: string) => plan.dates.length - 1 - plan.dates.indexOf(date);
  const mealDates = new Set(plan.meals.map((meal) => meal.localDate));
  const missingDate = currentDates.find((date) => !mealDates.has(date))!;
  const partialDate = [...currentDates].reverse().find((date) => mealDates.has(date) && kOf(date) % 2 === 1 && kOf(date) % 4 !== 1)!;
  const titleOnlyDate = [...currentDates].reverse().find((date) => mealDates.has(date) && kOf(date) % 4 === 1)!;
  const named = (localDate: string, what: string) => ({ ...expectedNutrition(plan, [localDate]), localDate, what });

  const weekMeals = expectedNutrition(plan, weekDates);
  const rangeMeals = expectedNutrition(plan, currentDates);

  return {
    counts: {
      checkIns: plan.checkIns.length,
      coaches: 1,
      gpxImports: plan.imports.filter((item) => item.kind === 'gpx').length,
      manualActivities: plan.manualActivities.length,
      meals: plan.meals.length,
      memberships: 2,
      movementDays: plan.movement.length,
      organizations: 1,
      recordedRuns: plan.runs.length,
      runPointsIngested: plan.runs.reduce((sum, run) => sum + run.pointCount, 0),
      runShares: plan.runs.filter((run) => run.share !== null).length,
      runners: 1,
      tcxImports: plan.imports.filter((item) => item.kind === 'tcx').length,
    },
    datasetVersion: plan.version,
    digest,
    digestNormalization: DIGEST_NORMALIZATION_VERSION,
    expected: {
      activityComparison: {
        change: {
          count: current.count - previous.count,
          countPercent: (() => {
            const tenths = activityTrendsPercentTenths(current.count, previous.count);
            return tenths === null ? null : tenths / 10;
          })(),
          distanceM: change(current.distanceM, previous.distanceM),
          durationS: change(current.durationS, previous.durationS),
        },
        current,
        previous,
        source: 'manual',
        type: 'run',
      },
      finishedRun: {
        distanceM: anchorSummary?.distanceM ?? 'missing',
        localDate: anchor,
        observedDurationS: anchorSummary?.observedDurationS ?? 'missing',
        pointCount: anchorRun.pointCount,
        runId: anchorRun.runId,
        sharedWithCoach: anchorRun.share !== null,
      },
      nutritionTrends: {
        dates: {
          missing: named(missingDate, 'no meal entries: unknown, not zero'),
          partial: named(partialDate, 'a lunch with energy and protein only: carbohydrate and fat are partly recorded'),
          recordedZeros: named(anchor, 'a "Black coffee" entry with all four values recorded as 0 next to full entries'),
          titleOnly: named(titleOnlyDate, 'a title-only dinner: counted as logged, records no value'),
        },
        range: { ...rangeMeals, daysWithEntries: currentDates.filter((date) => mealDates.has(date)).length },
      },
      recordedRunComparison: {
        current: { count: runsIn(plan.ranges.current).length, distanceM: Math.round(runsIn(plan.ranges.current).reduce((sum, run) => sum + run.plannedDistanceM, 0)) },
        previous: { count: runsIn(plan.ranges.previous).length, distanceM: Math.round(runsIn(plan.ranges.previous).reduce((sum, run) => sum + run.plannedDistanceM, 0)) },
      },
      today: {
        checkIn: anchorCheckIn === null ? null : { ...anchorCheckIn.request },
        manualActivities: manualByType,
        meals: expectedNutrition(plan, [anchor]),
        movement: anchorMovement === null ? null : { activeEnergyKcal: anchorMovement.request.activeEnergyKcal ?? null, steps: anchorMovement.request.steps ?? null },
        recordedRuns: plan.runs.filter((run) => run.localDate === anchor).length,
      },
      weeklyReview: {
        checkInDays: plan.checkIns.filter((item) => within(item.localDate, week)).length,
        manualActivities: { count: weekManual.length, withDistance: weekManual.filter((item) => item.request.distanceM !== null && item.request.distanceM !== undefined).length },
        meals: { ...weekMeals, daysWithEntries: weekDates.filter((date) => mealDates.has(date)).length },
        movement: {
          activeEnergyKcal: { daysRecorded: energy.length, total: energy.length === 0 ? null : tenthsSum(energy) },
          daysWithRecord: weekMovement.length,
          steps: { daysRecorded: steps.length, total: steps.length === 0 ? null : steps.reduce((sum, value) => sum + value, 0) },
        },
        recordedRuns: plan.runs.filter((run) => within(run.localDate, week)).length,
        week,
      },
    },
    gaps: plan.gaps,
    parameters: plan.parameters,
    ranges: plan.ranges,
    selections: {
      activityComparison: `Trends, end date ${anchor}: activity source Manual, type Run, compared with the previous 28 days (${plan.ranges.previous.startDate}..${plan.ranges.previous.endDate})`,
      finishedRun: `Run ${anchorRun.runId} on ${anchor}: finished, current published summary, shared with the coach (history)`,
      nutritionTrends: `Trends, end date ${anchor} (${plan.ranges.current.startDate}..${anchor}); named dates: ${missingDate} none logged, ${partialDate} partial, ${anchor} recorded zeros, ${titleOnlyDate} title-only`,
      today: `Today, date ${anchor}`,
      weeklyReview: `Weekly review, week ${week.start}..${week.end}`,
    },
  };
}
