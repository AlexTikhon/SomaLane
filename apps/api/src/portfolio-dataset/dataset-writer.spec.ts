import { describe, expect, it } from 'vitest';

import { planDataset, PORTFOLIO_DEFAULT_SEED } from './dataset-plan.js';
import type { SnapshotReport } from './dataset-snapshot.js';
import { baselineRefusal, classifySnapshot, DatasetConflictError, expectedRowsOf, seedPortfolioDataset, validateRun } from './dataset-writer.js';
import { IsolationError, PORTFOLIO_PROJECT, type DockerResult } from './isolation.js';

// The core writer enforces isolation itself: these refusals happen inside seedPortfolioDataset, before it asks Docker
// anything or opens a connection. Port 9 (discard) has no PostgreSQL behind it, so a writer that connected anyway would
// fail with a connection error instead of the IsolationError asserted here.

const parameters = { anchorDate: '2026-11-21', seed: PORTFOLIO_DEFAULT_SEED, timeZone: 'Europe/Warsaw' };
const now = Date.parse('2026-11-22T12:00:00Z');
const secret = 'b'.repeat(64);
const urlsFor = (database: string, host = '127.0.0.1', port = 9, query = '') => ({
  maintenance: `postgresql://running_tracker_maintenance:${secret}@${host}:${String(port)}/${database}${query}`,
  owner: `postgresql://running_tracker_owner:${secret}@${host}:${String(port)}/${database}${query}`,
  runtime: `postgresql://running_tracker_runtime:${secret}@${host}:${String(port)}/${database}${query}`,
});

function recordingDocker(respond: (args: readonly string[]) => DockerResult = () => ({ status: 0, stderr: '', stdout: '' })) {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: readonly string[]) => {
      calls.push([...args]);
      return respond(args);
    },
  };
}

describe('core writer isolation', () => {
  it.each([
    ['the development database', urlsFor('running_tracker'), /never a dataset target/u],
    ['the shared test database', urlsFor('running_tracker_test'), /never a dataset target/u],
    ['another database', urlsFor('running_tracker_load_test'), /only somalane_portfolio_demo/u],
    ['a non-local host', urlsFor('somalane_portfolio_demo', '192.168.1.20'), /must connect to 127\.0\.0\.1/u],
    ['an identity override in the URL', urlsFor('somalane_portfolio_demo', '127.0.0.1', 9, '?dbname=running_tracker'), /override connection identity/u],
    ['mixed endpoints', { ...urlsFor('somalane_portfolio_demo'), runtime: urlsFor('somalane_portfolio_demo', '127.0.0.1', 10).runtime }, /same loopback endpoint/u],
  ])('refuses %s before Docker or a connection is touched', async (_name, urls, message) => {
    const docker = recordingDocker();
    await expect(seedPortfolioDataset({ docker: docker.run, environment: {}, nowMs: now, parameters, urls })).rejects.toThrow(message);
    await expect(seedPortfolioDataset({ docker: docker.run, environment: {}, nowMs: now, parameters, urls })).rejects.toBeInstanceOf(IsolationError);
    expect(docker.calls).toEqual([]);
  });

  it('refuses APP_ENV=production whatever the target', async () => {
    const docker = recordingDocker();
    await expect(seedPortfolioDataset({ docker: docker.run, environment: { APP_ENV: 'production' }, nowMs: now, parameters, urls: urlsFor('somalane_portfolio_demo') })).rejects.toThrow(
      /APP_ENV=production/u,
    );
    expect(docker.calls).toEqual([]);
  });

  it('refuses an anchor that is not yet a completed date', async () => {
    const docker = recordingDocker();
    await expect(
      seedPortfolioDataset({ docker: docker.run, environment: {}, nowMs: now, parameters: { ...parameters, anchorDate: '2026-11-22' }, urls: urlsFor('somalane_portfolio_demo') }),
    ).rejects.toThrow(/completed date/u);
    expect(docker.calls).toEqual([]);
  });

  it('refuses when no owned container publishes the URL port, without connecting', async () => {
    const docker = recordingDocker((args) => ({ status: 0, stderr: '', stdout: args[0] === 'ps' ? '' : '' }));
    await expect(seedPortfolioDataset({ docker: docker.run, environment: {}, nowMs: now, parameters, urls: urlsFor('somalane_portfolio_demo') })).rejects.toThrow(
      new RegExp(`Compose project ${PORTFOLIO_PROJECT}\\) is not running`, 'u'),
    );
    expect(docker.calls.map((call) => call[0])).toEqual(['ps']);
  });
});

