import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import { LlmProviderError, type LlmCallOptions, type LlmJsonSchema, type LlmProvider, type LlmStructuredInput, type LlmStructuredResult } from '../insights/llm-provider.js';
import { createApiMetrics } from '../observability/api-metrics.js';
import { createLogger } from '../observability/logger.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { InterpretationAdmission } from '../runs/interpretation/interpretation-admission.js';
import { DataQuestionInterpretationService, type DataQuestionInterpretationRequest } from './data-question-interpretation-service.js';
import { DATA_QUESTION_INSTRUCTIONS } from './data-question-prompt.js';
import { dataQuestionWireJsonSchema } from './data-question-wire.js';

// The interpretation service of "Ask my data" (ADR-0094): admission, one model call under a hard deadline, the wire
// schema, deterministic normalization and plan resolution, and a last access check. The REQUEST ends at the deadline or
// when the client leaves; the OPERATION (the provider's promise) keeps its admission places until it settles.

const USER = '11111111-1111-4111-8111-111111111111';
// A recognisable private question: it must never appear in a log line or a metric.
const SENTINEL = 'SENTINEL-QXZ compare my manually entered running with the previous 28 days';

class ManualClock implements Clock {
  public nowMs = Date.parse('2026-11-18T10:00:00.000Z');
  readonly #timers = new Map<number, () => void>();
  #next = 1;

  public clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.#timers.delete(handle as unknown as number);
  }

  public monotonicNow(): number {
    return this.nowMs;
  }

  public setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const handle = this.#next;
    this.#next += 1;
    this.#timers.set(handle, callback);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }

  public utcNow(): Date {
    return new Date(this.nowMs);
  }

  public fireDeadlines(): void {
    const due = [...this.#timers.values()];
    this.#timers.clear();
    for (const callback of due) callback();
  }
}

interface Held {
  input: LlmStructuredInput;
  options: LlmCallOptions;
  reject(error: Error): void;
  resolve(value: unknown): void;
  schema: LlmJsonSchema;
}

/** A provider whose calls stay open until the test settles them, and which ignores cancellation. */
class HeldProvider implements LlmProvider {
  public readonly model = 'test-model';
  public readonly calls: Held[] = [];

  public generateStructured(input: LlmStructuredInput, schema: LlmJsonSchema, options: LlmCallOptions): Promise<LlmStructuredResult> {
    return new Promise((resolve, reject) => {
      this.calls.push({ input, options, reject, resolve: (value) => resolve({ value }), schema });
    });
  }
}

function setup(options: { maxConcurrent?: number } = {}) {
  const clock = new ManualClock();
  const registry = new MetricsRegistry();
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ clock, write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const provider = new HeldProvider();
  const admission = new InterpretationAdmission({
    allowance: { perWindow: 100, windowMs: 86_400_000 },
    clock,
    maxConcurrent: options.maxConcurrent ?? 2,
    maxUsers: 100,
    userRate: { perWindow: 30, windowMs: 60_000 },
  });
  const metrics = createApiMetrics(registry).dataQuestions;
  const service = new DataQuestionInterpretationService({ admission, clock, logger, maxOutputTokens: 300, metrics, provider, timeoutMs: 45_000 });
  return { admission, clock, lines, metrics, provider, registry, service };
}

function request(overrides: Partial<DataQuestionInterpretationRequest> = {}): DataQuestionInterpretationRequest {
  return {
    context: { selectedDate: '2026-11-11', timeZone: 'Europe/Warsaw' },
    requestId: 'req-1',
    revalidate: () => Promise.resolve(),
    signal: new AbortController().signal,
    text: SENTINEL,
    userId: USER,
    ...overrides,
  };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected a rejection');
}

const manualRun = { activityType: 'run', outcome: 'activity_comparison', period: 'selected_date', source: 'manual' };

