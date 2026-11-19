import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment.js';

const base = {
  ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://running_tracker_runtime:password@127.0.0.1:5433/running_tracker',
  MAINTENANCE_DATABASE_URL: 'postgresql://running_tracker_maintenance:password@127.0.0.1:5433/running_tracker',
  SESSION_COOKIE_SECURE: 'false',
};

describe('DATA_QUESTIONS_* configuration (ADR-0094)', () => {
  it('is off by default: no setting, no model, no provider', () => {
    const config = validateEnvironment(base);
    expect(config.DATA_QUESTIONS).toBeUndefined();
    expect(Object.keys(config).some((key) => key.startsWith('DATA_QUESTIONS_'))).toBe(false);
  });

  it('builds the fake provider for development and test, and refuses it in production', () => {
    expect(validateEnvironment({ ...base, DATA_QUESTIONS_PROVIDER: 'fake' }).DATA_QUESTIONS).toMatchObject({
      maxConcurrent: 1,
      maxOutputTokens: 300,
      model: 'fake',
      provider: 'fake',
      timeoutMs: 45_000,
      userRate: { perWindow: 5, windowMs: 60_000 },
    });
    expect(() => validateEnvironment({ ...base, APP_ENV: 'production', DATA_QUESTIONS_PROVIDER: 'fake' })).toThrow(/DATA_QUESTIONS_PROVIDER/u);
  });

  it('requires an explicit local model and a local address for Ollama: no cloud fallback', () => {
    expect(() => validateEnvironment({ ...base, DATA_QUESTIONS_PROVIDER: 'ollama' })).toThrow(/DATA_QUESTIONS_MODEL must be set/u);
    expect(() => validateEnvironment({ ...base, DATA_QUESTIONS_MODEL: 'qwen3:cloud', DATA_QUESTIONS_PROVIDER: 'ollama' })).toThrow(/cloud models are refused/u);
    expect(() =>
      validateEnvironment({ ...base, DATA_QUESTIONS_MODEL: 'qwen3:8b', DATA_QUESTIONS_OLLAMA_BASE_URL: 'https://api.example.com', DATA_QUESTIONS_PROVIDER: 'ollama' }),
    ).toThrow(/DATA_QUESTIONS_OLLAMA_BASE_URL/u);
    expect(validateEnvironment({ ...base, DATA_QUESTIONS_MODEL: 'qwen3:8b', DATA_QUESTIONS_PROVIDER: 'ollama' }).DATA_QUESTIONS).toEqual({
      allowance: { perWindow: 200, windowMs: 86_400_000 },
      baseUrl: 'http://127.0.0.1:11434',
      limiterMaxUsers: 1_000,
      maxConcurrent: 1,
      maxOutputTokens: 300,
      maxResponseBytes: 32_768,
      model: 'qwen3:8b',
      provider: 'ollama',
      timeoutMs: 45_000,
      userRate: { perWindow: 5, windowMs: 60_000 },
    });
  });

  it('bounds the deadline so that it fits the browser wait', () => {
    expect(() => validateEnvironment({ ...base, DATA_QUESTIONS_PROVIDER: 'fake', DATA_QUESTIONS_TIMEOUT_MS: '55001' })).toThrow(/DATA_QUESTIONS_TIMEOUT_MS/u);
  });

  it('is independent of the other AI features, and they of it', () => {
    const on = validateEnvironment({ ...base, DATA_QUESTIONS_PROVIDER: 'fake' });
    expect(on.MEAL_DRAFTS).toBeUndefined();
    expect(on.RUN_SEARCH_AI).toBeUndefined();
    expect(on.WEEKLY_INSIGHTS).toBeUndefined();
    expect(validateEnvironment({ ...base, MEAL_DRAFTS_PROVIDER: 'fake' }).DATA_QUESTIONS).toBeUndefined();
  });
});
