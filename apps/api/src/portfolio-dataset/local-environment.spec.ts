import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parsePrepareArguments } from './prepare-cli.js';
import {
  databaseScriptEnvironment,
  databaseUrls,
  datasetPaths,
  describeUrl,
  ensureLocalEnvironment,
  operatingSystemEnvironment,
  portfolioApiSettings,
  portfolioWebSettings,
} from './local-environment.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'portfolio-dataset-'));
  directories.push(directory);
  return directory;
}

let counter = 0;
const fakeRandom = (size: number) => Buffer.alloc(size, (counter += 1));

describe('local dataset environment', () => {
  it('creates the settings and a complete random secret set once, under .local/portfolio-dataset', () => {
    const paths = datasetPaths(temporaryRoot());
    const first = ensureLocalEnvironment(paths, { randomBytes: fakeRandom });
    expect(first.created).toBe(true);
    expect(first.environment.databasePort).toBe(5442);
    expect(paths.directory.replaceAll('\\', '/')).toMatch(/\/\.local\/portfolio-dataset$/u);
    expect(new Set(Object.values(first.environment.passwords)).size).toBe(4);
    const second = ensureLocalEnvironment(paths, { randomBytes: fakeRandom });
    expect(second).toEqual({ created: false, environment: first.environment });
    expect(readFileSync(paths.composeEnv, 'utf8')).toMatch(/^PORTFOLIO_DATASET_PORT=5442$/mu);
  });

  it('keeps the first port and refuses a different one later', () => {
    const paths = datasetPaths(temporaryRoot());
    ensureLocalEnvironment(paths, { port: 55_432, randomBytes: fakeRandom });
    expect(ensureLocalEnvironment(paths, { port: 55_432 }).environment.databasePort).toBe(55_432);
    expect(() => ensureLocalEnvironment(paths, { port: 5442 })).toThrow(/already configured for port 55432/u);
  });

  it('refuses an incomplete secret set instead of regenerating credentials', () => {
    const paths = datasetPaths(temporaryRoot());
    ensureLocalEnvironment(paths, { randomBytes: fakeRandom });
    rmSync(join(paths.secrets, 'runtime-password'));
    expect(() => ensureLocalEnvironment(paths)).toThrow(/incomplete secret set/u);
  });

  it('builds loopback URLs of one database and describes them without the password', () => {
    const paths = datasetPaths(temporaryRoot());
    const { environment } = ensureLocalEnvironment(paths, { randomBytes: fakeRandom });
    const urls = databaseUrls(environment, 'somalane_portfolio_t_0123456789ab');
    expect(describeUrl(urls.owner)).toBe('running_tracker_owner@127.0.0.1:5442/somalane_portfolio_t_0123456789ab');
    expect(describeUrl(urls.admin)).not.toContain(environment.passwords.admin);
    for (const value of Object.values(urls)) expect(new URL(value).hostname).toBe('127.0.0.1');
  });

  it('gives bootstrap and migration children only the dataset target, never an inherited one', () => {
    const paths = datasetPaths(temporaryRoot());
    const { environment } = ensureLocalEnvironment(paths, { randomBytes: fakeRandom });
    const urls = databaseUrls(environment);
    const child = databaseScriptEnvironment(
      {
        DATABASE_URL_FILE: '/run/secrets/x',
        LOAD_DATABASE_URL: 'postgresql://x@127.0.0.1:5433/running_tracker_load_test',
        PATH: '/usr/bin',
        PGHOST: 'elsewhere',
        PGOPTIONS: '-c role=postgres',
        TEST_BOOTSTRAP_DATABASE_URL: 'postgresql://x@127.0.0.1:5433/running_tracker_test',
        TEST_DATABASE_URL: 'postgresql://x@127.0.0.1:5433/running_tracker_test',
      },
      urls,
    );
    expect(child).toEqual({
      APP_ENV: 'development',
      BOOTSTRAP_DATABASE_URL: urls.admin,
      DATABASE_URL: urls.runtime,
      MAINTENANCE_DATABASE_URL: urls.maintenance,
      MIGRATION_DATABASE_URL: urls.owner,
      PATH: '/usr/bin',
    });
  });

  it('builds app settings that keep the stack local, the demo identities only, and every AI provider off', () => {
    const paths = datasetPaths(temporaryRoot());
    const { environment } = ensureLocalEnvironment(paths, { randomBytes: fakeRandom });
    const api = portfolioApiSettings(environment);
    expect(api).toMatchObject({
      ALLOWED_ORIGINS: 'http://127.0.0.1:5373',
      API_HOST: '127.0.0.1',
      APP_ENV: 'development',
      DATA_QUESTIONS_PROVIDER: 'off',
      LOCAL_AUTH_USER_IDS: 'dddddddd-dddd-4ddd-8ddd-dddddddd0001,dddddddd-dddd-4ddd-8ddd-dddddddd0002',
      MEAL_DRAFTS_PROVIDER: 'off',
      PORT: '3300',
      RUN_SEARCH_AI_ENABLED: 'false',
      WEEKLY_INSIGHTS_PROVIDER: 'off',
    });
    expect(api.DATABASE_URL).toMatch(/^postgresql:\/\/running_tracker_runtime:[0-9a-f]+@127\.0\.0\.1:5442\/somalane_portfolio_demo$/u);
    expect(JSON.stringify(api)).not.toMatch(/TEST_|_FILE|OIDC|METRICS|DELETION_JOURNAL|running_tracker_test|:5433\//u);
    expect(portfolioWebSettings()).toEqual({ API_PROXY_TARGET: 'http://127.0.0.1:3300', VITE_LOCAL_DEMO_ENABLED: 'true', VITE_MAPBOX_ACCESS_TOKEN: '' });
    // Nothing is written for the app: no env file with credentials exists to be launched in the unsafe way.
    expect(existsSync(join(paths.directory, 'api.env'))).toBe(false);
  });

  it('keeps only operating-system variables, whatever their case', () => {
    expect(
      operatingSystemEnvironment({
        API_PROXY_TARGET: 'http://127.0.0.1:3000',
        DATABASE_URL: 'postgresql://x@127.0.0.1:5433/running_tracker',
        NODE_OPTIONS: '--require ./poison.js',
        OIDC_ISSUER_URL: 'https://idp.example',
        Path: 'C:\\Windows',
        PGOPTIONS: '-c role=postgres',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        VITE_MAPBOX_ACCESS_TOKEN: 'pk.x',
      }),
    ).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' });
  });
});

describe('portfolio:dataset arguments', () => {
  it('parses the seed, the anchor and the first-run port', () => {
    expect(parsePrepareArguments([])).toEqual({});
    expect(parsePrepareArguments(['--seed', 'demo-2', '--anchor', '2026-11-01', '--port', '55432'])).toEqual({ anchorDate: '2026-11-01', port: 55_432, seed: 'demo-2' });
    expect(parsePrepareArguments(['--help'])).toBe('help');
  });

  it.each([
    [['--database-url', 'postgresql://x@127.0.0.1/running_tracker'], /Unknown argument --database-url/u],
    [['--force'], /Unknown argument --force/u],
    [['--seed'], /--seed needs a value/u],
    [['--seed', 'a', '--seed', 'b'], /given twice/u],
    [['--port', '80'], /1024 to 65535/u],
  ])('refuses %j', (argv, message) => {
    expect(() => parsePrepareArguments(argv)).toThrow(message);
  });
});
