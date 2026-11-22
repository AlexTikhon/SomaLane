import {
  activityTrendsSchema,
  addLocalDays,
  dailyOverviewSchema,
  dailyTrendsSchema,
  ingestPointsRequestSchema,
  weeklyReviewSchema,
  type PointInput,
} from '@running-tracker/contracts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { SessionManager } from '../../src/auth/session-manager.js';
import { InMemorySessionStore } from '../../src/auth/session-store.js';
import { systemClock } from '../../src/clock.js';
import { withAuthenticatedTenantTransaction } from '../../src/database/authenticated-tenant-transaction.js';
import { runRawPurgeOnce } from '../../src/maintenance/run-raw-purge.js';
import { ingestRunPoints } from '../../src/runs/run-service.js';
import { validateEnvironment } from '../../src/config/environment.js';
import { createDatabasePool } from '../../src/database/database.js';
import { buildManifest, type DatasetManifest } from '../../src/portfolio-dataset/dataset-manifest.js';
import { planDataset, zonedInstantMs, type DatasetParameters } from '../../src/portfolio-dataset/dataset-plan.js';
import { datasetDigest, readSnapshot } from '../../src/portfolio-dataset/dataset-snapshot.js';
import {
  classifySnapshot,
  DatasetBusyError,
  DatasetConflictError,
  instantClock,
  seedPortfolioDataset,
  type SeedHooks,
  type SeedResult,
} from '../../src/portfolio-dataset/dataset-writer.js';
import { IsolationError, verifyConnectedServer } from '../../src/portfolio-dataset/isolation.js';
import { datasetPaths, type DatasetPaths } from '../../src/portfolio-dataset/local-environment.js';
import { readSeedState, seedAndRecord } from '../../src/portfolio-dataset/prepare-cli.js';
import { createThrowawayDatabase, dropThrowawayDatabases, type ThrowawayDatabase } from './throwaway-database.js';

// Release step 2 against real PostgreSQL: every database here is a throwaway one inside the isolated dataset server
// (somalane_portfolio_t_<hex>), created and dropped by this file. The anchor's range crosses the 2026-10-25 change from
// CEST to CET.
const parameters: DatasetParameters = { anchorDate: '2026-11-08', seed: 'portfolio-test-seed', timeZone: 'Europe/Warsaw' };
const plan = planDataset(parameters);
const ids = plan.identities;
const zone = parameters.timeZone;
const origin = 'http://127.0.0.1:5373';
const outsider = { org: 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0000', user: 'eeeeeeee-eeee-4eee-8eee-eeeeeeee0001' };
const nowMs = zonedInstantMs(addLocalDays(parameters.anchorDate, 1), 12, 0, zone);

const seedUrls = (database: ThrowawayDatabase) => ({ maintenance: database.urls.maintenance, owner: database.urls.owner, runtime: database.urls.runtime });
const seed = (database: ThrowawayDatabase, overrides: Partial<Parameters<typeof seedPortfolioDataset>[0]> = {}) =>
  seedPortfolioDataset({ environment: {}, nowMs, parameters, urls: seedUrls(database), ...overrides });

async function snapshotOf(database: ThrowawayDatabase) {
  const client = new pg.Client({ connectionString: database.urls.owner });
  await client.connect();
  try {
    await verifyConnectedServer(client, { database: database.name, proof: database.proof, role: 'owner' }, 'owner URL');
    return await readSnapshot(client, { coach: ids.coach, organization: ids.organization, runner: ids.runner });
  } finally {
    await client.end();
  }
}

async function ownerQuery<Row extends pg.QueryResultRow = pg.QueryResultRow>(database: ThrowawayDatabase, text: string, values: unknown[] = []): Promise<Row[]> {
  const client = new pg.Client({ connectionString: database.urls.owner });
  await client.connect();
  try {
    await verifyConnectedServer(client, { database: database.name, proof: database.proof, role: 'owner' }, 'owner URL');
    return (await client.query<Row>(text, values)).rows;
  } finally {
    await client.end();
  }
}

interface TableFingerprint {
  /** md5 of every row's full text (all columns, geometry as hex), in a stable order. */
  content: string;
  rows: number;
  /** md5 of each timestamp column's values, so a rewritten created_at / updated_at / computed_at is named. */
  timestamps: Record<string, string>;
  /** md5 of the row versions (xmin): any UPDATE, even one that writes the same values, changes it. */
  versions: string;
}

/** Every row of every table the owner role holds in the throwaway database, read as the verified owner role. */
async function databaseFingerprint(database: ThrowawayDatabase): Promise<Record<string, TableFingerprint>> {
  const client = new pg.Client({ connectionString: database.urls.owner });
  await client.connect();
  try {
    await verifyConnectedServer(client, { database: database.name, proof: database.proof, role: 'owner' }, 'owner URL');
    const tables = await client.query<{ name: string; schema: string; table: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name, n.nspname AS schema, c.relname AS table
         FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname IN ('public', 'app_private')
          AND pg_get_userbyid(c.relowner) = 'running_tracker_owner'
        ORDER BY 1`,
    );
    const result: Record<string, TableFingerprint> = {};
    for (const { name, schema, table } of tables.rows) {
      const totals = await client.query<{ content: string; rows: number; versions: string }>(
        `SELECT count(*)::integer AS rows,
                md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS content,
                md5(coalesce(string_agg(t.xmin::text, '|' ORDER BY t.xmin::text), '')) AS versions
           FROM ${name} AS t`,
      );
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND data_type LIKE 'timestamp%' ORDER BY column_name`,
        [schema, table],
      );
      const timestamps: Record<string, string> = {};
      for (const { column_name: column } of columns.rows) {
        const quoted = (await client.query<{ quoted: string }>('SELECT quote_ident($1) AS quoted', [column])).rows[0]!.quoted;
        const values = await client.query<{ digest: string }>(`SELECT md5(coalesce(string_agg(${quoted}::text, '|' ORDER BY ${quoted}::text), '')) AS digest FROM ${name}`);
        timestamps[column] = values.rows[0]!.digest;
      }
      result[name] = { ...totals.rows[0]!, timestamps };
    }
    return result;
  } finally {
    await client.end();
  }
}

