import { spawn } from 'node:child_process';
import { join } from 'node:path';

import pg from 'pg';

import { loadEnvironment, type Environment } from '../config/environment.js';
import { main as startApi, type MainDependencies } from '../main.js';
import { portfolioIdentities } from './dataset-plan.js';
import {
  IsolationError,
  PORTFOLIO_DATABASE,
  proveOwnedServer,
  validateTargetUrl,
  verifyConnectedServer,
  type ConnectedIdentity,
  type DockerRunner,
  type OwnedServerProof,
} from './isolation.js';
import {
  datasetPaths,
  describeUrl,
  operatingSystemEnvironment,
  PORTFOLIO_API_ORIGIN,
  PORTFOLIO_API_PORT,
  PORTFOLIO_WEB_ORIGIN,
  PORTFOLIO_WEB_PORT,
  portfolioApiSettings,
  portfolioWebSettings,
  readLocalEnvironment,
  repositoryRoot,
  type DatasetPaths,
} from './local-environment.js';

// The ONE way to start the existing API and web app on the isolated portfolio dataset (docs/runbooks/portfolio-dataset.md,
// section 5): `npm run portfolio:dataset:api` and `npm run portfolio:dataset:web`, which the portfolio Playwright
// configuration runs too. Inherited variables and .env files decide nothing here:
//
// - API: the configuration source is exactly the dataset's own settings and secrets (portfolioApiSettings), passed to
//   the application's loadEnvironment with no inherited environment and no .env file; the result is checked
//   (assertIsolatedApiConfiguration); this process's own environment is reduced to operating-system variables, so the
//   pg driver sees no PG* default; then the configured runtime and maintenance URLs are proven, connection by
//   connection, to reach the owned portfolio server with the expected identities (the dataset's isolation checks); only
//   then does the existing main() start, through its loadConfig injection point.
// - Web: Vite runs with operating-system variables plus the one proxy target, on 127.0.0.1:5373.
//
// Nothing printed contains a password or a token: URLs are shown as role@host:port/database.

/** The API configuration of the isolated stack, from the dataset's settings only. */
export function portfolioApiConfiguration(paths: DatasetPaths = datasetPaths()): Environment {
  const config = loadEnvironment({ environment: portfolioApiSettings(readLocalEnvironment(paths)), envFiles: [] });
  assertIsolatedApiConfiguration(config);
  return config;
}

/** Refuses any configuration that is not the isolated stack's: wrong target, endpoint, identities, providers or outputs. */
export function assertIsolatedApiConfiguration(config: Environment): void {
  const problems: string[] = [];
  const expect = (condition: boolean, message: string) => {
    if (!condition) problems.push(message);
  };
  expect(config.APP_ENV === 'development', 'APP_ENV must be development');
  expect(config.API_HOST === '127.0.0.1' && config.PORT === PORTFOLIO_API_PORT, `the API must listen on ${PORTFOLIO_API_ORIGIN} only`);
  expect(config.ALLOWED_ORIGINS.length === 1 && config.ALLOWED_ORIGINS[0] === PORTFOLIO_WEB_ORIGIN, `the only allowed origin must be ${PORTFOLIO_WEB_ORIGIN}`);
  expect(
    config.LOCAL_AUTH_ENABLED && [...config.LOCAL_AUTH_USER_IDS].sort().join(',') === [portfolioIdentities.coach, portfolioIdentities.runner].sort().join(','),
    'local sign-in must allow the synthetic runner and coach and nobody else',
  );
  expect(config.METRICS_PORT === undefined, 'no metrics listener');
  expect(config.DELETION_JOURNAL_DIR === undefined, 'no deletion-journal export directory');
  for (const key of ['OIDC', 'RUN_SEARCH_AI', 'WEEKLY_INSIGHTS', 'MEAL_DRAFTS', 'DATA_QUESTIONS'] as const) expect(config[key] === undefined, `${key} must be off`);
  if (problems.length > 0) throw new IsolationError(`The portfolio API configuration is not isolated: ${problems.join('; ')}`);
  const runtime = validateTargetUrl(config.DATABASE_URL, 'runtime', 'DATABASE_URL');
  const maintenance = validateTargetUrl(config.MAINTENANCE_DATABASE_URL, 'maintenance', 'MAINTENANCE_DATABASE_URL');
  if (runtime.database !== PORTFOLIO_DATABASE || maintenance.database !== PORTFOLIO_DATABASE || runtime.port !== maintenance.port) {
    throw new IsolationError(`The portfolio API must use ${PORTFOLIO_DATABASE} on one loopback endpoint`);
  }
}

