import { spawnSync } from 'node:child_process';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

import { portfolioIdentities } from './dataset-plan.js';
import { PORTFOLIO_COMPOSE_FILE, PORTFOLIO_DATABASE, PORTFOLIO_PROJECT, PORTFOLIO_ROLES, type PortfolioRole } from './isolation.js';

// The dataset's local environment: everything it writes outside the database lives under .local/portfolio-dataset/
// (ignored by git). It never reads or writes .env, never reads DATABASE_URL or TEST_* variables, and only addresses its
// own Compose project.

export const DEFAULT_DATABASE_PORT = 5442;
export const PORTFOLIO_API_PORT = 3300;
export const PORTFOLIO_WEB_PORT = 5373;
export const PORTFOLIO_WEB_ORIGIN = `http://127.0.0.1:${String(PORTFOLIO_WEB_PORT)}`;
export const PORTFOLIO_API_ORIGIN = `http://127.0.0.1:${String(PORTFOLIO_API_PORT)}`;

export const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');

export interface DatasetPaths {
  composeEnv: string;
  directory: string;
  manifest: string;
  secrets: string;
  seedState: string;
  settings: string;
}

export function datasetPaths(root = repositoryRoot): DatasetPaths {
  const directory = join(root, '.local', 'portfolio-dataset');
  return {
    composeEnv: join(directory, 'compose.env'),
    directory,
    manifest: join(directory, 'manifest.json'),
    secrets: join(directory, 'secrets'),
    seedState: join(directory, 'seed-state.json'),
    settings: join(directory, 'settings.json'),
  };
}

const SECRET_FILES = ['postgres-password', 'owner-password', 'runtime-password', 'maintenance-password', 'cursor-signing-key'] as const;
type SecretFile = (typeof SECRET_FILES)[number];

export interface LocalEnvironment {
  databasePort: number;
  passwords: Record<PortfolioRole, string>;
  cursorSigningKey: string;
}

export function requirePort(value: unknown, label: string): number {
  const port = typeof value === 'number' ? value : /^\d{1,5}$/u.test(String(value)) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new RangeError(`${label} must be an integer from 1024 to 65535`);
  return port;
}

const posixPath = (path: string) => path.replaceAll('\\', '/');

/**
 * Creates the settings and the secret set on first use (random 256-bit passwords, never reused elsewhere), or reads
 * them back. A port given later must match the stored one: the volume's server is published there.
 */
export function ensureLocalEnvironment(
  paths: DatasetPaths,
  options: { port?: number | undefined; randomBytes?: (size: number) => Buffer } = {},
): { created: boolean; environment: LocalEnvironment } {
  const random = options.randomBytes ?? cryptoRandomBytes;
  mkdirSync(paths.directory, { recursive: true });
  let created = false;
  let databasePort: number;
  if (existsSync(paths.settings)) {
    databasePort = readSettings(paths).databasePort;
    if (options.port !== undefined && options.port !== databasePort) {
      throw new Error(
        `The dataset environment is already configured for port ${String(databasePort)} (${paths.settings}); --port ${String(options.port)} ` +
          'differs. Keep the stored port, or stop the dataset container and remove that file to choose another.',
      );
    }
  } else {
    databasePort = options.port ?? DEFAULT_DATABASE_PORT;
    writeFileSync(paths.settings, `${JSON.stringify({ databasePort, project: PORTFOLIO_PROJECT }, null, 2)}\n`);
    created = true;
  }
  const present = SECRET_FILES.filter((name) => existsSync(join(paths.secrets, name)));
  if (present.length === 0) {
    mkdirSync(paths.secrets, { mode: 0o700, recursive: true });
    for (const name of SECRET_FILES) {
      const value = name === 'cursor-signing-key' ? random(32).toString('base64url') : random(32).toString('hex');
      const path = join(paths.secrets, name);
      writeFileSync(path, `${value}\n`, { mode: 0o600 });
      // The PostgreSQL container reads the admin password file as another user (a bind-mounted Compose secret).
      chmodSync(path, name === 'postgres-password' ? 0o444 : 0o600);
    }
    created = true;
  } else if (present.length !== SECRET_FILES.length) {
    throw new Error(`${paths.secrets} holds an incomplete secret set (${present.join(', ')}); restore it or remove the dataset volume and the directory`);
  }
  writeFileSync(
    paths.composeEnv,
    [
      '# Written by npm run portfolio:dataset. Local to this computer; git ignores .local/.',
      `PORTFOLIO_DATASET_PORT=${String(databasePort)}`,
      `PORTFOLIO_DATASET_SECRETS_DIR=${posixPath(paths.secrets)}`,
      '',
    ].join('\n'),
  );
  return { created, environment: readLocalEnvironment(paths) };
}

