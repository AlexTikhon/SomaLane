import { describe, expect, it } from 'vitest';

import { OllamaProvider } from '../insights/ollama-provider.js';
import { buildMealDraftMessages } from '../meals/drafts/meal-draft-prompt.js';
import { mealDraftWireJsonSchema } from '../meals/drafts/meal-draft-wire.js';
import { collectReproducibilityMetadata, normalizedDigest, readGitState, type GitRunner } from './meal-draft-metadata.js';
import { buildExecutionProfile, createProfileGuard, mealDraftExecutionProfileSchema, valueDifferences } from './meal-draft-profile.js';

const digest = 'b'.repeat(64);
const settings = { maxOutputTokens: 600, maxResponseBytes: 32_768, model: 'qwen3:8b', modelDigest: digest, ollamaVersion: '0.40.16', timeoutMs: 45_000 };

describe('execution profile', () => {
  it('is built from the adapter constants and the run settings, before any call', () => {
    expect(buildExecutionProfile(settings)).toEqual({
      callsPerCase: 1,
      generation: { numCtx: 4_096, numPredict: 600, stream: false, temperature: 0, think: false },
      maxResponseBytes: 32_768,
      model: 'qwen3:8b',
      modelDigest: digest,
      ollamaVersion: '0.40.16',
      profileVersion: 1,
      provider: 'ollama',
      retries: 0,
      sequential: true,
      timeoutMs: 45_000,
    });
  });

  it('cannot be established without the model digest or the runtime version, or with a setting out of range', () => {
    expect(() => buildExecutionProfile({ ...settings, modelDigest: null })).toThrow(/modelDigest/u);
    expect(() => buildExecutionProfile({ ...settings, ollamaVersion: null })).toThrow(/ollamaVersion/u);
    expect(() => buildExecutionProfile({ ...settings, timeoutMs: 60_000 })).toThrow(/timeoutMs/u);
    expect(() => buildExecutionProfile({ ...settings, model: 'qwen3:8b-cloud' })).toThrow(/model/u);
  });

  it('refuses unknown fields, retries and streaming in a recorded profile', () => {
    const profile = buildExecutionProfile(settings);
    expect(mealDraftExecutionProfileSchema.safeParse({ ...profile, retries: 1 }).success).toBe(false);
    expect(mealDraftExecutionProfileSchema.safeParse({ ...profile, generation: { ...profile.generation, stream: true } }).success).toBe(false);
    expect(mealDraftExecutionProfileSchema.safeParse({ ...profile, extra: true }).success).toBe(false);
    const withoutGeneration: Partial<typeof profile> = { ...profile };
    delete withoutGeneration.generation;
    expect(mealDraftExecutionProfileSchema.safeParse(withoutGeneration).success).toBe(false);
  });

  it('names the leaves that differ', () => {
    const profile = buildExecutionProfile(settings);
    expect(valueDifferences(profile, { ...profile, generation: { ...profile.generation, temperature: 0.7 }, timeoutMs: 55_000 })).toEqual(['generation.temperature', 'timeoutMs']);
    expect(valueDifferences(undefined, profile.generation, 'metadata.generation')).toEqual(['metadata.generation']);
    expect(valueDifferences(profile, structuredClone(profile))).toEqual([]);
  });
});

