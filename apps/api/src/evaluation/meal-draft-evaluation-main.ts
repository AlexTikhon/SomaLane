import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { systemClock } from '../clock.js';
import { loadEnvironmentSource } from '../config/environment.js';
import { OllamaProvider } from '../insights/ollama-provider.js';
import { FakeMealDraftProvider } from '../meals/drafts/fake-meal-draft-provider.js';
import { runMealDraftEvaluationCli } from './meal-draft-evaluation-cli.js';

// The opt-in evaluation of "Draft from text" (docs/runbooks/meal-drafts.md). Never part of `npm test`, `npm run verify`
// or CI. With --provider ollama it sends the synthetic set's texts, one call per case and no retries, to the local Ollama
// named by MEAL_DRAFTS_OLLAMA_BASE_URL and MEAL_DRAFTS_MODEL, after checking that the model is already installed (nothing
// is ever pulled). With --provider fake it verifies this harness and says nothing about a model. --set safety runs the
// deterministic verifier corpus (supplied claims, no provider); --check judges both gates.
//
//   npm run eval:meal-drafts -- --set safety --out .local/eval/safety.json
//   npm run eval:meal-drafts -- --set development --provider fake
//   npm run eval:meal-drafts -- --set development --provider ollama --dry-run
//   npm run eval:meal-drafts -- --set heldout --provider ollama --max-calls 20 --out docs/reports/artifacts/x/heldout.json
//   npm run eval:meal-drafts:check -- --model dev.json --model heldout.json --out gates.json
//
// Exit codes: 0 PASS or a finished measurement, 1 an error that prevented a run or a verdict, 2 FAIL, 3 NOT_RUN.

// `npm run` starts this script inside the API workspace; relative --out and --model paths mean the directory the
// command was typed in (npm's INIT_CWD), not apps/api.
const fromInvocation = (path: string) => resolve(process.env['INIT_CWD'] ?? process.cwd(), path);

async function ollamaJson(baseUrl: string, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Ollama ${path} answered ${response.status}`);
  return response.json();
}

runMealDraftEvaluationCli(process.argv.slice(2), {
  clock: systemClock,
  createFakeProvider: () => new FakeMealDraftProvider(),
  createOllamaProvider: (options) => new OllamaProvider(options),
  environment: loadEnvironmentSource(),
  fetchOllamaJson: ollamaJson,
  info: (line) => console.info(line),
  now: () => new Date(),
  readJson: (path) => JSON.parse(readFileSync(fromInvocation(path), 'utf8')) as unknown,
  writeText: (path, text) => {
    const target = fromInvocation(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  },
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'The evaluation failed');
    process.exitCode = 1;
  });
