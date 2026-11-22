import type { CaptureState } from './capture-controller.js';
import type { RunnerState } from './runner-state.js';
import type { WriterOwnershipState } from './writer-lease.js';

// The compact Runner status shown while another view is open (release step 3). Derived only from state App already
// owns (the run, its server authority, the upload queue, the capture controller's state, the writer lease and the
// browser storage); it asks nothing and changes nothing. "Recording" is said only while the capture controller reports
// an active watch for a run the server lets record; every other in-progress state says that nothing is being recorded.

export type RunAttentionKind = 'attention' | 'paused' | 'pending' | 'recording';

export interface RunAttention {
  /** What is true now, in a sentence that does not change with every point (it is announced politely). */
  headline: string;
  /** Supporting detail (counts, the run, the connection), not announced on every change. */
  detail: string;
  kind: RunAttentionKind;
}

export interface RunAttentionInput {
  capture: CaptureState;
  runner: RunnerState;
  storage: { status: 'error' | 'loading' | 'ready' };
  writer: WriterOwnershipState;
}

const shortRun = (runId: string) => `#${runId.slice(0, 8)}`;

const points = (count: number) => `${count} ${count === 1 ? 'point' : 'points'}`;

function waitingDetail(runner: RunnerState): string {
  const pending = runner.upload.pendingCount;
  const offline = runner.connectivity === 'offline';
  if (pending === 0) return offline ? 'You are offline.' : '';
  return offline
    ? `${points(pending)} wait on this device until the connection returns.`
    : `${points(pending)} waiting to upload.`;
}

function joined(...parts: string[]): string {
  return parts.filter((part) => part !== '').join(' ');
}

function requestName(runner: RunnerState): string {
  const request = runner.pendingRequest;
  if (request === null) return '';
  if (request.kind === 'start') return 'Start';
  return request.type === 'pause' ? 'Pause' : request.type === 'resume' ? 'Resume' : 'Finish';
}

/** Why a run in the recording state is not being captured right now, in words for the person. */
function notCapturingReason(input: RunAttentionInput): string {
  const { capture, runner, writer } = input;
  if (writer.status === 'unclaimed' || writer.status === 'acquiring') return 'This tab is taking over recording.';
  switch (runner.authority.status) {
    case 'restored':
    case 'confirming':
      return 'The run is being checked with the server before capture resumes.';
    case 'unreachable':
      return 'The server could not be reached to confirm the run; capture resumes once it answers.';
    default:
      break;
  }
  switch (capture.status) {
    case 'starting':
      return `${capture.source} is starting.`;
    case 'complete':
      return `${capture.source} has no more points to deliver.`;
    case 'error':
    case 'lost':
      return capture.message;
    default:
      return 'Capture is not running.';
  }
}

/** The status to show away from Runner, or null when there is nothing in progress or waiting. */
export function runAttention(input: RunAttentionInput): RunAttention | null {
  const { capture, runner, storage, writer } = input;
  if (storage.status === 'error') {
    return { detail: 'Open Runner to see what happened.', headline: 'Run storage on this device failed.', kind: 'attention' };
  }
  if (storage.status !== 'ready') return null;

  const { run } = runner;
  const runLabel = run === null ? '' : `Run ${shortRun(run.runId)}.`;

  if (runner.error !== null) {
    return {
      detail: joined(runLabel, 'Open Runner to retry or resolve it.'),
      headline: 'A run request did not complete and needs attention.',
      kind: 'attention',
    };
  }
  if (run !== null && runner.authority.status === 'refused') {
    return {
      detail: joined(runLabel, 'Nothing is recorded. Open Runner to export or discard what this device kept.'),
      headline: 'The server no longer accepts this run.',
      kind: 'attention',
    };
  }
  if (run !== null && runner.upload.status === 'blocked') {
    return {
      detail: joined(runLabel, 'Its points are kept on this device. Open Runner to export or discard them.'),
      headline: 'The server rejected points of this run.',
      kind: 'attention',
    };
  }
  if (run !== null && run.status !== 'finished' && (writer.status === 'conflict' || writer.status === 'lost' || writer.status === 'error')) {
    return {
      detail: joined(runLabel, 'This tab is not recording. Open Runner to see which tab owns it.'),
      headline: writer.status === 'error' ? 'Recording ownership is unavailable.' : 'Another tab may own recording.',
      kind: 'attention',
    };
  }
  if (runner.pendingRequest !== null) {
    return {
      detail: joined(runLabel, waitingDetail(runner)),
      headline: `The ${requestName(runner)} request is being sent.`,
      kind: 'pending',
    };
  }
  if (run === null) {
    if (runner.upload.pendingCount === 0) return null;
    return { detail: waitingDetail(runner), headline: 'Points of a run are waiting to synchronize.', kind: 'pending' };
  }

  if (run.status === 'recording') {
    // The same rule the capture effect uses: only an active watch counts as recording.
    if (capture.status === 'capturing') {
      return {
        detail: joined(runLabel, `Source: ${capture.source}.`, waitingDetail(runner)),
        headline: runner.connectivity === 'offline'
          ? 'Offline: points are saved on this device and upload when the connection returns.'
          : 'Points are saved on this device and uploaded.',
        kind: 'recording',
      };
    }
    return {
      detail: joined(runLabel, notCapturingReason(input), waitingDetail(runner)),
      headline: 'Run in progress, but nothing is being recorded.',
      kind: 'attention',
    };
  }
  if (run.status === 'paused') {
    return {
      detail: joined(runLabel, 'Resume or finish it on Runner.', waitingDetail(runner)),
      headline: 'The run is paused; nothing is being recorded.',
      kind: 'paused',
    };
  }
  // Finished: only unsent points or an unconfirmed result are worth a status.
  if (runner.upload.pendingCount > 0 || runner.upload.status === 'retrying' || runner.upload.status === 'error' || runner.upload.status === 'suspended') {
    return {
      detail: joined(runLabel, waitingDetail(runner), runner.upload.message ?? ''),
      headline: 'Points of the finished run are waiting to upload.',
      kind: 'pending',
    };
  }
  if (runner.authority.status === 'unreachable') {
    return {
      detail: joined(runLabel, 'The server could not be reached to confirm it.'),
      headline: 'Finished run not yet confirmed by the server.',
      kind: 'attention',
    };
  }
  return null;
}
