import { createHash } from 'node:crypto';

import {
  activityTrendsSchema,
  dailyOverviewSchema,
  dailyTrendsDatesOf,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  mealListResponseSchema,
  weeklyReviewSchema,
} from '@running-tracker/contracts';
import {
  parseShowcaseSnapshot,
  SHOWCASE_NORMALIZATION_VERSION,
  showcaseSnapshotProblems,
  ShowcaseSnapshotError,
  type ShowcaseSnapshot,
} from '@running-tracker/contracts/showcase';
import { describe, expect, it } from 'vitest';

import { committedSnapshot, snapshotJson, snapshotText } from './showcase-test-support.js';

// The committed showcase snapshot (ADR-0099), the file the showcase build serves: validated by the existing response
// contract schemas, checked against its own catalog and provenance, in canonical form, and limited to the allowlist.

/** Keys sorted at every level, arrays in order (the export's canonicalJson). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function sortedDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedDeep);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, sortedDeep(entry)]));
}

/** The committed JSON, typed as a snapshot so a test can change it; values that break the contract are cast. */
const mutated = (change: (json: ShowcaseSnapshot) => void): unknown => {
  const json = snapshotJson() as unknown as ShowcaseSnapshot;
  change(json);
  return json;
};

describe('the committed showcase snapshot', () => {
  const snapshot = committedSnapshot();

  it('validates every response with its existing contract schema', () => {
    const { responses } = snapshot;
    for (const overview of Object.values(responses.dailyOverview)) expect(dailyOverviewSchema.safeParse(overview).success).toBe(true);
    for (const review of Object.values(responses.weeklyReview)) expect(weeklyReviewSchema.safeParse(review).success).toBe(true);
    for (const trends of Object.values(responses.dailyTrends)) expect(dailyTrendsSchema.safeParse(trends).success).toBe(true);
    for (const trends of Object.values(responses.activityTrends)) expect(activityTrendsSchema.safeParse(trends).success).toBe(true);
    for (const page of Object.values(responses.meals)) expect(mealListResponseSchema.safeParse(page).success).toBe(true);
    expect(showcaseSnapshotProblems(snapshot)).toEqual([]);
  });

  it('is synthetic, versioned and tied to the dataset digest, its anchor and zone', () => {
    expect(snapshot.dataset).toMatchObject({ anchorDate: '2026-11-21', datasetVersion: 'portfolio-dataset-v1', seed: 'somalane-portfolio-v1', synthetic: true, timeZone: 'Europe/Warsaw' });
    expect(snapshot.dataset.digest).toBe('sha256:b6222c858f464e8d4fe465b3f9c29a95f5c8f0f3e0cf3403b0021d49012e857d');
    // The first instant of 22 Nov 2026 in Warsaw (CET): the anchor is a completed date for every read.
    expect(snapshot.snapshot).toEqual({ asOfDate: '2026-11-21', readAt: '2026-11-21T23:00:00.000Z' });
  });

  it('is in canonical form and its content digest recomputes', () => {
    const text = snapshotText();
    expect(text).toBe(`${JSON.stringify(sortedDeep(JSON.parse(text)), null, 2)}\n`);
    expect(text).not.toContain('\r');
    const { contentDigest, ...body } = JSON.parse(text) as ShowcaseSnapshot;
    expect(contentDigest).toBe(`sha256:${createHash('sha256').update(`${SHOWCASE_NORMALIZATION_VERSION}\n${canonicalJson(body)}`, 'utf8').digest('hex')}`);
  });

  it('offers a closed catalog: every Trends row opens an offered day, every offered day has its week', () => {
    const { selections } = snapshot;
    expect(selections.trendsEndDates).toEqual(['2026-11-15', '2026-11-21']);
    for (const endDate of selections.trendsEndDates) {
      for (const date of dailyTrendsDatesOf(dailyTrendsRangeOf(endDate))) expect(selections.days).toContain(date);
    }
    expect(selections.weeks).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
    expect(selections.sampleDate).toBe('2026-11-21');
    expect(selections.defaultActivity).toEqual({ source: 'manual', type: 'run' });
    expect(selections.activity.map((selection) => `${selection.source}/${selection.type}`)).toEqual([
      'manual/run', 'manual/walk', 'manual/strength', 'gpx/ride', 'gpx/hike', 'tcx/swim', 'recorded_run/run',
    ]);
  });

  it('keeps missing, partial, recorded-zero and title-only states as the service answered them', () => {
    const { dailyOverview, meals } = snapshot.responses;
    // No meal logged on 29 Oct: unknown, never 0.
    expect(dailyOverview['2026-10-29']!.meals.count).toBe(0);
    expect(dailyOverview['2026-10-29']!.meals.energyKcal).toEqual({ recordedEntries: 0, total: null });
    // Nothing at all on 11 Nov (an unlogged date).
    expect(dailyOverview['2026-11-11']).toMatchObject({ checkIn: { recorded: false }, movement: { recorded: false } });
    expect(meals['2026-11-11']!.items).toEqual([]);
    // 14 Nov: carbohydrate recorded for 1 of 2 entries.
    expect(dailyOverview['2026-11-14']!.meals.carbohydrateG).toEqual({ recordedEntries: 1, total: 51 });
    // 21 Nov: a coffee recorded as 0 next to full entries; 20 Nov: a title-only dinner.
    expect(meals['2026-11-21']!.items.find((item) => item.title === 'Black coffee')).toMatchObject({ carbohydrateG: 0, energyKcal: 0, fatG: 0, proteinG: 0 });
    expect(meals['2026-11-20']!.items.some((item) => item.energyKcal === null && item.proteinG === null)).toBe(true);
    // The manual-run comparison the manifest names: +1 (+12.5 %), +11.6 km.
    const comparison = snapshot.responses.activityTrends['2026-11-21|manual|run']!.comparison!;
    expect(comparison.metrics.count).toMatchObject({ current: 9, previous: 8, change: { absolute: 1, percent: 12.5 } });
  });

  it('contains no credential, session, cursor, identifier of a person, organization or run, coordinate or note text', () => {
    const text = snapshotText();
    // Field names (values are app-written sentences such as "Strength sessions: 1", which are fine).
    const keys = new Set<string>();
    const collect = (value: unknown) => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(value)) keys.add(key);
        collect(entry);
      }
    };
    collect(JSON.parse(text));
    const forbiddenKeys = [...keys].filter((key) => /password|secret|token|csrf|session|cookie|credential|latitude|longitude|coordinates|geometry|polyline|externalIdentity|email|userId|orgId|runId|^note$|notes|payload/iu.test(key));
    expect(forbiddenKeys).toEqual([]);
    expect(text).not.toContain('Synthetic note');
    // The dataset's runner, coach, organization (dataset-plan.ts portfolioIdentities) and its shared run (the manifest).
    for (const id of ['dddddddd-dddd-4ddd-8ddd-dddddddd0001', 'dddddddd-dddd-4ddd-8ddd-dddddddd0002', 'dddddddd-dddd-4ddd-8ddd-dddddddd0000', '8c513944-a83e-4791-ab79-7263bb29c6e1']) {
      expect(text).not.toContain(id);
    }
    expect(text).not.toMatch(/demo-runner|demo-coach/u);
    for (const page of Object.values(snapshot.responses.meals)) expect(page.nextCursor).toBeNull();
  });
});

