import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import pg from 'pg';

import { buildManifest, type DatasetManifest } from './dataset-manifest.js';
import { PORTFOLIO_DATASET_VERSION, resolveParameters, type DatasetParameters } from './dataset-plan.js';
import { DatasetBusyError, DatasetConflictError, describeIsolationFailure, seedPortfolioDataset, type SeedResult } from './dataset-writer.js';
import {
  assertNotProduction,
  IsolationError,
  PORTFOLIO_DATABASE,
  PORTFOLIO_PROJECT,
  proveOwnedServer,
  runDocker,
  validateTargetUrl,
  verifyConnectedServer,
} from './isolation.js';
import {
  composeArguments,
  databaseUrls,
  datasetPaths,
  describeUrl,
  ensureLocalEnvironment,
  isLoopbackPortFree,
  PORTFOLIO_API_ORIGIN,
  PORTFOLIO_WEB_ORIGIN,
  repositoryRoot,
  requirePort,
  runDatabaseScript,
  type DatasetPaths,
} from './local-environment.js';

// `npm run portfolio:dataset -- [--seed <label>] [--anchor YYYY-MM-DD] [--port <n>]` (docs/runbooks/portfolio-dataset.md):
// prepares the isolated environment (its own Compose project, PostgreSQL server, network and volume; credentials under
// .local/portfolio-dataset/), proves isolation, bootstraps and migrates the dataset database with the existing scripts,
// seeds the 56-date dataset through the application's services, and writes the manifest. It never reads .env or the
// normal DATABASE_URL / TEST_* variables, never stops another process or container, and never resets data.

export interface PrepareArguments {
  anchorDate?: string;
  port?: number;
  seed?: string;
}

export function parsePrepareArguments(argv: readonly string[]): PrepareArguments | 'help' {
  const parsed: PrepareArguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--help' || flag === '-h') return 'help';
    const value = argv[index + 1];
    if (!['--seed', '--anchor', '--port'].includes(flag)) throw new Error(`Unknown argument ${flag} (try --help)`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === '--seed') {
      if (parsed.seed !== undefined) throw new Error('--seed was given twice');
      parsed.seed = value;
    } else if (flag === '--anchor') {
      if (parsed.anchorDate !== undefined) throw new Error('--anchor was given twice');
      parsed.anchorDate = value;
    } else {
      if (parsed.port !== undefined) throw new Error('--port was given twice');
      parsed.port = requirePort(value, '--port');
    }
  }
  return parsed;
}

const usage = `Usage: npm run portfolio:dataset -- [--seed <label>] [--anchor YYYY-MM-DD] [--port <n>]

  --seed    1-64 characters of A-Z a-z 0-9 . _ - (default somalane-portfolio-v1)
  --anchor  the last of the 56 dates, a completed date (default: yesterday in Europe/Warsaw)
  --port    loopback port of the dataset PostgreSQL, first run only (default 5442)

See docs/runbooks/portfolio-dataset.md.`;

export interface SeedState {
  digest?: string;
  error?: string;
  parameters: DatasetParameters;
  status: 'complete' | 'in-progress' | 'interrupted';
  version: string;
}

