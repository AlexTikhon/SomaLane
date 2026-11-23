import {
  createActivityRequestSchema,
  createMealRequestSchema,
  ingestPointsRequestSchema,
  putDailyMetricsRequestSchema,
  putDailyMovementRequestSchema,
  runCommandRequestSchema,
  upsertRunShareRequestSchema,
} from '@running-tracker/contracts';
import pg, { type Pool, type PoolClient } from 'pg';

import { createActivity } from '../activities/activity-service.js';
import { readGpxActivity } from '../activities/gpx-activity.js';
import { confirmGpxImport } from '../activities/gpx-import-service.js';
import { readTcxActivity } from '../activities/tcx-activity.js';
import { confirmTcxImport } from '../activities/tcx-import-service.js';
import type { Clock } from '../clock.js';
import { putDailyMetrics } from '../daily-metrics/daily-metrics-service.js';
import { putDailyMovement } from '../daily-movement/daily-movement-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { runSummaryPublicationOnce } from '../maintenance/run-summary-publication.js';
import { createMeal } from '../meals/meal-service.js';
import { applyRunCommand, createRun, ingestRunPoints, upsertRunShare } from '../runs/run-service.js';
import { assertAnchorCompleted, planDataset, type DatasetParameters, type DatasetPlan } from './dataset-plan.js';
import { canonicalJson, datasetDigest, readSnapshot, type DatasetSnapshot, type SnapshotReport } from './dataset-snapshot.js';
import {
  assertNotProduction,
  IsolationError,
  proveOwnedServer,
  validateTargetUrls,
  verifyConnectedServer,
  type ConnectedIdentity,
  type DockerRunner,
  type OwnedServerProof,
  type PortfolioRole,
} from './isolation.js';

// The core writer of the portfolio dataset (docs/runbooks/portfolio-dataset.md). It enforces isolation itself, whoever
// calls it (the CLI, a test): the target URLs are validated, the owned container is proven, and every physical connection
// of every pool reports the expected database, role and server before its first statement is used. Then:
//
// - one seed at a time per database: a session advisory lock on a dedicated owner connection, tried, never waited for;
// - before any write, the existing data is read and classified against the plan: empty, a partial run of THIS plan
//   (resumed), complete (nothing is written), or anything else (refused, with the reasons; nothing is overwritten);
//   when a completion digest is recorded for this target, only that completion is accepted (see baselineRefusal);
// - identities and the membership are provisioned by the owner role (the only rows the application has no route for);
// - every user record goes through the application's own service function inside withAuthenticatedTenantTransaction
//   (runtime role, membership rechecked, row-level security in force), with the request parsed by its contract schema
//   first, exactly as the HTTP routes do. GPX and TCX files are read by the real importers. Recorded runs go through
//   createRun / ingestRunPoints / applyRunCommand; their summaries are calculated and published by the maintenance job
//   function the API runs (runSummaryPublicationOnce). Historical instants come from the injected Clock each service
//   already takes; database defaults (ids, created_at) are left to the database;
// - every write is keyed by a stable operation key derived from the seed (activity ids and idempotency keys, meal keys,
//   run ids, point sequences, the finish command id), so an interrupted seed is resumed by running it again.
//
// No AI provider is involved: nothing here constructs one or makes a network call except to the dataset database.

/**
 * The stored data is not a state this seed accepts. `writes` is the number of seed write operations THIS attempt had
 * performed when it was refused: 0 for every check made before writing (only then does the message say nothing was
 * written); more for a check of the result, whose committed writes stay committed (nothing is rolled back).
 */
export class DatasetConflictError extends Error {
  public constructor(
    public readonly reasons: readonly string[],
    public readonly writes: number,
  ) {
    const outcome =
      writes === 0
        ? 'this attempt wrote nothing and overwrote nothing'
        : `this attempt had already performed ${String(writes)} seed write operation(s) (keyed, idempotent); what they committed stays committed, nothing was rolled back`;
    super(
      `The dataset database is not in a state this seed accepts, and ${outcome}:\n- ${reasons.slice(0, 12).join('\n- ')}` +
        (reasons.length > 12 ? `\n- ... ${String(reasons.length - 12)} more` : ''),
    );
    this.name = 'DatasetConflictError';
  }
}

