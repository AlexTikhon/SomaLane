import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import {
  ACTIVITY_HISTORY_SOURCES,
  ACTIVITY_TRENDS_VERSION,
  ACTIVITY_TYPES,
  activityTrendsQuerySchema,
  activityTrendsSchema,
  addLocalDays,
  DAILY_OVERVIEW_VERSION,
  DAILY_TRENDS_VERSION,
  dailyOverviewQuerySchema,
  dailyOverviewSchema,
  dailyTrendsDatesOf,
  dailyTrendsQuerySchema,
  dailyTrendsRangeOf,
  dailyTrendsSchema,
  mealListQuerySchema,
  mealListResponseSchema,
  WEEKLY_REVIEW_VERSION,
  weeklyReviewQuerySchema,
  weeklyReviewSchema,
  type ActivityTrends,
  type DailyOverview,
  type DailyTrends,
  type MealListResponse,
  type WeeklyReview,
} from '@running-tracker/contracts';
import {
  compareActivitySelections,
  parseShowcaseSnapshot,
  SHOWCASE_DEFAULT_METRIC,
  SHOWCASE_NORMALIZATION_VERSION,
  SHOWCASE_SNAPSHOT_FORMAT,
  SHOWCASE_SNAPSHOT_VERSION,
  showcaseActivityKey,
  type ShowcaseActivitySelection,
  type ShowcaseSnapshot,
} from '@running-tracker/contracts/showcase';
import pg, { type Pool, type PoolClient } from 'pg';

import { ActivityTrendsService } from '../activity-trends/activity-trends-service.js';
import { DailyOverviewService } from '../daily-overview/daily-overview-service.js';
import { DailyTrendsService } from '../daily-trends/daily-trends-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { WeeklyReviewService } from '../insights/weekly-review-service.js';
import { listMeals } from '../meals/meal-service.js';
import { startOfLocalDate } from '../runs/run-search-period.js';
import type { DatasetManifest } from './dataset-manifest.js';
import { planDataset, PORTFOLIO_DATASET_VERSION, portfolioIdentities, type DatasetParameters } from './dataset-plan.js';
import { canonicalJson, datasetDigest, DIGEST_NORMALIZATION_VERSION, readSnapshot } from './dataset-snapshot.js';
import { classifySnapshot, instantClock, readOnly } from './dataset-writer.js';
import {
  assertNotProduction,
  IsolationError,
  PORTFOLIO_CLUSTER_NAME,
  PORTFOLIO_DATABASE,
  PORTFOLIO_PROJECT,
  proveOwnedServer,
  validateTargetUrls,
  verifyConnectedServer,
  type ConnectedIdentity,
  type DockerRunner,
  type OwnedServerProof,
  type PortfolioRole,
} from './isolation.js';
import { databaseUrls, readLocalEnvironment, type DatasetPaths } from './local-environment.js';
import { readSeedState } from './prepare-cli.js';

// The showcase export (release step 5, ADR-0099, docs/runbooks/showcase.md): reads the isolated synthetic dataset through
// the application's own read services and writes the public read-only showcase's snapshot. It only reads:
//
// 1. Before connecting: APP_ENV=production is refused; the dataset's manifest and its recorded completion
//    (seed-state.json) must agree on version, parameters and digest; the URLs are the dataset's own (the isolation
//    rules of the seed: only somalane_portfolio_demo on 127.0.0.1, never running_tracker or running_tracker_test); the
//    container publishing that port must be the dataset's (Compose labels, published port, system identifier).
// 2. Every connection proves its database, role, system identifier and cluster name before its first statement, and is
//    opened with default_transaction_read_only=on (checked on the connection), so every transaction it runs, also one
//    a service opens with a plain BEGIN, is read-only. Nothing is bootstrapped, migrated, seeded or reset.
// 3. The stored dataset is read back by the owner role in one REPEATABLE READ READ ONLY snapshot: it must be complete
//    and carry exactly the recorded digest, before the export and again after it.
// 4. Every response is a real response of a read service (Today's overview, the weekly review, daily trends, activity
//    trends with their comparison, the meal list), asked as the synthetic runner with a fixed clock, and validated by its
//    contract schema; the whole document is validated again by the showcase envelope.
//
// Exported: an explicit allowlist of response data only. Never: credentials, sessions, CSRF tokens, cursors, command
// payloads, raw GPS points, identifiers of people, organizations or runs, notes, or any other database state.