export function readSeedState(path: string): SeedState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SeedState;
    return typeof parsed.parameters?.seed === 'string' && typeof parsed.parameters.anchorDate === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSeedState(path: string, state: SeedState): void {
  writeFileSync(path, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

const sameParameters = (a: DatasetParameters, b: DatasetParameters) => a.seed === b.seed && a.anchorDate === b.anchorDate && a.timeZone === b.timeZone;

/** The digest recorded when a dataset with these parameters last completed: the seed state, else the manifest. */
export function recordedDigest(paths: DatasetPaths, parameters: DatasetParameters): string | undefined {
  const state = readSeedState(paths.seedState);
  if (state?.status === 'complete' && state.version === PORTFOLIO_DATASET_VERSION && sameParameters(state.parameters, parameters) && state.digest) return state.digest;
  if (!existsSync(paths.manifest)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as Partial<DatasetManifest>;
    return manifest.datasetVersion === PORTFOLIO_DATASET_VERSION && manifest.parameters && sameParameters(manifest.parameters, parameters) ? manifest.digest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs the core writer with the recorded completion digest and records the outcome. The completion state and the
 * manifest are written only after the writer has accepted the dataset (and, when a digest was recorded, matched it);
 * a refused run (conflict, drift, busy, isolation) leaves every existing artifact byte for byte as it was. Any other
 * failure is recorded as `interrupted`, which the next run with the same parameters resumes.
 */
export async function seedAndRecord(
  paths: DatasetPaths,
  parameters: DatasetParameters,
  print: (line: string) => void,
  seed: (expectedDigest: string | undefined) => Promise<SeedResult>,
): Promise<{ manifest: DatasetManifest; result: SeedResult }> {
  const previous = readSeedState(paths.seedState);
  if (previous !== null && previous.status !== 'complete' && sameParameters(previous.parameters, parameters)) {
    print(`The last seed with these parameters did not complete (${previous.status}${previous.error ? `: ${previous.error}` : ''}); resuming it.`);
  }
  const expectedDigest = recordedDigest(paths, parameters);
  let result: SeedResult;
  try {
    result = await seed(expectedDigest);
  } catch (error) {
    if (error instanceof DatasetConflictError) {
      const stored = previous === null ? 'not recorded on this computer' : `${previous.version}, seed ${previous.parameters.seed}, anchor ${previous.parameters.anchorDate}, zone ${previous.parameters.timeZone} (${previous.status})`;
      // Only a refusal made before the first write may say nothing was written; a check of the result comes after
      // committed, keyed writes, which stay in the database.
      const written =
        error.writes === 0
          ? 'This attempt wrote nothing to the database, and no manifest or state file was replaced.'
          : `This attempt performed ${String(error.writes)} seed write operation(s) before the check failed; what they committed stays in the database ` +
            '(nothing was rolled back). No manifest or state file was replaced.';
      throw new Error(
        `${error.message}\nLast seed recorded on this computer: ${stored}. Requested: ${PORTFOLIO_DATASET_VERSION}, seed ${parameters.seed}, anchor ${parameters.anchorDate}. ` +
          `${written} Rerun with the recorded parameters, or start over by hand (remove the dataset volume and .local/portfolio-dataset/; ` +
          'docs/runbooks/portfolio-dataset.md, "Starting over").',
        { cause: error },
      );
    }
    if (error instanceof DatasetBusyError || error instanceof IsolationError) throw error;
    writeSeedState(paths.seedState, { error: error instanceof Error ? error.message.split('\n')[0]! : String(error), parameters, status: 'interrupted', version: PORTFOLIO_DATASET_VERSION });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nThe dataset is incomplete but consistent: every write is keyed, so running the same command again resumes it ` +
        `(npm run portfolio:dataset -- --seed ${parameters.seed} --anchor ${parameters.anchorDate}).`,
      { cause: error },
    );
  }
  print(`  recorded digest: ${result.baseline === 'matched' ? 'matched' : 'none recorded for these parameters (first completion)'}`);
  writeSeedState(paths.seedState, { digest: result.digest, parameters, status: 'complete', version: PORTFOLIO_DATASET_VERSION });
  const manifest = buildManifest(result.plan, result.report, result.digest);
  writeFileSync(paths.manifest, `${JSON.stringify({ ...manifest, database: { name: PORTFOLIO_DATABASE, project: PORTFOLIO_PROJECT } }, null, 2)}\n`);
  return { manifest, result };
}

function docker(args: readonly string[], what: string): void {
  const result = spawnSync('docker', [...args], { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (result.error) throw new Error(`Could not run docker to ${what}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`docker could not ${what}:\n${`${result.stdout}${result.stderr}`.trim()}`);
}

function ownContainerRunning(): boolean {
  const result = runDocker(['ps', '--filter', `label=com.docker.compose.project=${PORTFOLIO_PROJECT}`, '--filter', 'label=com.docker.compose.service=postgres', '--format', '{{.ID}}']);
  return result.status === 0 && result.stdout.trim() !== '';
}

export async function runPrepare(argv: readonly string[], print: (line: string) => void = console.log): Promise<DatasetManifest | undefined> {
  const parsed = parsePrepareArguments(argv);
  if (parsed === 'help') {
    print(usage);
    return undefined;
  }
  assertNotProduction(process.env);
  const nowMs = Date.now();
  const parameters = resolveParameters({ anchorDate: parsed.anchorDate, seed: parsed.seed }, nowMs);
  const paths = datasetPaths();

  // 1. Local configuration (created once; credentials never leave .local/portfolio-dataset/).
  const { created, environment } = ensureLocalEnvironment(paths, { port: parsed.port });
  print(`${created ? 'Created' : 'Using'} the dataset environment in ${paths.directory} (PostgreSQL on 127.0.0.1:${String(environment.databasePort)})`);

  // 2. The project's own PostgreSQL. A port held by anything else is reported, never freed.
  if (!ownContainerRunning() && !(await isLoopbackPortFree(environment.databasePort))) {
    throw new Error(
      `127.0.0.1:${String(environment.databasePort)} is in use by another process or container; nothing was stopped. Free it yourself, or on a ` +
        'first run choose another port with --port.',
    );
  }
  print(`Starting the ${PORTFOLIO_PROJECT} Compose project (its own server, network and volume) ...`);
  docker([...composeArguments(paths), 'up', '--detach', '--wait', '--wait-timeout', '300', 'postgres'], 'start the dataset PostgreSQL');

  // 3. Isolation proof before the first change (the bootstrap changes cluster-wide roles).
  const urls = databaseUrls(environment);
  validateTargetUrl(urls.admin, 'admin', 'admin URL');
  const proof = proveOwnedServer({ port: environment.databasePort });
  const admin = new pg.Client({ application_name: 'somalane-portfolio-dataset-admin', connectionString: urls.admin, connectionTimeoutMillis: 10_000 });
  await admin.connect();
  let adminIdentity;
  try {
    adminIdentity = await verifyConnectedServer(admin, { database: PORTFOLIO_DATABASE, proof, role: 'admin' }, 'admin URL');
  } finally {
    await admin.end();
  }
  print(`Isolation proven: container ${proof.containerId.slice(0, 12)} of ${proof.project}, published on 127.0.0.1:${String(proof.publishedPort)} only;`);
  print(`  over TCP: database ${adminIdentity.database}, current_user = session_user = ${adminIdentity.role}, cluster ${adminIdentity.clusterName},`);
  print(`  system identifier equal to the one read inside the container.`);

  // 4. Roles, PostGIS and migrations with the existing scripts, against this database only.
  print('Bootstrapping roles and PostGIS (scripts/bootstrap-database.mjs) ...');
  runDatabaseScript('bootstrap-database.mjs', urls);
  const migrated = runDatabaseScript('migrate.mjs', urls);
  const applied = migrated.split(/\r?\n/u).filter((line) => line.startsWith('apply ')).length;
  const skipped = migrated.split(/\r?\n/u).filter((line) => line.startsWith('skip ')).length;
  print(`Migrations (scripts/migrate.mjs): ${String(applied)} applied, ${String(skipped)} already in place.`);

  // 5. The dataset, through the application's services (the writer repeats every isolation check itself).
  print(`Seeding: version ${PORTFOLIO_DATASET_VERSION}, seed ${parameters.seed}, anchor ${parameters.anchorDate}, zone ${parameters.timeZone} ...`);
  const { manifest, result } = await seedAndRecord(paths, parameters, print, (expectedDigest) =>
    seedPortfolioDataset({ expectedDigest, log: (line) => print(`  ${line}`), nowMs, parameters, urls }),
  );

  print('');
  print(`Dataset ${result.stateBefore === 'complete' ? 'was already complete; nothing was written' : result.stateBefore === 'partial' ? 'resumed and completed' : 'created'} (${String(result.writes)} write operations).`);
  print(`  roles: ${describeUrl(urls.owner)} (provisioning), ${describeUrl(urls.runtime)} (records), ${describeUrl(urls.maintenance)} (summaries)`);
  print(`  ranges: previous ${manifest.ranges.previous.startDate}..${manifest.ranges.previous.endDate}, current ${manifest.ranges.current.startDate}..${manifest.ranges.current.endDate}`);
  print(`  counts: ${Object.entries(manifest.counts).map(([key, value]) => `${key} ${String(value)}`).join(', ')}`);
  print(`  digest: ${manifest.digest}`);
  print(`  manifest: ${paths.manifest}`);
  print('');
  print('Open in the existing app (docs/runbooks/portfolio-dataset.md, "Review the populated app"):');
  for (const [name, selection] of Object.entries(manifest.selections)) print(`  ${name}: ${selection}`);
  print('');
  print(`  API:  npm run portfolio:dataset:api   (${PORTFOLIO_API_ORIGIN}; verifies its database connections first)`);
  print(`  Web:  npm run portfolio:dataset:web   (${PORTFOLIO_WEB_ORIGIN}, proxying only to ${PORTFOLIO_API_ORIGIN})`);
  print('  Both ignore inherited variables and .env for their configuration; see the runbook, section 5.');
  print(`  Then open ${PORTFOLIO_WEB_ORIGIN} and press "Demo runner" (or "Demo coach").`);
  print(`  Reproduce exactly: npm run portfolio:dataset -- --seed ${parameters.seed} --anchor ${parameters.anchorDate}`);
  return manifest;
}

export async function main(argv: readonly string[]): Promise<void> {
  try {
    await runPrepare(argv);
  } catch (error) {
    console.error(`portfolio:dataset: ${describeIsolationFailure(error)}`);
    process.exitCode = 1;
  }
}
