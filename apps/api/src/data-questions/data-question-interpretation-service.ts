import {
  DATA_QUESTION_CONTRACT_VERSION,
  DATA_QUESTION_ERROR_CODES,
  dataQuestionInterpretationResponseSchema,
  type DataQuestionFailureReason,
  type DataQuestionInterpretationResponse,
} from '@running-tracker/contracts';

import type { Clock } from '../clock.js';
import { ApiError } from '../http/errors.js';
import { LlmProviderError, type LlmProvider, type LlmStructuredInput, type LlmStructuredResult } from '../insights/llm-provider.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import type { Logger } from '../observability/logger.js';
import {
  AdmissionRejectedError,
  type AdmissionRejection,
  type AdmissionTicket,
  type InterpretationAdmission,
} from '../runs/interpretation/interpretation-admission.js';
import { normalizeDataQuestion } from './data-question-normalizer.js';
import { resolveDataQuestionPlan } from './data-question-plan.js';
import { buildDataQuestionMessages } from './data-question-prompt.js';
import { dataQuestionWireJsonSchema, dataQuestionWireSchema } from './data-question-wire.js';

// One "Ask my data" interpretation (ADR-0094): admission, one model call under a hard deadline, the wire schema,
// deterministic normalization, plan resolution by the server's clock, and a last access check before the answer leaves.
// It owns no HTTP and no database: the route has checked access and the context, and `revalidate` is how it asks again.
// It never executes a plan: a proposal is returned for the person to review.
//
// The two lifetimes of ADR-0057 (addendum), unchanged and shared with meal drafts (ADR-0092): the REQUEST ends at the
// deadline or when the client leaves and is answered then; the OPERATION (the provider's promise) ends when it settles,
// and only then are its admission places released. A late answer is dropped unread. No retry, ever.

export interface DataQuestionInterpretationServiceOptions {
  admission: InterpretationAdmission;
  clock: Clock;
  logger: Logger;
  maxOutputTokens: number;
  metrics?: ApiMetrics['dataQuestions'];
  provider: LlmProvider;
  /** Hard deadline for the whole provider call, response body included. */
  timeoutMs: number;
}

export interface DataQuestionInterpretationRequest {
  /** The validated selected date and zone; the selected date was checked against today in the zone. */
  context: { selectedDate: string; timeZone: string };
  requestId: string;
  /** Called after the answer was normalized and before anything is returned; throws the authorization error if access is gone. */
  revalidate: () => Promise<void>;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
  /** The question, already checked against the request contract. */
  text: string;
  userId: string;
}

/** The only thing about a request that is ever logged or counted: never the question, the answer or the person. */
export type DataQuestionInterpretationOutcome =
  | 'aborted'
  | 'access_lost'
  | 'clarify'
  | 'incomplete'
  | 'invalid_output'
  | 'oversized'
  | 'proposal'
  | 'provider_error'
  | 'provider_unavailable'
  | 'rejected_budget_exhausted'
  | 'rejected_busy'
  | 'rejected_in_progress'
  | 'rejected_rate_limited'
  | 'timeout'
  | 'unsupported';

class RequestInterrupted extends Error {
  public constructor(public readonly reason: 'aborted' | 'timeout') {
    super(`The data question request ended: ${reason}`);
    this.name = 'RequestInterrupted';
  }
}

class ServiceFailure extends Error {
  public constructor(public readonly reason: DataQuestionFailureReason) {
    super(`The data question interpretation failed: ${reason}`);
    this.name = 'ServiceFailure';
  }
}

const rejection: Record<AdmissionRejection, { code: string; message: string; status: number }> = {
  budget_exhausted: {
    code: DATA_QUESTION_ERROR_CODES.budgetExhausted,
    message: 'The question interpretation allowance of this server is used up for now',
    status: 503,
  },
  busy: { code: DATA_QUESTION_ERROR_CODES.busy, message: 'Question interpretation is busy; try again shortly', status: 503 },
  in_progress: { code: DATA_QUESTION_ERROR_CODES.inProgress, message: 'An earlier question of yours is still being interpreted', status: 429 },
  rate_limited: { code: DATA_QUESTION_ERROR_CODES.rateLimited, message: 'Too many questions; try again shortly', status: 429 },
};

function providerFailure(error: unknown): DataQuestionInterpretationOutcome {
  if (!(error instanceof LlmProviderError)) return 'provider_error';
  switch (error.reason) {
    case 'aborted':
      return 'aborted';
    case 'timeout':
      return 'timeout';
    case 'incomplete':
      return 'incomplete';
    case 'invalid_response':
      return 'invalid_output';
    case 'oversized':
      return 'oversized';
    case 'unavailable':
      return 'provider_unavailable';
    case 'provider_error':
      return 'provider_error';
  }
}

function toError(outcome: DataQuestionInterpretationOutcome, error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AdmissionRejectedError) {
    const mapped = rejection[error.reason];
    return new ApiError(
      mapped.status,
      mapped.code,
      mapped.message,
      error.retryAfterMs === null ? undefined : { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) },
    );
  }
  if (outcome === 'timeout') return new ApiError(504, DATA_QUESTION_ERROR_CODES.timeout, 'Question interpretation did not answer in time');
  if (outcome === 'aborted') return new ApiError(499, DATA_QUESTION_ERROR_CODES.aborted, 'The interpretation request was cancelled');
  const reason: DataQuestionFailureReason =
    error instanceof ServiceFailure
      ? error.reason
      : (['incomplete', 'invalid_output', 'oversized', 'provider_unavailable'] as const).find((value) => value === outcome) ?? 'provider_error';
  return new ApiError(502, DATA_QUESTION_ERROR_CODES.failed, 'This question could not be interpreted', { reason });
}

