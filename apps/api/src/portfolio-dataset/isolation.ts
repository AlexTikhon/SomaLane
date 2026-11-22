import { spawnSync } from 'node:child_process';

import { parseDatabaseConnection, type ParsedDatabaseConnection } from '../config/environment.js';

// Isolation of the portfolio dataset (release step 2, docs/runbooks/portfolio-dataset.md). Every mutation of the dataset
// tooling (bootstrap, migrations, seed, throwaway test databases) is preceded by these checks, and the core writer runs
// them itself: a caller cannot hand it a pool and skip them.
//
// 1. Configuration: the database name must be the dataset's own (or a throwaway test database of this tooling); the
//    development database `running_tracker` and the shared test database `running_tracker_test` are refused
//    unconditionally, with no flag, variable or option to override it. APP_ENV=production is refused. The host must be
//    the loopback address. URLs that override the connection identity in query parameters are refused by the API's own
//    parser, and the dataset's URLs carry no query parameters at all.
// 2. Ownership: exactly one RUNNING container carries this project's Compose labels (project + service), it publishes
//    PostgreSQL on 127.0.0.1 only, and on the port the URL names. Inside it (docker exec, the container's own socket),
//    the server reports its system identifier: a random 64-bit value chosen when the cluster was initialised.
// 3. Connection: over the TCP connection the tooling will actually use, the server must report the expected database,
//    current_user = session_user = the expected role, the SAME system identifier, and the project's cluster_name. Docker
//    NAT means the server's own address and port (inet_server_addr/port) are the container's, never the published
//    loopback endpoint, so they prove nothing and are not compared; the system identifier ties the connection to the
//    container that was proven to be ours.

export const PORTFOLIO_PROJECT = 'somalane-portfolio-dataset';
export const PORTFOLIO_COMPOSE_FILE = 'infra/compose/docker-compose.portfolio-dataset.yml';
export const PORTFOLIO_DATABASE = 'somalane_portfolio_demo';
export const PORTFOLIO_CLUSTER_NAME = 'somalane-portfolio-dataset';
/** The development and shared test databases: never a target, whatever the configuration says. */
export const FORBIDDEN_DATABASES = Object.freeze(['running_tracker', 'running_tracker_test']);
/** Throwaway databases created by the dataset's own tests inside the owned server. */
export const THROWAWAY_DATABASE_PATTERN = /^somalane_portfolio_t_[0-9a-f]{12}$/u;

export const PORTFOLIO_ROLES = Object.freeze({
  admin: 'somalane_portfolio_admin',
  maintenance: 'running_tracker_maintenance',
  owner: 'running_tracker_owner',
  runtime: 'running_tracker_runtime',
});
export type PortfolioRole = keyof typeof PORTFOLIO_ROLES;

const LOOPBACK_HOST = '127.0.0.1';

export class IsolationError extends Error {
  public constructor(message: string) {
    super(`${message}; nothing was changed`);
    this.name = 'IsolationError';
  }
}

/** The development and shared test databases are refused first and unconditionally; then only the dataset's names pass. */
export function assertDatasetDatabaseName(database: string): string {
  if (FORBIDDEN_DATABASES.includes(database)) {
    throw new IsolationError(
      `Refusing the database ${database}: the development and shared test databases are never a dataset target, and no option overrides that`,
    );
  }
  if (database !== PORTFOLIO_DATABASE && !THROWAWAY_DATABASE_PATTERN.test(database)) {
    throw new IsolationError(`Refusing the database ${database}: only ${PORTFOLIO_DATABASE} or a throwaway somalane_portfolio_t_<12 hex> database is a dataset target`);
  }
  return database;
}

export function assertNotProduction(environment: Readonly<Record<string, string | undefined>>): void {
  if (environment.APP_ENV === 'production') throw new IsolationError('Refusing to run with APP_ENV=production');
}

/**
 * Validates one dataset connection URL (configuration only; a server proves the rest). Reuses the API's URL parser, so
 * an identity override in the query (user, host, port, database, dbname) is refused exactly as there.
 */
