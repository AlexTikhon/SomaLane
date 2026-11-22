import { randomBytes } from 'node:crypto';

import pg from 'pg';

import {
  PORTFOLIO_DATABASE,
  proveOwnedServer,
  THROWAWAY_DATABASE_PATTERN,
  validateTargetUrl,
  verifyConnectedServer,
  type OwnedServerProof,
  type PortfolioRole,
} from '../../src/portfolio-dataset/isolation.js';
import { databaseUrls, datasetPaths, readLocalEnvironment, runDatabaseScript } from '../../src/portfolio-dataset/local-environment.js';

// Throwaway databases for the dataset's own tests: created INSIDE the isolated dataset server (never the development
// server, never running_tracker_test), named somalane_portfolio_t_<12 hex>, bootstrapped and migrated with the existing
// scripts, and dropped by name only if this process created them. Needs `npm run portfolio:dataset` to have prepared
// the environment once (docs/runbooks/portfolio-dataset.md).

const created = new Set<string>();

export interface ThrowawayDatabase {
  name: string;
  proof: OwnedServerProof;
  urls: Record<PortfolioRole, string>;
}

async function withVerifiedAdmin<Result>(callback: (client: pg.Client, proof: OwnedServerProof) => Promise<Result>): Promise<Result> {
  const environment = readLocalEnvironment(datasetPaths());
  const adminUrl = databaseUrls(environment).admin;
  validateTargetUrl(adminUrl, 'admin', 'admin URL');
  const proof = proveOwnedServer({ port: environment.databasePort });
  const client = new pg.Client({ application_name: 'somalane-portfolio-dataset-test-admin', connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await verifyConnectedServer(client, { database: PORTFOLIO_DATABASE, proof, role: 'admin' }, 'admin URL');
    return await callback(client, proof);
  } finally {
    await client.end();
  }
}

export async function createThrowawayDatabase(): Promise<ThrowawayDatabase> {
  const name = `somalane_portfolio_t_${randomBytes(6).toString('hex')}`;
  const proof = await withVerifiedAdmin(async (client, verified) => {
    await client.query(`CREATE DATABASE ${name}`);
    created.add(name);
    return verified;
  });
  const urls = databaseUrls(readLocalEnvironment(datasetPaths()), name);
  runDatabaseScript('bootstrap-database.mjs', urls);
  runDatabaseScript('migrate.mjs', urls);
  return { name, proof, urls };
}

export async function dropThrowawayDatabases(): Promise<string[]> {
  const names = [...created].filter((name) => THROWAWAY_DATABASE_PATTERN.test(name));
  if (names.length === 0) return [];
  await withVerifiedAdmin(async (client) => {
    for (const name of names) {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      created.delete(name);
    }
  });
  return names;
}
