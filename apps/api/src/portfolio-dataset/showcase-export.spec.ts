import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mealListResponseSchema, type MealListResponse } from '@running-tracker/contracts';
import { parseShowcaseSnapshot, showcaseActivityKey, type ShowcaseSnapshot } from '@running-tracker/contracts/showcase';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatasetManifest } from './dataset-manifest.js';
import { PORTFOLIO_DATASET_VERSION, portfolioIdentities } from './dataset-plan.js';
import { DIGEST_NORMALIZATION_VERSION } from './dataset-snapshot.js';
import { IsolationError, type DockerRunner } from './isolation.js';
import { datasetPaths, repositoryRoot } from './local-environment.js';
import {
  buildShowcaseSnapshot,
  checkedManifest,
  derivedMealId,
  exportShowcaseSnapshot,
  hasActivityEntries,
  normalizedMealPage,
  publicContentProblems,
  readRecordedBaseline,
  serializeShowcaseSnapshot,
  SHOWCASE_EXPORT_CONNECTION_OPTION,
  SHOWCASE_SNAPSHOT_PATH,
  showcaseCatalog,
  ShowcaseExportError,
  snapshotReadAt,
  type ShowcaseResponses,
} from './showcase-export.js';

// The showcase export (ADR-0099): its catalog, its handling of volatile values, its canonical output, its allowlist, and
// its refusals before Docker or any database connection is touched. The real export against the dataset is exercised by
// `npm run portfolio:showcase:export` (twice, byte-identical, and `--check`) in the verification report.

const DIGEST = 'sha256:b6222c858f464e8d4fe465b3f9c29a95f5c8f0f3e0cf3403b0021d49012e857d';
const parameters = { anchorDate: '2026-11-21', seed: 'somalane-portfolio-v1', timeZone: 'Europe/Warsaw' };

function manifestFixture(): DatasetManifest {
  return {
    counts: {},
    database: { name: 'somalane_portfolio_demo', project: 'somalane-portfolio-dataset' },
    datasetVersion: PORTFOLIO_DATASET_VERSION,
    digest: DIGEST,
    digestNormalization: DIGEST_NORMALIZATION_VERSION,
    expected: {
      activityComparison: { source: 'manual', type: 'run' },
      finishedRun: { runId: '8c513944-a83e-4791-ab79-7263bb29c6e1' },
      weeklyReview: { week: { end: '2026-11-15', start: '2026-11-09' } },
    },
    gaps: {},
    parameters,
    ranges: { current: { endDate: '2026-11-21', startDate: '2026-10-25' }, previous: { endDate: '2026-10-24', startDate: '2026-09-27' } },
    selections: {},
  } as unknown as DatasetManifest;
}

const committedPath = join(repositoryRoot, ...SHOWCASE_SNAPSHOT_PATH);
const committedText = () => readFileSync(committedPath, 'utf8');
const committed = (): ShowcaseSnapshot => parseShowcaseSnapshot(JSON.parse(committedText()));

