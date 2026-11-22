import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnvironment } from '../config/environment.js';
import { IsolationError, PORTFOLIO_PROJECT, type DockerResult } from './isolation.js';
import { datasetPaths, ensureLocalEnvironment, readLocalEnvironment } from './local-environment.js';
import { assertIsolatedApiConfiguration, portfolioApiConfiguration, reduceToOperatingSystemEnvironment, runApi, webLaunch } from './serve-cli.js';

// Configuration-only probes of the portfolio launcher (finding 1 of the step-2 review). No real database is contacted:
// the "unintended target" is a test-owned decoy listener that counts connection attempts, and Docker is a fake.

const decoyUrl = (role: string, port: number) => `postgresql://${role}:decoy@127.0.0.1:${String(port)}/running_tracker`;

/** Everything an inherited shell or a developer's .env could carry to move the stack elsewhere or widen it. */
function poisonedVariables(decoyPort: number, directory: string): Record<string, string> {
  writeFileSync(join(directory, 'decoy-url'), decoyUrl('running_tracker_runtime', decoyPort));
  return {
    ALLOWED_ORIGINS: 'http://evil.example',
    API_HOST: '0.0.0.0',
    API_PROXY_TARGET: 'http://127.0.0.1:3000',
    APP_ENV: 'development',
    DATABASE_URL: decoyUrl('running_tracker_runtime', decoyPort),
    DATA_QUESTIONS_PROVIDER: 'fake',
    DELETION_JOURNAL_DIR: directory,
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
    MAINTENANCE_DATABASE_URL: decoyUrl('running_tracker_maintenance', decoyPort),
    MEAL_DRAFTS_PROVIDER: 'fake',
    METRICS_HOST: '0.0.0.0',
    METRICS_PORT: '9464',
    OIDC_CLIENT_ID: 'decoy',
    OIDC_CLIENT_SECRET: 'decoy-secret',
    OIDC_ISSUER_URL: 'http://127.0.0.1:9/realms/decoy',
    OIDC_REDIRECT_URI: 'http://evil.example/api/auth/callback',
    PGHOST: '127.0.0.1',
    PGOPTIONS: '-c role=running_tracker_owner',
    PGPORT: String(decoyPort),
    PORT: '3000',
    RUN_SEARCH_AI_ENABLED: 'true',
    RUN_SEARCH_AI_PROVIDER: 'fake',
    SESSION_COOKIE_SECURE: 'false',
    WEEKLY_INSIGHTS_PROVIDER: 'fake',
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'portfolio-serve-'));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

/** A listener standing in for a database or API the stack must never reach; it counts every connection. */
async function decoyListener(): Promise<{ connections: () => number; port: number }> {
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no decoy port');
  return { connections: () => connections, port: address.port };
}

/** A dataset environment in a temporary repository, plus a cwd whose ./.env and ../../.env are poisoned. */
function poisonedWorkspace(variables: Record<string, string>) {
  const root = temporaryDirectory();
  const paths = datasetPaths(root);
  ensureLocalEnvironment(paths, { randomBytes: (size) => Buffer.alloc(size, 7) });
  const dotenv = Object.entries(variables).map(([name, value]) => `${name}=${value}`).join('\n');
  const cwd = join(root, 'apps', 'api');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(root, '.env'), dotenv);
  writeFileSync(join(cwd, '.env'), dotenv);
  return { cwd, paths, root };
}

