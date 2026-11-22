import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { datasetPaths, readLocalEnvironment, repositoryRoot } from '../../src/portfolio-dataset/local-environment.js';

// Finding 1 of the step-2 review, end to end: the REAL launcher (`npm run portfolio:dataset:api` / `:web`) started from
// a poisoned parent. Every inherited setting and both .env files that the API's loader would read from this working
// directory point somewhere else: a test-owned decoy "database" (a TCP listener that counts connections), a decoy API
// (an HTTP listener that counts requests), other ports, origins, identities, OIDC, metrics, a journal directory and
// fake AI providers. The stack must come up on the isolated portfolio database and endpoints anyway, and never touch a
// decoy. It reads the existing demo dataset only (a sign-in writes one session row); nothing else is written.

const origin = 'http://127.0.0.1:5373';
const apiOrigin = 'http://127.0.0.1:3300';
const manifest = JSON.parse(readFileSync(datasetPaths().manifest, 'utf8')) as {
  expected: { today: { checkIn: { weightKg: number } } };
  parameters: { anchorDate: string; timeZone: string };
};
const organization = 'dddddddd-dddd-4ddd-8ddd-dddddddd0000';
const runner = 'dddddddd-dddd-4ddd-8ddd-dddddddd0001';

interface Decoys {
  apiRequests: () => number;
  apiPort: number;
  databaseConnections: () => number;
  databasePort: number;
  freePorts: number[];
}

const servers: Array<{ close: () => void }> = [];
const children: ChildProcess[] = [];
let workspace = '';

async function listening(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function decoys(): Promise<Decoys> {
  let databaseConnections = 0;
  let apiRequests = 0;
  const databasePort = await listening(
    createServer((socket) => {
      databaseConnections += 1;
      socket.destroy();
    }),
  );
  const apiPort = await listening(
    createHttpServer((_request, response) => {
      apiRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"decoy":true}');
    }),
  );
  return { apiPort, apiRequests: () => apiRequests, databaseConnections: () => databaseConnections, databasePort, freePorts: [await freePort(), await freePort()] };
}

function poisoned(decoy: Decoys, journal: string): Record<string, string> {
  const database = (role: string) => `postgresql://${role}:decoy@127.0.0.1:${String(decoy.databasePort)}/running_tracker`;
  return {
    ALLOWED_ORIGINS: 'http://evil.example',
    API_HOST: '0.0.0.0',
    API_PROXY_TARGET: `http://127.0.0.1:${String(decoy.apiPort)}`,
    APP_ENV: 'development',
    DATABASE_URL: database('running_tracker_runtime'),
    DATA_QUESTIONS_PROVIDER: 'fake',
    DELETION_JOURNAL_DIR: journal,
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: '11111111-1111-4111-8111-111111111111',
    MAINTENANCE_DATABASE_URL: database('running_tracker_maintenance'),
    MEAL_DRAFTS_PROVIDER: 'fake',
    METRICS_HOST: '127.0.0.1',
    METRICS_PORT: String(decoy.freePorts[1]),
    OIDC_CLIENT_ID: 'decoy',
    OIDC_CLIENT_SECRET: 'decoy-secret',
    OIDC_ISSUER_URL: `http://127.0.0.1:${String(decoy.apiPort)}/oidc`,
    OIDC_REDIRECT_URI: 'http://evil.example/api/auth/callback',
    PGHOST: '127.0.0.1',
    PGOPTIONS: '-c role=running_tracker_owner',
    PGPORT: String(decoy.databasePort),
    PORT: String(decoy.freePorts[0]),
    RUN_SEARCH_AI_ENABLED: 'true',
    RUN_SEARCH_AI_PROVIDER: 'fake',
    SESSION_COOKIE_SECURE: 'true',
    VITE_LOCAL_DEMO_ENABLED: 'false',
    WEEKLY_INSIGHTS_PROVIDER: 'fake',
  };
}

function launch(target: 'api' | 'web', environment: NodeJS.ProcessEnv, cwd: string): { child: ChildProcess; output: () => string } {
  const loader = pathToFileURL(join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', loader, join(repositoryRoot, 'apps', 'api', 'src', 'portfolio-dataset', 'serve-main.ts'), target], {
    cwd,
    detached: process.platform !== 'win32',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  return { child, output: () => output };
}

function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else process.kill(-child.pid, 'SIGKILL');
}

