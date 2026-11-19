import type {
  DataQuestionActivitySource,
  DataQuestionAnswer,
  DataQuestionCapabilities,
  DataQuestionClarificationReason,
  DataQuestionIntent,
  DataQuestionInterpretationResponse,
  DataQuestionPlan,
  DataQuestionSourceChoice,
  DataQuestionUnsupportedReason,
} from '@running-tracker/contracts';

import { RunnerApiError } from './runner-api.js';

// Framework-free controller of "Ask my data" on Today (ADR-0094). It holds ONE current question's state in memory:
// nothing is persisted, cached or kept as a history. It belongs to one session, person and organization (the screen is
// keyed by them); the selected date and the zone are its context, and changing either clears the state.
//
// Every request is explicit and at most one is in flight. A generation counter, not the abort signal, decides whether a
// response is still wanted, so a transport that ignores cancellation can never overwrite newer state; cancelling, a
// context change, a sign-out (the session signal) and disposal all move the generation on and abort the request.
// Interpretation only ever yields a plan to REVIEW; only `ask` (a predefined question, itself an explicit read request)
// and `execute` read data.

export type AskState =
  | { kind: 'idle' }
  | { kind: 'interpreting' }
  /** A plan to review; nothing has been read. */
  | { kind: 'proposal'; plan: DataQuestionPlan }
  /** Executing a plan (null while a predefined question's plan is being resolved). */
  | { kind: 'answering'; plan: DataQuestionPlan | null; returnTo: 'idle' | 'proposal' }
  | { answer: DataQuestionAnswer; kind: 'ready'; refreshing: boolean }
  | { kind: 'clarify'; reason: DataQuestionClarificationReason; sourceChoice: DataQuestionSourceChoice | null }
  | { kind: 'unsupported'; reason: DataQuestionUnsupportedReason }
  | { accessDenied: boolean; kind: 'error'; message: string; retryable: boolean };

export type InterpretationCapability = 'available' | 'checking' | 'off' | 'unavailable';

export interface AskContext {
  selectedDate: string;
  timeZone: string;
}

export interface AskSnapshot {
  capability: InterpretationCapability;
  context: AskContext;
  state: AskState;
}

/** The four routes, bound to the session's CSRF credentials by the screen. */
export interface DataQuestionApi {
  answer(plan: DataQuestionPlan, signal: AbortSignal): Promise<DataQuestionAnswer>;
  capabilities(orgId: string, signal: AbortSignal): Promise<DataQuestionCapabilities>;
  interpret(context: AskContext, text: string, signal: AbortSignal): Promise<DataQuestionInterpretationResponse>;
  plan(context: AskContext, intent: DataQuestionIntent, signal: AbortSignal): Promise<DataQuestionPlan>;
}

