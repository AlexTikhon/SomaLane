import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { isLocalOllamaModel } from '../config/run-search-ai-config.js';
import { DEFAULT_OLLAMA_BASE_URL, isLocalOllamaBaseUrl } from '../config/weekly-insights-config.js';
import { dataQuestionsEnvironmentFields } from '../config/data-questions-config.js';
import { FakeDataQuestionProvider } from '../data-questions/fake-data-question-provider.js';
import { DATA_QUESTION_PROMPT_VERSION, dataQuestionPromptDigest } from '../data-questions/data-question-prompt.js';
import { OllamaProvider } from '../insights/ollama-provider.js';
import {
  buildDataQuestionReport,
  DATA_QUESTION_DATASET_DIGESTS,
  DATA_QUESTION_EVAL_MAX_CALLS,
  DATA_QUESTION_EVAL_SETS,
  DATA_QUESTION_FINGERPRINT_FILES,
  DATA_QUESTION_THRESHOLDS,
  dataQuestionCodeFingerprint,
  evaluateDataQuestionGate,
  formatDataQuestionGate,
  formatDataQuestionReport,
  loadDataQuestionDataset,
  runDataQuestionEvaluation,
  type DataQuestionEvalReport,
  type DataQuestionEvalSet,
} from './data-question-evaluation.js';
import { readGitState } from './meal-draft-metadata.js';
import { buildExecutionProfile, createProfileGuard } from './meal-draft-profile.js';

// The "Ask my data" interpretation evaluation (ADR-0094), separate from the meal-draft gate.
//
//   npm run eval:data-questions -- --set development --provider fake             harness self-check, NOT model evidence
//   npm run eval:data-questions -- --freeze --model qwen3:8b --out freeze.json    digests and profile, no inference
//   npm run eval:data-questions -- --set development --provider ollama --model qwen3:8b --out dev.json
//   npm run eval:data-questions -- --check --report dev.json --report heldout.json --out gates.json   offline
//
// Ollama is reached only by `--provider ollama`: one sequential call per case, no retries, no warm-up; the runtime's
// version and the model's digest come from its metadata endpoints (no inference). The deadline, output budget and response
// bound are the product defaults of DATA_QUESTIONS_*. Exit codes: 0 PASS (or a finished measurement), 2 FAIL, 3 NOT_RUN.

const defaults = {
  maxOutputTokens: dataQuestionsEnvironmentFields.DATA_QUESTIONS_MAX_OUTPUT_TOKENS.parse(undefined),
  maxResponseBytes: dataQuestionsEnvironmentFields.DATA_QUESTIONS_MAX_RESPONSE_BYTES.parse(undefined),
  timeoutMs: dataQuestionsEnvironmentFields.DATA_QUESTIONS_TIMEOUT_MS.parse(undefined),
};

async function ollamaJson(baseUrl: string, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Ollama ${path} answered HTTP ${response.status}`);
  return response.json();
}

async function runtimeProfile(model: string, baseUrl: string) {
  const version = ((await ollamaJson(baseUrl, '/api/version')) as { version?: string }).version ?? null;
  const tags = (await ollamaJson(baseUrl, '/api/tags')) as { models?: Array<{ digest?: string; name?: string }> };
  const installed = tags.models?.find((entry) => entry.name === model);
  if (installed === undefined) throw new Error(`The model ${model} is not installed in this Ollama (nothing is pulled)`);
  return buildExecutionProfile({ ...defaults, model, modelDigest: installed.digest ?? null, ollamaVersion: version });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      check: { type: 'boolean' },
      freeze: { type: 'boolean' },
      'max-calls': { type: 'string' },
      model: { type: 'string' },
      out: { type: 'string' },
      provider: { type: 'string' },
      report: { multiple: true, type: 'string' },
      set: { type: 'string' },
    },
    strict: true,
  });
  const write = (value: unknown) => {
    if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(value, null, 2)}\n`);
  };

  if (values.check === true) {
    const reports = (values.report ?? []).map((path) => JSON.parse(readFileSync(path, 'utf8')) as DataQuestionEvalReport);
    const gate = evaluateDataQuestionGate(reports);
    console.log(formatDataQuestionGate(gate));
    write({ gate, checkedAt: new Date().toISOString(), codeFingerprint: dataQuestionCodeFingerprint(), promptDigest: dataQuestionPromptDigest() });
    return gate.status === 'PASS' ? 0 : gate.status === 'FAIL' ? 2 : 3;
  }

  const baseUrl = new URL(values['base-url'] ?? process.env['DATA_QUESTIONS_OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL).origin;
  if (!isLocalOllamaBaseUrl(baseUrl)) throw new Error('The Ollama address must be local (loopback or private network)');

  if (values.freeze === true) {
    const model = values.model ?? '';
    if (!isLocalOllamaModel(model)) throw new Error('--model must name a local Ollama model');
    for (const set of DATA_QUESTION_EVAL_SETS) loadDataQuestionDataset(set);
    const freeze = {
      codeFingerprint: dataQuestionCodeFingerprint(),
      datasetDigests: DATA_QUESTION_DATASET_DIGESTS,
      fingerprintFiles: DATA_QUESTION_FINGERPRINT_FILES,
      frozenAt: new Date().toISOString(),
      git: readGitState(),
      inferenceCallsMade: 0,
      maxInferenceCalls: DATA_QUESTION_EVAL_MAX_CALLS,
      profile: await runtimeProfile(model, baseUrl),
      promptDigest: dataQuestionPromptDigest(),
      promptVersion: DATA_QUESTION_PROMPT_VERSION,
      thresholds: DATA_QUESTION_THRESHOLDS,
    };
    console.log(JSON.stringify(freeze, null, 2));
    write(freeze);
    return 0;
  }

  const set = values.set as DataQuestionEvalSet | undefined;
  if (set === undefined || !DATA_QUESTION_EVAL_SETS.includes(set)) throw new Error('--set must be development or heldout');
  const maxCalls = Number(values['max-calls'] ?? 20);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > DATA_QUESTION_EVAL_MAX_CALLS) throw new Error('--max-calls must be 1 to 40');
  const { dataset, digest } = loadDataQuestionDataset(set);
  const startedAt = new Date().toISOString();

  if (values.provider === 'fake') {
    const run = await runDataQuestionEvaluation({ dataset, maxCalls, ...defaults, provider: new FakeDataQuestionProvider() });
    const report = buildDataQuestionReport({ dataset, digest, finishedAt: new Date().toISOString(), profile: { model: 'fake', provider: 'fake' }, profileCheck: null, run, startedAt });
    console.log(formatDataQuestionReport(report));
    write(report);
    return 0;
  }
  if (values.provider !== 'ollama') throw new Error('--provider must be fake or ollama');
  const model = values.model ?? '';
  if (!isLocalOllamaModel(model)) throw new Error('--model must name a local Ollama model');
  const profile = await runtimeProfile(model, baseUrl);
  const guard = createProfileGuard(profile, globalThis.fetch.bind(globalThis));
  const provider = new OllamaProvider({ baseUrl, fetch: guard.fetch, maxResponseBytes: profile.maxResponseBytes, model });
  const run = await runDataQuestionEvaluation({ dataset, maxCalls, maxOutputTokens: profile.generation.numPredict, provider, timeoutMs: profile.timeoutMs });
  const report = buildDataQuestionReport({ dataset, digest, finishedAt: new Date().toISOString(), profile, profileCheck: guard.check(), run, startedAt });
  console.log(formatDataQuestionReport(report));
  write(report);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`eval:data-questions failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 3;
  },
);
