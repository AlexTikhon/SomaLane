import { DATA_QUESTION_DEADLINE_MAX_MS } from '@running-tracker/contracts';
import { z } from 'zod';

import { isLocalOllamaModel } from './run-search-ai-config.js';
import { DEFAULT_OLLAMA_BASE_URL, isLocalOllamaBaseUrl } from './weekly-insights-config.js';

// Configuration of question interpretation for "Ask my data" (ADR-0094). Its own flag, off by default and independent of
// meal drafts, the run-search interpreter and the weekly insight. Off means: no provider object exists, no model is
// contacted, the interpretation route answers 503 and the capability route says `off`. Predefined questions and the
// deterministic answers never depend on this setting. `ollama` is a local Ollama (the weekly insight's address rule);
// `fake` is the deterministic stand-in for automated tests, refused in production and never model-quality evidence.

const integer = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);

export const DATA_QUESTIONS_TIMEOUT_MAX_MS = DATA_QUESTION_DEADLINE_MAX_MS;
const USER_RATE_WINDOW_MS = 60_000;

export const dataQuestionsEnvironmentFields = {
  DATA_QUESTIONS_ALLOWANCE: integer(1, 100_000).default(200),
  DATA_QUESTIONS_ALLOWANCE_WINDOW_MS: integer(1_000, 7 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  DATA_QUESTIONS_LIMITER_MAX_USERS: integer(1, 100_000).default(1_000),
  // A local Ollama serves one request at a time by default, so one is the honest default.
  DATA_QUESTIONS_MAX_CONCURRENT: integer(1, 8).default(1),
  DATA_QUESTIONS_MAX_OUTPUT_TOKENS: integer(64, 2_000).default(300),
  DATA_QUESTIONS_MAX_RESPONSE_BYTES: integer(1_024, 262_144).default(32_768),
  DATA_QUESTIONS_MODEL: z.string().max(64).optional(),
  DATA_QUESTIONS_OLLAMA_BASE_URL: z.string().max(256).default(DEFAULT_OLLAMA_BASE_URL),
  DATA_QUESTIONS_PROVIDER: z.enum(['off', 'ollama', 'fake']).default('off'),
  DATA_QUESTIONS_TIMEOUT_MS: integer(1_000, DATA_QUESTIONS_TIMEOUT_MAX_MS).default(45_000),
  DATA_QUESTIONS_USER_RATE_PER_MINUTE: integer(1, 60).default(5),
};

type DataQuestionsFieldValues = z.output<z.ZodObject<typeof dataQuestionsEnvironmentFields>>;

interface DataQuestionsLimits {
  /** Dispatches the whole process may make in `windowMs`; failures after dispatch still count. */
  readonly allowance: { readonly perWindow: number; readonly windowMs: number };
  readonly limiterMaxUsers: number;
  readonly maxConcurrent: number;
  readonly maxOutputTokens: number;
  /** Deadline of the one model call, response body included. */
  readonly timeoutMs: number;
  readonly userRate: { readonly perWindow: number; readonly windowMs: number };
}

export interface FakeDataQuestionsConfig extends DataQuestionsLimits {
  readonly model: 'fake';
  readonly provider: 'fake';
}

export interface OllamaDataQuestionsConfig extends DataQuestionsLimits {
  readonly baseUrl: string;
  readonly maxResponseBytes: number;
  readonly model: string;
  readonly provider: 'ollama';
}

export type DataQuestionsConfig = FakeDataQuestionsConfig | OllamaDataQuestionsConfig;

export function checkDataQuestionsEnvironment(
  values: DataQuestionsFieldValues,
  environment: { readonly APP_ENV: 'development' | 'production' | 'test' },
  context: z.RefinementCtx,
): void {
  const fail = (path: string, message: string): void => {
    context.addIssue({ code: 'custom', message, path: [path] });
  };
  if (values.DATA_QUESTIONS_PROVIDER === 'off') return;
  if (values.DATA_QUESTIONS_PROVIDER === 'fake') {
    if (environment.APP_ENV === 'production') fail('DATA_QUESTIONS_PROVIDER', 'DATA_QUESTIONS_PROVIDER must be off or ollama in production');
    return;
  }
  const model = values.DATA_QUESTIONS_MODEL?.trim() ?? '';
  if (model === '') {
    fail('DATA_QUESTIONS_MODEL', 'DATA_QUESTIONS_MODEL must be set when DATA_QUESTIONS_PROVIDER is ollama');
  } else if (!isLocalOllamaModel(model)) {
    fail(
      'DATA_QUESTIONS_MODEL',
      `DATA_QUESTIONS_MODEL "${model.slice(0, 64)}" is not a name of a local Ollama model (a name check only; cloud models are refused)`,
    );
  }
  if (!isLocalOllamaBaseUrl(values.DATA_QUESTIONS_OLLAMA_BASE_URL)) {
    fail(
      'DATA_QUESTIONS_OLLAMA_BASE_URL',
      'DATA_QUESTIONS_OLLAMA_BASE_URL must be an http(s) origin of a local Ollama: loopback, a private address, host.docker.internal or a single-label service name, without credentials or a path',
    );
  }
}

/** The validated settings, or undefined when interpretation is off. */
export function buildDataQuestionsConfig(values: DataQuestionsFieldValues): DataQuestionsConfig | undefined {
  const limits: DataQuestionsLimits = {
    allowance: { perWindow: values.DATA_QUESTIONS_ALLOWANCE, windowMs: values.DATA_QUESTIONS_ALLOWANCE_WINDOW_MS },
    limiterMaxUsers: values.DATA_QUESTIONS_LIMITER_MAX_USERS,
    maxConcurrent: values.DATA_QUESTIONS_MAX_CONCURRENT,
    maxOutputTokens: values.DATA_QUESTIONS_MAX_OUTPUT_TOKENS,
    timeoutMs: values.DATA_QUESTIONS_TIMEOUT_MS,
    userRate: { perWindow: values.DATA_QUESTIONS_USER_RATE_PER_MINUTE, windowMs: USER_RATE_WINDOW_MS },
  };
  switch (values.DATA_QUESTIONS_PROVIDER) {
    case 'off':
      return undefined;
    case 'fake':
      return { ...limits, model: 'fake', provider: 'fake' };
    case 'ollama': {
      const model = values.DATA_QUESTIONS_MODEL?.trim() ?? '';
      if (model === '') throw new Error('DATA_QUESTIONS_MODEL must be set when DATA_QUESTIONS_PROVIDER is ollama');
      return {
        ...limits,
        baseUrl: new URL(values.DATA_QUESTIONS_OLLAMA_BASE_URL).origin,
        maxResponseBytes: values.DATA_QUESTIONS_MAX_RESPONSE_BYTES,
        model,
        provider: 'ollama',
      };
    }
    default:
      return assertNever(values.DATA_QUESTIONS_PROVIDER);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported data questions provider: ${String(value).slice(0, 32)}`);
}

/** The configuration without the raw variables. */
export function withoutDataQuestionsFields<Environment extends DataQuestionsFieldValues>(
  environment: Environment,
): Omit<Environment, keyof DataQuestionsFieldValues> {
  const remaining: Record<string, unknown> = { ...environment };
  for (const key of Object.keys(dataQuestionsEnvironmentFields)) delete remaining[key];
  return remaining as Omit<Environment, keyof DataQuestionsFieldValues>;
}