function readSettings(paths: DatasetPaths): { databasePort: number } {
  const parsed = JSON.parse(readFileSync(paths.settings, 'utf8')) as { databasePort?: unknown; project?: unknown };
  if (parsed.project !== PORTFOLIO_PROJECT) throw new Error(`${paths.settings} does not belong to ${PORTFOLIO_PROJECT}`);
  return { databasePort: requirePort(parsed.databasePort, 'databasePort') };
}

export function readLocalEnvironment(paths: DatasetPaths): LocalEnvironment {
  if (!existsSync(paths.settings)) throw new Error('No dataset environment yet: run npm run portfolio:dataset first');
  const secret = (name: SecretFile) => {
    const value = readFileSync(join(paths.secrets, name), 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(value)) throw new Error(`${name} in ${paths.secrets} is not a generated secret`);
    return value;
  };
  return {
    cursorSigningKey: secret('cursor-signing-key'),
    databasePort: readSettings(paths).databasePort,
    passwords: {
      admin: secret('postgres-password'),
      maintenance: secret('maintenance-password'),
      owner: secret('owner-password'),
      runtime: secret('runtime-password'),
    },
  };
}

/** The four loopback URLs of one database on the owned server. Passwords are hex, so they need no escaping. */
export function databaseUrls(environment: LocalEnvironment, database = PORTFOLIO_DATABASE): Record<PortfolioRole, string> {
  const url = (role: PortfolioRole) =>
    `postgresql://${PORTFOLIO_ROLES[role]}:${environment.passwords[role]}@127.0.0.1:${String(environment.databasePort)}/${database}`;
  return { admin: url('admin'), maintenance: url('maintenance'), owner: url('owner'), runtime: url('runtime') };
}

/** `role@127.0.0.1:port/database`, never a password. */
export function describeUrl(connectionString: string): string {
  const url = new URL(connectionString);
  return `${decodeURIComponent(url.username)}@${url.hostname}:${url.port}/${decodeURIComponent(url.pathname.slice(1))}`;
}

export function composeArguments(paths: DatasetPaths): string[] {
  return ['compose', '--project-name', PORTFOLIO_PROJECT, '--file', PORTFOLIO_COMPOSE_FILE, '--env-file', paths.composeEnv];
}

/** Resolves when 127.0.0.1:port can be bound (nothing listens there); never touches whoever holds it. */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen({ exclusive: true, host: '127.0.0.1', port }, () => server.close(() => resolvePromise(true)));
  });
}

/**
 * The COMPLETE configuration source of the API on the isolated stack, built from the dataset's own settings and
 * secrets. It is handed to loadEnvironment as its only source (no inherited variable, no .env file), so anything not
 * named here takes the application's default: no OIDC, no metrics listener, no deletion-journal directory, no *_FILE
 * secret, and every AI provider at its default `off` (stated explicitly here as well).
 */