export class DatasetBusyError extends Error {
  public constructor(database: string) {
    super(`Another seed of ${database} is running (its advisory lock is held); nothing was changed. Wait for it to finish.`);
    this.name = 'DatasetBusyError';
  }
}

export interface SeedHooks {
  /** Called after every write operation (tests inject a failure here to interrupt a seed). */
  afterWrite?: (operation: string, index: number) => void | Promise<void>;
}

export interface SeedOptions {
  docker?: DockerRunner;
  /**
   * The canonical digest recorded when this dataset (same parameters) last completed on this target, if known: the
   * completion baseline. When given, only a complete dataset with exactly this digest is accepted (and nothing is
   * written); a complete dataset with another digest, and an empty or partial one, are refused before any write.
   */
  expectedDigest?: string | undefined;
  environment?: Readonly<Record<string, string | undefined>>;
  hooks?: SeedHooks;
  log?: (line: string) => void;
  /** The real clock's instant, only to refuse an anchor that is not yet completed. */
  nowMs?: number;
  parameters: DatasetParameters;
  urls: Readonly<Record<'maintenance' | 'owner' | 'runtime', string>>;
}

export type DatasetState = 'complete' | 'empty' | 'partial';

export interface SeedResult {
  /** Whether the result was compared with a recorded completion digest. */
  baseline: 'matched' | 'not recorded';
  digest: string;
  identities: Record<'maintenance' | 'owner' | 'runtime', ConnectedIdentity>;
  plan: DatasetPlan;
  proof: OwnedServerProof;
  report: SnapshotReport;
  stateAfter: DatasetState;
  stateBefore: DatasetState;
  writes: number;
}

export function instantClock(instantMs: number): Clock {
  return {
    clearTimeout: (handle) => clearTimeout(handle),
    monotonicNow: () => instantMs,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    utcNow: () => new Date(instantMs),
  };
}

type Expected = { database: string; proof: OwnedServerProof; role: PortfolioRole };

/** A pool whose every NEW physical connection proves its identity before it is handed out. */
function verifyingPool(pool: Pool, expected: Expected, label: string): Pick<Pool, 'connect'> {
  const verified = new WeakSet<PoolClient>();
  const connect = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    if (!verified.has(client)) {
      try {
        await verifyConnectedServer(client, expected, label);
      } catch (error) {
        client.release(true);
        throw error;
      }
      verified.add(client);
    }
    return client;
  };
  return { connect };
}

// --- Expectations ----------------------------------------------------------------------------------------------------

interface ExpectedRows {
  activities: Map<string, DatasetSnapshot['activities'][number]>;
  dailyMetrics: Map<string, DatasetSnapshot['dailyMetrics'][number]>;
  dailyMovement: Map<string, DatasetSnapshot['dailyMovement'][number]>;
  meals: Map<string, Omit<DatasetSnapshot['meals'][number], 'creationDigest'>>;
  runs: Map<string, DatasetPlan['runs'][number]>;
}

const numberText = (value: number | null | undefined) => (value === null || value === undefined ? null : String(value));