async function mealCount(database: ThrowawayDatabase): Promise<number> {
  return (await ownerQuery<{ count: number }>(database, 'SELECT count(*)::integer AS count FROM meals'))[0]!.count;
}

/** A .local/portfolio-dataset/ directory of its own, so seedAndRecord writes its real artifacts there. */
const recordDirectories: string[] = [];
function recordPaths(): DatasetPaths {
  const root = mkdtempSync(join(tmpdir(), 'portfolio-dataset-record-'));
  recordDirectories.push(root);
  const paths = datasetPaths(root);
  mkdirSync(paths.directory, { recursive: true });
  return paths;
}
const artifactFingerprint = (paths: DatasetPaths) =>
  [paths.seedState, paths.manifest].map((path) => ({ bytes: readFileSync(path).toString('base64'), mtimeMs: statSync(path).mtimeMs, path }));

/** Runs seedAndRecord against a throwaway database with the real core writer; the writer gets the recorded digest. */
const record = (paths: DatasetPaths, database: ThrowawayDatabase, hooks?: SeedHooks) =>
  seedAndRecord(paths, parameters, () => undefined, (expectedDigest) => seed(database, { expectedDigest, ...(hooks === undefined ? {} : { hooks }) }));

/**
 * Runs an attempt that must be refused before any seed write and proves it: the error, no write hook reached, every
 * stored row, row version and timestamp unchanged, the same meal count.
 */
async function expectRefusedBeforeWrites(database: ThrowawayDatabase, attempt: (hooks: SeedHooks) => Promise<unknown>): Promise<Error> {
  const before = await databaseFingerprint(database);
  const meals = await mealCount(database);
  const reached: string[] = [];
  const outcome = await attempt({ afterWrite: (operation) => void reached.push(operation) }).then(
    () => new Error('the attempt was accepted'),
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).not.toBe('the attempt was accepted');
  expect(reached).toEqual([]);
  expect(await mealCount(database)).toBe(meals);
  expect(await databaseFingerprint(database)).toEqual(before);
  return outcome as Error;
}