export const SHOWCASE_SNAPSHOT_PATH = ['apps', 'web', 'showcase', 'public', 'showcase-snapshot.json'] as const;

export class ShowcaseExportError extends Error {
  public constructor(message: string) {
    super(`${message}; nothing was exported`);
    this.name = 'ShowcaseExportError';
  }
}

// --- The manifest, the recorded completion and the catalog (pure) ----------------------------------------------------

const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const weekday = (localDate: string) => new Date(`${localDate}T12:00:00Z`).getUTCDay();
const mondayOf = (localDate: string) => addLocalDays(localDate, -((weekday(localDate) + 6) % 7));
const sameParameters = (a: DatasetParameters, b: DatasetParameters) => a.seed === b.seed && a.anchorDate === b.anchorDate && a.timeZone === b.timeZone;

/** The parts of the manifest the export relies on, checked: anything else in it is not trusted or copied. */
export function checkedManifest(input: unknown): DatasetManifest {
  const manifest = input as Partial<DatasetManifest> | null;
  const problems: string[] = [];
  if (manifest === null || typeof manifest !== 'object') throw new ShowcaseExportError('manifest.json is not a JSON object');
  if (manifest.datasetVersion !== PORTFOLIO_DATASET_VERSION) problems.push(`datasetVersion is not ${PORTFOLIO_DATASET_VERSION}`);
  if (manifest.digestNormalization !== DIGEST_NORMALIZATION_VERSION) problems.push(`digestNormalization is not ${DIGEST_NORMALIZATION_VERSION}`);
  if (typeof manifest.digest !== 'string' || !sha256Pattern.test(manifest.digest)) problems.push('digest is not a sha256 digest');
  const parameters = manifest.parameters;
  if (!parameters || typeof parameters.seed !== 'string' || typeof parameters.anchorDate !== 'string' || !datePattern.test(parameters.anchorDate) || typeof parameters.timeZone !== 'string') {
    problems.push('parameters are incomplete');
  }
  const database = (manifest as { database?: { name?: unknown; project?: unknown } }).database;
  if (database?.name !== PORTFOLIO_DATABASE || database.project !== PORTFOLIO_PROJECT) problems.push(`it does not describe ${PORTFOLIO_PROJECT}/${PORTFOLIO_DATABASE}`);
  const week = manifest.expected?.weeklyReview?.week;
  if (!week || typeof week.start !== 'string' || typeof week.end !== 'string' || mondayOf(week.start) !== week.start || addLocalDays(week.start, 6) !== week.end) {
    problems.push('expected.weeklyReview.week is not a Monday-to-Sunday week');
  }
  const comparison = manifest.expected?.activityComparison;
  if (!comparison || comparison.source !== 'manual' || comparison.type !== 'run') problems.push('expected.activityComparison is not the manual run selection');
  const ranges = manifest.ranges;
  if (!ranges?.current || !ranges.previous || ranges.current.endDate !== parameters?.anchorDate) problems.push('ranges do not end on the anchor');
  if (problems.length > 0) throw new ShowcaseExportError(`The dataset manifest cannot be used: ${problems.join('; ')}`);
  return manifest as DatasetManifest;
}

/** The manifest and the completion recorded for it: both must exist and agree, or the export stops before connecting. */
export function readRecordedBaseline(paths: Pick<DatasetPaths, 'manifest' | 'seedState'>): DatasetManifest {
  if (!existsSync(paths.manifest)) throw new ShowcaseExportError(`No dataset manifest at ${paths.manifest}: run npm run portfolio:dataset first`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.manifest, 'utf8'));
  } catch {
    throw new ShowcaseExportError('manifest.json is not valid JSON');
  }
  const manifest = checkedManifest(parsed);
  const state = readSeedState(paths.seedState);
  if (state === null || state.status !== 'complete' || state.version !== PORTFOLIO_DATASET_VERSION || !sameParameters(state.parameters, manifest.parameters)) {
    throw new ShowcaseExportError('seed-state.json does not record a completed dataset with the manifest’s parameters');
  }
  if (state.digest !== manifest.digest) throw new ShowcaseExportError('seed-state.json and manifest.json record different digests');
  return manifest;
}