async function waitFor(url: string, child: ChildProcess, output: () => string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the launcher exited (${String(child.exitCode)}):\n${output()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not answer in time:\n${output()}`);
}

function refusesConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

describe('portfolio stack started from a poisoned parent environment', () => {
  let decoy: Decoys;
  let api: ReturnType<typeof launch>;
  let web: ReturnType<typeof launch>;

  beforeAll(async () => {
    decoy = await decoys();
    workspace = mkdtempSync(join(tmpdir(), 'portfolio-poisoned-'));
    const journal = join(workspace, 'journal');
    mkdirSync(journal);
    const variables = poisoned(decoy, journal);
    // The API's loader reads ./.env and ../../.env from its working directory: both are poisoned here.
    const cwd = join(workspace, 'apps', 'api');
    mkdirSync(cwd, { recursive: true });
    const dotenv = Object.entries(variables).map(([name, value]) => `${name}=${value}`).join('\n');
    writeFileSync(join(workspace, '.env'), dotenv);
    writeFileSync(join(cwd, '.env'), dotenv);
    const environment = { ...process.env, ...variables };
    api = launch('api', environment, cwd);
    await waitFor(`${apiOrigin}/api/health/ready`, api.child, api.output);
    web = launch('web', environment, cwd);
    await waitFor(origin, web.child, web.output);
  });

  afterAll(() => {
    for (const child of children) stopTree(child);
    for (const server of servers) server.close();
    if (workspace !== '') rmSync(workspace, { force: true, recursive: true });
  });

  it('the API verified and uses the owned portfolio database, and never contacted the decoy', () => {
    expect(api.output()).toContain('portfolio API: verified running_tracker_runtime@127.0.0.1:5442/somalane_portfolio_demo and running_tracker_maintenance@127.0.0.1:5442/somalane_portfolio_demo');
    expect(api.output()).toMatch(/owned server: container [0-9a-f]{12} of somalane-portfolio-dataset, database somalane_portfolio_demo/u);
    const secrets = readLocalEnvironment(datasetPaths());
    for (const secret of [...Object.values(secrets.passwords), secrets.cursorSigningKey]) expect(api.output()).not.toContain(secret);
    expect(decoy.databaseConnections()).toBe(0);
  });

  it('serves the dataset to the synthetic runner, with the isolated origin and identities only', async () => {
    const signIn = (userId: string, from: string) =>
      fetch(`${apiOrigin}/api/session`, { body: JSON.stringify({ userId }), headers: { 'content-type': 'application/json', origin: from }, method: 'POST' });
    expect((await signIn(runner, 'http://evil.example')).status).toBe(403);
    expect((await signIn('11111111-1111-4111-8111-111111111111', origin)).status).toBe(403);
    const session = await signIn(runner, origin);
    expect(session.status).toBe(201);
    // Not Secure: SESSION_COOKIE_SECURE=true from the parent did not apply.
    expect(session.headers.get('set-cookie')).not.toMatch(/;\s*secure/iu);
    const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]!;
    const { anchorDate, timeZone } = manifest.parameters;
    const today = await fetch(`${apiOrigin}/api/orgs/${organization}/daily-overview/${anchorDate}?timeZone=${encodeURIComponent(timeZone)}`, { headers: { cookie } });
    expect(today.status).toBe(200);
    expect(((await today.json()) as { checkIn: { weightKg: number } }).checkIn.weightKg).toBe(manifest.expected.today.checkIn.weightKg);
    // OIDC from the parent is not configured.
    expect((await fetch(`${apiOrigin}/api/auth/login`, { redirect: 'manual' })).status).toBe(404);
  });

  it('listens on its dedicated loopback endpoints only: not the inherited API or metrics ports', async () => {
    expect(await refusesConnection(decoy.freePorts[0]!)).toBe(true);
    expect(await refusesConnection(decoy.freePorts[1]!)).toBe(true);
  });

  it('the web app proxies to the isolated API, never to the inherited proxy target', async () => {
    const ready = await fetch(`${origin}/api/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.text()).not.toContain('decoy');
    expect(web.output()).toContain('proxying /api only to http://127.0.0.1:3300');
    expect(decoy.apiRequests()).toBe(0);
    expect(decoy.databaseConnections()).toBe(0);
  });
});