describe('one interpretation call, normalized and resolved by the server', () => {
  it('sends only the instructions, the validated context and the question, and returns a plan to review', async () => {
    const { lines, provider, service } = setup();
    const pending = service.interpret(request());
    await settleMicrotasks();
    expect(provider.calls).toHaveLength(1);
    const [call] = provider.calls;
    expect(call!.input.user).toBe(SENTINEL);
    expect(call!.input.system.startsWith(DATA_QUESTION_INSTRUCTIONS)).toBe(true);
    expect(call!.input.system.slice(DATA_QUESTION_INSTRUCTIONS.length)).toBe(
      '\n\nContext: the selected date is 2026-11-11; the time zone is Europe/Warsaw. Choose symbolic periods only; never write a date.',
    );
    expect(call!.schema).toBe(dataQuestionWireJsonSchema);
    expect(call!.options).toMatchObject({ maxOutputTokens: 300, timeoutMs: 45_000 });
    call!.resolve(manualRun);
    await expect(pending).resolves.toEqual({
      outcome: 'proposal',
      plan: {
        compare: 'previous_period',
        operation: 'activity_comparison',
        period: { endDate: '2026-11-11', previousEndDate: '2026-10-14', previousStartDate: '2026-09-17', startDate: '2026-10-15', symbol: 'selected_date' },
        source: 'manual',
        timeZone: 'Europe/Warsaw',
        type: 'run',
        version: 'data-question-1',
      },
      version: 'data-question-1',
    });
    expect(lines).toEqual([expect.objectContaining({ event: 'data_question.interpretation', outcome: 'proposal' })]);
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
    expect(JSON.stringify(lines)).not.toContain('manual');
  });

  it('turns a model-chosen source the question never names into a source choice, never a plan', async () => {
    const { provider, service } = setup();
    const pending = service.interpret(request({ text: 'Compare my running with the previous 28 days' }));
    await settleMicrotasks();
    provider.calls[0]!.resolve({ ...manualRun, source: 'recorded_run' });
    await expect(pending).resolves.toEqual({
      outcome: 'clarify',
      reason: 'activity_source_missing',
      sourceChoice: { operation: 'activity_comparison', period: 'selected_date', type: 'run' },
      version: 'data-question-1',
    });
  });

  it('a symbolic period the server cannot resolve is a period clarification, never a guess', async () => {
    const { provider, service } = setup();
    const pending = service.interpret(request({ context: { selectedDate: '2000-01-01', timeZone: 'UTC' }, text: 'yesterday?' }));
    await settleMicrotasks();
    provider.calls[0]!.resolve({ outcome: 'day_overview', period: 'yesterday' });
    // The clock says 2026-11-18, so "yesterday" resolves fine: use a clock at the lower bound instead.
    await expect(pending).resolves.toMatchObject({ outcome: 'proposal' });
    const early = setup();
    early.clock.nowMs = Date.parse('2000-01-01T10:00:00.000Z');
    const refused = early.service.interpret(request({ context: { selectedDate: '2000-01-01', timeZone: 'UTC' }, text: 'yesterday?' }));
    await settleMicrotasks();
    early.provider.calls[0]!.resolve({ outcome: 'day_overview', period: 'yesterday' });
    await expect(refused).resolves.toEqual({ outcome: 'clarify', reason: 'period_ambiguous', sourceChoice: null, version: 'data-question-1' });
  });

  it('fails an answer the wire schema refuses (unknown tool, field, period or free text) without using any of it', async () => {
    for (const invalid of [
      { outcome: 'run_sql', query: 'select * from meals' },
      { outcome: 'day_overview', period: 'tomorrow' },
      { outcome: 'day_overview', period: 'today', url: 'http://example.invalid' },
      { outcome: 'unsupported', reason: 'diagnosis', text: 'You may have anemia' },
      { outcome: 'activity_comparison', period: 'today', source: 'all', activityType: 'run' },
      'not json object',
    ]) {
      const { lines, provider, service } = setup();
      const pending = service.interpret(request());
      await settleMicrotasks();
      provider.calls[0]!.resolve(invalid);
      const error = await rejection(pending);
      expect(error.statusCode).toBe(502);
      expect(error.code).toBe('DATA_QUESTION_FAILED');
      expect(error.details).toEqual({ reason: 'invalid_output' });
      expect(JSON.stringify(lines)).not.toContain('anemia');
    }
  });

  it('maps provider failures to bounded codes and makes exactly one call', async () => {
    const { provider, service } = setup();
    const pending = service.interpret(request());
    await settleMicrotasks();
    provider.calls[0]!.reject(new LlmProviderError('unavailable', true));
    const error = await rejection(pending);
    expect([error.statusCode, error.code, error.details]).toEqual([502, 'DATA_QUESTION_FAILED', { reason: 'provider_unavailable' }]);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('request lifetime versus operation lifetime', () => {
  it('answers 504 at the deadline but keeps the admission places until the provider settles, and drops the late answer', async () => {
    const { admission, clock, lines, provider, service } = setup({ maxConcurrent: 1 });
    const first = service.interpret(request());
    await settleMicrotasks();
    clock.fireDeadlines();
    const timeout = await rejection(first);
    expect([timeout.statusCode, timeout.code]).toEqual([504, 'DATA_QUESTION_TIMEOUT']);
    expect(provider.calls[0]!.options.signal?.aborted).toBe(true);

    // The operation is still outstanding: the same person and anyone else are refused while it runs.
    const again = await rejection(service.interpret(request({ requestId: 'req-2' })));
    expect(again.code).toBe('DATA_QUESTION_IN_PROGRESS');
    const other = await rejection(service.interpret(request({ requestId: 'req-3', userId: '33333333-3333-4333-8333-333333333333' })));
    expect(other.code).toBe('DATA_QUESTION_BUSY');

    // The late answer settles the operation: its places are freed and nothing of it is returned.
    provider.calls[0]!.resolve(manualRun);
    await settleMicrotasks();
    expect(lines.some((line) => line.event === 'data_question.operation_settled')).toBe(true);
    const next = service.interpret(request({ requestId: 'req-4' }));
    await settleMicrotasks();
    expect(provider.calls).toHaveLength(2);
    provider.calls[1]!.resolve(manualRun);
    await expect(next).resolves.toMatchObject({ outcome: 'proposal' });
    expect(admission.allowanceInUse()).toBe(2);
  });

  it('a client that leaves ends the request at once; the call keeps its place until it settles', async () => {
    const { provider, service } = setup({ maxConcurrent: 1 });
    const client = new AbortController();
    const pending = service.interpret(request({ signal: client.signal }));
    await settleMicrotasks();
    client.abort();
    const error = await rejection(pending);
    expect([error.statusCode, error.code]).toEqual([499, 'DATA_QUESTION_ABORTED']);
    expect((await rejection(service.interpret(request({ requestId: 'r2' })))).code).toBe('DATA_QUESTION_IN_PROGRESS');
    provider.calls[0]!.reject(new LlmProviderError('aborted', false));
    await settleMicrotasks();
    const next = service.interpret(request({ requestId: 'r3' }));
    await settleMicrotasks();
    expect(provider.calls).toHaveLength(2);
    provider.calls[1]!.resolve(manualRun);
    await expect(next).resolves.toMatchObject({ outcome: 'proposal' });
  });

  it('an already cancelled request reaches no provider and takes no place', async () => {
    const { admission, provider, service } = setup();
    const client = new AbortController();
    client.abort();
    expect((await rejection(service.interpret(request({ signal: client.signal })))).code).toBe('DATA_QUESTION_ABORTED');
    expect(provider.calls).toHaveLength(0);
    expect(admission.allowanceInUse()).toBe(0);
  });
});

describe('access lost during inference', () => {
  it('drops the proposal and returns the authorization error when the session or membership is gone', async () => {
    for (const lost of [new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required'), new ApiError(403, 'ORG_ACCESS_DENIED', 'No access')]) {
      const { lines, provider, service } = setup();
      const pending = service.interpret(request({ revalidate: () => Promise.reject(lost) }));
      await settleMicrotasks();
      provider.calls[0]!.resolve(manualRun);
      const error = await rejection(pending);
      expect(error).toBe(lost);
      expect(lines).toEqual([expect.objectContaining({ outcome: 'access_lost' })]);
    }
  });

  it('revalidates only after the model answered', async () => {
    const { provider, service } = setup();
    let revalidated = 0;
    const pending = service.interpret(request({ revalidate: () => Promise.resolve(void (revalidated += 1)) }));
    await settleMicrotasks();
    expect(revalidated).toBe(0);
    provider.calls[0]!.resolve({ outcome: 'unsupported', reason: 'other_person' });
    await expect(pending).resolves.toEqual({ outcome: 'unsupported', reason: 'other_person', version: 'data-question-1' });
    expect(revalidated).toBe(1);
  });
});

describe('metrics carry bounded outcomes only', () => {
  it('counts outcomes without content or health labels', async () => {
    const { provider, registry, service } = setup();
    const pending = service.interpret(request());
    await settleMicrotasks();
    provider.calls[0]!.resolve(manualRun);
    await pending;
    const exposition = registry.render();
    expect(exposition).toContain('data_question_interpretation_requests_total{outcome="proposal"} 1');
    expect(exposition).not.toContain('SENTINEL');
    expect(exposition).not.toContain('manual');
    expect(exposition).not.toContain('2026-11-11');
  });
});