describe('profile guard on the production adapter', () => {
  const ollamaReply = () =>
    new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ outcome: 'unsupported', reason: 'not_a_meal' }), role: 'assistant' } }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });

  it('lets through exactly the requests the profile describes and counts them', async () => {
    const profile = buildExecutionProfile(settings);
    let sent = 0;
    const guard = createProfileGuard(profile, () => {
      sent += 1;
      return Promise.resolve(ollamaReply());
    });
    const adapter = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', fetch: guard.fetch, maxResponseBytes: profile.maxResponseBytes, model: profile.model });
    const result = await adapter.generateStructured(buildMealDraftMessages('Hello'), mealDraftWireJsonSchema, { maxOutputTokens: 600, timeoutMs: 5_000 });
    expect(result.value).toEqual({ outcome: 'unsupported', reason: 'not_a_meal' });
    expect(sent).toBe(1);
    expect(guard.check()).toEqual({ mismatches: 0, requests: 1 });
  });

  it('refuses, before sending, a request whose generation options or model differ from the profile', async () => {
    const profile = buildExecutionProfile(settings);
    let sent = 0;
    const network = () => {
      sent += 1;
      return Promise.resolve(ollamaReply());
    };
    // The adapter asked for another output limit than the profile recorded.
    const guard = createProfileGuard(profile, network);
    const adapter = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', fetch: guard.fetch, maxResponseBytes: profile.maxResponseBytes, model: profile.model });
    await expect(adapter.generateStructured(buildMealDraftMessages('Hello'), mealDraftWireJsonSchema, { maxOutputTokens: 700, timeoutMs: 5_000 })).rejects.toThrow();
    // Another model name than the profile's.
    const other = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', fetch: guard.fetch, maxResponseBytes: profile.maxResponseBytes, model: 'qwen3:4b' });
    await expect(other.generateStructured(buildMealDraftMessages('Hello'), mealDraftWireJsonSchema, { maxOutputTokens: 600, timeoutMs: 5_000 })).rejects.toThrow();
    // A profile that says another temperature than the adapter sends.
    const warm = createProfileGuard({ ...profile, generation: { ...profile.generation, temperature: 0.5 } }, network);
    const third = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434', fetch: warm.fetch, maxResponseBytes: profile.maxResponseBytes, model: profile.model });
    await expect(third.generateStructured(buildMealDraftMessages('Hello'), mealDraftWireJsonSchema, { maxOutputTokens: 600, timeoutMs: 5_000 })).rejects.toThrow();
    expect(sent).toBe(0);
    expect(guard.check()).toEqual({ mismatches: 2, requests: 2 });
    expect(warm.check()).toEqual({ mismatches: 1, requests: 1 });
  });
});

describe('reproducibility metadata', () => {
  const sha = 'a'.repeat(40);

  it('records the commit and whether the tree is dirty, with the uncommitted paths but no content', () => {
    const dirty: GitRunner = (args) => (args[0] === 'rev-parse' ? `${sha}\n` : ' M apps/api/src/x.ts\n?? docs/new.md\n');
    expect(readGitState(dirty)).toEqual({ dirty: true, dirtyPathCount: 2, dirtyPaths: ['apps/api/src/x.ts', 'docs/new.md'], sha });
    const clean: GitRunner = (args) => (args[0] === 'rev-parse' ? sha : '');
    expect(readGitState(clean)).toEqual({ dirty: false, dirtyPathCount: 0, dirtyPaths: [], sha });
  });

  it('says "unknown" instead of guessing when Git is unavailable', () => {
    const missing: GitRunner = () => {
      throw new Error('git not found');
    };
    expect(readGitState(missing)).toEqual({ dirty: null, dirtyPathCount: null, dirtyPaths: [], sha: null });
  });

  it('digests text independently of line endings', () => {
    expect(normalizedDigest('a\r\nb\r\n')).toBe(normalizedDigest('a\nb\n'));
    expect(normalizedDigest('a\nb\n')).not.toBe(normalizedDigest('a\nc\n'));
  });

  it('collects the run settings it is given beside the current fingerprint and prompt digest', () => {
    const metadata = collectReproducibilityMetadata({
      datasetDigest: 'd'.repeat(64),
      generation: { temperature: 0 },
      git: (args) => (args[0] === 'rev-parse' ? sha : ''),
      model: 'qwen3:8b',
      modelDigest: 'e'.repeat(64),
      now: new Date('2026-11-16T10:00:00.000Z'),
      ollamaVersion: '0.40.16',
      timeoutMs: 45_000,
    });
    expect(metadata).toMatchObject({
      datasetDigest: 'd'.repeat(64),
      generation: { temperature: 0 },
      git: { dirty: false, sha },
      model: 'qwen3:8b',
      modelDigest: 'e'.repeat(64),
      ollamaVersion: '0.40.16',
      recordedAt: '2026-11-16T10:00:00.000Z',
      timeoutMs: 45_000,
    });
    expect(metadata.fingerprint.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(metadata.promptDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