export interface ShowcaseCatalog {
  activityCandidates: ShowcaseActivitySelection[];
  days: string[];
  defaultActivity: ShowcaseActivitySelection;
  defaultTrendsEndDate: string;
  defaultWeekStart: string;
  sampleDate: string;
  trendsEndDates: string[];
  weeks: string[];
}

/**
 * The bounded catalog, from the manifest alone. The sample date is the anchor (the manifest's Today selection). Trends
 * end on the anchor (the manifest's nutrition and activity selections) and on the Sunday of the manifest's weekly-review
 * week (the primary journey's completed week). Every date of those two ranges can be opened from a Trends row, so each
 * is an offered day; every week containing an offered day is an offered week. Activity: every source and type the
 * contract allows is a candidate; only those with entries are kept after reading.
 */
export function showcaseCatalog(manifest: DatasetManifest): ShowcaseCatalog {
  const anchor = manifest.parameters.anchorDate;
  const first = manifest.ranges.previous.startDate;
  const trendsEndDates = [...new Set([manifest.expected.weeklyReview.week.end, anchor])].filter((date) => date <= anchor).sort();
  const days = [...new Set(trendsEndDates.flatMap((endDate) => dailyTrendsDatesOf(dailyTrendsRangeOf(endDate))))].sort();
  if (days.some((day) => day < first || day > anchor)) throw new ShowcaseExportError('the catalog reaches dates outside the dataset');
  const weeks = [...new Set(days.map(mondayOf))].sort();
  const activityCandidates = ACTIVITY_HISTORY_SOURCES.flatMap((source) =>
    (source === 'recorded_run' ? (['run'] as const) : ACTIVITY_TYPES).map((type) => ({ source, type })),
  ).sort(compareActivitySelections);
  return {
    activityCandidates,
    days,
    defaultActivity: { source: manifest.expected.activityComparison.source, type: manifest.expected.activityComparison.type },
    defaultTrendsEndDate: anchor,
    defaultWeekStart: mondayOf(anchor),
    sampleDate: anchor,
    trendsEndDates,
    weeks,
  };
}

/** The fixed "now" of every read: the first instant after the anchor in the dataset's zone, so the anchor is complete. */
export function snapshotReadAt(manifest: DatasetManifest): string {
  return new Date(startOfLocalDate(addLocalDays(manifest.parameters.anchorDate, 1), manifest.parameters.timeZone)).toISOString();
}

// --- Volatile values (pure) ------------------------------------------------------------------------------------------

/** A UUID (version 8, RFC 9562) derived from a meal entry's date and position, replacing its database-generated id. */
export function derivedMealId(localDate: string, index: number): string {
  const hex = createHash('sha256').update(`showcase-meal-v1|${localDate}|${String(index)}`, 'utf8').digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/** One date's meal page with its volatile values normalised; every other value is the service's, unchanged. */
export function normalizedMealPage(page: MealListResponse, localDate: string, readAt: string): MealListResponse {
  if (page.nextCursor !== null) throw new ShowcaseExportError(`the meals of ${localDate} do not fit one page`);
  return mealListResponseSchema.parse({
    items: page.items.map((item, index) => ({ ...item, createdAt: readAt, mealId: derivedMealId(localDate, index), updatedAt: readAt })),
    nextCursor: null,
  });
}

/** Whether an activity-trends answer has any entry in either period: only such selections are offered. */
export function hasActivityEntries(trends: ActivityTrends): boolean {
  const count = trends.comparison?.metrics.count;
  return count !== undefined && (count.current > 0 || (count.previous ?? 0) > 0);
}

// --- The document (pure) ---------------------------------------------------------------------------------------------

/** Object keys sorted at every level, arrays in order: the canonical form the file is written in. */
export function sortedDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedDeep);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortedDeep(entry)]),
  );
}

export function showcaseContentDigest(document: Omit<ShowcaseSnapshot, 'contentDigest'>): string {
  return `sha256:${createHash('sha256').update(`${SHOWCASE_NORMALIZATION_VERSION}\n${canonicalJson(document)}`, 'utf8').digest('hex')}`;
}

/** The file's exact bytes: canonical key order, two-space indentation, LF, one trailing newline. */
export function serializeShowcaseSnapshot(snapshot: ShowcaseSnapshot): string {
  return `${JSON.stringify(sortedDeep(snapshot), null, 2)}\n`;
}

/** Key names that must never appear in the public document, whatever a future contract adds. */
const FORBIDDEN_KEYS = /password|secret|token|csrf|session|cookie|credential|latitude|longitude|coordinates|geometry|polyline|externalidentity|email|userid|orgid|runid|^note$|notes|payload/iu;

