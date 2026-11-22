import { describe, expect, it } from 'vitest';

import {
  assertDatasetDatabaseName,
  assertNotProduction,
  IsolationError,
  PORTFOLIO_CLUSTER_NAME,
  PORTFOLIO_PROJECT,
  proveOwnedServer,
  validateTargetUrl,
  validateTargetUrls,
  verifyConnectedServer,
  type DockerResult,
  type OwnedServerProof,
  type Queryable,
} from './isolation.js';

const password = 'a'.repeat(64);
const url = (user: string, database: string, host = '127.0.0.1', port = 5442, query = '') =>
  `postgresql://${user}:${password}@${host}:${String(port)}/${database}${query}`;
const ownerUrl = (database = 'somalane_portfolio_demo', host?: string, port?: number, query?: string) => url('running_tracker_owner', database, host, port, query);

describe('dataset target names', () => {
  it.each(['running_tracker', 'running_tracker_test'])('refuses %s unconditionally', (database) => {
    expect(() => assertDatasetDatabaseName(database)).toThrow(IsolationError);
    expect(() => assertDatasetDatabaseName(database)).toThrow(/never a dataset target, and no option overrides that/u);
    expect(() => validateTargetUrl(ownerUrl(database), 'owner', 'owner URL')).toThrow(/never a dataset target/u);
  });

  it.each(['running_tracker_load_test', 'running_tracker_lan_pilot', 'postgres', 'somalane_portfolio_t_123', 'somalane_portfolio_t_ABCDEF123456', 'somalane_portfolio_demo2'])(
    'refuses %s, which is not a dataset database',
    (database) => expect(() => assertDatasetDatabaseName(database)).toThrow(/only somalane_portfolio_demo/u),
  );

  it('accepts the dataset database and a throwaway test database', () => {
    expect(assertDatasetDatabaseName('somalane_portfolio_demo')).toBe('somalane_portfolio_demo');
    expect(assertDatasetDatabaseName('somalane_portfolio_t_0123456789ab')).toBe('somalane_portfolio_t_0123456789ab');
  });

  it('refuses APP_ENV=production only', () => {
    expect(() => assertNotProduction({ APP_ENV: 'production' })).toThrow(/APP_ENV=production/u);
    expect(() => assertNotProduction({ APP_ENV: 'development' })).not.toThrow();
    expect(() => assertNotProduction({})).not.toThrow();
  });
});

describe('dataset connection URLs', () => {
  it.each(['user', 'host', 'port', 'database', 'dbname'])('refuses a %s override in the query (the API parser)', (name) => {
    expect(() => validateTargetUrl(ownerUrl(undefined, undefined, undefined, `?${name}=running_tracker`), 'owner', 'owner URL')).toThrow(
      /must not override connection identity in query parameters/u,
    );
  });

  it('refuses any other query parameter too', () => {
    expect(() => validateTargetUrl(ownerUrl(undefined, undefined, undefined, '?options=-c%20role%3Dpostgres'), 'owner', 'owner URL')).toThrow(/query parameters/u);
  });

  it.each(['localhost', '10.0.0.5', 'db.example.com', '[::1]', '0.0.0.0'])('refuses the host %s: only 127.0.0.1', (host) => {
    expect(() => validateTargetUrl(ownerUrl(undefined, host), 'owner', 'owner URL')).toThrow(/must connect to 127\.0\.0\.1/u);
  });

  it('refuses a URL for another role than the one it is used as', () => {
    expect(() => validateTargetUrl(url('running_tracker_runtime', 'somalane_portfolio_demo'), 'owner', 'owner URL')).toThrow(/must authenticate as running_tracker_owner/u);
    expect(() => validateTargetUrl(url('somalane_portfolio_admin', 'somalane_portfolio_demo'), 'runtime', 'runtime URL')).toThrow(/running_tracker_runtime/u);
  });

  it('requires every URL of one target to name the same endpoint and database', () => {
    expect(
      validateTargetUrls({ maintenance: url('running_tracker_maintenance', 'somalane_portfolio_demo'), owner: ownerUrl(), runtime: url('running_tracker_runtime', 'somalane_portfolio_demo') }),
    ).toEqual({ database: 'somalane_portfolio_demo', port: 5442 });
    expect(() => validateTargetUrls({ owner: ownerUrl(), runtime: url('running_tracker_runtime', 'somalane_portfolio_demo', '127.0.0.1', 5443) })).toThrow(/same loopback endpoint/u);
    expect(() => validateTargetUrls({ owner: ownerUrl(), runtime: url('running_tracker_runtime', 'somalane_portfolio_t_0123456789ab') })).toThrow(/same loopback endpoint/u);
  });
});