describe('a snapshot that does not hold together is refused with a reason', () => {
  const refusal = (input: unknown) => {
    try {
      parseShowcaseSnapshot(input);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(ShowcaseSnapshotError);
      return (error as Error).message;
    }
  };

  it('accepts the committed file', () => {
    expect(refusal(snapshotJson())).toBeNull();
  });

  it.each([
    ['another format', (json: ShowcaseSnapshot) => { json.format = 'something-else' as never; }, /format/u],
    ['another contract version', (json: ShowcaseSnapshot) => { json.contracts.dailyOverview = 'daily-overview-3' as never; }, /contracts\.dailyOverview/u],
    ['a non-synthetic dataset', (json: ShowcaseSnapshot) => { json.dataset.synthetic = false as never; }, /dataset\.synthetic/u],
    ['an invalid response value', (json: ShowcaseSnapshot) => { (json.responses.dailyOverview['2026-11-21']!.movement as { steps: number }).steps = -1; }, /responses\.dailyOverview/u],
    ['an extra field in a response', (json: ShowcaseSnapshot) => { (json.responses.meals['2026-11-21']!.items[0] as unknown as Record<string, unknown>).owner = 'x'; }, /responses\.meals/u],
    ['a response under another date', (json: ShowcaseSnapshot) => { json.responses.dailyOverview['2026-11-20'] = json.responses.dailyOverview['2026-11-21']!; }, /2026-11-20/u],
    ['a missing day of a Trends range', (json: ShowcaseSnapshot) => { json.selections.days = json.selections.days.filter((day) => day !== '2026-11-01'); }, /2026-11-01/u],
    ['a response that is not offered', (json: ShowcaseSnapshot) => { json.responses.weeklyReview['2026-10-12'] = json.responses.weeklyReview['2026-10-19']!; }, /weeklyReview/u],
    ['a wall-clock timestamp left in a meal', (json: ShowcaseSnapshot) => { json.responses.meals['2026-11-21']!.items[0]!.createdAt = '2026-11-22T09:15:40.000Z'; }, /wall-clock/u],
    ['a computation time other than the snapshot instant', (json: ShowcaseSnapshot) => { json.responses.dailyTrends['2026-11-21']!.provenance.computedAt = '2026-11-23T10:00:00.000Z'; }, /snapshot\.readAt/u],
    ['a date after the snapshot', (json: ShowcaseSnapshot) => { json.selections.trendsEndDates = ['2026-11-15', '2026-11-21', '2026-11-22']; }, /2026-11-21/u],
  ])('%s', (_name, change, reason) => {
    expect(refusal(mutated(change))).toMatch(reason);
  });

  it('refuses something that is not a snapshot at all', () => {
    expect(refusal(null)).toMatch(/document/u);
    expect(refusal([])).toMatch(/document|format/u);
  });
});
