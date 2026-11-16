import { MEAL_DRAFT_DEADLINE_MAX_MS } from '@running-tracker/contracts';
import { z } from 'zod';

import { isLocalOllamaModel } from '../config/run-search-ai-config.js';
import { OLLAMA_INSIGHT_GENERATION } from '../insights/ollama-provider.js';

// The EXECUTION PROFILE of a real-model evaluation run (ADR-0092): everything about how the model was called that can
// change its answers or which answers count. It is built and validated BEFORE the first call, from the same values that
// configure the call (the adapter's fixed generation constants, the run's output limit, deadline and response limit, and
// the model and runtime the local Ollama reports), and every outgoing request is then checked against it, so a profile
// cannot describe one configuration while another was used. Model evidence is only comparable between runs with the
// same profile; the model gate requires it for both sets.

export const MEAL_DRAFT_PROFILE_VERSION = 1;

const generationSchema = z.strictObject({
  numCtx: z.number().int().min(256).max(1_048_576),
  numPredict: z.number().int().min(64).max(2_000),
  stream: z.literal(false),
  temperature: z.number().finite().min(0).max(2),
  think: z.boolean(),
});

export const mealDraftExecutionProfileSchema = z.strictObject({
  /** One call per case; the evaluation never asks twice. */
  callsPerCase: z.literal(1),
  generation: generationSchema,
  maxResponseBytes: z.number().int().min(1_024).max(262_144),
  model: z.string().min(1).max(64).refine(isLocalOllamaModel, 'must name a local Ollama model'),
  modelDigest: z.string().regex(/^[0-9a-f]{64}$/u, 'must be the SHA-256 the runtime reports'),
  ollamaVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u, 'must be the version the runtime reports'),
  profileVersion: z.literal(MEAL_DRAFT_PROFILE_VERSION),
  provider: z.literal('ollama'),
  retries: z.literal(0),
  sequential: z.literal(true),
  timeoutMs: z.number().int().min(1_000).max(MEAL_DRAFT_DEADLINE_MAX_MS),
});

export type MealDraftExecutionProfile = z.infer<typeof mealDraftExecutionProfileSchema>;
export type MealDraftGeneration = MealDraftExecutionProfile['generation'];

/** The profile of a run about to start. Throws (naming the fields) when the configuration cannot be described exactly. */
export function buildExecutionProfile(input: {
  maxOutputTokens: number;
  maxResponseBytes: number;
  model: string;
  modelDigest: string | null;
  ollamaVersion: string | null;
  timeoutMs: number;
}): MealDraftExecutionProfile {
  const parsed = mealDraftExecutionProfileSchema.safeParse({
    callsPerCase: 1,
    generation: {
      numCtx: OLLAMA_INSIGHT_GENERATION.numCtx,
      numPredict: input.maxOutputTokens,
      stream: false,
      temperature: OLLAMA_INSIGHT_GENERATION.temperature,
      think: OLLAMA_INSIGHT_GENERATION.think,
    },
    maxResponseBytes: input.maxResponseBytes,
    model: input.model,
    modelDigest: input.modelDigest,
    ollamaVersion: input.ollamaVersion,
    profileVersion: MEAL_DRAFT_PROFILE_VERSION,
    provider: 'ollama',
    retries: 0,
    sequential: true,
    timeoutMs: input.timeoutMs,
  });
  if (!parsed.success) throw new Error(`The execution profile cannot be established: ${profileIssues(parsed.error).join('; ')}`);
  return parsed.data;
}

export function profileIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || '(profile)'} ${issue.message}`);
}

/** Leaf paths whose values differ (`generation.temperature`, `timeoutMs`…), in a stable order. */
export function valueDifferences(left: unknown, right: unknown, prefix = ''): string[] {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (isRecord(left) && isRecord(right)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((key) => valueDifferences(left[key], right[key], prefix === '' ? key : `${prefix}.${key}`));
  }
  return Object.is(left, right) ? [] : [prefix === '' ? '(value)' : prefix];
}

export interface ProfileCheck {
  /** Requests whose body did not match the profile; each was refused before it was sent. */
  mismatches: number;
  /** Requests the adapter tried to send. */
  requests: number;
}

/**
 * A `fetch` for the Ollama adapter that compares every request it is asked to send with the profile (model, stream,
 * think, and exactly the options num_ctx, num_predict and temperature). A request that does not match is refused
 * before it leaves the process (the call fails, nothing is inferred) and counted.
 */
export function createProfileGuard(profile: MealDraftExecutionProfile, base: typeof fetch): { check: () => ProfileCheck; fetch: typeof fetch } {
  const counts: ProfileCheck = { mismatches: 0, requests: 0 };
  const expected = {
    model: profile.model,
    options: { num_ctx: profile.generation.numCtx, num_predict: profile.generation.numPredict, temperature: profile.generation.temperature },
    stream: profile.generation.stream,
    think: profile.generation.think,
  };
  const guarded: typeof fetch = async (input, init) => {
    counts.requests += 1;
    let actual: unknown;
    try {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as Record<string, unknown> | null;
      actual = body === null ? null : { model: body['model'], options: body['options'], stream: body['stream'], think: body['think'] };
    } catch {
      actual = null;
    }
    if (actual === null || valueDifferences(expected, actual).length > 0) {
      counts.mismatches += 1;
      throw new Error('The request does not match the execution profile; it was not sent');
    }
    return base(input, init);
  };
  return { check: () => ({ ...counts }), fetch: guarded };
}