function emptyReport(): SnapshotReport {
  return {
    foreign: { coachRecords: 0, otherMemberships: 0, otherOrganizations: 0, otherUsers: 0, runTombstones: 0 },
    runPointCounts: {},
    runPoints: {},
    runRawStates: {},
    summaryChecks: {},
    snapshot: {
      activities: [],
      dailyMetrics: [],
      dailyMovement: [],
      identities: { memberships: [], organizations: [], users: [] },
      meals: [],
      runCommands: [],
      runShares: [],
      runSummaries: [],
      runs: [],
    },
  };
}

describe('classification of existing data', () => {
  const plan = planDataset(parameters);
  const expected = expectedRowsOf(plan);

  it('calls an empty database empty and a subset of the plan partial', () => {
    expect(classifySnapshot(plan, emptyReport(), expected)).toEqual({ reasons: [], state: 'empty' });
    const report = emptyReport();
    report.snapshot.dailyMetrics = [expected.dailyMetrics.get(plan.checkIns[0]!.localDate)!];
    expect(classifySnapshot(plan, report, expected)).toEqual({ reasons: [], state: 'partial' });
  });

  it('refuses a changed value, an unplanned row and foreign data, naming each', () => {
    const report = emptyReport();
    const first = expected.dailyMetrics.get(plan.checkIns[0]!.localDate)!;
    report.snapshot.dailyMetrics = [{ ...first, note: 'edited by hand' }, { ...first, localDate: '1999-12-31' }];
    report.foreign.otherUsers = 1;
    report.foreign.runTombstones = 2;
    const { reasons } = classifySnapshot(plan, report, expected);
    expect(reasons).toEqual(
      expect.arrayContaining([
        `daily_metrics: ${first.localDate} differs from this plan`,
        'daily_metrics: 1999-12-31 is not in this plan',
        '1 user(s) other than the synthetic runner and coach',
        '2 deleted run(s) (tombstones)',
      ]),
    );
  });

  it('refuses a run finished at another time than the plan (for example by auto-finish)', () => {
    const { report, run } = finishedRun(plan.runs[0]!);
    report.snapshot.runs[0] = { ...run, finishedAt: '2030-01-01T00:00:00.000Z' };
    const reasons = classifySnapshot(plan, report, expected).reasons;
    expect(reasons).toContain(`runs: ${run.id} was finished at another time (for example by the auto-finish job)`);
  });
});

type PlannedRun = ReturnType<typeof planDataset>['runs'][number];

/** The stored state the writer's lifecycle leaves for one finished, summarised run (raw history still available). */
function finishedRun(planned: PlannedRun) {
  const report = emptyReport();
  const finishedAt = new Date(planned.finishedAtMs).toISOString();
  const dataRevision = String(planned.batches.length + 1);
  const run = { controlRevision: '1', dataRevision, finishedAt, id: planned.runId, requestedStartedAt: planned.startedAt, startedAt: planned.startedAt, status: 'finished' };
  report.snapshot.runs = [run];
  report.runRawStates[planned.runId] = 'available';
  report.runPoints[planned.runId] = planned.batches.flat().map((point) => ({ ...point, recordedAt: new Date(point.recordedAt).toISOString() }));
  report.snapshot.runCommands = [
    {
      commandId: planned.finishCommandId,
      payload: '{"type": "finish", "expectedControlRevision": "0"}',
      response: JSON.stringify({ status: 'finished', commandId: planned.finishCommandId, finishedAt, dataRevision, controlRevision: '1' }),
      runId: planned.runId,
    },
  ];
  report.snapshot.runSummaries = [
    {
      algorithmVersion: 'track-v1',
      current: true,
      displayGeometry: { md5: 'f'.repeat(32), points: 40 },
      distanceM: (planned.plannedDistanceM * 1.002).toFixed(3),
      observedDurationS: String(planned.plannedDurationS),
      qualityStats: '{}',
      runId: planned.runId,
      sourceRevision: dataRevision,
    },
  ];
  report.summaryChecks[planned.runId] = { algorithmCurrent: true, qualityStatsValid: true };
  return { report, run };
}