export class DataQuestionInterpretationService {
  readonly #options: DataQuestionInterpretationServiceOptions;

  public constructor(options: DataQuestionInterpretationServiceOptions) {
    this.#options = options;
  }

  public get model(): string {
    return this.#options.provider.model;
  }

  public async interpret(request: DataQuestionInterpretationRequest): Promise<DataQuestionInterpretationResponse> {
    const { admission, clock, logger, metrics, provider } = this.#options;
    const startedAt = clock.monotonicNow();
    let outcome: DataQuestionInterpretationOutcome = 'provider_error';

    try {
      if (request.signal.aborted) {
        outcome = 'aborted';
        throw new RequestInterrupted('aborted');
      }

      let ticket: AdmissionTicket;
      try {
        ticket = admission.admit(request.userId);
      } catch (error) {
        if (error instanceof AdmissionRejectedError) outcome = `rejected_${error.reason}`;
        throw error;
      }

      let answer: LlmStructuredResult;
      try {
        answer = await this.#run(request, ticket);
      } catch (error) {
        outcome = error instanceof RequestInterrupted ? error.reason : providerFailure(error);
        throw error;
      }

      const wire = dataQuestionWireSchema.safeParse(answer.value);
      if (!wire.success) {
        outcome = 'invalid_output';
        throw new ServiceFailure('invalid_output');
      }

      const normalized = normalizeDataQuestion(request.text, wire.data);
      let response: DataQuestionInterpretationResponse;
      const version = DATA_QUESTION_CONTRACT_VERSION;
      if (normalized.outcome === 'intent') {
        try {
          response = { outcome: 'proposal', plan: resolveDataQuestionPlan(normalized.intent, request.context, clock), version };
        } catch (error) {
          // A symbol the server cannot resolve into supported dates (yesterday before 2000-01-01) is not guessed at.
          if (!(error instanceof ApiError) || error.statusCode !== 400) throw error;
          response = { outcome: 'clarify', reason: 'period_ambiguous', sourceChoice: null, version };
        }
      } else if (normalized.outcome === 'clarify') {
        response = { outcome: 'clarify', reason: normalized.reason, sourceChoice: normalized.sourceChoice, version };
      } else {
        response = { outcome: 'unsupported', reason: normalized.reason, version };
      }

      try {
        await request.revalidate();
      } catch (error) {
        outcome = 'access_lost';
        throw error;
      }
      outcome = response.outcome;
      return dataQuestionInterpretationResponseSchema.parse(response);
    } catch (error) {
      throw toError(outcome, error);
    } finally {
      const durationMs = Math.max(0, Math.round(clock.monotonicNow() - startedAt));
      const fields = { durationMs, model: provider.model, outcome, requestId: request.requestId };
      if (outcome === 'proposal' || outcome === 'clarify' || outcome === 'unsupported') logger.info('data_question.interpretation', fields);
      else logger.warn('data_question.interpretation', fields);
      metrics?.interpretations.inc({ outcome });
      metrics?.interpretationSeconds.observe({ outcome }, durationMs / 1_000);
    }
  }

  /**
   * Starts the one provider call and waits for it for as long as the REQUEST may. The ticket is released only when the
   * provider's own promise settles, never on a timer and never when the request gives up.
   */
  async #run(request: DataQuestionInterpretationRequest, ticket: AdmissionTicket): Promise<LlmStructuredResult> {
    const { clock, logger, maxOutputTokens, provider, timeoutMs } = this.#options;
    const controller = new AbortController();

    let input: LlmStructuredInput;
    try {
      input = buildDataQuestionMessages(request.text, request.context);
    } catch (error) {
      ticket.release({ dispatched: false });
      throw error;
    }

    const dispatchedAt = clock.monotonicNow();
    let call: Promise<LlmStructuredResult>;
    try {
      call = Promise.resolve(provider.generateStructured(input, dataQuestionWireJsonSchema, { maxOutputTokens, signal: controller.signal, timeoutMs }));
    } catch (error) {
      ticket.release({ dispatched: true });
      throw error;
    }

    let requestEnded = false;
    const settled = (reason: 'fulfilled' | 'rejected'): void => {
      ticket.release({ dispatched: true });
      if (requestEnded) {
        logger.info('data_question.operation_settled', {
          durationMs: Math.max(0, Math.round(clock.monotonicNow() - dispatchedAt)),
          model: provider.model,
          reason,
          requestId: request.requestId,
        });
      }
    };
    const operation = call.then(
      (answer) => {
        settled('fulfilled');
        return answer;
      },
      (error: unknown) => {
        settled('rejected');
        throw error;
      },
    );
    operation.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClientAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = clock.setTimeout(() => {
        reject(new RequestInterrupted('timeout'));
        controller.abort();
      }, timeoutMs);
      onClientAbort = () => {
        reject(new RequestInterrupted('aborted'));
        controller.abort();
      };
      request.signal.addEventListener('abort', onClientAbort, { once: true });
    });
    interrupted.catch(() => undefined);

    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      requestEnded = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      if (onClientAbort !== undefined) request.signal.removeEventListener('abort', onClientAbort);
      controller.abort();
    }
  }
}