/**
 * The public-content check of the allowlist: no forbidden key, no identifier of the dataset's people, organization or runs,
 * and no note text. The contract schemas are strict, so the responses cannot carry other fields; this states the rule.
 */
export function publicContentProblems(snapshot: ShowcaseSnapshot, forbiddenText: readonly string[]): string[] {
  const problems: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(value) && FORBIDDEN_KEYS.test(key)) problems.push(`forbidden key ${path}${key}`);
      visit(entry, `${path}${key}.`);
    }
  };
  visit(snapshot, '');
  const text = JSON.stringify(snapshot);
  for (const forbidden of forbiddenText) if (forbidden !== '' && text.includes(forbidden)) problems.push(`the document contains ${forbidden.slice(0, 12)}…`);
  return problems;
}

export interface ShowcaseResponses {
  activityTrends: Map<string, ActivityTrends>;
  dailyOverview: Map<string, DailyOverview>;
  dailyTrends: Map<string, DailyTrends>;
  meals: Map<string, MealListResponse>;
  weeklyReview: Map<string, WeeklyReview>;
}

/** Assembles, digests and validates the document from the catalog and the responses read for it. */
export function buildShowcaseSnapshot(manifest: DatasetManifest, catalog: ShowcaseCatalog, responses: ShowcaseResponses, readAt: string): ShowcaseSnapshot {
  const activity = catalog.activityCandidates.filter((selection) =>
    catalog.trendsEndDates.some((endDate) => {
      const trends = responses.activityTrends.get(showcaseActivityKey(endDate, selection));
      return trends !== undefined && hasActivityEntries(trends);
    }),
  );
  if (!activity.some((selection) => selection.source === catalog.defaultActivity.source && selection.type === catalog.defaultActivity.type)) {
    throw new ShowcaseExportError('the manifest’s activity selection has no entries');
  }
  const pick = <Value>(map: Map<string, Value>, keys: readonly string[], what: string): Record<string, Value> =>
    Object.fromEntries(
      keys.map((key) => {
        const value = map.get(key);
        if (value === undefined) throw new ShowcaseExportError(`${what} ${key} was not read`);
        return [key, value];
      }),
    );
  const body: Omit<ShowcaseSnapshot, 'contentDigest'> = {
    contracts: { activityTrends: ACTIVITY_TRENDS_VERSION, dailyOverview: DAILY_OVERVIEW_VERSION, dailyTrends: DAILY_TRENDS_VERSION, weeklyReview: WEEKLY_REVIEW_VERSION },
    dataset: {
      anchorDate: manifest.parameters.anchorDate,
      datasetVersion: manifest.datasetVersion,
      digest: manifest.digest,
      digestNormalization: manifest.digestNormalization,
      ranges: {
        current: { endDate: manifest.ranges.current.endDate, startDate: manifest.ranges.current.startDate },
        previous: { endDate: manifest.ranges.previous.endDate, startDate: manifest.ranges.previous.startDate },
      },
      seed: manifest.parameters.seed,
      synthetic: true,
      timeZone: manifest.parameters.timeZone,
    },
    format: SHOWCASE_SNAPSHOT_FORMAT,
    normalization: SHOWCASE_NORMALIZATION_VERSION,
    responses: {
      activityTrends: pick(responses.activityTrends, catalog.trendsEndDates.flatMap((endDate) => activity.map((selection) => showcaseActivityKey(endDate, selection))), 'activity trends'),
      dailyOverview: pick(responses.dailyOverview, catalog.days, 'the overview of'),
      dailyTrends: pick(responses.dailyTrends, catalog.trendsEndDates, 'the trends ending'),
      meals: pick(responses.meals, catalog.days, 'the meals of'),
      weeklyReview: pick(responses.weeklyReview, catalog.weeks, 'the review of'),
    },
    selections: {
      activity,
      days: catalog.days,
      defaultActivity: catalog.defaultActivity,
      defaultMetric: SHOWCASE_DEFAULT_METRIC,
      defaultTrendsEndDate: catalog.defaultTrendsEndDate,
      defaultWeekStart: catalog.defaultWeekStart,
      sampleDate: catalog.sampleDate,
      trendsEndDates: catalog.trendsEndDates,
      weeks: catalog.weeks,
    },
    snapshot: { asOfDate: manifest.parameters.anchorDate, readAt },
    version: SHOWCASE_SNAPSHOT_VERSION,
  };
  const snapshot = { ...body, contentDigest: showcaseContentDigest(body) };
  let parsed: ShowcaseSnapshot;
  try {
    parsed = parseShowcaseSnapshot(snapshot);
  } catch (error) {
    throw new ShowcaseExportError(`the assembled snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const forbidden = [portfolioIdentities.runner, portfolioIdentities.coach, portfolioIdentities.organization, manifest.expected.finishedRun.runId, 'Synthetic note'];
  const problems = publicContentProblems(parsed, forbidden);
  if (problems.length > 0) throw new ShowcaseExportError(`the snapshot would publish more than the allowlist: ${problems.join('; ')}`);
  return parsed;
}

// --- Reading (database) ----------------------------------------------------------------------------------------------

type Expected = { database: string; proof: OwnedServerProof; role: PortfolioRole };

const READ_ONLY_OPTION = '-c default_transaction_read_only=on';

/** A pool whose every new connection proves its identity and that it is read-only before it is handed out. */
function verifiedReadOnlyPool(pool: Pool, expected: Expected, label: string): Pick<Pool, 'connect'> {
  const verified = new WeakSet<PoolClient>();
  return {
    connect: async () => {
      const client = await pool.connect();
      if (!verified.has(client)) {
        try {
          await verifyConnectedServer(client, expected, label);
          const setting = (await client.query<{ value: string }>("SELECT current_setting('default_transaction_read_only') AS value")).rows[0]?.value;
          if (setting !== 'on') throw new IsolationError(`${label}: the connection is not read-only`);
        } catch (error) {
          client.release(true);
          throw error;
        }
        verified.add(client);
      }
      return client;
    },
  };
}

export interface ShowcaseExportOptions {
  docker?: DockerRunner;
  environment?: Readonly<Record<string, string | undefined>>;
  log?: (line: string) => void;
  paths: DatasetPaths;
}

export interface ShowcaseExportResult {
  identities: Record<'owner' | 'runtime', ConnectedIdentity>;
  proof: OwnedServerProof;
  reads: number;
  serialized: string;
  snapshot: ShowcaseSnapshot;
}

/** The stored dataset, read by the owner role in one read-only snapshot: complete, with exactly the recorded digest. */
async function assertRecordedDataset(owner: Pick<Pool, 'connect'>, manifest: DatasetManifest, when: string): Promise<void> {
  const plan = planDataset(manifest.parameters);
  const scope = { coach: plan.identities.coach, organization: plan.identities.organization, runner: plan.identities.runner };
  const report = await readOnly(owner, (client) => readSnapshot(client, scope));
  const classified = classifySnapshot(plan, report);
  if (classified.reasons.length > 0 || classified.state !== 'complete') {
    throw new ShowcaseExportError(`${when}, the stored dataset is not the complete planned dataset (${classified.state}${classified.reasons.length > 0 ? `: ${classified.reasons[0]!}` : ''})`);
  }
  const digest = datasetDigest(report.snapshot);
  if (digest !== manifest.digest) throw new ShowcaseExportError(`${when}, the stored dataset's digest ${digest} is not the recorded ${manifest.digest}`);
}

export async function exportShowcaseSnapshot(options: ShowcaseExportOptions): Promise<ShowcaseExportResult> {
  const log = options.log ?? (() => undefined);
  // 1. Before connecting.
  assertNotProduction(options.environment ?? process.env);
  const manifest = readRecordedBaseline(options.paths);
  const catalog = showcaseCatalog(manifest);
  const readAt = snapshotReadAt(manifest);
  const urls = databaseUrls(readLocalEnvironment(options.paths));
  const target = validateTargetUrls({ owner: urls.owner, runtime: urls.runtime });
  if (target.database !== PORTFOLIO_DATABASE) throw new IsolationError(`The showcase is exported from ${PORTFOLIO_DATABASE} only`);
  const proof = proveOwnedServer({ docker: options.docker, port: target.port });
  const expectedFor = (role: PortfolioRole): Expected => ({ database: target.database, proof, role });

  // 2. Connections that prove themselves and cannot write.
  const pools = {
    owner: new pg.Pool({ application_name: 'somalane-showcase-export-owner', connectionString: urls.owner, max: 1, options: READ_ONLY_OPTION, statement_timeout: 30_000 }),
    runtime: new pg.Pool({ application_name: 'somalane-showcase-export-runtime', connectionString: urls.runtime, max: 2, options: READ_ONLY_OPTION, statement_timeout: 30_000 }),
  };
  for (const pool of Object.values(pools)) pool.on('error', () => undefined);
  try {
    const owner = verifiedReadOnlyPool(pools.owner, expectedFor('owner'), 'owner URL');
    const runtime = verifiedReadOnlyPool(pools.runtime, expectedFor('runtime'), 'runtime URL');
    const identityOf = async (pool: Pick<Pool, 'connect'>, role: PortfolioRole, label: string) => {
      const client = await pool.connect();
      try {
        return await verifyConnectedServer(client, expectedFor(role), label);
      } finally {
        client.release();
      }
    };
    const identities = { owner: await identityOf(owner, 'owner', 'owner URL'), runtime: await identityOf(runtime, 'runtime', 'runtime URL') };
    log(`verified ${identities.owner.role} and ${identities.runtime.role} on ${identities.runtime.database} (cluster ${PORTFOLIO_CLUSTER_NAME}, container ${proof.containerId.slice(0, 12)}); read-only connections`);

    // 3. The stored dataset is the recorded one.
    await assertRecordedDataset(owner, manifest, 'before the export');
    log(`dataset digest matches the recorded ${manifest.digest}`);

    // 4. The responses, through the read services, as the synthetic runner, at the fixed instant.
    const clock = instantClock(Date.parse(readAt));
    const session = { userId: portfolioIdentities.runner };
    const orgId = portfolioIdentities.organization;
    const timeZone = manifest.parameters.timeZone;
    const overviewService = new DailyOverviewService({ clock, pool: runtime });
    const reviewService = new WeeklyReviewService({ clock, pool: runtime });
    const trendsService = new DailyTrendsService({ clock, pool: runtime });
    const activityService = new ActivityTrendsService({ clock, pool: runtime });
    const responses: ShowcaseResponses = { activityTrends: new Map(), dailyOverview: new Map(), dailyTrends: new Map(), meals: new Map(), weeklyReview: new Map() };
    let reads = 0;
    for (const day of catalog.days) {
      responses.dailyOverview.set(day, dailyOverviewSchema.parse(await overviewService.read(session, orgId, day, dailyOverviewQuerySchema.parse({ timeZone }))));
      const query = mealListQuerySchema.parse({ localDate: day });
      const page = await withAuthenticatedTenantTransaction(runtime, session, orgId, (client) => listMeals(client, session, orgId, query), { snapshot: 'read-only snapshot' });
      responses.meals.set(day, normalizedMealPage(mealListResponseSchema.parse(page), day, readAt));
      reads += 2;
    }
    for (const week of catalog.weeks) {
      responses.weeklyReview.set(week, weeklyReviewSchema.parse(await reviewService.read(session, orgId, weeklyReviewQuerySchema.parse({ timeZone, weekStart: week }))));
      reads += 1;
    }
    for (const endDate of catalog.trendsEndDates) {
      responses.dailyTrends.set(endDate, dailyTrendsSchema.parse(await trendsService.read(session, orgId, dailyTrendsQuerySchema.parse({ endDate, timeZone }))));
      reads += 1;
      for (const selection of catalog.activityCandidates) {
        const query = activityTrendsQuerySchema.parse({ compare: 'previous_period', endDate, source: selection.source, timeZone, type: selection.type });
        responses.activityTrends.set(showcaseActivityKey(endDate, selection), activityTrendsSchema.parse(await activityService.read(session, orgId, query)));
        reads += 1;
      }
    }
    log(`read ${String(reads)} responses through the read services at ${readAt}`);

    // 5. Nothing changed while reading.
    await assertRecordedDataset(owner, manifest, 'after the export');

    const snapshot = buildShowcaseSnapshot(manifest, catalog, responses, readAt);
    return { identities, proof, reads, serialized: serializeShowcaseSnapshot(snapshot), snapshot };
  } finally {
    await Promise.all(Object.values(pools).map((pool) => pool.end().catch(() => undefined)));
  }
}

/** For callers that only need to know that a pool is never used to write: the read-only option of the export's pools. */
export const SHOWCASE_EXPORT_CONNECTION_OPTION = READ_ONLY_OPTION;