/** A run interrupted after `batches` complete point batches (recording, no command, no summary). */
function recordingRun(planned: PlannedRun, batches: number) {
  const report = emptyReport();
  const run = { controlRevision: '0', dataRevision: String(batches), finishedAt: null, id: planned.runId, requestedStartedAt: planned.startedAt, startedAt: planned.startedAt, status: 'recording' };
  report.snapshot.runs = [run];
  report.runRawStates[planned.runId] = 'available';
  report.runPoints[planned.runId] = planned.batches.slice(0, batches).flat().map((point) => ({ ...point }));
  return { report, run };
}

describe('run validation (drift and malformed partial state)', () => {
  const planned = planDataset(parameters).runs[1]!;

  it('accepts the lifecycle states the writer and retention can produce', () => {
    const complete = finishedRun(planned);
    expect(validateRun(planned, complete.run, complete.report)).toEqual({ complete: true, reasons: [] });
    for (const batches of [0, 1, planned.batches.length]) {
      const partial = recordingRun(planned, batches);
      expect(validateRun(planned, partial.run, partial.report)).toEqual({ complete: false, reasons: [] });
    }
    // Finished but interrupted before publication: resumable.
    const unpublished = finishedRun(planned);
    unpublished.report.snapshot.runSummaries = [];
    expect(validateRun(planned, unpublished.run, unpublished.report)).toEqual({ complete: false, reasons: [] });
    // Legitimate raw retention: purging keeps a subset of the planned points, purged none; the summary stays current.
    const purging = finishedRun(planned);
    purging.report.runRawStates[planned.runId] = 'purging';
    purging.report.runPoints[planned.runId] = purging.report.runPoints[planned.runId]!.slice(150);
    expect(validateRun(planned, purging.run, purging.report)).toEqual({ complete: true, reasons: [] });
    const purged = finishedRun(planned);
    purged.report.runRawStates[planned.runId] = 'purged';
    purged.report.runPoints[planned.runId] = [];
    expect(validateRun(planned, purged.run, purged.report)).toEqual({ complete: true, reasons: [] });
  });

  it.each([
    ['a summary distance the points cannot produce', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runSummaries[0]!.distanceM = '999999'), /summary distance/u],
    ['a summary without display geometry', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runSummaries[0]!.displayGeometry = null), /display geometry/u],
    ['another effective start', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runs[0]!.startedAt = '2001-01-01T00:00:00.000Z'), /another effective start/u],
    ['a replaced finish-command payload', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runCommands[0]!.payload = '{}'), /finish command payload/u],
    ['a replaced finish-command response', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runCommands[0]!.response = '{}'), /finish command response/u],
    ['another requested start', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runs[0]!.requestedStartedAt = '2001-01-01T00:00:00.000Z'), /another requested start/u],
    ['a revision that does not match the uploads', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runs[0]!.dataRevision = '9'), /revisions that do not match/u],
    ['a stale summary', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runSummaries[0]!.current = false), /another data revision/u],
    ['a summary of another algorithm', (state: ReturnType<typeof finishedRun>) => (state.report.summaryChecks[planned.runId] = { algorithmCurrent: false, qualityStatsValid: true }), /another algorithm/u],
    ['invalid quality statistics', (state: ReturnType<typeof finishedRun>) => (state.report.summaryChecks[planned.runId] = { algorithmCurrent: true, qualityStatsValid: false }), /quality statistics/u],
    ['another observed duration', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runSummaries[0]!.observedDurationS = '1'), /summary duration/u],
    ['a missing finish command', (state: ReturnType<typeof finishedRun>) => (state.report.snapshot.runCommands = []), /exactly its planned finish command/u],
    ['missing points with raw history available', (state: ReturnType<typeof finishedRun>) => state.report.runPoints[planned.runId]!.pop(), /without all of its planned points/u],
    ['purged points without a summary', (state: ReturnType<typeof finishedRun>) => {
      state.report.runRawStates[planned.runId] = 'purged';
      state.report.runPoints[planned.runId] = [];
      state.report.snapshot.runSummaries = [];
    }, /without a current summary/u],
    ['a moved point after a purge began', (state: ReturnType<typeof finishedRun>) => {
      state.report.runRawStates[planned.runId] = 'purging';
      state.report.runPoints[planned.runId]![0]!.latitude += 0.001;
    }, /not the planned points/u],
  ])('refuses a finished run with %s', (_name, change, message) => {
    const state = finishedRun(planned);
    change(state);
    const outcome = validateRun(planned, state.report.snapshot.runs[0]!, state.report);
    expect(outcome.complete).toBe(false);
    expect(outcome.reasons.join('\n')).toMatch(message);
  });

  it.each([
    ['a gap (the second batch without the first)', (state: ReturnType<typeof recordingRun>) => (state.report.runPoints[planned.runId] = planned.batches[1]!.map((point) => ({ ...point }))), /whole number of planned batches/u],
    ['half a batch', (state: ReturnType<typeof recordingRun>) => state.report.runPoints[planned.runId]!.splice(150), /whole number of planned batches/u],
    ['a point that is not the planned point', (state: ReturnType<typeof recordingRun>) => (state.report.runPoints[planned.runId]![7]!.longitude += 0.01), /not the planned points/u],
    ['a data revision behind its uploads', (state: ReturnType<typeof recordingRun>) => (state.report.snapshot.runs[0]!.dataRevision = '1'), /data revision that does not match/u],
    ['a lifecycle command while recording', (state: ReturnType<typeof recordingRun>) => (state.report.snapshot.runCommands = [{ commandId: planned.finishCommandId, payload: '{}', response: '{}', runId: planned.runId }]), /lifecycle command/u],
    ['a pause', (state: ReturnType<typeof recordingRun>) => (state.report.snapshot.runs[0]!.status = 'paused'), /paused, which this plan never does/u],
    ['purged raw history', (state: ReturnType<typeof recordingRun>) => (state.report.runRawStates[planned.runId] = 'purged'), /recording without its raw history/u],
  ])('refuses a partial run with %s', (_name, change, message) => {
    const state = recordingRun(planned, 2);
    change(state);
    const outcome = validateRun(planned, state.report.snapshot.runs[0]!, state.report);
    expect(outcome.reasons.join('\n')).toMatch(message);
  });
});