function withPoisonedProcess(variables: Record<string, string>, cwd: string): void {
  const saved = { ...process.env };
  const savedCwd = process.cwd();
  Object.assign(process.env, variables);
  process.chdir(cwd);
  cleanups.push(() => {
    process.chdir(savedCwd);
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
}

describe('portfolio API configuration under a poisoned environment', () => {
  it('the probe is real: the application loader, as the raw --env-file launch used it, accepts the decoy target', async () => {
    const decoy = await decoyListener();
    const directory = temporaryDirectory();
    const variables = poisonedVariables(decoy.port, directory);
    const { cwd } = poisonedWorkspace(variables);
    withPoisonedProcess(variables, cwd);
    const unsafe = loadEnvironment();
    expect(unsafe.DATABASE_URL).toBe(variables.DATABASE_URL);
    expect(unsafe.PORT).toBe(3000);
    expect(decoy.connections()).toBe(0);
  });

  it('ignores inherited variables and both .env files: the configuration is the dataset target, endpoints and identities only', async () => {
    const decoy = await decoyListener();
    const directory = temporaryDirectory();
    const variables = poisonedVariables(decoy.port, directory);
    const { cwd, paths } = poisonedWorkspace(variables);
    withPoisonedProcess({ ...variables, DATABASE_URL_FILE: join(directory, 'decoy-url') }, cwd);
    const config = portfolioApiConfiguration(paths);
    const local = readLocalEnvironment(paths);
    expect(config.DATABASE_URL).toBe(`postgresql://running_tracker_runtime:${local.passwords.runtime}@127.0.0.1:5442/somalane_portfolio_demo`);
    expect(config.MAINTENANCE_DATABASE_URL).toBe(`postgresql://running_tracker_maintenance:${local.passwords.maintenance}@127.0.0.1:5442/somalane_portfolio_demo`);
    expect(config).toMatchObject({
      ALLOWED_ORIGINS: ['http://127.0.0.1:5373'],
      API_HOST: '127.0.0.1',
      APP_ENV: 'development',
      LOCAL_AUTH_USER_IDS: ['dddddddd-dddd-4ddd-8ddd-dddddddd0001', 'dddddddd-dddd-4ddd-8ddd-dddddddd0002'],
      LIVE_TRACK_CURSOR_SIGNING_KEY: local.cursorSigningKey,
      PORT: 3300,
    });
    for (const key of ['OIDC', 'RUN_SEARCH_AI', 'WEEKLY_INSIGHTS', 'MEAL_DRAFTS', 'DATA_QUESTIONS', 'METRICS_PORT', 'DELETION_JOURNAL_DIR'] as const) expect(config[key]).toBeUndefined();
    expect(decoy.connections()).toBe(0);
  });

  it('refuses a configuration that is not the isolated one', () => {
    const base = { APP_ENV: 'development', DATABASE_URL: 'postgresql://running_tracker_runtime:x@127.0.0.1:5442/somalane_portfolio_demo', MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:x@127.0.0.1:5442/somalane_portfolio_demo' };
    const isolated = { ...base, ALLOWED_ORIGINS: 'http://127.0.0.1:5373', API_HOST: '127.0.0.1', LOCAL_AUTH_ENABLED: 'true', LOCAL_AUTH_USER_IDS: 'dddddddd-dddd-4ddd-8ddd-dddddddd0001,dddddddd-dddd-4ddd-8ddd-dddddddd0002', PORT: '3300' };
    const load = (overrides: Record<string, string>) => loadEnvironment({ environment: { ...isolated, ...overrides }, envFiles: [] });
    expect(() => assertIsolatedApiConfiguration(load({}))).not.toThrow();
    for (const [overrides, message] of [
      [{ METRICS_PORT: '9464' }, /no metrics listener/u],
      [{ API_HOST: '0.0.0.0' }, /listen on http:\/\/127\.0\.0\.1:3300 only/u],
      [{ ALLOWED_ORIGINS: 'http://127.0.0.1:5173' }, /only allowed origin/u],
      [{ LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111' }, /runner and coach and nobody else/u],
      [{ WEEKLY_INSIGHTS_PROVIDER: 'fake' }, /WEEKLY_INSIGHTS must be off/u],
    ] as const) {
      expect(() => assertIsolatedApiConfiguration(load(overrides))).toThrow(message);
    }
    // The application's loader already refuses URLs that disagree with each other; a configuration object is checked
    // on its own too.
    expect(() => assertIsolatedApiConfiguration({ ...load({}), DATABASE_URL: 'postgresql://running_tracker_runtime:x@127.0.0.1:5433/running_tracker' })).toThrow(/never a dataset target/u);
    expect(() =>
      assertIsolatedApiConfiguration({ ...load({}), MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:x@127.0.0.1:5442/somalane_portfolio_t_0123456789ab' }),
    ).toThrow(/one loopback endpoint/u);
  });

  it('refuses before connecting or starting when the generated settings point at another server', async () => {
    const decoy = await decoyListener();
    const { paths } = poisonedWorkspace({});
    const settings = JSON.parse(readFileSync(paths.settings, 'utf8')) as Record<string, unknown>;
    writeFileSync(paths.settings, JSON.stringify({ ...settings, databasePort: decoy.port }));
    const start = vi.fn(async () => Promise.resolve());
    const docker = (args: readonly string[]): DockerResult => {
      if (args[0] === 'ps') return { status: 0, stderr: '', stdout: `${'c'.repeat(64)}\n` };
      if (args[0] === 'inspect') {
        return {
          status: 0,
          stderr: '',
          stdout: `${JSON.stringify({ 'com.docker.compose.project': PORTFOLIO_PROJECT, 'com.docker.compose.project.config_files': 'infra/compose/docker-compose.portfolio-dataset.yml', 'com.docker.compose.service': 'postgres' })}\n${JSON.stringify({ '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5442' }] })}\n`,
        };
      }
      throw new Error(`unexpected docker ${args.join(' ')}`);
    };
    const environment: NodeJS.ProcessEnv = { DATABASE_URL: decoyUrl('running_tracker_runtime', decoy.port), Path: 'C:\\Windows', PGPORT: String(decoy.port) };
    await expect(runApi({ docker, environment, paths, print: () => undefined, start })).rejects.toThrow(
      new RegExp(`does not publish 127\\.0\\.0\\.1:${String(decoy.port)}`, 'u'),
    );
    await expect(runApi({ docker, environment, paths, print: () => undefined, start })).rejects.toBeInstanceOf(IsolationError);
    expect(start).not.toHaveBeenCalled();
    expect(decoy.connections()).toBe(0);
    expect(environment).toEqual({ Path: 'C:\\Windows' });
  });
});

describe('portfolio process environment', () => {
  it('reduces a poisoned process environment to operating-system variables, in place', () => {
    const environment: NodeJS.ProcessEnv = { ComSpec: 'cmd.exe', DATABASE_URL: 'x', MAINTENANCE_DATABASE_URL_FILE: 'y', NODE_OPTIONS: '--require z', PATH: '/bin', PGPASSWORD: 'p', npm_config_x: '1' };
    reduceToOperatingSystemEnvironment(environment);
    expect(environment).toEqual({ ComSpec: 'cmd.exe', PATH: '/bin' });
  });

  it('starts Vite on its loopback endpoint with the one proxy target, whatever the parent carries', () => {
    const launch = webLaunch({ API_PROXY_TARGET: 'http://127.0.0.1:3000', NODE_OPTIONS: '--require poison', PATH: '/bin', VITE_LOCAL_DEMO_ENABLED: 'false', VITE_MAPBOX_ACCESS_TOKEN: 'pk.decoy' });
    expect(launch.environment).toEqual({ API_PROXY_TARGET: 'http://127.0.0.1:3300', PATH: '/bin', VITE_LOCAL_DEMO_ENABLED: 'true', VITE_MAPBOX_ACCESS_TOKEN: '' });
    expect(launch.args.slice(1)).toEqual(['--host', '127.0.0.1', '--port', '5373', '--strictPort']);
    expect(launch.args[0]!.replaceAll('\\', '/')).toMatch(/\/node_modules\/vite\/bin\/vite\.js$/u);
    expect(launch.cwd.replaceAll('\\', '/')).toMatch(/\/apps\/web$/u);
  });
});