export interface DataQuestionControllerOptions {
  api: DataQuestionApi;
  context: AskContext;
  onChange: (snapshot: AskSnapshot) => void;
  orgId: string;
  /** The session's signal: its end disposes the controller. */
  signal?: AbortSignal;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function serverText(error: RunnerApiError): string {
  const reference = error.requestId === null ? '' : ` Reference ${error.requestId}.`;
  return `${error.message.replace(/[.\s]+$/u, '')}.${reference}`;
}

const ACCESS_LOST = 'You no longer have access to this organization.';

/** The error state for a failed request: fixed sentences for every interpretation failure, the server's for the rest. */
export function errorStateOf(error: unknown): Extract<AskState, { kind: 'error' }> & { interpretationOff?: true } {
  const state = (message: string, retryable: boolean) => ({ accessDenied: false, kind: 'error' as const, message, retryable });
  if (error instanceof DOMException && error.name === 'TimeoutError') return state('The request took too long. Try again.', true);
  if (!(error instanceof RunnerApiError)) return state('The request failed. Check your connection and try again.', true);
  if (error.status === 401 || error.status === 403) return { accessDenied: true, kind: 'error', message: ACCESS_LOST, retryable: false };
  switch (error.code) {
    case 'DATA_QUESTION_INTERPRETATION_DISABLED':
      return { ...state('Question interpretation is not available on this server. The questions below still work.', false), interpretationOff: true };
    case 'DATA_QUESTION_RATE_LIMITED':
    case 'DATA_QUESTION_IN_PROGRESS':
      return state('Too many questions, or an earlier one is still being interpreted. Wait a moment, then try again.', true);
    case 'DATA_QUESTION_BUSY':
    case 'DATA_QUESTION_BUDGET_EXHAUSTED':
      return state('Question interpretation is busy right now. Try again later, or use a question below.', true);
    case 'DATA_QUESTION_TIMEOUT':
      return state('Interpreting the question took too long. Try again, or use a question below.', true);
    case 'DATA_QUESTION_FAILED':
      return state('This question could not be interpreted. Rephrase it, or use a question below.', true);
    case 'DATA_QUESTION_ABORTED':
      return state('The request was cancelled.', true);
    default:
      return state(serverText(error), error.status >= 500 || error.status === 0);
  }
}

/** JSON with object keys sorted, so two equal plans compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right)))
      : inner,
  );
}

export class DataQuestionController {
  readonly #api: DataQuestionApi;
  readonly #onChange: (snapshot: AskSnapshot) => void;
  readonly #orgId: string;
  readonly #onSessionEnd = (): void => this.dispose();
  #session: AbortSignal | undefined;
  #disposed = false;
  #generation = 0;
  #inFlight: AbortController | null = null;
  #capabilityRequest: AbortController | null = null;
  #retry: (() => void) | null = null;
  #snapshot: AskSnapshot;

  public constructor(options: DataQuestionControllerOptions) {
    this.#api = options.api;
    this.#onChange = options.onChange;
    this.#orgId = options.orgId;
    this.#snapshot = { capability: 'checking', context: options.context, state: { kind: 'idle' } };
    const signal = options.signal;
    if (signal?.aborted) this.dispose();
    else if (signal !== undefined) {
      this.#session = signal;
      signal.addEventListener('abort', this.#onSessionEnd, { once: true });
    }
  }

  public get snapshot(): AskSnapshot {
    return this.#snapshot;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  get #busy(): boolean {
    const { state } = this.#snapshot;
    return state.kind === 'interpreting' || state.kind === 'answering' || (state.kind === 'ready' && state.refreshing);
  }

  /** Asks whether interpretation is available. A failure only hides interpretation; predefined questions stay. */
  public start(): void {
    if (this.#disposed) return;
    const controller = new AbortController();
    this.#capabilityRequest = controller;
    void this.#api.capabilities(this.#orgId, controller.signal).then(
      (capabilities) => {
        if (this.#disposed || this.#capabilityRequest !== controller) return;
        this.#capabilityRequest = null;
        this.#emit({ ...this.#snapshot, capability: capabilities.interpretation });
      },
      (error: unknown) => {
        if (this.#disposed || this.#capabilityRequest !== controller || isAbort(error)) return;
        this.#capabilityRequest = null;
        this.#emit({ ...this.#snapshot, capability: 'unavailable' });
      },
    );
  }

  /** A predefined question: resolve its plan and execute it (selecting it is the explicit read request). */
  public ask(intent: DataQuestionIntent): void {
    if (this.#disposed || this.#busy) return;
    this.#retry = () => this.ask(intent);
    const { context } = this.#snapshot;
    this.#setState({ kind: 'answering', plan: null, returnTo: 'idle' });
    this.#request(
      (signal) => this.#api.plan(context, intent, signal),
      (plan) => this.#execute(plan, 'idle'),
    );
  }

  /** Interprets a question into a plan to review. Never reads data. */
  public interpret(text: string): void {
    const question = text.trim();
    if (this.#disposed || this.#busy || question === '') return;
    this.#retry = () => this.interpret(question);
    const { context } = this.#snapshot;
    this.#setState({ kind: 'interpreting' });
    this.#request(
      (signal) => this.#api.interpret(context, question, signal),
      (answer) => {
        if (answer.outcome === 'proposal') this.#setState({ kind: 'proposal', plan: answer.plan });
        else if (answer.outcome === 'clarify') this.#setState({ kind: 'clarify', reason: answer.reason, sourceChoice: answer.sourceChoice });
        else this.#setState({ kind: 'unsupported', reason: answer.reason });
      },
    );
  }

  /** The person's explicit source after a source clarification: the complete intent becomes a plan to review. */
  public chooseSource(source: DataQuestionActivitySource): void {
    const { state } = this.#snapshot;
    if (this.#disposed || state.kind !== 'clarify' || state.sourceChoice === null) return;
    const intent: DataQuestionIntent = { ...state.sourceChoice, source };
    this.#retry = () => {
      this.#setState(state);
      this.chooseSource(source);
    };
    const { context } = this.#snapshot;
    this.#setState({ kind: 'answering', plan: null, returnTo: 'idle' });
    this.#request(
      (signal) => this.#api.plan(context, intent, signal),
      (plan) => this.#setState({ kind: 'proposal', plan }),
    );
  }

  /** Executes the reviewed proposal. */
  public execute(): void {
    const { state } = this.#snapshot;
    if (this.#disposed || state.kind !== 'proposal') return;
    this.#execute(state.plan, 'proposal');
  }

  /** Reads the current answer's plan again; an error replaces the answer (it could show deleted records). */
  public refresh(): void {
    const { state } = this.#snapshot;
    if (this.#disposed || state.kind !== 'ready' || state.refreshing) return;
    const plan = state.answer.plan;
    this.#retry = () => this.#execute(plan, 'idle');
    this.#setState({ ...state, refreshing: true });
    this.#request(
      (signal) => this.#api.answer(plan, signal),
      (answer) => this.#acceptAnswer(plan, answer),
    );
  }

  public retry(): void {
    const { state } = this.#snapshot;
    if (this.#disposed || state.kind !== 'error' || !state.retryable || this.#retry === null) return;
    this.#retry();
  }

  /** Cancels the request in flight: an interpretation returns to idle, an execution to its reviewed proposal. */
  public cancel(): void {
    if (this.#disposed) return;
    const { state } = this.#snapshot;
    this.#abort();
    if (state.kind === 'interpreting') this.#setState({ kind: 'idle' });
    else if (state.kind === 'answering') this.#setState(state.returnTo === 'proposal' && state.plan !== null ? { kind: 'proposal', plan: state.plan } : { kind: 'idle' });
    else if (state.kind === 'ready' && state.refreshing) this.#setState({ ...state, refreshing: false });
  }

  /** Back to an empty question (after an answer, a clarification, a refusal or an error). */
  public dismiss(): void {
    if (this.#disposed) return;
    this.#abort();
    this.#retry = null;
    this.#setState({ kind: 'idle' });
  }

  /** A new selected date or zone: everything about the previous context is dropped. */
  public setContext(context: AskContext): void {
    if (this.#disposed) return;
    const current = this.#snapshot.context;
    if (current.selectedDate === context.selectedDate && current.timeZone === context.timeZone) return;
    this.#abort();
    this.#retry = null;
    this.#emit({ ...this.#snapshot, context, state: { kind: 'idle' } });
  }

  public dispose(): void {
    this.#disposed = true;
    this.#session?.removeEventListener('abort', this.#onSessionEnd);
    this.#session = undefined;
    this.#abort();
    this.#capabilityRequest?.abort();
    this.#capabilityRequest = null;
  }

  #execute(plan: DataQuestionPlan, returnTo: 'idle' | 'proposal'): void {
    this.#retry = () => this.#execute(plan, returnTo);
    this.#setState({ kind: 'answering', plan, returnTo });
    this.#request(
      (signal) => this.#api.answer(plan, signal),
      (answer) => this.#acceptAnswer(plan, answer),
    );
  }

  #acceptAnswer(plan: DataQuestionPlan, answer: DataQuestionAnswer): void {
    if (canonical(answer.plan) !== canonical(plan)) {
      this.#setState({ accessDenied: false, kind: 'error', message: 'The answer did not match the question. Try again.', retryable: true });
      return;
    }
    this.#setState({ answer, kind: 'ready', refreshing: false });
  }

  #request<Value>(run: (signal: AbortSignal) => Promise<Value>, onValue: (value: Value) => void): void {
    this.#abort();
    const controller = new AbortController();
    this.#inFlight = controller;
    const generation = this.#generation;
    const current = () => !this.#disposed && this.#generation === generation;
    void run(controller.signal).then(
      (value) => {
        if (!current()) return;
        this.#inFlight = null;
        onValue(value);
      },
      (error: unknown) => {
        if (!current() || isAbort(error)) return;
        this.#inFlight = null;
        const failure = errorStateOf(error);
        const { interpretationOff, ...errorState } = failure;
        if (interpretationOff === true) this.#emit({ ...this.#snapshot, capability: 'off', state: errorState });
        else this.#setState(errorState);
      },
    );
  }

  #abort(): void {
    this.#generation += 1;
    this.#inFlight?.abort();
    this.#inFlight = null;
  }

  #setState(state: AskState): void {
    this.#emit({ ...this.#snapshot, state });
  }

  #emit(snapshot: AskSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    this.#onChange(snapshot);
  }
}