/** Keeps only operating-system variables in `environment` (this process's own by default), in place. */
export function reduceToOperatingSystemEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  const keep = operatingSystemEnvironment(environment);
  for (const name of Object.keys(environment)) {
    if (!Object.hasOwn(keep, name)) delete environment[name];
  }
}

export interface VerifiedApiTargets {
  maintenance: ConnectedIdentity;
  proof: OwnedServerProof;
  runtime: ConnectedIdentity;
}

/** Proves that the configured runtime and maintenance URLs reach the owned portfolio server as the expected roles. */
export async function verifyApiTargets(config: Environment, options: { docker?: DockerRunner | undefined } = {}): Promise<VerifiedApiTargets> {
  assertIsolatedApiConfiguration(config);
  const port = Number(validateTargetUrl(config.DATABASE_URL, 'runtime', 'DATABASE_URL').port);
  const proof = proveOwnedServer({ docker: options.docker, port });
  const verify = async (connectionString: string, role: 'maintenance' | 'runtime', label: string) => {
    const client = new pg.Client({ application_name: 'somalane-portfolio-api-check', connectionString, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      return await verifyConnectedServer(client, { database: PORTFOLIO_DATABASE, proof, role }, label);
    } finally {
      await client.end();
    }
  };
  return {
    maintenance: await verify(config.MAINTENANCE_DATABASE_URL, 'maintenance', 'MAINTENANCE_DATABASE_URL'),
    proof,
    runtime: await verify(config.DATABASE_URL, 'runtime', 'DATABASE_URL'),
  };
}

export interface ApiStartupOptions {
  docker?: DockerRunner;
  environment?: NodeJS.ProcessEnv;
  paths?: DatasetPaths;
  print?: (line: string) => void;
  start?: (dependencies: MainDependencies) => Promise<void>;
}

export async function runApi(options: ApiStartupOptions = {}): Promise<VerifiedApiTargets> {
  const print = options.print ?? console.log;
  reduceToOperatingSystemEnvironment(options.environment ?? process.env);
  const config = portfolioApiConfiguration(options.paths);
  const verified = await verifyApiTargets(config, { docker: options.docker });
  print(`portfolio API: verified ${describeUrl(config.DATABASE_URL)} and ${describeUrl(config.MAINTENANCE_DATABASE_URL)}`);
  print(
    `  owned server: container ${verified.proof.containerId.slice(0, 12)} of ${verified.proof.project}, database ${verified.runtime.database}, ` +
      `roles ${verified.runtime.role} and ${verified.maintenance.role}, matching system identifier`,
  );
  print(`  listening on ${PORTFOLIO_API_ORIGIN}; origin ${PORTFOLIO_WEB_ORIGIN}; demo runner and coach only; every AI provider off; no OIDC, metrics or journal export`);
  await (options.start ?? startApi)({ loadConfig: () => config });
  return verified;
}

export interface WebLaunch {
  args: string[];
  command: string;
  cwd: string;
  environment: Record<string, string>;
}

/** How the web app is started: Vite on 127.0.0.1:5373, operating-system variables plus the portfolio settings. */
export function webLaunch(parent: NodeJS.ProcessEnv = process.env): WebLaunch {
  return {
    args: [join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(PORTFOLIO_WEB_PORT), '--strictPort'],
    command: process.execPath,
    cwd: join(repositoryRoot, 'apps', 'web'),
    environment: { ...operatingSystemEnvironment(parent), ...portfolioWebSettings() },
  };
}

function runWeb(print: (line: string) => void): void {
  const launch = webLaunch();
  print(`portfolio web: ${PORTFOLIO_WEB_ORIGIN}, proxying /api only to ${launch.environment.API_PROXY_TARGET}`);
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.environment, stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 1 : 0);
  });
  child.on('error', (error) => {
    console.error(`portfolio web: could not start Vite (${error.message})`);
    process.exitCode = 1;
  });
}

export async function main(argv: readonly string[]): Promise<void> {
  const [target, ...rest] = argv;
  try {
    if (rest.length > 0 || (target !== 'api' && target !== 'web')) throw new Error('Usage: portfolio-dataset serve api|web (docs/runbooks/portfolio-dataset.md)');
    if (target === 'api') await runApi();
    else runWeb(console.log);
  } catch (error) {
    console.error(`portfolio:dataset:${String(target)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