export function validateTargetUrl(connectionString: string, role: PortfolioRole, label: string): ParsedDatabaseConnection {
  const parsed = parseDatabaseConnection(connectionString, label, PORTFOLIO_ROLES[role], false, (message) => new IsolationError(message));
  const url = new URL(connectionString);
  if (url.search !== '') throw new IsolationError(`${label} must not carry query parameters`);
  if (parsed.host !== LOOPBACK_HOST) {
    throw new IsolationError(`${label} must connect to ${LOOPBACK_HOST}: the dataset never uses a non-local server`);
  }
  assertDatasetDatabaseName(parsed.database);
  return parsed;
}

/** Validates the URLs of one target together: the same loopback endpoint and database for every role. */
export function validateTargetUrls<Roles extends PortfolioRole>(urls: Readonly<Record<Roles, string>>): { database: string; port: number } {
  const parsed = (Object.entries(urls) as [Roles, string][]).map(([role, url]) => validateTargetUrl(url, role, `${role} URL`));
  const [first, ...rest] = parsed;
  if (!first) throw new IsolationError('No dataset connection URL was given');
  if (rest.some((entry) => entry.database !== first.database || entry.port !== first.port || entry.host !== first.host)) {
    throw new IsolationError('Every dataset connection URL must name the same loopback endpoint and database');
  }
  return { database: first.database, port: Number(first.port) };
}

// --- Ownership proof -------------------------------------------------------------------------------------------------

export interface DockerResult {
  error?: Error | undefined;
  status: number | null;
  stderr: string;
  stdout: string;
}
export type DockerRunner = (args: readonly string[]) => DockerResult;

