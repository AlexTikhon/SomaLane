import type { Clock } from '../clock.js';
import type { DataQuestionsConfig } from '../config/data-questions-config.js';
import type { Environment } from '../config/environment.js';
import type { LlmProvider } from '../insights/llm-provider.js';
import { OllamaProvider } from '../insights/ollama-provider.js';
import type { ApiMetrics } from '../observability/api-metrics.js';
import type { Logger } from '../observability/logger.js';
import { InterpretationAdmission } from '../runs/interpretation/interpretation-admission.js';
import { DataQuestionInterpretationService } from './data-question-interpretation-service.js';
import { FakeDataQuestionProvider } from './fake-data-question-provider.js';

/**
 * The provider of the configured mode, and only that one: exhaustive, no fallback. The Ollama adapter is the weekly
 * insight's (one non-streaming chat request with the JSON schema as `format`, a bounded body, no redirect, one attempt,
 * never a retry), used unchanged; only its address and limits come from this feature's own configuration.
 */
export function createDataQuestionProvider(config: DataQuestionsConfig): LlmProvider {
  switch (config.provider) {
    case 'fake':
      return new FakeDataQuestionProvider();
    case 'ollama':
      return new OllamaProvider({ baseUrl: config.baseUrl, maxResponseBytes: config.maxResponseBytes, model: config.model });
    default:
      return unsupported(config);
  }
}

function unsupported(config: never): never {
  throw new Error(`Unsupported data questions provider: ${String((config as { provider?: unknown }).provider).slice(0, 32)}`);
}

export interface DataQuestionFactoryOptions {
  clock: Clock;
  config: Environment;
  logger: Logger;
  metrics?: ApiMetrics['dataQuestions'];
  /** Replaces the configured provider. Only reachable through the test-only application dependency. */
  provider?: LlmProvider;
}

/** The interpretation service, or undefined when DATA_QUESTIONS_PROVIDER=off: then no provider object exists. */
export function createDataQuestionInterpretationService({
  clock,
  config,
  logger,
  metrics,
  provider,
}: DataQuestionFactoryOptions): DataQuestionInterpretationService | undefined {
  const settings = config.DATA_QUESTIONS;
  if (settings === undefined) return undefined;
  const chosen = provider ?? createDataQuestionProvider(settings);
  logger.info('data_question.enabled', { model: chosen.model, reason: settings.provider });
  return new DataQuestionInterpretationService({
    admission: new InterpretationAdmission({
      allowance: settings.allowance,
      clock,
      maxConcurrent: settings.maxConcurrent,
      maxUsers: settings.limiterMaxUsers,
      userRate: settings.userRate,
    }),
    clock,
    logger,
    maxOutputTokens: settings.maxOutputTokens,
    ...(metrics === undefined ? {} : { metrics }),
    provider: chosen,
    timeoutMs: settings.timeoutMs,
  });
}
