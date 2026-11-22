import { createHash } from 'node:crypto';

import type { Queryable } from './isolation.js';

// The dataset as stored, read back read-only and normalised for the canonical digest (docs/runbooks/portfolio-dataset.md,
// "Digest normalisation"). Business values, dates, zones, sources, client-chosen operation keys, server-derived provenance
// (import fingerprints, meal creation digests, revisions) and the published summary results are kept. Left out, and only
// these: values the database or the wall clock generates (meal ids, created_at/updated_at, received_at), the summary's
// computed_at, the organization's archive_revision (a cache-invalidation counter), and state that a retention rule owns
// (run_points and runs.raw_state: the API purges raw points of runs finished more than 7 days ago, which must not change
// the dataset's identity). Numbers are PostgreSQL's own text: trim_scale for numerics, summaries rounded to a millimetre and
// a millisecond, display geometry as point count and the MD5 of its WKT snapped to 1e-7 degrees.

export interface SnapshotScope {
  coach: string;
  organization: string;
  runner: string;
}

export interface DatasetSnapshot {
  activities: Array<{
    distanceM: number | null;
    durationS: number;
    id: string;
    idempotencyKey: string | null;
    importFingerprint: string | null;
    notes: string | null;
    rpe: number | null;
    source: string;
    startedAt: string;
    type: string;
  }>;
  dailyMetrics: Array<{
    localDate: string;
    mood: number | null;
    note: string | null;
    sleepMinutes: number | null;
    sleepQuality: number | null;
    soreness: number | null;
    timeZone: string;
    weightKg: string | null;
  }>;
  dailyMovement: Array<{ activeEnergyKcal: string | null; localDate: string; source: string; steps: number | null; timeZone: string }>;
  identities: {
    memberships: Array<{ active: boolean; orgId: string; role: string; userId: string }>;
    organizations: string[];
    users: Array<{ externalIdentity: string; id: string }>;
  };
  meals: Array<{
    carbohydrateG: string | null;
    creationDigest: string;
    energyKcal: string | null;
    fatG: string | null;
    idempotencyKey: string;
    localDate: string;
    mealType: string;
    proteinG: string | null;
    source: string;
    timeZone: string;
    title: string;
  }>;
  runCommands: Array<{ commandId: string; payload: string; response: string; runId: string }>;
  runShares: Array<{ canReadHistory: boolean; canReadLive: boolean; granteeUserId: string; runId: string }>;
  runSummaries: Array<{
    algorithmVersion: string;
    current: boolean;
    displayGeometry: { md5: string; points: number } | null;
    distanceM: string;
    observedDurationS: string;
    qualityStats: string;
    runId: string;
    sourceRevision: string;
  }>;
  runs: Array<{
    controlRevision: string;
    dataRevision: string;
    finishedAt: string | null;
    id: string;
    requestedStartedAt: string;
    startedAt: string;
    status: string;
  }>;
}

/** What is outside the dataset's scope: anything here means the database holds data this tooling did not plan. */
export interface ForeignData {
  coachRecords: number;
  otherMemberships: number;
  otherOrganizations: number;
  otherUsers: number;
  runTombstones: number;
}

/** One stored raw point, as the run validation compares it with the plan. */
export interface StoredRunPoint {
  accuracyM: number;
  latitude: number;
  longitude: number;
  recordedAt: string;
  segmentId: number;
  seq: string;
}

/**
 * The digested snapshot plus state the validation needs but the digest deliberately leaves out (retention-owned raw
 * points and raw_state) or that is a property of the server, not of the data (the current algorithm version and the
 * quality-statistics contract). None of it is digested, so a legitimate raw purge does not change the dataset identity.
 */
export interface SnapshotReport {
  foreign: ForeignData;
  /** Raw points present now (not part of the digest: retention may purge them). */
  runPointCounts: Record<string, number>;
  /** Every stored raw point of the runner's runs, by run, in sequence order. */
  runPoints: Record<string, StoredRunPoint[]>;
  /** runs.raw_state by run: available, purging or purged. */
  runRawStates: Record<string, string>;
  snapshot: DatasetSnapshot;
  /** Per summary: its algorithm is the server's current one, and its quality statistics satisfy the v1 contract. */
  summaryChecks: Record<string, { algorithmCurrent: boolean; qualityStatsValid: boolean }>;
}

const ms = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const numericText = (column: string) => `trim_scale(${column})::text`;