export const runDocker: DockerRunner = (args) => {
  const result = spawnSync('docker', [...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return { error: result.error, status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
};

export interface OwnedServerProof {
  containerId: string;
  project: string;
  publishedPort: number;
  systemIdentifier: string;
}

function dockerOutput(docker: DockerRunner, args: readonly string[], what: string): string {
  const result = docker(args);
  if (result.error) throw new IsolationError(`Could not run docker to ${what} (${result.error.message}); is Docker running?`);
  if (result.status !== 0) throw new IsolationError(`docker could not ${what}: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
  return result.stdout.trim();
}

interface PortBinding {
  HostIp?: string;
  HostPort?: string;
}

/**
 * Proves that the dataset's PostgreSQL container is running, belongs to this Compose project, publishes only on
 * 127.0.0.1:<port>, and reports a system identifier from inside. `port` is the port the connection URLs name.
 */
export function proveOwnedServer(input: { docker?: DockerRunner | undefined; port: number }): OwnedServerProof {
  const docker = input.docker ?? runDocker;
  const ids = dockerOutput(
    docker,
    ['ps', '--no-trunc', '--filter', `label=com.docker.compose.project=${PORTFOLIO_PROJECT}`, '--filter', 'label=com.docker.compose.service=postgres', '--format', '{{.ID}}'],
    "list the dataset's PostgreSQL container",
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new IsolationError(
      ids.length === 0
        ? `The dataset's PostgreSQL container (Compose project ${PORTFOLIO_PROJECT}) is not running; run npm run portfolio:dataset`
        : `More than one running container claims to be the dataset's PostgreSQL service (${String(ids.length)})`,
    );
  }
  const containerId = ids[0]!;
  if (!/^[0-9a-f]{64}$/u.test(containerId)) throw new IsolationError('docker returned an unexpected container ID');

  const inspected = dockerOutput(docker, ['inspect', '--format', '{{json .Config.Labels}}\n{{json .NetworkSettings.Ports}}', containerId], 'inspect the dataset container');
  const [labelsJson, portsJson] = inspected.split(/\r?\n/u);
  let labels: Record<string, string>;
  let ports: Record<string, PortBinding[] | null>;
  try {
    labels = JSON.parse(labelsJson ?? 'null') as Record<string, string>;
    ports = JSON.parse(portsJson ?? 'null') as Record<string, PortBinding[] | null>;
  } catch {
    throw new IsolationError('docker inspect returned output that is not JSON');
  }
  if (labels?.['com.docker.compose.project'] !== PORTFOLIO_PROJECT || labels['com.docker.compose.service'] !== 'postgres') {
    throw new IsolationError('The container does not carry the dataset project labels');
  }
  const configFiles = labels['com.docker.compose.project.config_files'] ?? '';
  if (!configFiles.replaceAll('\\', '/').endsWith(PORTFOLIO_COMPOSE_FILE.split('/').at(-1)!)) {
    throw new IsolationError(`The container was not started from ${PORTFOLIO_COMPOSE_FILE}`);
  }
  const bindings = Object.entries(ports ?? {}).flatMap(([containerPort, entries]) => (entries ?? []).map((entry) => ({ containerPort, ...entry })));
  if (bindings.length === 0 || bindings.some((binding) => binding.containerPort !== '5432/tcp' || binding.HostIp !== LOOPBACK_HOST)) {
    throw new IsolationError('The dataset container must publish only PostgreSQL (5432/tcp) and only on 127.0.0.1');
  }
  if (!bindings.some((binding) => binding.HostPort === String(input.port))) {
    throw new IsolationError(`The dataset container does not publish 127.0.0.1:${String(input.port)}, the port the connection names`);
  }

  const systemIdentifier = dockerOutput(
    docker,
    ['exec', containerId, 'psql', '--no-psqlrc', '--username', PORTFOLIO_ROLES.admin, '--dbname', 'postgres', '--tuples-only', '--no-align', '--command', 'SELECT system_identifier FROM pg_control_system()'],
    'read the server identity inside the dataset container',
  );
  if (!/^\d{1,20}$/u.test(systemIdentifier)) throw new IsolationError('The dataset container reported no system identifier');
  return { containerId, project: PORTFOLIO_PROJECT, publishedPort: input.port, systemIdentifier };
}

// --- Connection identity ---------------------------------------------------------------------------------------------

export interface Queryable {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface ConnectedIdentity {
  clusterName: string;
  database: string;
  role: string;
  sessionRole: string;
  systemIdentifier: string;
}

export const connectedIdentitySql = `SELECT current_database() AS database,
       current_user AS role,
       session_user AS session_role,
       (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
       current_setting('cluster_name') AS cluster_name`;

/**
 * Asks the server behind `client` who and where it is, read-only, and refuses unless it is the expected database and
 * role on the proven container. Run before the first statement that changes anything.
 */
export async function verifyConnectedServer(
  client: Queryable,
  expected: { database: string; proof: OwnedServerProof; role: PortfolioRole },
  label: string,
): Promise<ConnectedIdentity> {
  const row = (
    await client.query<{ cluster_name: string; database: string; role: string; session_role: string; system_identifier: string }>(connectedIdentitySql)
  ).rows[0];
  if (!row) throw new IsolationError(`${label}: the server did not report its identity`);
  assertDatasetDatabaseName(row.database);
  const role = PORTFOLIO_ROLES[expected.role];
  if (row.database !== expected.database || row.role !== role || row.session_role !== role) {
    throw new IsolationError(
      `${label} reached database ${row.database} as ${row.role} (session ${row.session_role}), not ${expected.database} as ${role}`,
    );
  }
  if (row.system_identifier !== expected.proof.systemIdentifier) {
    throw new IsolationError(`${label} reached a PostgreSQL server that is not the dataset container (system identifiers differ)`);
  }
  if (row.cluster_name !== PORTFOLIO_CLUSTER_NAME) {
    throw new IsolationError(`${label} reached a server whose cluster_name is not ${PORTFOLIO_CLUSTER_NAME}`);
  }
  return { clusterName: row.cluster_name, database: row.database, role: row.role, sessionRole: row.session_role, systemIdentifier: row.system_identifier };
}