export function portfolioApiSettings(environment: LocalEnvironment): Record<string, string> {
  const urls = databaseUrls(environment);
  return {
    ALLOWED_ORIGINS: PORTFOLIO_WEB_ORIGIN,
    API_HOST: '127.0.0.1',
    APP_ENV: 'development',
    DATABASE_URL: urls.runtime,
    DATA_QUESTIONS_PROVIDER: 'off',
    LIVE_TRACK_CURSOR_SIGNING_KEY: environment.cursorSigningKey,
    LOCAL_AUTH_ENABLED: 'true',
    LOCAL_AUTH_USER_IDS: `${portfolioIdentities.runner},${portfolioIdentities.coach}`,
    MAINTENANCE_DATABASE_URL: urls.maintenance,
    MEAL_DRAFTS_PROVIDER: 'off',
    PORT: String(PORTFOLIO_API_PORT),
    RUN_SEARCH_AI_ENABLED: 'false',
    SESSION_COOKIE_SECURE: 'false',
    WEEKLY_INSIGHTS_PROVIDER: 'off',
  };
}

/**
 * The variables the web app's Vite process gets on top of the operating-system ones: the one proxy target (the
 * isolated API), the demo sign-in buttons, and no Mapbox token (no external map request from the isolated stack).
 * Vite never lets a .env file override a variable that is already set.
 */
export function portfolioWebSettings(): Record<string, string> {
  return { API_PROXY_TARGET: PORTFOLIO_API_ORIGIN, VITE_LOCAL_DEMO_ENABLED: 'true', VITE_MAPBOX_ACCESS_TOKEN: '' };
}

/**
 * Operating-system variables a launched process needs (paths, temporary directories, user profile, locale, terminal),
 * and nothing else: no application setting, database target, PG* default, proxy, NODE_OPTIONS or provider key can be
 * inherited through this filter. Names are compared case-insensitively, as Windows does.
 */
const OPERATING_SYSTEM_VARIABLES = new Set(
  [
    'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'COMPUTERNAME', 'COMSPEC', 'HOME', 'HOMEDRIVE',
    'HOMEPATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'LOGNAME', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT',
    'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SHELL', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'TEMP', 'TERM', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'USERPROFILE', 'WINDIR',
  ],
);

export function operatingSystemEnvironment(parent: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parent).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && OPERATING_SYSTEM_VARIABLES.has(entry[0].toUpperCase())),
  );
}

/** Variables a child script must never inherit: the normal and shared-test targets, and any pg default. */
const INHERITED_TARGET_VARIABLES = /^(?:(?:TEST_)?(?:BOOTSTRAP_|MIGRATION_|MAINTENANCE_)?DATABASE_URL(?:_FILE)?|PG[A-Z]+|LOAD_[A-Z_]*DATABASE_URL|RESTORE_DRILL_[A-Z_]+)$/u;

/**
 * The environment of a bootstrap or migration child: the parent's variables without any database target or PG* default,
 * plus exactly the four URLs of one database of the owned server. Explicit variables win over .env in those scripts
 * (process.loadEnvFile never overrides a set variable), so .env cannot redirect them.
 */
export function databaseScriptEnvironment(parent: NodeJS.ProcessEnv, urls: Record<PortfolioRole, string>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(parent).filter(([name]) => !INHERITED_TARGET_VARIABLES.test(name))),
    APP_ENV: 'development',
    BOOTSTRAP_DATABASE_URL: urls.admin,
    DATABASE_URL: urls.runtime,
    MAINTENANCE_DATABASE_URL: urls.maintenance,
    MIGRATION_DATABASE_URL: urls.owner,
  };
}

/** Runs scripts/bootstrap-database.mjs or scripts/migrate.mjs against one database of the owned server. */
export function runDatabaseScript(script: 'bootstrap-database.mjs' | 'migrate.mjs', urls: Record<PortfolioRole, string>, root = repositoryRoot): string {
  const environment = databaseScriptEnvironment(process.env, urls);
  const result = spawnSync(process.execPath, [join('scripts', script)], { cwd: root, encoding: 'utf8', env: environment, timeout: 180_000, windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`${script} failed (${result.error?.message ?? `exit ${String(result.status)}`}):\n${output.trim()}`);
  }
  return output;
}
