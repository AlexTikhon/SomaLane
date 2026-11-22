import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { planDataset, PORTFOLIO_DATASET_VERSION, PORTFOLIO_DEFAULT_SEED } from './dataset-plan.js';
import { DatasetConflictError, type SeedResult } from './dataset-writer.js';
import { datasetPaths } from './local-environment.js';
import { readSeedState, recordedDigest, seedAndRecord } from './prepare-cli.js';

// How the CLI records completion (finding 2 of the step-2 review): the recorded digest goes to the core writer, and
// nothing replaces the completion state or the manifest unless the writer accepted the dataset.

const parameters = { anchorDate: '2026-11-21', seed: PORTFOLIO_DEFAULT_SEED, timeZone: 'Europe/Warsaw' };
const recorded = `sha256:${'a'.repeat(64)}`;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function completedEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'portfolio-record-'));
  directories.push(root);
  const paths = datasetPaths(root);
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.seedState, `${JSON.stringify({ digest: recorded, parameters, status: 'complete', updatedAt: '2026-11-22T08:00:00.000Z', version: PORTFOLIO_DATASET_VERSION }, null, 2)}\n`);
  writeFileSync(paths.manifest, `${JSON.stringify({ datasetVersion: PORTFOLIO_DATASET_VERSION, digest: recorded, parameters }, null, 2)}\n`);
  const fingerprint = () => [paths.seedState, paths.manifest].map((path) => `${readFileSync(path, 'utf8')}|${String(statSync(path).mtimeMs)}`);
  return { fingerprint, paths };
}

function seedResult(digest: string): SeedResult {
  return {
    baseline: 'matched',
    digest,
    plan: planDataset(parameters),
    report: {
      foreign: { coachRecords: 0, otherMemberships: 0, otherOrganizations: 0, otherUsers: 0, runTombstones: 0 },
      runPointCounts: {},
      runPoints: {},
      runRawStates: {},
      snapshot: { activities: [], dailyMetrics: [], dailyMovement: [], identities: { memberships: [], organizations: [], users: [] }, meals: [], runCommands: [], runShares: [], runSummaries: [], runs: [] },
      summaryChecks: {},
    },
    stateAfter: 'complete',
    stateBefore: 'complete',
    writes: 0,
  } as unknown as SeedResult;
}

describe('recording a seed outcome', () => {
  it('finds the digest recorded for the same parameters only', () => {
    const { paths } = completedEnvironment();
    expect(recordedDigest(paths, parameters)).toBe(recorded);
    expect(recordedDigest(paths, { ...parameters, seed: 'another' })).toBeUndefined();
    rmSync(paths.seedState);
    expect(recordedDigest(paths, parameters)).toBe(recorded);
  });

  it('hands the recorded digest to the core writer and leaves every artifact unchanged when it refuses drift', async () => {
    const { fingerprint, paths } = completedEnvironment();
    const before = fingerprint();
    const seed = vi.fn(async (expectedDigest: string | undefined) => {
      expect(expectedDigest).toBe(recorded);
      return Promise.reject(new DatasetConflictError(['the complete dataset no longer has the digest recorded when it was seeded'], 0));
    });
    await expect(seedAndRecord(paths, parameters, () => undefined, seed)).rejects.toThrow(
      /This attempt wrote nothing to the database, and no manifest or state file was replaced\./u,
    );
    expect(seed).toHaveBeenCalledTimes(1);
    expect(fingerprint()).toEqual(before);
  });

  it('does not claim nothing was written when the writer refused its result after writing, and keeps every artifact', async () => {
    const { fingerprint, paths } = completedEnvironment();
    const before = fingerprint();
    const refusal = new DatasetConflictError(['meals: k differs from this plan'], 254);
    const error = await seedAndRecord(paths, parameters, () => undefined, () => Promise.reject(refusal)).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.cause).toBe(refusal);
    expect(error?.message).toMatch(/This attempt performed 254 seed write operation\(s\) before the check failed; what they committed stays in the database \(nothing was rolled back\)/u);
    expect(error?.message).not.toMatch(/wrote nothing|Nothing was written/u);
    expect(fingerprint()).toEqual(before);
  });

  it('records an interruption without touching the manifest', async () => {
    const { paths } = completedEnvironment();
    const manifest = readFileSync(paths.manifest, 'utf8');
    await expect(seedAndRecord(paths, parameters, () => undefined, () => Promise.reject(new Error('connection lost')))).rejects.toThrow(/running the same command again resumes it/u);
    expect(readSeedState(paths.seedState)).toMatchObject({ error: 'connection lost', status: 'interrupted' });
    expect(readFileSync(paths.manifest, 'utf8')).toBe(manifest);
  });

  it('replaces the state and the manifest only after the writer accepted the dataset', async () => {
    const { paths } = completedEnvironment();
    const { manifest } = await seedAndRecord(paths, parameters, () => undefined, () => Promise.resolve(seedResult(recorded)));
    expect(manifest.digest).toBe(recorded);
    expect(readSeedState(paths.seedState)).toMatchObject({ digest: recorded, status: 'complete' });
    expect(JSON.parse(readFileSync(paths.manifest, 'utf8'))).toMatchObject({ digest: recorded, parameters });
  });
});