/** The rows the plan produces, as the snapshot reads them. Import rows use the real importers' summaries. */
export function expectedRowsOf(plan: DatasetPlan): ExpectedRows {
  const zone = plan.parameters.timeZone;
  const activities = new Map<string, DatasetSnapshot['activities'][number]>();
  for (const item of plan.manualActivities) {
    const request = createActivityRequestSchema.parse(item.request);
    activities.set(item.activityId, {
      distanceM: request.distanceM ?? null,
      durationS: request.durationS,
      id: item.activityId,
      idempotencyKey: request.idempotencyKey,
      importFingerprint: null,
      notes: request.notes ?? null,
      rpe: request.rpe ?? null,
      source: 'manual',
      startedAt: new Date(request.startedAt).toISOString(),
      type: request.type,
    });
  }
  for (const item of plan.imports) {
    const bytes = Buffer.from(item.document, 'utf8');
    const parsed = item.kind === 'gpx' ? readGpxActivity(bytes, item.importedAtMs) : readTcxActivity(bytes, item.importedAtMs);
    const durationS = 'elapsedDurationS' in parsed.summary ? parsed.summary.elapsedDurationS : parsed.summary.reportedDurationS;
    activities.set(item.activityId, {
      distanceM: parsed.summary.distanceM,
      durationS,
      id: item.activityId,
      idempotencyKey: item.idempotencyKey,
      importFingerprint: parsed.fingerprint.toString('hex'),
      notes: null,
      rpe: null,
      source: item.kind,
      startedAt: new Date(parsed.summary.startedAt).toISOString(),
      type: item.type,
    });
  }
  return {
    activities,
    dailyMetrics: new Map(
      plan.checkIns.map((item) => [
        item.localDate,
        {
          localDate: item.localDate,
          mood: item.request.mood ?? null,
          note: item.request.note ?? null,
          sleepMinutes: item.request.sleepMinutes ?? null,
          sleepQuality: item.request.sleepQuality ?? null,
          soreness: item.request.soreness ?? null,
          timeZone: zone,
          weightKg: numberText(item.request.weightKg),
        },
      ]),
    ),
    dailyMovement: new Map(
      plan.movement.map((item) => [
        item.localDate,
        { activeEnergyKcal: numberText(item.request.activeEnergyKcal), localDate: item.localDate, source: 'manual', steps: item.request.steps ?? null, timeZone: zone },
      ]),
    ),
    meals: new Map(
      plan.meals.map((item) => [
        item.request.idempotencyKey,
        {
          carbohydrateG: numberText(item.request.carbohydrateG),
          energyKcal: numberText(item.request.energyKcal),
          fatG: numberText(item.request.fatG),
          idempotencyKey: item.request.idempotencyKey,
          localDate: item.localDate,
          mealType: item.request.mealType,
          proteinG: numberText(item.request.proteinG),
          source: 'manual',
          timeZone: zone,
          title: item.request.title,
        },
      ]),
    ),
    runs: new Map(plan.runs.map((run) => [run.runId, run])),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function compareKeyed<Row>(
  table: string,
  stored: readonly Row[],
  keyOf: (row: Row) => string,
  expected: ReadonlyMap<string, unknown>,
  project: (row: Row) => unknown,
  reasons: string[],
): number {
  let matched = 0;
  for (const row of stored) {
    const key = keyOf(row);
    const wanted = expected.get(key);
    if (wanted === undefined) reasons.push(`${table}: ${key} is not in this plan`);
    else if (!sameJson(project(row), wanted)) reasons.push(`${table}: ${key} differs from this plan`);
    else matched += 1;
  }
  return matched;
}

const ordered = <Value extends Record<string, unknown>>(value: Value) =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) as Value;

/** A summary's distance may differ from the planned polyline by the sphere/ellipsoid difference, never by more. */
export const SUMMARY_DISTANCE_TOLERANCE = 0.02;

const sameCanonical = (stored: string, wanted: unknown): boolean => {
  try {
    return canonicalJson(JSON.parse(stored)) === canonicalJson(wanted);
  } catch {
    return false;
  }
};

/**
 * Whether one stored run is a state this plan's lifecycle can produce, step by step as the writer performs it:
 * created at its planned start (requested and effective, control revision 0), its batches uploaded in order (each
 * complete batch adds one data revision, and every uploaded point is the planned point), then finished by the planned
 * command at the planned instant (control revision 1, one more data revision, the command's canonical payload and
 * response exactly as the service stores them), then summarised by the maintenance path (current for the data
 * revision, the server's current algorithm, valid quality statistics, a display geometry, the planned duration and a
 * distance within the tolerance of the planned polyline). Raw points may afterwards be purged by retention, which only
 * the server does, only for a finished run with a current summary: `purging` keeps a subset of the planned points,
 * `purged` none. `complete` is true when nothing is left to write for the run.
 */
export function validateRun(planned: DatasetPlan['runs'][number], run: DatasetSnapshot['runs'][number], report: SnapshotReport): { complete: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const label = `runs: ${run.id}`;
  const finishedAt = new Date(planned.finishedAtMs).toISOString();
  const points = report.runPoints[run.id] ?? [];
  const rawState = report.runRawStates[run.id] ?? 'available';
  const commands = report.snapshot.runCommands.filter((command) => command.runId === run.id);
  const summary = report.snapshot.runSummaries.find((entry) => entry.runId === run.id);
  if (run.requestedStartedAt !== planned.startedAt) reasons.push(`${label} has another requested start`);
  if (run.startedAt !== planned.startedAt) reasons.push(`${label} has another effective start`);

  // Uploaded points: each one must be the planned point with that sequence number.
  const plannedPoints = new Map(planned.batches.flat().map((point) => [point.seq, point]));
  const foreignPoints = points.filter((point) => {
    const wanted = plannedPoints.get(point.seq);
    return (
      wanted === undefined ||
      point.segmentId !== wanted.segmentId ||
      point.recordedAt !== new Date(wanted.recordedAt).toISOString() ||
      point.longitude !== wanted.longitude ||
      point.latitude !== wanted.latitude ||
      point.accuracyM !== wanted.accuracyM
    );
  });
  if (foreignPoints.length > 0) reasons.push(`${label} holds ${String(foreignPoints.length)} uploaded point(s) that are not the planned points`);
  // With raw history available, the points are exactly the first k batches (k = 0..all): a batch is one transaction.
  const batchEnds = planned.batches.reduce<number[]>((ends, batch) => [...ends, (ends.at(-1) ?? 0) + batch.length], [0]);
  const uploadedBatches = batchEnds.indexOf(points.length);
  const contiguous = points.every((point, index) => point.seq === String(index + 1));
  if (rawState === 'available' && (uploadedBatches < 0 || !contiguous)) reasons.push(`${label} holds an upload that is not a whole number of planned batches in order`);

  if (run.status === 'recording') {
    if (run.finishedAt !== null || run.controlRevision !== '0') reasons.push(`${label} has lifecycle revisions this plan cannot produce`);
    if (rawState !== 'available') reasons.push(`${label} is recording without its raw history`);
    else if (uploadedBatches >= 0 && run.dataRevision !== String(uploadedBatches)) reasons.push(`${label} has a data revision that does not match its uploaded batches`);
    if (commands.length > 0) reasons.push(`${label} is recording but has a lifecycle command`);
    if (summary !== undefined) reasons.push(`${label} is recording but has a summary`);
    return { complete: false, reasons };
  }
  if (run.status !== 'finished') {
    reasons.push(`${label} is ${run.status}, which this plan never does`);
    return { complete: false, reasons };
  }

  if (run.finishedAt !== finishedAt) reasons.push(`${label} was finished at another time (for example by the auto-finish job)`);
  const finishedRevision = String(planned.batches.length + 1);
  if (run.controlRevision !== '1' || run.dataRevision !== finishedRevision) reasons.push(`${label} has revisions that do not match its planned uploads and finish`);
  const command = commands.find((entry) => entry.commandId === planned.finishCommandId);
  if (commands.length !== 1 || command === undefined) reasons.push(`${label} does not have exactly its planned finish command`);
  else {
    if (!sameCanonical(command.payload, { expectedControlRevision: '0', type: 'finish' })) reasons.push(`${label} has a finish command payload that is not the planned one`);
    const response = { commandId: planned.finishCommandId, controlRevision: '1', dataRevision: finishedRevision, finishedAt, status: 'finished' };
    if (!sameCanonical(command.response, response)) reasons.push(`${label} has a finish command response that is not the planned one`);
  }
  if (rawState === 'available' && points.length !== planned.pointCount) reasons.push(`${label} is finished without all of its planned points`);
  if (rawState !== 'available' && rawState !== 'purging' && rawState !== 'purged') reasons.push(`${label} has an unknown raw state`);
  if (rawState === 'purged' && points.length > 0) reasons.push(`${label} is purged but still holds points`);

  if (summary === undefined) {
    // Interrupted between the finish and the publication: the next run publishes it. Retention never purges first.
    if (rawState !== 'available') reasons.push(`${label} lost its raw points without a current summary`);
    return { complete: false, reasons };
  }
  const check = report.summaryChecks[run.id];
  if (!summary.current || summary.sourceRevision !== run.dataRevision) reasons.push(`${label} has a summary for another data revision`);
  if (check?.algorithmCurrent !== true) reasons.push(`${label} has a summary from another algorithm version`);
  if (check?.qualityStatsValid !== true) reasons.push(`${label} has summary quality statistics outside the contract`);
  if (summary.displayGeometry === null || summary.displayGeometry.points < 2) reasons.push(`${label} has a summary without its display geometry`);
  if (Number(summary.observedDurationS) !== planned.plannedDurationS) reasons.push(`${label} has a summary duration that is not the recorded one`);
  const distance = Number(summary.distanceM);
  if (!Number.isFinite(distance) || Math.abs(distance - planned.plannedDistanceM) > planned.plannedDistanceM * SUMMARY_DISTANCE_TOLERANCE) {
    reasons.push(`${label} has a summary distance that the recorded points cannot produce`);
  }
  return { complete: reasons.length === 0, reasons };
}

/**
 * Classifies what is stored against the plan. Any row the plan does not produce, a row that differs, or a run in a state
 * the plan's lifecycle cannot lead to is a conflict; rows the plan produces that are missing make the state partial.
 */
export function classifySnapshot(plan: DatasetPlan, report: SnapshotReport, expected = expectedRowsOf(plan)): { reasons: string[]; state: DatasetState } {
  const reasons: string[] = [];
  const { foreign, snapshot } = report;
  if (foreign.otherUsers > 0) reasons.push(`${String(foreign.otherUsers)} user(s) other than the synthetic runner and coach`);
  if (foreign.otherOrganizations > 0) reasons.push(`${String(foreign.otherOrganizations)} other organization(s)`);
  if (foreign.otherMemberships > 0) reasons.push(`${String(foreign.otherMemberships)} other membership(s)`);
  if (foreign.coachRecords > 0) reasons.push(`${String(foreign.coachRecords)} record(s) owned by someone other than the runner`);
  if (foreign.runTombstones > 0) reasons.push(`${String(foreign.runTombstones)} deleted run(s) (tombstones)`);

  const ids = plan.identities;
  const expectedUsers = new Map<string, string>([
    [ids.coach, ids.coachExternalIdentity],
    [ids.runner, ids.runnerExternalIdentity],
  ]);
  for (const user of snapshot.identities.users) {
    if (expectedUsers.get(user.id) !== user.externalIdentity) reasons.push(`users: ${user.id} has another external identity`);
  }
  const expectedRoles = new Map<string, string>([
    [ids.coach, 'coach'],
    [ids.runner, 'runner'],
  ]);
  for (const membership of snapshot.identities.memberships) {
    if (expectedRoles.get(membership.userId) !== membership.role || !membership.active) reasons.push(`memberships: ${membership.userId} is not the planned active ${String(expectedRoles.get(membership.userId))}`);
  }

  const counted = {
    activities: compareKeyed('activities', snapshot.activities, (row) => row.id, new Map([...expected.activities].map(([key, row]) => [key, ordered(row)])), ordered, reasons),
    dailyMetrics: compareKeyed('daily_metrics', snapshot.dailyMetrics, (row) => row.localDate, new Map([...expected.dailyMetrics].map(([key, row]) => [key, ordered(row)])), ordered, reasons),
    dailyMovement: compareKeyed('daily_movement', snapshot.dailyMovement, (row) => row.localDate, new Map([...expected.dailyMovement].map(([key, row]) => [key, ordered(row)])), ordered, reasons),
    meals: compareKeyed(
      'meals',
      snapshot.meals,
      (row) => row.idempotencyKey,
      new Map([...expected.meals].map(([key, row]) => [key, ordered(row)])),
      // The creation digest is server-derived from the same fields; JSON drops the undefined key.
      (row) => ordered({ ...row, creationDigest: undefined }),
      reasons,
    ),
  };

  let runsComplete = 0;
  for (const run of snapshot.runs) {
    const planned = expected.runs.get(run.id);
    if (!planned) {
      reasons.push(`runs: ${run.id} is not in this plan`);
      continue;
    }
    const outcome = validateRun(planned, run, report);
    reasons.push(...outcome.reasons);
    if (outcome.reasons.length === 0 && outcome.complete) {
      const shareOk =
        planned.share === null ||
        snapshot.runShares.some(
          (share) =>
            share.runId === run.id &&
            share.granteeUserId === planned.share!.granteeUserId &&
            share.canReadHistory === planned.share!.canReadHistory &&
            share.canReadLive === planned.share!.canReadLive,
        );
      if (shareOk) runsComplete += 1;
    }
  }
  const storedRunIds = new Set(snapshot.runs.map((run) => run.id));
  for (const summary of snapshot.runSummaries) {
    if (!storedRunIds.has(summary.runId)) reasons.push(`run_summaries: ${summary.runId} belongs to no stored run of the runner`);
  }
  const plannedCommands = new Map(plan.runs.map((run) => [run.finishCommandId, run.runId]));
  for (const command of snapshot.runCommands) {
    if (plannedCommands.get(command.commandId) !== command.runId) reasons.push(`run_commands: ${command.commandId} is not this plan's finish command`);
  }
  for (const share of snapshot.runShares) {
    const planned = expected.runs.get(share.runId)?.share;
    if (!planned || planned.granteeUserId !== share.granteeUserId || planned.canReadHistory !== share.canReadHistory || planned.canReadLive !== share.canReadLive) {
      reasons.push(`run_shares: ${share.runId} -> ${share.granteeUserId} is not this plan's share`);
    }
  }

  if (reasons.length > 0) return { reasons, state: 'partial' };
  const nothing =
    snapshot.identities.users.length === 0 &&
    snapshot.identities.organizations.length === 0 &&
    snapshot.activities.length + snapshot.dailyMetrics.length + snapshot.dailyMovement.length + snapshot.meals.length + snapshot.runs.length === 0;
  if (nothing) return { reasons, state: 'empty' };
  const complete =
    snapshot.identities.users.length === 2 &&
    snapshot.identities.organizations.length === 1 &&
    snapshot.identities.memberships.length === 2 &&
    counted.activities === expected.activities.size &&
    counted.dailyMetrics === expected.dailyMetrics.size &&
    counted.dailyMovement === expected.dailyMovement.size &&
    counted.meals === expected.meals.size &&
    runsComplete === plan.runs.length &&
    snapshot.runs.length === plan.runs.length;
  return { reasons, state: complete ? 'complete' : 'partial' };
}

/**
 * The recorded completion baseline, checked before any write. Without one, an empty dataset is seeded and a partial one
 * resumed (a first seed that was interrupted). With one, this target already completed with these parameters, so the
 * only acceptable state is that completion itself: complete, with the recorded digest. A partial or empty dataset is
 * then a completed one that lost records, which must not be rewritten as if it were an interrupted first seed.
 * Retention (raw purge) keeps the state complete and the digest equal, so it stays accepted.
 */
export function baselineRefusal(state: DatasetState, digest: string, expectedDigest: string | undefined): string | null {
  if (expectedDigest === undefined) return null;
  if (state === 'complete') {
    return digest === expectedDigest ? null : `the complete dataset no longer has the digest recorded when it was seeded (${expectedDigest}): stored values changed since`;
  }
  return (
    `a completion was recorded for these parameters (${expectedDigest}), but the dataset database is now ${state}` +
    (state === 'empty' ? '' : ' (records of the plan are missing)') +
    ': a completed dataset that lost data is not seeded again as an interrupted first seed'
  );
}

// --- Seeding ---------------------------------------------------------------------------------------------------------

const lockKey = (database: string) => `somalane-portfolio-dataset:${database}`;

export async function seedPortfolioDataset(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? (() => undefined);
  // 1. Configuration: refused before anything connects.
  assertNotProduction(options.environment ?? process.env);
  const target = validateTargetUrls(options.urls);
  const plan = planDataset(options.parameters);
  assertAnchorCompleted(plan.parameters.anchorDate, plan.parameters.timeZone, options.nowMs ?? Date.now());

  // 2. Ownership: the container that publishes this port is the dataset's.
  const proof = proveOwnedServer({ docker: options.docker, port: target.port });
  const expectedFor = (role: PortfolioRole): Expected => ({ database: target.database, proof, role });

  // 3. Connections: each proves its identity before it is used.
  const lockClient = new pg.Client({ application_name: 'somalane-portfolio-dataset-lock', connectionString: options.urls.owner, connectionTimeoutMillis: 10_000 });
  const pools = {
    maintenance: new pg.Pool({ application_name: 'somalane-portfolio-dataset-maintenance', connectionString: options.urls.maintenance, max: 1, statement_timeout: 60_000 }),
    owner: new pg.Pool({ application_name: 'somalane-portfolio-dataset-owner', connectionString: options.urls.owner, max: 1, statement_timeout: 30_000 }),
    runtime: new pg.Pool({ application_name: 'somalane-portfolio-dataset-runtime', connectionString: options.urls.runtime, lock_timeout: 5_000, max: 2, statement_timeout: 30_000 }),
  };
  for (const pool of Object.values(pools)) pool.on('error', () => undefined);
  let locked = false;
  try {
    await lockClient.connect();
    const ownerIdentity = await verifyConnectedServer(lockClient, expectedFor('owner'), 'owner URL');
    const runtime = verifyingPool(pools.runtime, expectedFor('runtime'), 'runtime URL');
    const maintenance = verifyingPool(pools.maintenance, expectedFor('maintenance'), 'maintenance URL');
    const owner = verifyingPool(pools.owner, expectedFor('owner'), 'owner URL');
    const identities = {
      maintenance: await identityOf(maintenance, expectedFor('maintenance'), 'maintenance URL'),
      owner: ownerIdentity,
      runtime: await identityOf(runtime, expectedFor('runtime'), 'runtime URL'),
    };

    // 4. One seed at a time.
    const acquired = await lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lockKey(target.database)]);
    if (acquired.rows[0]?.locked !== true) throw new DatasetBusyError(target.database);
    locked = true;

    // 5. What is there already, read-only, before any write.
    const expected = expectedRowsOf(plan);
    const scope = { coach: plan.identities.coach, organization: plan.identities.organization, runner: plan.identities.runner };
    const before = await readOnly(owner, (client) => readSnapshot(client, scope));
    const classified = classifySnapshot(plan, before, expected);
    if (classified.reasons.length > 0) throw new DatasetConflictError(classified.reasons, 0);
    const refusal = baselineRefusal(classified.state, datasetDigest(before.snapshot), options.expectedDigest);
    if (refusal !== null) throw new DatasetConflictError([refusal], 0);
    log(`existing data: ${classified.state}`);

    let writes = 0;
    const done = async (operation: string) => {
      writes += 1;
      await options.hooks?.afterWrite?.(operation, writes);
    };
    if (classified.state !== 'complete') {
      await writeDataset(plan, { maintenance, owner, runtime }, done, log);
    }

    // 6. Read back and check that the database now holds exactly the plan.
    const report = await readOnly(owner, (client) => readSnapshot(client, scope));
    const after = classifySnapshot(plan, report, expected);
    // With a baseline nothing was written above (only its own completion passes the check before writing), so these
    // checks of the result can only report writes for a seed without one.
    if (after.reasons.length > 0) throw new DatasetConflictError(after.reasons, writes);
    if (after.state !== 'complete') throw new Error('The seed finished but the dataset is not complete; run it again to resume');
    const digest = datasetDigest(report.snapshot);
    if (options.expectedDigest !== undefined && digest !== options.expectedDigest) {
      throw new DatasetConflictError([`the completed dataset's digest ${digest} is not the one recorded for these parameters (${options.expectedDigest})`], writes);
    }
    return {
      baseline: options.expectedDigest === undefined ? 'not recorded' : 'matched',
      digest,
      identities,
      plan,
      proof,
      report,
      stateAfter: after.state,
      stateBefore: classified.state,
      writes,
    };
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey(target.database)]).catch(() => undefined);
    await lockClient.end().catch(() => undefined);
    await Promise.all(Object.values(pools).map((pool) => pool.end().catch(() => undefined)));
  }
}