const containerId = 'c'.repeat(64);
const labels = {
  'com.docker.compose.project': PORTFOLIO_PROJECT,
  'com.docker.compose.project.config_files': 'C:\\repo\\infra\\compose\\docker-compose.portfolio-dataset.yml',
  'com.docker.compose.service': 'postgres',
};
const ports = { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5442' }] };

function fakeDocker(overrides: { ids?: string; labels?: unknown; ports?: unknown; systemIdentifier?: string; fail?: 'ps' } = {}) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): DockerResult => {
    calls.push([...args]);
    const ok = (stdout: string): DockerResult => ({ status: 0, stderr: '', stdout });
    if (args[0] === 'ps') return overrides.fail === 'ps' ? { status: 1, stderr: 'Cannot connect to the Docker daemon', stdout: '' } : ok(overrides.ids ?? `${containerId}\n`);
    if (args[0] === 'inspect') return ok(`${JSON.stringify(overrides.labels ?? labels)}\n${JSON.stringify(overrides.ports ?? ports)}\n`);
    if (args[0] === 'exec') return ok(`${overrides.systemIdentifier ?? '7441223344556677889'}\n`);
    throw new Error(`unexpected docker call ${args.join(' ')}`);
  };
  return { calls, run };
}

describe('owned container proof', () => {
  it('proves the running project container, its loopback port and its system identifier', () => {
    const docker = fakeDocker();
    expect(proveOwnedServer({ docker: docker.run, port: 5442 })).toEqual({ containerId, project: PORTFOLIO_PROJECT, publishedPort: 5442, systemIdentifier: '7441223344556677889' });
    expect(docker.calls[0]).toEqual(expect.arrayContaining([`label=com.docker.compose.project=${PORTFOLIO_PROJECT}`, 'label=com.docker.compose.service=postgres']));
    expect(docker.calls[2]).toEqual(expect.arrayContaining(['exec', containerId, 'psql']));
  });

  it.each([
    ['no running container', { ids: '' }, /is not running/u],
    ['two containers', { ids: `${containerId}\n${'d'.repeat(64)}\n` }, /More than one/u],
    ['Docker unavailable', { fail: 'ps' as const }, /Docker daemon/u],
    ['another project', { labels: { ...labels, 'com.docker.compose.project': 'running-tracker' } }, /project labels/u],
    ['another compose file', { labels: { ...labels, 'com.docker.compose.project.config_files': 'infra/compose/docker-compose.yml' } }, /was not started from/u],
    ['published on every interface', { ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5442' }] } }, /only on 127\.0\.0\.1/u],
    ['another published port', { ports: { ...ports, '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } }, /only PostgreSQL/u],
    ['not the port the URL names', { ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5433' }] } }, /does not publish 127\.0\.0\.1:5442/u],
    ['no system identifier', { systemIdentifier: '' }, /no system identifier/u],
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => proveOwnedServer({ docker: fakeDocker(overrides).run, port: 5442 })).toThrow(message);
  });
});

const proof: OwnedServerProof = { containerId, project: PORTFOLIO_PROJECT, publishedPort: 5442, systemIdentifier: '7441223344556677889' };

function server(row: Partial<{ cluster_name: string; database: string; role: string; session_role: string; system_identifier: string }>): Queryable & { statements: string[] } {
  const statements: string[] = [];
  return {
    async query<Row>(text: string) {
      statements.push(text);
      return Promise.resolve({
        rows: [
          {
            cluster_name: PORTFOLIO_CLUSTER_NAME,
            database: 'somalane_portfolio_demo',
            role: 'running_tracker_owner',
            session_role: 'running_tracker_owner',
            system_identifier: proof.systemIdentifier,
            ...row,
          } as Row,
        ],
      });
    },
    statements,
  };
}

describe('connected server identity', () => {
  const expected = { database: 'somalane_portfolio_demo', proof, role: 'owner' as const };

  it('accepts the expected database and role on the proven server, with one read-only statement', async () => {
    const client = server({});
    await expect(verifyConnectedServer(client, expected, 'owner URL')).resolves.toMatchObject({ database: 'somalane_portfolio_demo', role: 'running_tracker_owner' });
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]).toMatch(/^SELECT /u);
  });

  it.each([
    ['the development database', { database: 'running_tracker' }, /never a dataset target/u],
    ['the shared test database', { database: 'running_tracker_test' }, /never a dataset target/u],
    ['another dataset database', { database: 'somalane_portfolio_t_0123456789ab' }, /not somalane_portfolio_demo as running_tracker_owner/u],
    ['another role', { role: 'running_tracker_runtime', session_role: 'running_tracker_runtime' }, /as running_tracker_runtime/u],
    ['a role switched after login', { session_role: 'somalane_portfolio_admin' }, /session somalane_portfolio_admin/u],
    ['another server (Docker NAT cannot hide it)', { system_identifier: '1234' }, /system identifiers differ/u],
    ['another cluster name', { cluster_name: '' }, /cluster_name/u],
  ])('refuses %s', async (_name, row, message) => {
    await expect(verifyConnectedServer(server(row), expected, 'owner URL')).rejects.toThrow(message);
  });
});
