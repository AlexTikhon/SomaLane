import type {
  DataQuestionAnswer,
  DataQuestionCapabilities,
  DataQuestionDayPlan,
  DataQuestionIntent,
  DataQuestionInterpretationResponse,
  DataQuestionPlan,
} from '@running-tracker/contracts';
import { describe, expect, it } from 'vitest';

import { DataQuestionController, type AskSnapshot, type DataQuestionApi } from './data-question-controller.js';
import { overviewFixture } from './daily-overview-fixtures.js';
import { RunnerApiError } from './runner-api.js';

// The "Ask my data" controller (ADR-0094): one current question, proposal and answer, held in memory only. Every request
// is explicit, at most one is in flight, and an answer that arrives after a cancellation, a context change, a sign-out
// or disposal is dropped.

const version = 'data-question-1' as const;
const context = { selectedDate: '2026-11-18', timeZone: 'Europe/Warsaw' };
const dayPlan = (localDate = '2026-11-18'): DataQuestionDayPlan => ({ operation: 'day_overview', period: { localDate, symbol: 'selected_date' }, timeZone: 'Europe/Warsaw', version });
const dayAnswer = (localDate = '2026-11-18'): DataQuestionAnswer => {
  const overview = overviewFixture();
  return {
    operation: 'day_overview',
    plan: dayPlan(localDate),
    provenance: { answerVersion: version, computedAt: '2026-11-18T10:00:00.000Z', persisted: false, service: 'daily_overview', serviceVersion: 'daily-overview-4' },
    result: { ...overview, day: { ...overview.day, localDate } },
    version,
  };
};

interface Deferred<Value> {
  promise: Promise<Value>;
  reject(error: unknown): void;
  resolve(value: Value): void;
  signal: AbortSignal;
}

/** An API whose every call stays open until the test settles it, recording what it was asked. */
class HeldApi implements DataQuestionApi {
  public readonly calls: Array<{ args: unknown[]; deferred: Deferred<unknown>; name: string }> = [];

  #hold<Value>(name: string, signal: AbortSignal, args: unknown[]): Promise<Value> {
    let resolve!: (value: Value) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    this.calls.push({ args, deferred: { promise, reject, resolve, signal }, name });
    return promise;
  }

  public capabilities(orgId: string, signal: AbortSignal): Promise<DataQuestionCapabilities> {
    return this.#hold('capabilities', signal, [orgId]);
  }

  public plan(ctx: { selectedDate: string; timeZone: string }, intent: DataQuestionIntent, signal: AbortSignal): Promise<DataQuestionPlan> {
    return this.#hold('plan', signal, [ctx, intent]);
  }

  public interpret(ctx: { selectedDate: string; timeZone: string }, text: string, signal: AbortSignal): Promise<DataQuestionInterpretationResponse> {
    return this.#hold('interpret', signal, [ctx, text]);
  }

  public answer(plan: DataQuestionPlan, signal: AbortSignal): Promise<DataQuestionAnswer> {
    return this.#hold('answer', signal, [plan]);
  }

  public last(name: string) {
    const found = this.calls.filter((call) => call.name === name).at(-1);
    if (found === undefined) throw new Error(`no ${name} call`);
    return found;
  }

  public count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }
}

const tick = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