async function identityOf(pool: Pick<Pool, 'connect'>, expected: Expected, label: string): Promise<ConnectedIdentity> {
  const client = await pool.connect();
  try {
    return await verifyConnectedServer(client, expected, label);
  } finally {
    client.release();
  }
}

/** One REPEATABLE READ READ ONLY transaction on a connection of pool (also used by the showcase export). */
export async function readOnly<Result>(pool: Pick<Pool, 'connect'>, read: (client: PoolClient) => Promise<Result>): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface Pools {
  maintenance: Pick<Pool, 'connect'>;
  owner: Pick<Pool, 'connect'>;
  runtime: Pick<Pool, 'connect'>;
}

async function provisionIdentities(plan: DatasetPlan, owner: Pick<Pool, 'connect'>): Promise<void> {
  const ids = plan.identities;
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    // Insert-only: an existing row is never changed here (the classification already refused a different one).
    await client.query('INSERT INTO users (id, external_identity) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING', [
      ids.runner,
      ids.runnerExternalIdentity,
      ids.coach,
      ids.coachExternalIdentity,
    ]);
    await client.query('INSERT INTO organizations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [ids.organization]);
    await client.query(
      `INSERT INTO memberships (org_id, user_id, role, active) VALUES ($1, $2, 'runner', true), ($1, $3, 'coach', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ids.organization, ids.runner, ids.coach],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function writeDataset(plan: DatasetPlan, pools: Pools, done: (operation: string) => Promise<void>, log: (line: string) => void): Promise<void> {
  const ids = plan.identities;
  const session = { userId: ids.runner };
  const org = ids.organization;
  const asRunner = <Result>(callback: (client: PoolClient) => Promise<Result>) => withAuthenticatedTenantTransaction(pools.runtime, session, org, callback);

  await provisionIdentities(plan, pools.owner);
  await done('identities');

  for (const item of plan.checkIns) {
    const request = putDailyMetricsRequestSchema.parse(item.request);
    await asRunner((client) => putDailyMetrics(client, session, org, item.localDate, request, instantClock(item.loggedAtMs)));
    await done(`check-in ${item.localDate}`);
  }
  for (const item of plan.movement) {
    const request = putDailyMovementRequestSchema.parse(item.request);
    await asRunner((client) => putDailyMovement(client, session, org, item.localDate, request, instantClock(item.loggedAtMs)));
    await done(`movement ${item.localDate}`);
  }
  for (const item of plan.manualActivities) {
    const request = createActivityRequestSchema.parse(item.request);
    await asRunner((client) => createActivity(client, session, org, item.activityId, request, instantClock(item.loggedAtMs)));
    await done(`activity ${item.activityId}`);
  }
  for (const item of plan.imports) {
    const bytes = Buffer.from(item.document, 'utf8');
    const choice = { idempotencyKey: item.idempotencyKey, type: item.type };
    if (item.kind === 'gpx') {
      const parsed = readGpxActivity(bytes, item.importedAtMs);
      await asRunner((client) => confirmGpxImport(client, session, org, item.activityId, choice, parsed));
    } else {
      const parsed = readTcxActivity(bytes, item.importedAtMs);
      await asRunner((client) => confirmTcxImport(client, session, org, item.activityId, choice, parsed));
    }
    await done(`${item.kind} import ${item.activityId}`);
  }
  for (const item of plan.meals) {
    const request = createMealRequestSchema.parse(item.request);
    await asRunner((client) => createMeal(client, session, org, request, instantClock(item.loggedAtMs)));
    await done(`meal ${item.request.idempotencyKey}`);
  }
  log(`wrote check-ins, movement, activities, imports and meals`);

  for (const run of plan.runs) {
    const startMs = Date.parse(run.startedAt);
    const created = await asRunner((client) => createRun(client, session, org, run.runId, { startedAt: run.startedAt }, instantClock(startMs)));
    await done(`run ${run.runId} created`);
    if (created.run.status !== 'finished') {
      for (const batch of run.batches) {
        const request = ingestPointsRequestSchema.parse({ points: batch });
        const lastMs = Date.parse(batch.at(-1)!.recordedAt);
        await asRunner((client) => ingestRunPoints(client, session, org, run.runId, request, instantClock(lastMs + 1_000)));
        await done(`run ${run.runId} points ${batch[0]!.seq}-${batch.at(-1)!.seq}`);
      }
      const command = runCommandRequestSchema.parse({ commandId: run.finishCommandId, expectedControlRevision: created.run.controlRevision, type: 'finish' });
      await asRunner((client) => applyRunCommand(client, session, org, run.runId, command, instantClock(run.finishedAtMs)));
      await done(`run ${run.runId} finished`);
    }
    if (run.share !== null) {
      const request = upsertRunShareRequestSchema.parse({ canReadHistory: run.share.canReadHistory, canReadLive: run.share.canReadLive });
      await asRunner((client) => upsertRunShare(client, session, org, run.runId, run.share!.granteeUserId, request));
      await done(`run ${run.runId} shared`);
    }
    // The maintenance job's own calculation and publication (app_private.calculate_run_summary, the display-geometry
    // simplifier and publish_run_summary), as the API's summary worker runs it. Only this dataset's runs exist here.
    for (let attempt = 0; attempt <= plan.runs.length; attempt += 1) {
      const published = await runSummaryPublicationOnce(pools.maintenance, instantClock(run.finishedAtMs + 30_000));
      if (published.status === 'idle') break;
      if (published.status === 'published') await done(`summary ${published.runId}`);
    }
  }
  log(`recorded ${String(plan.runs.length)} runs and published their summaries`);
}

export function describeIsolationFailure(error: unknown): string {
  return error instanceof IsolationError || error instanceof DatasetConflictError || error instanceof DatasetBusyError
    ? error.message
    : error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
}