describe('portfolio dataset on real PostgreSQL (isolated throwaway databases)', () => {
  let primary: ThrowawayDatabase;
  let first: SeedResult;
  let manifest: DatasetManifest;

  beforeAll(async () => {
    primary = await createThrowawayDatabase();
    first = await seed(primary);
    manifest = buildManifest(first.plan, first.report, first.digest);
  });

  afterAll(async () => {
    for (const directory of recordDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
    const dropped = await dropThrowawayDatabases();
    expect(dropped.every((name) => /^somalane_portfolio_t_[0-9a-f]{12}$/u.test(name))).toBe(true);
  });

  it('seeds an empty database completely, proving the owned server and every role before writing', () => {
    expect(first.stateBefore).toBe('empty');
    expect(first.stateAfter).toBe('complete');
    expect(first.writes).toBeGreaterThan(250);
    expect(first.proof.project).toBe('somalane-portfolio-dataset');
    for (const [role, expectedRole] of [
      ['owner', 'running_tracker_owner'],
      ['runtime', 'running_tracker_runtime'],
      ['maintenance', 'running_tracker_maintenance'],
    ] as const) {
      expect(first.identities[role]).toEqual({
        clusterName: 'somalane-portfolio-dataset',
        database: primary.name,
        role: expectedRole,
        sessionRole: expectedRole,
        systemIdentifier: first.proof.systemIdentifier,
      });
    }
    expect(first.report.snapshot.dailyMetrics).toHaveLength(plan.checkIns.length);
    expect(first.report.snapshot.dailyMovement).toHaveLength(plan.movement.length);
    expect(first.report.snapshot.meals).toHaveLength(plan.meals.length);
    expect(first.report.snapshot.activities).toHaveLength(plan.manualActivities.length + plan.imports.length);
    expect(first.report.snapshot.runs).toHaveLength(plan.runs.length);
    expect(Object.values(first.report.runPointCounts).reduce((sum, count) => sum + count, 0)).toBe(manifest.counts.runPointsIngested);
  });

  it('reruns without writing or duplicating anything and gives the same digest', async () => {
    const again = await seed(primary, { expectedDigest: first.digest });
    expect(again.stateBefore).toBe('complete');
    expect(again.writes).toBe(0);
    expect(again.digest).toBe(first.digest);
    expect(again.baseline).toBe('matched');
    const counts = await ownerQuery<{ activities: number; meals: number; runs: number; summaries: number }>(
      primary,
      `SELECT (SELECT count(*) FROM activities)::integer AS activities, (SELECT count(*) FROM meals)::integer AS meals,
              (SELECT count(*) FROM runs)::integer AS runs, (SELECT count(*) FROM run_summaries)::integer AS summaries`,
    );
    expect(counts[0]).toEqual({ activities: 31, meals: plan.meals.length, runs: 6, summaries: 6 });
  });

  it('publishes current summaries through the maintenance path and keeps import provenance server-owned', async () => {
    const summaries = await ownerQuery<{ algorithm: boolean; current: boolean; distance: number; duration: number; geometry: boolean; run_id: string }>(
      primary,
      `SELECT summary.run_id::text, summary.source_revision = run.data_revision AS current,
              summary.algorithm_version = app_private.current_track_algorithm_version() AS algorithm,
              summary.distance_m AS distance, summary.observed_duration_s AS duration, summary.display_geom IS NOT NULL AS geometry
         FROM run_summaries AS summary JOIN runs AS run ON run.org_id = summary.org_id AND run.id = summary.run_id`,
    );
    expect(summaries).toHaveLength(6);
    for (const summary of summaries) {
      const planned = plan.runs.find((run) => run.runId === summary.run_id)!;
      expect(summary).toMatchObject({ algorithm: true, current: true, geometry: true });
      expect(Math.abs(summary.distance - planned.plannedDistanceM) / planned.plannedDistanceM).toBeLessThan(0.01);
      expect(summary.duration).toBe(planned.plannedDurationS);
    }
    expect(await ownerQuery(primary, 'SELECT * FROM app_private.find_stale_run_summaries(1000)')).toEqual([]);
    const commands = await ownerQuery<{ count: number }>(primary, 'SELECT count(*)::integer AS count FROM run_commands');
    expect(commands[0]!.count).toBe(6);

    const imports = await ownerQuery<{ distance_m: number; duration_s: number; fingerprint_bytes: number; id: string; idempotency_key: string; source: string; started_at: string }>(
      primary,
      `SELECT id::text, source, duration_s, distance_m, octet_length(import_fingerprint) AS fingerprint_bytes, idempotency_key::text,
              to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
         FROM activities WHERE source <> 'manual' ORDER BY started_at`,
    );
    expect(imports.map((row) => row.source)).toEqual(['tcx', 'gpx', 'tcx', 'gpx']);
    for (const row of imports) {
      const planned = plan.imports.find((item) => item.activityId === row.id)!;
      expect(row.source).toBe(planned.kind);
      expect(row.fingerprint_bytes).toBe(32);
      expect(row.idempotency_key).toBe(planned.idempotencyKey);
      expect(row.started_at).toBe(planned.expected.startedAt);
      expect(row.duration_s).toBe(planned.expected.durationS);
      expect(Math.abs(row.distance_m - planned.expected.distanceM)).toBeLessThanOrEqual(planned.expected.distanceToleranceM);
    }
    const manualProvenance = await ownerQuery<{ sources: string[] }>(
      primary,
      `SELECT array_agg(DISTINCT source ORDER BY source) AS sources FROM (
         SELECT source FROM meals UNION ALL SELECT source FROM daily_movement UNION ALL
         SELECT source FROM activities WHERE import_fingerprint IS NULL) AS provenance`,
    );
    expect(manualProvenance[0]!.sources).toEqual(['manual']);
  });

  describe('existing read models agree with the plan', () => {
    let app: ReturnType<typeof createApp>;
    let runtimePool: pg.Pool;
    let runnerCookie: string;
    let coachCookie: string;
    let outsiderCookie: string;

    beforeAll(async () => {
      await ownerQuery(primary, 'INSERT INTO users (id, external_identity) VALUES ($1, $2)', [outsider.user, 'synthetic-outsider']);
      await ownerQuery(primary, 'INSERT INTO organizations (id) VALUES ($1)', [outsider.org]);
      await ownerQuery(primary, "INSERT INTO memberships (org_id, user_id, role, active) VALUES ($1, $2, 'runner', true)", [outsider.org, outsider.user]);
      const config = validateEnvironment({
        ALLOWED_ORIGINS: origin,
        APP_ENV: 'test',
        DATABASE_URL: primary.urls.runtime,
        LOCAL_AUTH_ENABLED: 'true',
        LOCAL_AUTH_USER_IDS: [ids.runner, ids.coach, outsider.user].join(','),
        MAINTENANCE_DATABASE_URL: primary.urls.maintenance,
        SESSION_COOKIE_SECURE: 'false',
      });
      runtimePool = createDatabasePool(config);
      const client = await runtimePool.connect();
      try {
        await verifyConnectedServer(client, { database: primary.name, proof: primary.proof, role: 'runtime' }, 'runtime URL');
      } finally {
        client.release();
      }
      const clock = instantClock(nowMs);
      app = createApp({ clock, config, pool: runtimePool, sessionManager: new SessionManager({ clock, store: new InMemorySessionStore(100), ttlMs: config.SESSION_TTL_MS }) });
      const login = async (userId: string) => {
        const response = await request(app).post('/api/session').set('Origin', origin).type('application/json').send({ userId }).expect(201);
        const header = response.headers['set-cookie'] as unknown as string[];
        return header[0]!.split(';', 1)[0]!;
      };
      runnerCookie = await login(ids.runner);
      coachCookie = await login(ids.coach);
      outsiderCookie = await login(outsider.user);
    });

    afterAll(async () => {
      await runtimePool?.end();
    });

    const get = (cookie: string, path: string, query: Record<string, string> = {}) => request(app).get(`/api/orgs/${ids.organization}${path}`).query(query).set('Cookie', cookie);

    it('Today (the anchor) shows the planned check-in, movement, activities, run and meals', async () => {
      const response = await get(runnerCookie, `/daily-overview/${parameters.anchorDate}`, { timeZone: zone }).expect(200);
      const overview = dailyOverviewSchema.parse(response.body);
      const expected = manifest.expected.today;
      expect(overview.day.inProgress).toBe(false);
      expect(overview.checkIn).toMatchObject({ recorded: true, sleepMinutes: expected.checkIn!.sleepMinutes, weightKg: expected.checkIn!.weightKg });
      expect(overview.movement).toMatchObject({ recorded: true, steps: expected.movement!.steps, activeEnergyKcal: expected.movement!.activeEnergyKcal });
      expect(overview.manualActivities.count).toBe(Object.values(expected.manualActivities).reduce((sum, count) => sum + count, 0));
      expect(overview.gpsRuns.count).toBe(expected.recordedRuns);
      expect(overview.meals).toMatchObject({ count: expected.meals.loggedEntries });
      expect(JSON.stringify(overview.meals)).toContain(`"total":${String(expected.meals.metrics.energyKcal.total)}`);
    });

    it('an unlogged date is empty, not zero', async () => {
      const response = await get(runnerCookie, `/daily-overview/${plan.gaps.unlogged.at(-1)!}`, { timeZone: zone }).expect(200);
      const overview = dailyOverviewSchema.parse(response.body);
      expect(overview.checkIn.recorded).toBe(false);
      expect(overview.movement.recorded).toBe(false);
      expect(overview.manualActivities.count).toBe(0);
      expect(overview.meals.count).toBe(0);
    });

    it('the weekly review shows the planned movement, meals and coverage', async () => {
      const expected = manifest.expected.weeklyReview;
      const response = await get(runnerCookie, '/weekly-review', { timeZone: zone, weekStart: expected.week.start }).expect(200);
      const review = weeklyReviewSchema.parse(response.body);
      expect(review.week).toMatchObject({ end: expected.week.end, inProgress: false, start: expected.week.start });
      expect(review.movement).toMatchObject({
        activeEnergyKcal: { daysRecorded: expected.movement.activeEnergyKcal.daysRecorded, recordedTotal: expected.movement.activeEnergyKcal.total },
        daysWithRecord: expected.movement.daysWithRecord,
        steps: { daysRecorded: expected.movement.steps.daysRecorded, recordedTotal: expected.movement.steps.total },
      });
      expect(review.meals).toMatchObject({
        daysWithEntries: expected.meals.daysWithEntries,
        energyKcal: { recordedEntries: expected.meals.metrics.energyKcal.recordedEntries, total: expected.meals.metrics.energyKcal.total },
        fatG: { recordedEntries: expected.meals.metrics.fatG.recordedEntries, total: expected.meals.metrics.fatG.total },
        loggedEntries: expected.meals.loggedEntries,
      });
      expect(review.coverage).toMatchObject({
        daysWithCheckInRecord: expected.checkInDays,
        gpsRuns: { count: expected.recordedRuns },
        manualActivities: { count: expected.manualActivities.count, withDistance: expected.manualActivities.withDistance },
      });
    });

    it('nutrition Trends show partial, missing and recorded-zero values as planned', async () => {
      const response = await get(runnerCookie, '/daily-trends', { endDate: parameters.anchorDate, timeZone: zone }).expect(200);
      const trends = dailyTrendsSchema.parse(response.body);
      const expected = manifest.expected.nutritionTrends;
      expect(trends.range).toMatchObject({ days: 28, endDate: parameters.anchorDate, startDate: plan.ranges.current.startDate });
      expect(trends.summary.nutrition).toMatchObject({
        daysWithEntries: expected.range.daysWithEntries,
        loggedEntries: expected.range.loggedEntries,
        carbohydrateG: { recordedEntries: expected.range.metrics.carbohydrateG.recordedEntries, total: expected.range.metrics.carbohydrateG.total },
        energyKcal: { recordedEntries: expected.range.metrics.energyKcal.recordedEntries, total: expected.range.metrics.energyKcal.total },
      });
      for (const named of Object.values(expected.dates)) {
        const day = trends.days.find((entry) => entry.localDate === named.localDate)!;
        expect(day.nutrition.loggedEntries).toBe(named.loggedEntries);
        for (const field of ['energyKcal', 'proteinG', 'carbohydrateG', 'fatG'] as const) expect(day.nutrition[field]).toEqual(named.metrics[field]);
      }
      expect(expected.dates.missing.metrics.energyKcal.total).toBeNull();
      expect(expected.dates.recordedZeros.metrics.fatG.recordedEntries).toBeGreaterThan(expected.dates.partial.metrics.fatG.recordedEntries);
    });

    it('the manual-run activity comparison with the previous 28 dates is defined and matches the plan', async () => {
      const response = await get(runnerCookie, '/activity-trends', { compare: 'previous_period', endDate: parameters.anchorDate, source: 'manual', timeZone: zone, type: 'run' }).expect(200);
      const trends = activityTrendsSchema.parse(response.body);
      const expected = manifest.expected.activityComparison;
      const comparison = trends.comparison!;
      expect(comparison.periodReasons).toEqual([]);
      expect(comparison.metrics.count).toEqual({
        change: { absolute: expected.change.count, percent: expected.change.countPercent, percentUnavailableReason: null, status: 'available' },
        current: expected.current.count,
        previous: expected.previous.count,
      });
      expect(comparison.metrics.distance).toMatchObject({ change: { absolute: expected.change.distanceM, status: 'available' }, current: expected.current.distanceM, previous: expected.previous.distanceM });
      expect(JSON.stringify(comparison.metrics)).toContain(`"current":${String(expected.current.durationS)}`);
    });

    it('the recorded-run comparison uses only current summaries, and GPX has no previous entries', async () => {
      const response = await get(runnerCookie, '/activity-trends', { compare: 'previous_period', endDate: parameters.anchorDate, source: 'recorded_run', timeZone: zone, type: 'run' }).expect(200);
      const comparison = activityTrendsSchema.parse(response.body).comparison!;
      expect(comparison.metrics.count).toMatchObject({ current: 3, previous: 3 });
      expect(comparison.metrics.distance.change.status).toBe('available');
      const gpx = await get(runnerCookie, '/activity-trends', { compare: 'previous_period', endDate: parameters.anchorDate, source: 'gpx', timeZone: zone, type: 'ride' }).expect(200);
      expect(JSON.stringify(activityTrendsSchema.parse(gpx.body).comparison!.metrics.distance.change)).toContain('previous_period_no_entries');
    });

    it('the anchor run is finished with its current published summary', async () => {
      const run = manifest.expected.finishedRun;
      const response = await get(runnerCookie, `/runs/${run.runId}`).expect(200);
      expect(response.body).toMatchObject({ runId: run.runId, status: 'finished' });
      expect((response.body as { summary: { distanceM: number } | null }).summary).not.toBeNull();
    });

    it('owner-only health data stays invisible to the coach and to another organization', async () => {
      const anchor = parameters.anchorDate;
      const from = plan.dates[0]!;
      expect((await get(coachCookie, '/daily-metrics', { from: addLocalDays(anchor, -27), to: anchor }).expect(200)).body).toEqual({ items: [] });
      expect((await get(coachCookie, '/daily-movement', { from: addLocalDays(anchor, -27), to: anchor }).expect(200)).body).toEqual({ items: [] });
      expect((await get(coachCookie, '/meals', { localDate: anchor }).expect(200)).body).toMatchObject({ items: [] });
      expect((await get(coachCookie, '/activities').expect(200)).body).toMatchObject({ items: [] });
      const coachToday = dailyOverviewSchema.parse((await get(coachCookie, `/daily-overview/${anchor}`, { timeZone: zone }).expect(200)).body);
      expect(coachToday.checkIn.recorded || coachToday.movement.recorded || coachToday.meals.count > 0 || coachToday.manualActivities.count > 0).toBe(false);
      expect(from < anchor).toBe(true);
      // The coach sees the one run shared with them (history), and nothing else of the runner's.
      await get(coachCookie, `/runs/${manifest.expected.finishedRun.runId}`).expect(200);
      await get(coachCookie, `/runs/${plan.runs[0]!.runId}`).expect(404);
      const denied = await get(outsiderCookie, `/daily-overview/${anchor}`, { timeZone: zone }).expect(403);
      expect(denied.body).toMatchObject({ error: { code: 'ORG_ACCESS_DENIED' } });
    });

    it('refuses to seed over unexpected data (the outsider) and changes nothing', async () => {
      const before = datasetDigest((await snapshotOf(primary)).snapshot);
      await expect(seed(primary)).rejects.toThrow(DatasetConflictError);
      await expect(seed(primary)).rejects.toThrow(/user\(s\) other than the synthetic runner and coach/u);
      expect(datasetDigest((await snapshotOf(primary)).snapshot)).toBe(before);
    });
  });

  it('refuses another seed or anchor over a complete dataset before any write', async () => {
    const database = await createThrowawayDatabase();
    const completed = await seed(database);
    for (const other of [{ ...parameters, seed: 'another-seed' }, { ...parameters, anchorDate: '2026-11-07' }]) {
      const attempt = seed(database, { parameters: other });
      await expect(attempt).rejects.toBeInstanceOf(DatasetConflictError);
      await expect(seed(database, { parameters: other })).rejects.toThrow(/is not in this plan|differs from this plan/u);
    }
    expect(datasetDigest((await snapshotOf(database)).snapshot)).toBe(completed.digest);
    expect(completed.digest).toBe(first.digest);
  });

  it('agrees on the canonical digest across independently prepared databases, and a concurrent second seed is refused', async () => {
    const database = await createThrowawayDatabase();
    const results = await Promise.allSettled([seed(database), seed(database)]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<SeedResult> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(DatasetBusyError);
    expect(fulfilled[0]!.value.digest).toBe(first.digest);
    expect(fulfilled[0]!.value.report.snapshot).toEqual(first.report.snapshot);
  });

  it('resumes an interrupted seed (between meals, and inside a run) to the same dataset', async () => {
    const database = await createThrowawayDatabase();
    const failAt = (index: number) => ({
      afterWrite: (_operation: string, count: number) => {
        if (count === index) throw new Error(`injected failure after write ${String(index)}`);
      },
    });
    await expect(seed(database, { hooks: failAt(120) })).rejects.toThrow(/injected failure after write 120/u);
    const partial = await snapshotOf(database);
    expect(classifySnapshot(plan, partial)).toEqual({ reasons: [], state: 'partial' });
    expect(partial.snapshot.meals.length).toBeLessThan(plan.meals.length);

    // Interrupted again during the second run's point upload: the run is left recording with some points.
    let interruptedRun = '';
    await expect(
      seed(database, {
        hooks: {
          afterWrite: (operation) => {
            if (operation.startsWith(`run ${plan.runs[1]!.runId} points 101-`)) {
              interruptedRun = plan.runs[1]!.runId;
              throw new Error('injected failure inside a run');
            }
          },
        },
      }),
    ).rejects.toThrow(/inside a run/u);
    const midRun = await snapshotOf(database);
    expect(midRun.snapshot.runs.find((run) => run.id === interruptedRun)).toMatchObject({ status: 'recording' });
    expect(classifySnapshot(plan, midRun).state).toBe('partial');

    const resumed = await seed(database);
    expect(resumed.stateBefore).toBe('partial');
    expect(resumed.stateAfter).toBe('complete');
    expect(resumed.digest).toBe(first.digest);
  });

  it('does not accept the reproduced drift of a stored snapshot (copied and changed in memory) as complete', () => {
    const stored = first.report;
    expect(classifySnapshot(plan, stored)).toEqual({ reasons: [], state: 'complete' });
    const variants: Array<[string, (copy: typeof stored) => void]> = [
      ['summary distance 999999', (copy) => (copy.snapshot.runSummaries[0]!.distanceM = '999999')],
      ['no display geometry', (copy) => (copy.snapshot.runSummaries[0]!.displayGeometry = null)],
      ['run start 2001-01-01', (copy) => (copy.snapshot.runs[0]!.startedAt = '2001-01-01T00:00:00.000Z')],
      ['finish payload {}', (copy) => (copy.snapshot.runCommands[0]!.payload = '{}')],
    ];
    for (const [name, change] of variants) {
      const copy = structuredClone(stored);
      change(copy);
      const outcome = classifySnapshot(plan, copy);
      expect(outcome.reasons.length, name).toBeGreaterThan(0);
    }
  });

  it('refuses drift in a stored complete dataset before writing, and a subtle change by its recorded digest', async () => {
    const database = await createThrowawayDatabase();
    const completed = await seed(database);
    const run = plan.runs[2]!.runId;
    // A summary changed beyond what its points can produce: refused by the run validation, nothing written.
    await ownerQuery(database, 'UPDATE run_summaries SET distance_m = 999999 WHERE run_id = $1', [run]);
    const drifted = datasetDigest((await snapshotOf(database)).snapshot);
    await expect(seed(database, { expectedDigest: completed.digest })).rejects.toThrow(/summary distance that the recorded points cannot produce/u);
    expect(datasetDigest((await snapshotOf(database)).snapshot)).toBe(drifted);
    // Back to a plausible but different value (0.5 m more): only the recorded digest can tell, and does.
    await ownerQuery(database, 'UPDATE run_summaries SET distance_m = $2 WHERE run_id = $1', [
      run,
      Number(completed.report.snapshot.runSummaries.find((summary) => summary.runId === run)!.distanceM) + 0.5,
    ]);
    const subtle = datasetDigest((await snapshotOf(database)).snapshot);
    expect(subtle).not.toBe(completed.digest);
    await expect(seed(database, { expectedDigest: completed.digest })).rejects.toThrow(/no longer has the digest recorded/u);
    expect(datasetDigest((await snapshotOf(database)).snapshot)).toBe(subtle);
  });

  it('keeps a legitimate raw purge complete with the same digest (retention-compatible)', async () => {
    const database = await createThrowawayDatabase();
    const completed = await seed(database);
    const pool = new pg.Pool({ connectionString: database.urls.maintenance, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await verifyConnectedServer(client, { database: database.name, proof: database.proof, role: 'maintenance' }, 'maintenance URL');
      } finally {
        client.release();
      }
      // The maintenance job the API runs, at the real current time: every run of this anchor finished > 7 days ago.
      for (let cycle = 0; cycle < 20; cycle += 1) if ((await runRawPurgeOnce(pool, systemClock)).status === 'idle') break;
    } finally {
      await pool.end();
    }
    const purged = await snapshotOf(database);
    expect(Object.values(purged.runRawStates)).toEqual(Array.from({ length: 6 }, () => 'purged'));
    expect(Object.keys(purged.runPoints)).toEqual([]);
    const rerun = await seed(database, { expectedDigest: completed.digest });
    expect(rerun).toMatchObject({ baseline: 'matched', digest: completed.digest, stateBefore: 'complete', writes: 0 });
  });

  it.each([
    ['points that are not the planned points', (batch: PointInput[]) => batch.map((point) => ({ ...point, longitude: point.longitude + 0.001 })), 0, /not the planned points/u],
    ['a gap (the second batch first)', (batch: PointInput[]) => batch, 1, /whole number of planned batches/u],
  ])('refuses a partial run holding %s before any further write', async (_name, upload, batchIndex, message) => {
    const database = await createThrowawayDatabase();
    const firstRun = plan.runs[0]!;
    await expect(
      seed(database, {
        hooks: {
          afterWrite: (operation) => {
            if (operation === `run ${firstRun.runId} created`) throw new Error('injected failure after the run was created');
          },
        },
      }),
    ).rejects.toThrow(/after the run was created/u);
    // The malformed upload goes through the application's own ingestion, as the runner.
    const pool = new pg.Pool({ connectionString: database.urls.runtime, max: 1 });
    try {
      const client = await pool.connect();
      try {
        await verifyConnectedServer(client, { database: database.name, proof: database.proof, role: 'runtime' }, 'runtime URL');
      } finally {
        client.release();
      }
      const request = ingestPointsRequestSchema.parse({ points: upload(firstRun.batches[batchIndex]!) });
      await withAuthenticatedTenantTransaction(pool, { userId: ids.runner }, ids.organization, (client) =>
        ingestRunPoints(client, { userId: ids.runner }, ids.organization, firstRun.runId, request, instantClock(Date.parse(firstRun.startedAt) + 600_000)),
      );
    } finally {
      await pool.end();
    }
    const before = await snapshotOf(database);
    await expect(seed(database)).rejects.toThrow(message);
    const after = await snapshotOf(database);
    expect(datasetDigest(after.snapshot)).toBe(datasetDigest(before.snapshot));
    expect(after.runPoints).toEqual(before.runPoints);
  });

  describe('a recorded completion baseline, enforced before any seed write', () => {
    const refusedOver = (state: string) => new RegExp(`a completion was recorded for these parameters \\(${first.digest}\\), but the dataset database is now ${state}`, 'u');
    const coreWroteNothing = /this attempt wrote nothing and overwrote nothing/u;
    const cliWroteNothing = /This attempt wrote nothing to the database, and no manifest or state file was replaced/u;

    /** A throwaway database completed through seedAndRecord, with the real completion record it wrote. */
    async function completedWithRecord() {
      const database = await createThrowawayDatabase();
      const paths = recordPaths();
      const { result } = await record(paths, database);
      expect(result).toMatchObject({ baseline: 'not recorded', digest: first.digest, stateAfter: 'complete', stateBefore: 'empty' });
      expect(readSeedState(paths.seedState)).toMatchObject({ digest: first.digest, status: 'complete' });
      return { database, paths };
    }

    async function deleteMeal(database: ThrowawayDatabase, index: number) {
      const deleted = await ownerQuery(database, 'DELETE FROM meals WHERE idempotency_key = $1 RETURNING id', [plan.meals[index]!.request.idempotencyKey]);
      expect(deleted).toHaveLength(1);
    }

    /** The refusal, by the core writer given the digest and then by seedAndRecord reading it from the record. */
    async function expectBaselineRefusal(database: ThrowawayDatabase, paths: DatasetPaths, state: 'empty' | 'partial') {
      const core = await expectRefusedBeforeWrites(database, (hooks) => seed(database, { expectedDigest: first.digest, hooks }));
      expect(core).toBeInstanceOf(DatasetConflictError);
      expect((core as DatasetConflictError).writes).toBe(0);
      expect(core.message).toMatch(refusedOver(state));
      expect(core.message).toMatch(coreWroteNothing);

      const artifacts = artifactFingerprint(paths);
      const cli = await expectRefusedBeforeWrites(database, (hooks) => record(paths, database, hooks));
      expect(cli.cause).toBeInstanceOf(DatasetConflictError);
      expect(cli.message).toMatch(refusedOver(state));
      expect(cli.message).toMatch(cliWroteNothing);
      expect(cli.message).not.toMatch(/rolled back|stay committed/u);
      expect(artifactFingerprint(paths)).toEqual(artifacts);
    }

    it('refuses the reproduced drift (a summary 0.5 m longer and a deleted meal) instead of resuming it and recreating the meal', async () => {
      const { database, paths } = await completedWithRecord();
      const run = plan.runs[2]!.runId;
      const stored = first.report.snapshot.runSummaries.find((summary) => summary.runId === run)!;
      await ownerQuery(database, 'UPDATE run_summaries SET distance_m = $2 WHERE run_id = $1', [run, Number(stored.distanceM) + 0.5]);
      await deleteMeal(database, 40);
      // Within the run checks' tolerance and a subset of the plan: classified partial, which used to be resumed.
      expect(classifySnapshot(plan, await snapshotOf(database))).toEqual({ reasons: [], state: 'partial' });
      expect(await mealCount(database)).toBe(plan.meals.length - 1);
      await expectBaselineRefusal(database, paths, 'partial');
      expect(await mealCount(database)).toBe(plan.meals.length - 1);
    });

    it('refuses a recorded complete dataset that only lost one meal', async () => {
      const { database, paths } = await completedWithRecord();
      await deleteMeal(database, 0);
      expect(classifySnapshot(plan, await snapshotOf(database))).toEqual({ reasons: [], state: 'partial' });
      await expectBaselineRefusal(database, paths, 'partial');
      expect(await mealCount(database)).toBe(plan.meals.length - 1);
    });

    it('refuses an empty target when a completion is recorded (it does not become a first seed)', async () => {
      const { paths } = await completedWithRecord();
      // The record kept, the data gone: a fresh database stands in for a removed volume.
      const empty = await createThrowawayDatabase();
      expect(classifySnapshot(plan, await snapshotOf(empty))).toEqual({ reasons: [], state: 'empty' });
      await expectBaselineRefusal(empty, paths, 'empty');
      expect((await ownerQuery<{ count: number }>(empty, 'SELECT count(*)::integer AS count FROM users'))[0]!.count).toBe(0);
    });

    it('accepts an unchanged recorded completion with zero writes, the same digest and no row rewritten', async () => {
      const { database, paths } = await completedWithRecord();
      const before = await databaseFingerprint(database);
      const reached: string[] = [];
      const { result } = await record(paths, database, { afterWrite: (operation) => void reached.push(operation) });
      expect(result).toMatchObject({ baseline: 'matched', digest: first.digest, stateAfter: 'complete', stateBefore: 'complete', writes: 0 });
      expect(reached).toEqual([]);
      expect(await databaseFingerprint(database)).toEqual(before);
      expect(readSeedState(paths.seedState)).toMatchObject({ digest: first.digest, status: 'complete' });
    });

    it('still resumes a genuine interrupted first seed, which has no recorded completion', async () => {
      const database = await createThrowawayDatabase();
      const paths = recordPaths();
      const failAt120 = { afterWrite: (_operation: string, count: number) => { if (count === 120) throw new Error('injected failure after write 120'); } };
      await expect(record(paths, database, failAt120)).rejects.toThrow(/injected failure after write 120[\s\S]*running the same command again resumes it/u);
      expect(readSeedState(paths.seedState)).toMatchObject({ status: 'interrupted' });
      expect(() => statSync(paths.manifest)).toThrow();
      expect(classifySnapshot(plan, await snapshotOf(database)).state).toBe('partial');
      const { result } = await record(paths, database);
      expect(result).toMatchObject({ baseline: 'not recorded', digest: first.digest, stateAfter: 'complete', stateBefore: 'partial' });
      expect(result.writes).toBeGreaterThan(0);
      expect(readSeedState(paths.seedState)).toMatchObject({ digest: first.digest, status: 'complete' });
    });
  });

  it('the core writer refuses targets outside the isolation boundary against the real environment', async () => {
    const swap = (url: string, database: string) => url.replace(/\/[^/]+$/u, `/${database}`);
    for (const database of ['running_tracker', 'running_tracker_test']) {
      const urls = Object.fromEntries(Object.entries(seedUrls(primary)).map(([role, url]) => [role, swap(url, database)])) as ReturnType<typeof seedUrls>;
      await expect(seed(primary, { urls })).rejects.toThrow(/never a dataset target/u);
    }
    // The development server's port: no owned container publishes it, so nothing connects there.
    const devPort = Object.fromEntries(Object.entries(seedUrls(primary)).map(([role, url]) => [role, url.replace(/:\d+\//u, ':5433/')])) as ReturnType<typeof seedUrls>;
    await expect(seed(primary, { urls: devPort })).rejects.toThrow(/does not publish 127\.0\.0\.1:5433/u);
    await expect(seed(primary, { urls: devPort })).rejects.toBeInstanceOf(IsolationError);
    // A URL whose password belongs to another role would connect as that role: refused by the URL rule before connecting.
    const swappedRole = { ...seedUrls(primary), runtime: primary.urls.owner };
    await expect(seed(primary, { urls: swappedRole })).rejects.toThrow(/must authenticate as running_tracker_runtime/u);
  });
});