function responsesOf(snapshot: ShowcaseSnapshot): ShowcaseResponses {
  const map = <Value>(record: Record<string, Value>) => new Map(Object.entries(record));
  const { responses } = snapshot;
  return {
    activityTrends: map(responses.activityTrends),
    dailyOverview: map(responses.dailyOverview),
    dailyTrends: map(responses.dailyTrends),
    meals: map(responses.meals),
    weeklyReview: map(responses.weeklyReview),
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('the catalog, from the manifest alone', () => {
  it('offers the anchor and the review week’s Sunday as Trends ends, every date those ranges open, and their weeks', () => {
    const catalog = showcaseCatalog(manifestFixture());
    expect(catalog.sampleDate).toBe('2026-11-21');
    expect(catalog.defaultWeekStart).toBe('2026-11-16');
    expect(catalog.trendsEndDates).toEqual(['2026-11-15', '2026-11-21']);
    expect(catalog.days[0]).toBe('2026-10-19');
    expect(catalog.days.at(-1)).toBe('2026-11-21');
    expect(catalog.days).toHaveLength(34);
    expect(catalog.weeks).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
    expect(catalog.defaultActivity).toEqual({ source: 'manual', type: 'run' });
    // Every source and type the contract allows is read; a recorded run is only a run.
    expect(catalog.activityCandidates).toHaveLength(22);
    expect(catalog.activityCandidates.filter((selection) => selection.source === 'recorded_run')).toEqual([{ source: 'recorded_run', type: 'run' }]);
  });

  it('reads every response at one fixed instant: the first instant after the anchor in the dataset’s zone', () => {
    expect(snapshotReadAt(manifestFixture())).toBe('2026-11-21T23:00:00.000Z');
    const summer = manifestFixture();
    summer.parameters = { ...parameters, anchorDate: '2026-07-01' };
    expect(snapshotReadAt(summer)).toBe('2026-07-01T22:00:00.000Z');
  });

  type Change = (manifest: DatasetManifest & { database: { name: string; project: string } }) => void;
  it.each<[string, Change, RegExp]>([
    ['another dataset version', (manifest) => { manifest.datasetVersion = 'portfolio-dataset-v0'; }, /datasetVersion/u],
    ['another digest normalisation', (manifest) => { manifest.digestNormalization = 'x'; }, /digestNormalization/u],
    ['a malformed digest', (manifest) => { manifest.digest = 'md5:abc'; }, /digest is not/u],
    ['another database', (manifest) => { manifest.database = { name: 'running_tracker', project: 'somalane-portfolio-dataset' }; }, /does not describe/u],
    ['a review week that is not Monday to Sunday', (manifest) => { manifest.expected.weeklyReview.week = { end: '2026-11-16', start: '2026-11-10' }; }, /Monday-to-Sunday/u],
    ['another activity selection', (manifest) => { manifest.expected.activityComparison = { ...manifest.expected.activityComparison, source: 'gpx' as 'manual' }; }, /manual run/u],
  ])('refuses a manifest with %s', (_name, change, reason) => {
    const manifest = manifestFixture() as DatasetManifest & { database: { name: string; project: string } };
    change(manifest);
    expect(() => checkedManifest(manifest)).toThrow(ShowcaseExportError);
    expect(() => checkedManifest(manifest)).toThrow(reason);
  });
});

describe('volatile values', () => {
  it('derives a meal id from its date and position: a stable, valid version-8 UUID, never the database’s', () => {
    const id = derivedMealId('2026-11-21', 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(derivedMealId('2026-11-21', 0)).toBe(id);
    expect(new Set([derivedMealId('2026-11-21', 1), derivedMealId('2026-11-20', 0), id]).size).toBe(3);
  });

  const page = (nextCursor: string | null): MealListResponse =>
    mealListResponseSchema.parse({
      items: [
        { carbohydrateG: null, createdAt: '2026-11-22T09:15:39.123Z', energyKcal: 0, fatG: 0, localDate: '2026-11-21', mealId: '1f6a3c2e-9b8d-4e7f-a6b5-c4d3e2f1a0b9', mealType: 'snack', proteinG: 0, source: 'manual', timeZone: 'Europe/Warsaw', title: 'Black coffee', updatedAt: '2026-11-22T09:15:39.123Z' },
      ],
      nextCursor,
    });

  it('replaces a meal’s id and wall-clock times and keeps every value', () => {
    const [item] = normalizedMealPage(page(null), '2026-11-21', '2026-11-21T23:00:00.000Z').items;
    expect(item).toEqual({
      carbohydrateG: null,
      createdAt: '2026-11-21T23:00:00.000Z',
      energyKcal: 0,
      fatG: 0,
      localDate: '2026-11-21',
      mealId: derivedMealId('2026-11-21', 0),
      mealType: 'snack',
      proteinG: 0,
      source: 'manual',
      timeZone: 'Europe/Warsaw',
      title: 'Black coffee',
      updatedAt: '2026-11-21T23:00:00.000Z',
    });
  });

  it('refuses a date whose meals need a second page (an opaque cursor is never exported)', () => {
    expect(() => normalizedMealPage(page('opaque-cursor'), '2026-11-21', '2026-11-21T23:00:00.000Z')).toThrow(/do not fit one page/u);
  });
});

describe('the document', () => {
  it('rebuilds the committed snapshot byte for byte from its responses and the manifest (canonical, deterministic)', () => {
    const snapshot = committed();
    const manifest = manifestFixture();
    const rebuilt = buildShowcaseSnapshot(manifest, showcaseCatalog(manifest), responsesOf(snapshot), snapshotReadAt(manifest));
    expect(serializeShowcaseSnapshot(rebuilt)).toBe(committedText());
    // Key order of the input does not matter.
    const reversed = Object.fromEntries(Object.entries(rebuilt).reverse()) as ShowcaseSnapshot;
    expect(serializeShowcaseSnapshot(reversed)).toBe(committedText());
  });

  it('offers only activity selections with entries in either period, and refuses when the manifest’s own has none', () => {
    const snapshot = committed();
    for (const selection of snapshot.selections.activity) {
      const withEntries = snapshot.selections.trendsEndDates.some((endDate) => hasActivityEntries(snapshot.responses.activityTrends[showcaseActivityKey(endDate, selection)]!));
      expect(withEntries, `${selection.source}/${selection.type}`).toBe(true);
    }
    const responses = responsesOf(snapshot);
    for (const endDate of snapshot.selections.trendsEndDates) responses.activityTrends.delete(showcaseActivityKey(endDate, { source: 'manual', type: 'run' }));
    const manifest = manifestFixture();
    expect(() => buildShowcaseSnapshot(manifest, showcaseCatalog(manifest), responses, snapshotReadAt(manifest))).toThrow(/activity selection has no entries/u);
  });

  it('refuses to publish an identifier of the dataset’s people, organization or runs, or a note', () => {
    const snapshot = committed();
    expect(publicContentProblems(snapshot, [portfolioIdentities.runner, 'Synthetic note'])).toEqual([]);
    const responses = responsesOf(snapshot);
    const meals = responses.meals.get('2026-11-21')!;
    responses.meals.set('2026-11-21', { ...meals, items: meals.items.map((item, index) => (index === 0 ? { ...item, title: `Lunch ${portfolioIdentities.runner}` } : item)) });
    const manifest = manifestFixture();
    expect(() => buildShowcaseSnapshot(manifest, showcaseCatalog(manifest), responses, snapshotReadAt(manifest))).toThrow(/more than the allowlist/u);
  });

  it('refuses a response read at another instant', () => {
    const responses = responsesOf(committed());
    const trends = responses.dailyTrends.get('2026-11-21')!;
    responses.dailyTrends.set('2026-11-21', { ...trends, provenance: { ...trends.provenance, computedAt: '2026-11-23T08:00:00.000Z' } });
    const manifest = manifestFixture();
    expect(() => buildShowcaseSnapshot(manifest, showcaseCatalog(manifest), responses, snapshotReadAt(manifest))).toThrow(/snapshot is invalid/u);
  });
});

describe('the export’s refusals before Docker or any connection', () => {
  function environment(options: { digest?: string; manifest?: boolean; seedState?: 'complete' | 'interrupted' | 'none' } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'showcase-export-'));
    directories.push(root);
    const paths = datasetPaths(root);
    mkdirSync(paths.secrets, { recursive: true });
    writeFileSync(paths.settings, `${JSON.stringify({ databasePort: 5442, project: 'somalane-portfolio-dataset' })}\n`);
    for (const name of ['postgres-password', 'owner-password', 'runtime-password', 'maintenance-password', 'cursor-signing-key']) writeFileSync(join(paths.secrets, name), `${'a'.repeat(64)}\n`);
    if (options.manifest !== false) writeFileSync(paths.manifest, `${JSON.stringify(manifestFixture(), null, 2)}\n`);
    if ((options.seedState ?? 'complete') !== 'none') {
      writeFileSync(paths.seedState, `${JSON.stringify({ digest: options.digest ?? DIGEST, parameters, status: options.seedState ?? 'complete', version: PORTFOLIO_DATASET_VERSION })}\n`);
    }
    return paths;
  }
  const docker = () => vi.fn<DockerRunner>(() => ({ status: 0, stderr: '', stdout: '' }));

  it('refuses APP_ENV=production before reading anything', async () => {
    const runner = docker();
    await expect(exportShowcaseSnapshot({ docker: runner, environment: { APP_ENV: 'production' }, paths: environment() })).rejects.toThrow(IsolationError);
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses without a manifest, without a recorded completion, or when they disagree', async () => {
    const runner = docker();
    await expect(exportShowcaseSnapshot({ docker: runner, environment: {}, paths: environment({ manifest: false }) })).rejects.toThrow(/No dataset manifest/u);
    await expect(exportShowcaseSnapshot({ docker: runner, environment: {}, paths: environment({ seedState: 'none' }) })).rejects.toThrow(/does not record a completed dataset/u);
    await expect(exportShowcaseSnapshot({ docker: runner, environment: {}, paths: environment({ seedState: 'interrupted' }) })).rejects.toThrow(/does not record a completed dataset/u);
    await expect(exportShowcaseSnapshot({ docker: runner, environment: {}, paths: environment({ digest: `sha256:${'b'.repeat(64)}` }) })).rejects.toThrow(/different digests/u);
    expect(runner).not.toHaveBeenCalled();
    expect(() => readRecordedBaseline(environment())).not.toThrow();
  });

  it('refuses when the dataset’s container is not the one running, before any database connection', async () => {
    const runner = docker();
    await expect(exportShowcaseSnapshot({ docker: runner, environment: {}, paths: environment() })).rejects.toThrow(/is not running/u);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0]).toContain('ps');
  });

  it('opens only read-only connections', () => {
    expect(SHOWCASE_EXPORT_CONNECTION_OPTION).toBe('-c default_transaction_read_only=on');
  });
});
