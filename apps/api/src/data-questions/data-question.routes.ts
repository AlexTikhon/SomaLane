import {
  DATA_QUESTION_CONTRACT_VERSION,
  DATA_QUESTION_ERROR_CODES,
  dataQuestionAnswerRequestSchema,
  dataQuestionCapabilitiesSchema,
  dataQuestionInterpretationRequestSchema,
  dataQuestionPlanRequestSchema,
  dataQuestionPlanResponseSchema,
  organizationPathSchema,
} from '@running-tracker/contracts';
import type { Request, RequestHandler, Router } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import { z, type ZodType } from 'zod';

import { createAuthenticatedMutationProtection, createSessionAuthentication, getAuthenticatedSession } from '../auth/session-http.js';
import type { SessionManager } from '../auth/session-manager.js';
import { SessionStoreUnavailableError } from '../auth/session-store.js';
import type { Clock } from '../clock.js';
import type { Environment } from '../config/environment.js';
import { canonicalTimeZone } from '../daily-metrics/daily-metrics-service.js';
import { withAuthenticatedTenantTransaction } from '../database/authenticated-tenant-transaction.js';
import { ApiError, sessionStoreUnavailable } from '../http/errors.js';
import { getRequestId } from '../http/request-id.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import type { Logger } from '../observability/logger.js';
import { localDateOf } from '../runs/run-search-period.js';
import type { DataQuestionExecutor } from './data-question-executor.js';
import type { DataQuestionInterpretationService } from './data-question-interpretation-service.js';
import { resolveDataQuestionPlan } from './data-question-plan.js';

interface DataQuestionRouterDependencies {
  clock: Clock;
  config: Environment;
  executor: DataQuestionExecutor;
  /** Undefined when DATA_QUESTIONS_PROVIDER=off. */
  interpretation?: DataQuestionInterpretationService;
  logger: Logger;
  metrics?: ApiMetrics['dataQuestions'];
  pool: Pick<Pool, 'connect'>;
  sessionManager: SessionManager;
}

function parseContract<Output>(schema: ZodType<Output>, input: unknown, label: string): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, 'INVALID_REQUEST', `The ${label} is invalid`, {
      fields: parsed.error.issues.map(({ message, path }) => ({ message, path })),
    });
  }
  return parsed.data;
}

const noQuerySchema = z.strictObject({});

/**
 * Health data: no response under this path, an error included, may be stored by a cache that does not know the session.
 * `app.ts` also mounts it before the JSON body parser, so a malformed or oversized body's error carries it too.
 */
export const dataQuestionsNoStore: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

const requireJson: RequestHandler = (request, _response, next) => {
  if (!request.is('application/json')) {
    next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    return;
  }
  next();
};

function organizationOf(request: Request): string {
  return parseContract(organizationPathSchema, request.params, 'organization path').orgId.toLowerCase();
}

/**
 * "Ask my data" under /api/orgs/:orgId/data-questions (ADR-0094). Owner-only and read-only: the owner is always the
 * session's identity and the organization the path's; no body names either. Four routes:
 * - GET  /capabilities: whether interpretation is available (no implementation detail);
 * - POST /plans: a symbolic intent resolved into a plan, deterministically (membership checked, no record read);
 * - POST /interpretations: a question interpreted into a plan to review (optional model, never executes anything);
 * - POST /answers: a reviewed plan executed by exactly one allowlisted service read.
 * Nothing about a question, a plan or an answer is stored, cached or logged; logs and metrics carry bounded codes.
 */