function setup(options: { signal?: AbortSignal } = {}) {
  const api = new HeldApi();
  const snapshots: AskSnapshot[] = [];
  const controller = new DataQuestionController({
    api,
    context,
    onChange: (snapshot) => snapshots.push(snapshot),
    orgId: 'org-1',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { api, controller, snapshots, state: () => controller.snapshot.state };
}

describe('capability', () => {
  it('reports interpretation available or off without blocking predefined questions', async () => {
    const { api, controller } = setup();
    controller.start();
    expect(controller.snapshot.capability).toBe('checking');
    api.last('capabilities').deferred.resolve({ interpretation: 'off', version });
    await tick();
    expect(controller.snapshot.capability).toBe('off');
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    expect(controller.snapshot.state.kind).toBe('answering');
  });

  it('a failed capability check leaves interpretation unavailable, never an error state', async () => {
    const { api, controller } = setup();
    controller.start();
    api.last('capabilities').deferred.reject(new TypeError('network'));
    await tick();
    expect(controller.snapshot.capability).toBe('unavailable');
    expect(controller.snapshot.state).toEqual({ kind: 'idle' });
  });
});

describe('a predefined question', () => {
  it('resolves its plan, executes it once, and shows the answer with its plan', async () => {
    const { api, controller, state } = setup();
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    expect(state()).toEqual({ kind: 'answering', plan: null, returnTo: 'idle' });
    // A second click while busy is ignored.
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    expect(api.count('plan')).toBe(1);
    expect(api.last('plan').args).toEqual([context, { operation: 'day_overview', period: 'selected_date' }]);
    api.last('plan').deferred.resolve(dayPlan());
    await tick();
    expect(state()).toEqual({ kind: 'answering', plan: dayPlan(), returnTo: 'idle' });
    expect(api.last('answer').args).toEqual([dayPlan()]);
    api.last('answer').deferred.resolve(dayAnswer());
    await tick();
    expect(state()).toEqual({ answer: dayAnswer(), kind: 'ready', refreshing: false });
  });

  it('refresh recomputes the answer; an error during refresh never keeps the old answer as current', async () => {
    const { api, controller, state } = setup();
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    api.last('plan').deferred.resolve(dayPlan());
    await tick();
    api.last('answer').deferred.resolve(dayAnswer());
    await tick();
    controller.refresh();
    expect(state()).toMatchObject({ kind: 'ready', refreshing: true });
    expect(api.count('answer')).toBe(2);
    api.last('answer').deferred.reject(new RunnerApiError('Database unavailable', 503, 'DATABASE_UNAVAILABLE', 'req-9'));
    await tick();
    expect(state()).toEqual({ accessDenied: false, kind: 'error', message: 'Database unavailable. Reference req-9.', retryable: true });
    // Retry repeats the same execution.
    controller.retry();
    expect(api.count('answer')).toBe(3);
    expect(api.last('answer').args).toEqual([dayPlan()]);
  });
});

describe('an interpreted question', () => {
  it('shows the proposal for review and reads nothing until the person executes it', async () => {
    const { api, controller, state } = setup();
    controller.interpret('  What did I record?  ');
    expect(state()).toEqual({ kind: 'interpreting' });
    expect(api.last('interpret').args).toEqual([context, 'What did I record?']);
    controller.interpret('again');
    expect(api.count('interpret')).toBe(1);
    api.last('interpret').deferred.resolve({ outcome: 'proposal', plan: dayPlan(), version });
    await tick();
    expect(state()).toEqual({ kind: 'proposal', plan: dayPlan() });
    expect(api.count('answer')).toBe(0);
    controller.execute();
    expect(state()).toEqual({ kind: 'answering', plan: dayPlan(), returnTo: 'proposal' });
    api.last('answer').deferred.resolve(dayAnswer());
    await tick();
    expect(state()).toMatchObject({ kind: 'ready' });
  });

  it('a source clarification offers a choice, which becomes a plan to review, not an answer', async () => {
    const { api, controller, state } = setup();
    controller.interpret('Compare my running');
    const choice = { operation: 'activity_comparison', period: 'selected_date', type: 'run' } as const;
    api.last('interpret').deferred.resolve({ outcome: 'clarify', reason: 'activity_source_missing', sourceChoice: choice, version });
    await tick();
    expect(state()).toEqual({ kind: 'clarify', reason: 'activity_source_missing', sourceChoice: choice });
    controller.chooseSource('gpx');
    expect(api.last('plan').args).toEqual([context, { ...choice, source: 'gpx' }]);
    const plan: DataQuestionPlan = {
      compare: 'previous_period',
      operation: 'activity_comparison',
      period: { endDate: '2026-11-18', previousEndDate: '2026-10-21', previousStartDate: '2026-09-24', startDate: '2026-10-22', symbol: 'selected_date' },
      source: 'gpx',
      timeZone: 'Europe/Warsaw',
      type: 'run',
      version,
    };
    api.last('plan').deferred.resolve(plan);
    await tick();
    expect(state()).toEqual({ kind: 'proposal', plan });
    expect(api.count('answer')).toBe(0);
  });

  it('an unsupported request shows its bounded reason', async () => {
    const { api, controller, state } = setup();
    controller.interpret('Diagnose me');
    api.last('interpret').deferred.resolve({ outcome: 'unsupported', reason: 'medical_or_coaching', version });
    await tick();
    expect(state()).toEqual({ kind: 'unsupported', reason: 'medical_or_coaching' });
  });

  it('maps a disabled server to capability off, and refusals and failures to fixed sentences', async () => {
    const { api, controller, state } = setup();
    controller.interpret('x');
    api.last('interpret').deferred.reject(new RunnerApiError('off', 503, 'DATA_QUESTION_INTERPRETATION_DISABLED', null));
    await tick();
    expect(controller.snapshot.capability).toBe('off');
    expect(state()).toMatchObject({ kind: 'error', retryable: false });
    for (const [code, status, retryable] of [
      ['DATA_QUESTION_TIMEOUT', 504, true],
      ['DATA_QUESTION_FAILED', 502, true],
      ['DATA_QUESTION_IN_PROGRESS', 429, true],
      ['DATA_QUESTION_BUSY', 503, true],
    ] as const) {
      controller.dismiss();
      controller.interpret('x');
      api.last('interpret').deferred.reject(new RunnerApiError('server text', status, code, null));
      await tick();
      expect(state(), code).toMatchObject({ kind: 'error', retryable });
      expect((state() as { message: string }).message, code).not.toContain('server text');
    }
  });

  it('a lost session or membership shows the access state and offers no retry', async () => {
    const { api, controller, state } = setup();
    controller.interpret('x');
    api.last('interpret').deferred.reject(new RunnerApiError('No access', 403, 'ORG_ACCESS_DENIED', null));
    await tick();
    expect(state()).toEqual({ accessDenied: true, kind: 'error', message: 'You no longer have access to this organization.', retryable: false });
  });
});

describe('cancellation and late responses', () => {
  it('cancel aborts the interpretation and drops its late answer', async () => {
    const { api, controller, state } = setup();
    controller.interpret('What did I record?');
    const pending = api.last('interpret');
    controller.cancel();
    expect(pending.deferred.signal.aborted).toBe(true);
    expect(state()).toEqual({ kind: 'idle' });
    pending.deferred.resolve({ outcome: 'proposal', plan: dayPlan(), version });
    await tick();
    expect(state()).toEqual({ kind: 'idle' });
  });

  it('cancelling an execution returns to the reviewed proposal', async () => {
    const { api, controller, state } = setup();
    controller.interpret('What did I record?');
    api.last('interpret').deferred.resolve({ outcome: 'proposal', plan: dayPlan(), version });
    await tick();
    controller.execute();
    const pending = api.last('answer');
    controller.cancel();
    expect(state()).toEqual({ kind: 'proposal', plan: dayPlan() });
    pending.deferred.resolve(dayAnswer());
    await tick();
    expect(state()).toEqual({ kind: 'proposal', plan: dayPlan() });
  });

  it('a date or zone change clears the proposal and answer and drops responses for the old context', async () => {
    const { api, controller, state } = setup();
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    api.last('plan').deferred.resolve(dayPlan());
    await tick();
    const pending = api.last('answer');
    controller.setContext({ selectedDate: '2026-11-17', timeZone: 'Europe/Warsaw' });
    expect(pending.deferred.signal.aborted).toBe(true);
    expect(state()).toEqual({ kind: 'idle' });
    pending.deferred.resolve(dayAnswer());
    await tick();
    expect(state()).toEqual({ kind: 'idle' });
    // A shown answer is cleared too.
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    expect(api.last('plan').args[0]).toEqual({ selectedDate: '2026-11-17', timeZone: 'Europe/Warsaw' });
    api.last('plan').deferred.resolve(dayPlan('2026-11-17'));
    await tick();
    api.last('answer').deferred.resolve(dayAnswer('2026-11-17'));
    await tick();
    controller.setContext({ selectedDate: '2026-11-17', timeZone: 'America/New_York' });
    expect(state()).toEqual({ kind: 'idle' });
  });

  it('disposal aborts and silences: a late answer never reaches the next session', async () => {
    const { api, controller, snapshots } = setup();
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    const pending = api.last('plan');
    controller.dispose();
    expect(pending.deferred.signal.aborted).toBe(true);
    const seen = snapshots.length;
    pending.deferred.resolve(dayPlan());
    await tick();
    expect(snapshots).toHaveLength(seen);
    expect(api.count('answer')).toBe(0);
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    expect(api.count('plan')).toBe(1);
  });

  it('ending the session disposes the controller', async () => {
    const session = new AbortController();
    const { api, controller, snapshots } = setup({ signal: session.signal });
    controller.interpret('What did I record?');
    const pending = api.last('interpret');
    session.abort();
    expect(controller.disposed).toBe(true);
    expect(pending.deferred.signal.aborted).toBe(true);
    const seen = snapshots.length;
    pending.deferred.resolve({ outcome: 'proposal', plan: dayPlan(), version });
    await tick();
    expect(snapshots).toHaveLength(seen);
  });

  it('an answer for a plan other than the one executed is refused', async () => {
    const { api, controller, state } = setup();
    controller.ask({ operation: 'day_overview', period: 'selected_date' });
    api.last('plan').deferred.resolve(dayPlan());
    await tick();
    api.last('answer').deferred.resolve(dayAnswer('2026-11-10'));
    await tick();
    expect(state()).toMatchObject({ kind: 'error' });
  });
});