describe('the recorded completion baseline (checked before any write)', () => {
  const recorded = `sha256:${'a'.repeat(64)}`;
  const other = `sha256:${'b'.repeat(64)}`;

  it('without a baseline, lets an empty dataset be seeded and a partial one resumed', () => {
    for (const state of ['empty', 'partial', 'complete'] as const) expect(baselineRefusal(state, other, undefined)).toBeNull();
  });

  it('with a baseline, accepts only the complete dataset with the recorded digest', () => {
    expect(baselineRefusal('complete', recorded, recorded)).toBeNull();
    expect(baselineRefusal('complete', other, recorded)).toMatch(/no longer has the digest recorded when it was seeded/u);
  });

  it.each([
    ['partial', /is now partial \(records of the plan are missing\): a completed dataset that lost data is not seeded again/u],
    ['empty', /is now empty: a completed dataset that lost data is not seeded again/u],
  ] as const)('with a baseline, refuses a %s dataset instead of treating it as an interrupted first seed', (state, message) => {
    // Whatever the digest of what is left: a partial dataset never has the recorded digest anyway.
    for (const digest of [recorded, other]) {
      const reason = baselineRefusal(state, digest, recorded);
      expect(reason).toMatch(message);
      expect(reason).toContain(`a completion was recorded for these parameters (${recorded})`);
    }
  });
});

describe('conflict messages say only what is established', () => {
  it('a refusal before the first write says this attempt wrote nothing', () => {
    const error = new DatasetConflictError(['reason one'], 0);
    expect(error.writes).toBe(0);
    expect(error.message).toMatch(/^The dataset database is not in a state this seed accepts, and this attempt wrote nothing and overwrote nothing:\n- reason one$/u);
  });

  it('a refusal of the result after writes says they stay committed and never that nothing was written', () => {
    const error = new DatasetConflictError(['reason one'], 254);
    expect(error.writes).toBe(254);
    expect(error.message).toMatch(/had already performed 254 seed write operation\(s\)/u);
    expect(error.message).toMatch(/stays committed, nothing was rolled back/u);
    expect(error.message).not.toMatch(/wrote nothing|nothing was written/iu);
  });
});
