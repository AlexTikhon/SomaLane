import type { RunView } from '@running-tracker/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { CaptureState } from './capture-controller.js';
import { runAttention, type RunAttentionInput } from './run-attention.js';
import { createInitialRunnerState, type RunnerState } from './runner-state.js';
import { RunStatusNotice } from './RunStatusNotice.js';
import type { WriterOwnershipState } from './writer-lease.js';

const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function run(status: RunView['status']): RunView {
  return {
    controlRevision: '3',
    dataRevision: '5',
    finishedAt: status === 'finished' ? '2026-10-06T09:00:00.000Z' : null,
    rawState: 'available',
    runId,
    startedAt: '2026-10-06T08:00:00.000Z',
    status,
    summary: null,
  };
}

const facts = { capturedCount: 4, lastPersistedAtMs: 1_000, lastRecordedAt: '2026-10-06T08:00:20.000Z' };
const capturing: CaptureState = { ...facts, consecutiveFailures: 0, segmentId: 1, signal: 'live', source: 'Simulator · normal · seed 1', startedAtMs: 0, status: 'capturing', warning: null };
const owned: WriterOwnershipState = { expiresAt: '2026-10-06T08:01:00.000Z', fencingToken: '7', status: 'owned' };

function input(runner: Partial<RunnerState>, extra: Partial<RunAttentionInput> = {}): RunAttentionInput {
  return {
    capture: capturing,
    runner: { ...createInitialRunnerState('online'), ...runner },
    storage: { status: 'ready' },
    writer: owned,
    ...extra,
  };
}

describe('the Runner status away from Runner', () => {
  it('says nothing while there is no run, nothing waiting and storage is not restored yet', () => {
    expect(runAttention(input({}, { capture: { status: 'idle' } }))).toBeNull();
    expect(runAttention(input({ run: run('recording') }, { storage: { status: 'loading' } }))).toBeNull();
    expect(runAttention(input({ run: run('finished') }, { capture: { status: 'idle' } }))).toBeNull();
  });

  it('says Recording only while the capture controller has an active watch for a run the server lets record', () => {
    const recording = runAttention(input({ run: run('recording'), upload: { message: null, pendingCount: 2, status: 'uploading' } }));
    expect(recording).toEqual({
      detail: 'Run #bbbbbbbb. Source: Simulator · normal · seed 1. 2 points waiting to upload.',
      headline: 'Points are saved on this device and uploaded.',
      kind: 'recording',
    });
    const offline = runAttention(input({ connectivity: 'offline', run: run('recording'), upload: { message: null, pendingCount: 1, status: 'idle' } }));
    expect(offline?.kind).toBe('recording');
    expect(offline?.headline).toBe('Offline: points are saved on this device and upload when the connection returns.');
    expect(offline?.detail).toContain('1 point wait on this device until the connection returns.');
  });

  it('never implies GPS is recording when it is not', () => {
    const cases: Array<[string, RunAttentionInput, string]> = [
      ['capture starting', input({ run: run('recording') }, { capture: { ...facts, source: 'Device GPS', status: 'starting' } }), 'Device GPS is starting.'],
      ['capture complete', input({ run: run('recording') }, { capture: { ...capturing, status: 'complete' } }), 'has no more points to deliver.'],
      ['capture failed', input({ run: run('recording') }, { capture: { ...facts, message: 'Location permission was denied.', reason: 'permission-denied', source: 'Device GPS', status: 'error' } }), 'Location permission was denied.'],
      ['not yet confirmed', input({ authority: { status: 'restored' }, run: run('recording') }, { capture: { status: 'idle' } }), 'checked with the server'],
      ['server unreachable', input({ authority: { message: 'timeout', status: 'unreachable' }, run: run('recording') }, { capture: { status: 'idle' } }), 'could not be reached'],
      ['taking over the writer', input({ run: run('recording') }, { capture: { status: 'idle' }, writer: { status: 'acquiring' } }), 'taking over recording'],
    ];
    for (const [name, value, reason] of cases) {
      const attention = runAttention(value);
      expect(attention?.kind, name).toBe('attention');
      expect(attention?.headline, name).toBe('Run in progress, but nothing is being recorded.');
      expect(attention?.detail, name).toContain(reason);
    }
  });

  it('distinguishes paused, pending synchronization and blocked states', () => {
    expect(runAttention(input({ run: run('paused') }, { capture: { status: 'idle' } }))).toMatchObject({ headline: 'The run is paused; nothing is being recorded.', kind: 'paused' });
    const finishing = runAttention(input({
      pendingRequest: { commandId: 'c', expectedControlRevision: '3', kind: 'command', orgId, runId, type: 'finish' },
      run: run('recording'),
    }));
    expect(finishing).toMatchObject({ headline: 'The Finish request is being sent.', kind: 'pending' });
    expect(runAttention(input({ run: run('finished'), upload: { message: null, pendingCount: 3, status: 'retrying' } }, { capture: { status: 'idle' } })))
      .toMatchObject({ detail: 'Run #bbbbbbbb. 3 points waiting to upload.', headline: 'Points of the finished run are waiting to upload.', kind: 'pending' });
    expect(runAttention(input({ run: null, upload: { message: null, pendingCount: 2, status: 'suspended' } }, { capture: { status: 'idle' } })))
      .toMatchObject({ kind: 'pending' });

    const blocked: Array<[string, RunAttentionInput, string]> = [
      ['upload rejected', input({ run: run('recording'), upload: { message: 'rejected', pendingCount: 5, status: 'blocked' } }, { capture: { status: 'idle' } }), 'The server rejected points of this run.'],
      ['run refused', input({ authority: { code: 'RUN_NOT_FOUND', message: 'gone', status: 'refused' }, run: run('recording') }, { capture: { status: 'idle' } }), 'The server no longer accepts this run.'],
      ['request failed', input({ error: { message: 'failed', request: { kind: 'start', orgId, runId, startedAt: 'x' } } }, { capture: { status: 'idle' } }), 'A run request did not complete and needs attention.'],
      ['another tab', input({ run: run('recording') }, { capture: { status: 'idle' }, writer: { expiresAt: 'x', status: 'conflict' } }), 'Another tab may own recording.'],
      ['storage failed', input({ run: run('recording') }, { storage: { status: 'error' } }), 'Run storage on this device failed.'],
    ];
    for (const [name, value, headline] of blocked) {
      expect(runAttention(value), name).toMatchObject({ headline, kind: 'attention' });
    }
  });

  it('renders a labelled region with a polite status and a way back to Runner', () => {
    const attention = runAttention(input({ run: run('recording') }))!;
    const html = renderToStaticMarkup(<RunStatusNotice attention={attention} onOpenRunner={() => undefined} />);
    expect(html).toContain('<section aria-label="Run status" class="run-status run-status--recording" data-run-status="recording">');
    expect(html).toContain('<p role="status"><strong>Recording.</strong> Points are saved on this device and uploaded.</p>');
    expect(html).toContain('<button type="button">Go to Runner</button>');
  });
});