/** Reads the dataset with the owner role (which row-level security does not limit), in one read-only snapshot. */
export async function readSnapshot(client: Queryable, scope: SnapshotScope): Promise<SnapshotReport> {
  const { coach, organization: org, runner } = scope;
  const rows = async <Row>(text: string, values: unknown[]): Promise<Row[]> => (await client.query<Row>(text, values)).rows;

  const users = await rows<{ externalIdentity: string; id: string }>(
    `SELECT id::text AS id, external_identity AS "externalIdentity" FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [[runner, coach]],
  );
  const organizations = (await rows<{ id: string }>('SELECT id::text AS id FROM organizations WHERE id = $1 ORDER BY id', [org])).map((row) => row.id);
  const memberships = await rows<{ active: boolean; orgId: string; role: string; userId: string }>(
    `SELECT org_id::text AS "orgId", user_id::text AS "userId", role, active FROM memberships
      WHERE org_id = $1 AND user_id = ANY($2::uuid[]) ORDER BY user_id`,
    [org, [runner, coach]],
  );
  const dailyMetrics = await rows<DatasetSnapshot['dailyMetrics'][number]>(
    `SELECT to_char(local_date, 'YYYY-MM-DD') AS "localDate", time_zone AS "timeZone", ${numericText('weight_kg')} AS "weightKg",
            sleep_minutes AS "sleepMinutes", sleep_quality AS "sleepQuality", mood, soreness, note
       FROM daily_metrics WHERE org_id = $1 AND user_id = $2 ORDER BY local_date`,
    [org, runner],
  );
  const dailyMovement = await rows<DatasetSnapshot['dailyMovement'][number]>(
    `SELECT to_char(local_date, 'YYYY-MM-DD') AS "localDate", source, time_zone AS "timeZone", steps,
            ${numericText('active_energy_kcal')} AS "activeEnergyKcal"
       FROM daily_movement WHERE org_id = $1 AND user_id = $2 ORDER BY local_date, source`,
    [org, runner],
  );
  const activities = await rows<DatasetSnapshot['activities'][number]>(
    `SELECT id::text AS id, type, source, ${ms('started_at')} AS "startedAt", duration_s AS "durationS", distance_m AS "distanceM",
            rpe, notes, idempotency_key::text AS "idempotencyKey", encode(import_fingerprint, 'hex') AS "importFingerprint"
       FROM activities WHERE org_id = $1 AND user_id = $2 ORDER BY started_at, id`,
    [org, runner],
  );
  const meals = await rows<DatasetSnapshot['meals'][number]>(
    `SELECT idempotency_key::text AS "idempotencyKey", to_char(local_date, 'YYYY-MM-DD') AS "localDate", time_zone AS "timeZone",
            meal_type AS "mealType", title, ${numericText('energy_kcal')} AS "energyKcal", ${numericText('protein_g')} AS "proteinG",
            ${numericText('carbohydrate_g')} AS "carbohydrateG", ${numericText('fat_g')} AS "fatG", source,
            encode(creation_digest, 'hex') AS "creationDigest"
       FROM meals WHERE org_id = $1 AND user_id = $2 ORDER BY local_date, idempotency_key`,
    [org, runner],
  );
  const runs = await rows<DatasetSnapshot['runs'][number]>(
    `SELECT id::text AS id, status, ${ms('requested_started_at')} AS "requestedStartedAt", ${ms('started_at')} AS "startedAt",
            ${ms('finished_at')} AS "finishedAt", data_revision::text AS "dataRevision", control_revision::text AS "controlRevision"
       FROM runs WHERE org_id = $1 AND user_id = $2 ORDER BY started_at, id`,
    [org, runner],
  );
  const runCommands = await rows<DatasetSnapshot['runCommands'][number]>(
    `SELECT command.run_id::text AS "runId", command.command_id::text AS "commandId", command.canonical_payload::text AS payload,
            command.response::text AS response
       FROM run_commands AS command JOIN runs AS run ON run.org_id = command.org_id AND run.id = command.run_id
      WHERE command.org_id = $1 AND run.user_id = $2 ORDER BY command.run_id, command.command_id`,
    [org, runner],
  );
  const runSummaries = await rows<{
    algorithmVersion: string;
    current: boolean;
    distanceM: string;
    geometryMd5: string | null;
    geometryPoints: number | null;
    observedDurationS: string;
    qualityStats: string;
    runId: string;
    sourceRevision: string;
  }>(
    `SELECT summary.run_id::text AS "runId", summary.source_revision::text AS "sourceRevision", summary.algorithm_version AS "algorithmVersion",
            (summary.source_revision = run.data_revision) AS current,
            trim_scale(round(summary.distance_m::numeric, 3))::text AS "distanceM",
            trim_scale(round(summary.observed_duration_s::numeric, 3))::text AS "observedDurationS",
            summary.quality_stats::text AS "qualityStats",
            ST_NPoints(summary.display_geom) AS "geometryPoints",
            md5(ST_AsText(ST_SnapToGrid(summary.display_geom, 0.0000001))) AS "geometryMd5"
       FROM run_summaries AS summary JOIN runs AS run ON run.org_id = summary.org_id AND run.id = summary.run_id
      WHERE summary.org_id = $1 AND run.user_id = $2 ORDER BY summary.run_id`,
    [org, runner],
  );
  const runShares = await rows<DatasetSnapshot['runShares'][number]>(
    `SELECT share.run_id::text AS "runId", share.grantee_user_id::text AS "granteeUserId", share.can_read_history AS "canReadHistory",
            share.can_read_live AS "canReadLive"
       FROM run_shares AS share JOIN runs AS run ON run.org_id = share.org_id AND run.id = share.run_id
      WHERE share.org_id = $1 AND run.user_id = $2 ORDER BY share.run_id, share.grantee_user_id`,
    [org, runner],
  );
  const pointCounts = await rows<{ count: number; runId: string }>(
    `SELECT point.run_id::text AS "runId", count(*)::integer AS count FROM run_points AS point
       JOIN runs AS run ON run.org_id = point.org_id AND run.id = point.run_id
      WHERE point.org_id = $1 AND run.user_id = $2 GROUP BY point.run_id ORDER BY point.run_id`,
    [org, runner],
  );
  const points = await rows<StoredRunPoint & { runId: string }>(
    `SELECT point.run_id::text AS "runId", point.seq::text AS seq, point.segment_id AS "segmentId",
            ${ms('point.recorded_at')} AS "recordedAt", ST_X(point.geom) AS longitude, ST_Y(point.geom) AS latitude,
            point.accuracy_m AS "accuracyM"
       FROM run_points AS point JOIN runs AS run ON run.org_id = point.org_id AND run.id = point.run_id
      WHERE point.org_id = $1 AND run.user_id = $2 ORDER BY point.run_id, point.seq`,
    [org, runner],
  );
  const runPoints: Record<string, StoredRunPoint[]> = {};
  for (const { runId, ...point } of points) (runPoints[runId] ??= []).push(point);
  const rawStates = await rows<{ rawState: string; runId: string }>(
    `SELECT id::text AS "runId", raw_state AS "rawState" FROM runs WHERE org_id = $1 AND user_id = $2 ORDER BY id`,
    [org, runner],
  );
  const summaryChecks = await rows<{ algorithmCurrent: boolean; qualityStatsValid: boolean; runId: string }>(
    `SELECT summary.run_id::text AS "runId",
            summary.algorithm_version = app_private.current_track_algorithm_version() AS "algorithmCurrent",
            app_private.run_summary_quality_stats_valid(summary.quality_stats) AS "qualityStatsValid"
       FROM run_summaries AS summary JOIN runs AS run ON run.org_id = summary.org_id AND run.id = summary.run_id
      WHERE summary.org_id = $1 AND run.user_id = $2 ORDER BY summary.run_id`,
    [org, runner],
  );
  const foreign = (
    await rows<ForeignData>(
      `SELECT (SELECT count(*) FROM users WHERE id <> ALL($2::uuid[]))::integer AS "otherUsers",
              (SELECT count(*) FROM organizations WHERE id <> $1)::integer AS "otherOrganizations",
              (SELECT count(*) FROM memberships WHERE org_id <> $1 OR user_id <> ALL($2::uuid[]))::integer AS "otherMemberships",
              ((SELECT count(*) FROM daily_metrics WHERE user_id <> $3)
               + (SELECT count(*) FROM daily_movement WHERE user_id <> $3)
               + (SELECT count(*) FROM activities WHERE user_id <> $3)
               + (SELECT count(*) FROM meals WHERE user_id <> $3)
               + (SELECT count(*) FROM runs WHERE user_id <> $3))::integer AS "coachRecords",
              (SELECT count(*) FROM run_tombstones)::integer AS "runTombstones"`,
      [org, [runner, coach], runner],
    )
  )[0]!;

  return {
    foreign,
    runPointCounts: Object.fromEntries(pointCounts.map((row) => [row.runId, row.count])),
    runPoints,
    runRawStates: Object.fromEntries(rawStates.map((row) => [row.runId, row.rawState])),
    summaryChecks: Object.fromEntries(summaryChecks.map(({ runId, ...check }) => [runId, check])),
    snapshot: {
      activities,
      dailyMetrics,
      dailyMovement,
      identities: { memberships, organizations, users },
      meals,
      runCommands,
      runShares,
      runSummaries: runSummaries.map(({ geometryMd5, geometryPoints, ...summary }) => ({
        ...summary,
        displayGeometry: geometryMd5 === null || geometryPoints === null ? null : { md5: geometryMd5, points: geometryPoints },
      })),
      runs,
    },
  };
}

/** JSON with object keys sorted at every level; arrays keep their (SQL-ordered) order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export const DIGEST_NORMALIZATION_VERSION = 'portfolio-dataset-digest-v1';

/** SHA-256 over the normalisation version and the canonical JSON of the snapshot. */
export function datasetDigest(snapshot: DatasetSnapshot): string {
  return `sha256:${createHash('sha256').update(`${DIGEST_NORMALIZATION_VERSION}\n${canonicalJson(snapshot)}`, 'utf8').digest('hex')}`;
}