export function createDataQuestionRouter({
  clock,
  config,
  executor,
  interpretation,
  logger,
  metrics,
  pool,
  sessionManager,
}: DataQuestionRouterDependencies): Router {
  const router = createRouter({ mergeParams: true });
  const authenticate = createSessionAuthentication(sessionManager);
  const mutationProtection = createAuthenticatedMutationProtection(config, sessionManager);
  const version = DATA_QUESTION_CONTRACT_VERSION;

  router.use(dataQuestionsNoStore);

  router.get('/capabilities', authenticate, async (request, response, next) => {
    try {
      const orgId = organizationOf(request);
      parseContract(noQuerySchema, request.query, 'capabilities query');
      const session = getAuthenticatedSession(request);
      await withAuthenticatedTenantTransaction(pool, session, orgId, () => Promise.resolve());
      response.status(200).json(dataQuestionCapabilitiesSchema.parse({ interpretation: interpretation === undefined ? 'off' : 'available', version }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/plans', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const orgId = organizationOf(request);
      parseContract(noQuerySchema, request.query, 'data question query');
      const body = parseContract(dataQuestionPlanRequestSchema, request.body, 'data question plan request');
      const session = getAuthenticatedSession(request);
      await withAuthenticatedTenantTransaction(pool, session, orgId, () => Promise.resolve());
      const plan = resolveDataQuestionPlan(body.intent, { selectedDate: body.selectedDate, timeZone: body.timeZone }, clock);
      response.status(200).json(dataQuestionPlanResponseSchema.parse({ plan, version }));
    } catch (error) {
      next(error);
    }
  });

  // The membership is asked before the model is called and again (with the session) before the answer leaves, each in its
  // own short transaction, so no connection is held while the model works. The context's date rules apply first.
  router.post('/interpretations', ...mutationProtection, requireJson, async (request, response, next) => {
    try {
      const orgId = organizationOf(request);
      parseContract(noQuerySchema, request.query, 'data question query');
      const body = parseContract(dataQuestionInterpretationRequestSchema, request.body, 'data question interpretation request');
      const session = getAuthenticatedSession(request);
      if (interpretation === undefined) {
        throw new ApiError(503, DATA_QUESTION_ERROR_CODES.disabled, 'Question interpretation is not enabled on this server; predefined questions still work');
      }
      const timeZone = canonicalTimeZone(body.timeZone);
      const today = localDateOf(clock.utcNow().getTime(), timeZone);
      if (body.selectedDate > today) {
        const message = `The selected date cannot be after today (${today} in ${timeZone})`;
        throw new ApiError(400, 'INVALID_REQUEST', message, { fields: [{ message, path: ['selectedDate'] }] });
      }

      const verifyAccess = async (): Promise<void> => {
        await withAuthenticatedTenantTransaction(pool, session, orgId, () => Promise.resolve());
      };
      await verifyAccess();

      const clientGone = new AbortController();
      response.once('close', () => {
        if (!response.writableFinished) clientGone.abort();
      });

      const answer = await interpretation.interpret({
        context: { selectedDate: body.selectedDate, timeZone },
        requestId: getRequestId(request),
        revalidate: async () => {
          let active: boolean;
          try {
            active = (await sessionManager.isActive(session)) === true;
          } catch (error) {
            throw error instanceof SessionStoreUnavailableError ? sessionStoreUnavailable() : error;
          }
          if (!active) throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
          await verifyAccess();
        },
        signal: clientGone.signal,
        text: body.text,
        userId: session.userId,
      });
      response.status(200).json(answer);
    } catch (error) {
      const retryAfter = (error as ApiError | undefined)?.details?.retryAfterSeconds;
      if (typeof retryAfter === 'number') response.setHeader('Retry-After', String(retryAfter));
      next(error);
    }
  });

  router.post('/answers', ...mutationProtection, requireJson, async (request, response, next) => {
    const startedAt = clock.monotonicNow();
    let operation = 'unknown';
    let outcome: 'answered' | 'failed' | 'refused' = 'failed';
    try {
      const orgId = organizationOf(request);
      parseContract(noQuerySchema, request.query, 'data question query');
      const body = parseContract(dataQuestionAnswerRequestSchema, request.body, 'data question answer request');
      operation = body.plan.operation;
      const session = getAuthenticatedSession(request);
      const answer = await executor.answer(session, orgId, body.plan);
      outcome = 'answered';
      response.status(200).json(answer);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode < 500) outcome = 'refused';
      next(error);
    } finally {
      const durationMs = Math.max(0, Math.round(clock.monotonicNow() - startedAt));
      logger.info('data_question.answer', { durationMs, outcome, requestId: getRequestId(request), task: operation });
      metrics?.answers.inc({ operation, outcome });
    }
  });

  return router;
}
