import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { dataQuestionsEnvironmentFields } from '../config/data-questions-config.js';
import { isLocalOllamaModel } from '../config/run-search-ai-config.js';
import { DEFAULT_OLLAMA_BASE_URL, isLocalOllamaBaseUrl } from '../config/weekly-insights-config.js';
import { DATA_QUESTION_PROMPT_VERSION, dataQuestionPromptDigest } from '../data-questions/data-question-prompt.js';
import { FakeDataQuestionProvider } from '../data-questions/fake-data-question-provider.js';
import { OllamaProvider } from '../insights/ollama-provider.js';
import {
  buildDataQuestionReport,
  DATA_QUESTION_DATASET_REGISTRY,
  DATA_QUESTION_EVAL_MAX_CALLS,
  DATA_QUESTION_EVAL_SETS,
  DATA_QUESTION_FINGERPRINT_FILES,
  DATA_QUESTION_THRESHOLDS,
  dataQuestionCodeFingerprint,
  dataQuestionDatasetDigests,
  evaluateDataQuestionGate,
  formatDataQuestionGate,
  formatDataQuestionReport,
  loadDataQuestionDataset,
  parseDataQuestionDatasetVersion,
  runDataQuestionEvaluation,
  type DataQuestionEvalSet,
  type DataQuestionGate,
} from './data-question-evaluation.js';
import { readGitState, type GitState } from './meal-draft-metadata.js';
import { buildExecutionProfile, createProfileGuard } from './meal-draft-profile.js';

// The command line of the "Ask my data" interpretation evaluation (ADR-0094), separated from its entry point so that its
// paths, exit codes and network use are tested.
//
//   npm run eval:data-questions -- --set development --provider fake             harness self-check, NOT model evidence
//   npm run eval:data-questions -- --freeze --model qwen3:8b --out freeze.json    digests and profile, no inference
//   npm run eval:data-questions -- --set development --provider ollama --model qwen3:8b --out dev.json
//   npm run eval:data-questions -- --check --report dev.json --report heldout.json --out gates.json   offline
//
// Every form takes --dataset-version v1|v2 (v1 by default, so earlier commands keep their meaning): the frozen sets run,
// frozen or judged. A check judges exactly the one selected version; reports of another version are refused.
//
// User-supplied relative --report and --out paths mean the directory the command was typed in: npm's INIT_CWD (npm starts
// the script inside apps/api), else the process's working directory (direct invocation). Absolute paths stay as typed. The
// frozen datasets are repository-owned and always read from the repository.
//
// Ollama is reached only by `--provider ollama` (and `--freeze`, for metadata only): one sequential call per case, no
// retries, no warm-up. A check and a fake run never use the network. Exit codes: 0 PASS (or a finished measurement),
// 2 FAIL, 3 NOT_RUN (and any error that prevented a verdict).

export interface DataQuestionCliDependencies {
  /** The code and prompt to judge reports against (default: the current ones). Tests only. */
  current?: { codeFingerprint: string; promptDigest: string; promptVersion?: string };
  /** The only network: Ollama metadata, and inference under the profile guard. */
  fetch: typeof fetch;
  gitState?: () => GitState;
  info: (line: string) => void;
  /** Where relative user paths are resolved: see `invocationDirectory`. */
  invocationDirectory: string;
  now?: () => Date;
}

/** npm's INIT_CWD (the directory the command was typed in) when present, else the working directory. */
export function invocationDirectory(environment: Record<string, string | undefined>, cwd: string): string {
  const initial = environment['INIT_CWD'];
  return initial === undefined || initial === '' ? cwd : initial;
}

const defaults = {
  maxOutputTokens: dataQuestionsEnvironmentFields.DATA_QUESTIONS_MAX_OUTPUT_TOKENS.parse(undefined),
  maxResponseBytes: dataQuestionsEnvironmentFields.DATA_QUESTIONS_MAX_RESPONSE_BYTES.parse(undefined),
  timeoutMs: dataQuestionsEnvironmentFields.DATA_QUESTIONS_TIMEOUT_MS.parse(undefined),
};

/** Reads each report; a file that cannot be read or parsed becomes a bounded problem (its name, never its full path). */
function readReports(paths: readonly string[], at: (path: string) => string): { problems: string[]; reports: unknown[] } {
  const problems: string[] = [];
  const reports: unknown[] = [];
  paths.forEach((path, index) => {
    const label = `report ${index + 1} (${basename(path).slice(0, 80)})`;
    let text: string;
    try {
      text = readFileSync(at(path), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      problems.push(`${label}: cannot be read${typeof code === 'string' ? ` (${code})` : ''}`);
      return;
    }
    try {
      reports.push(JSON.parse(text));
    } catch {
      problems.push(`${label}: not valid JSON`);
    }
  });
  return { problems, reports };
}

export async function runDataQuestionEvaluationCli(argv: readonly string[], deps: DataQuestionCliDependencies): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'base-url': { type: 'string' },
      check: { type: 'boolean' },
      'dataset-version': { type: 'string' },
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
  const datasetVersion = parseDataQuestionDatasetVersion(values['dataset-version']);
  const now = deps.now ?? (() => new Date());
  const gitState = deps.gitState ?? (() => readGitState());
  const at = (path: string) => resolve(deps.invocationDirectory, path);
  const write = (value: unknown) => {
    if (values.out === undefined) return;
    const target = at(values.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  };

  if (values.check === true) {
    const read = readReports(values.report ?? [], at);
    const judged = evaluateDataQuestionGate(read.reports, { datasetVersion, ...(deps.current === undefined ? {} : { current: deps.current }) });
    const gate: DataQuestionGate =
      read.problems.length === 0 ? judged : { ...judged, evidenceValid: false, problems: [...read.problems, ...judged.problems], status: 'NOT_RUN' };
    deps.info(formatDataQuestionGate(gate));
    const current = deps.current ?? { codeFingerprint: dataQuestionCodeFingerprint(), promptDigest: dataQuestionPromptDigest() };
    write({ checkedAt: now().toISOString(), codeFingerprint: current.codeFingerprint, gate, inferenceCallsMade: 0, promptDigest: current.promptDigest });
    return gate.status === 'PASS' ? 0 : gate.status === 'FAIL' ? 2 : 3;
  }

  const ollamaJson = async (baseUrl: string, path: string): Promise<unknown> => {
    const response = await deps.fetch(new URL(path, baseUrl), { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Ollama ${path} answered HTTP ${response.status}`);
    return response.json();
  };
  const runtimeProfile = async (model: string, baseUrl: string) => {
    const version = ((await ollamaJson(baseUrl, '/api/version')) as { version?: string }).version ?? null;
    const tags = (await ollamaJson(baseUrl, '/api/tags')) as { models?: Array<{ digest?: string; name?: string }> };
    const installed = tags.models?.find((entry) => entry.name === model);
    if (installed === undefined) throw new Error(`The model ${model} is not installed in this Ollama (nothing is pulled)`);
    return buildExecutionProfile({ ...defaults, model, modelDigest: installed.digest ?? null, ollamaVersion: version });
  };

  const baseUrl = new URL(values['base-url'] ?? process.env['DATA_QUESTIONS_OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL).origin;
  if (!isLocalOllamaBaseUrl(baseUrl)) throw new Error('The Ollama address must be local (loopback or private network)');

  if (values.freeze === true) {
    const model = values.model ?? '';
    if (!isLocalOllamaModel(model)) throw new Error('--model must name a local Ollama model');
    for (const set of DATA_QUESTION_EVAL_SETS) loadDataQuestionDataset(set, undefined, datasetVersion);
    const freeze = {
      codeFingerprint: dataQuestionCodeFingerprint(),
      datasetDigests: dataQuestionDatasetDigests(datasetVersion),
      datasetVersion: DATA_QUESTION_DATASET_REGISTRY[datasetVersion].name,
      fingerprintFiles: DATA_QUESTION_FINGERPRINT_FILES,
      frozenAt: now().toISOString(),
      git: gitState(),
      inferenceCallsMade: 0,
      maxInferenceCalls: DATA_QUESTION_EVAL_MAX_CALLS,
      profile: await runtimeProfile(model, baseUrl),
      promptDigest: dataQuestionPromptDigest(),
      promptVersion: DATA_QUESTION_PROMPT_VERSION,
      thresholds: DATA_QUESTION_THRESHOLDS,
    };
    deps.info(JSON.stringify(freeze, null, 2));
    write(freeze);
    return 0;
  }

  const set = values.set as DataQuestionEvalSet | undefined;
  if (set === undefined || !DATA_QUESTION_EVAL_SETS.includes(set)) throw new Error('--set must be development or heldout');
  const maxCalls = Number(values['max-calls'] ?? 20);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > DATA_QUESTION_EVAL_MAX_CALLS) throw new Error('--max-calls must be 1 to 40');
  const { dataset, digest } = loadDataQuestionDataset(set, undefined, datasetVersion);
  const startedAt = now().toISOString();

  if (values.provider === 'fake') {
    const run = await runDataQuestionEvaluation({ dataset, maxCalls, ...defaults, provider: new FakeDataQuestionProvider() });
    const report = buildDataQuestionReport({ dataset, digest, finishedAt: now().toISOString(), git: gitState(), profile: { model: 'fake', provider: 'fake' }, profileCheck: null, run, startedAt });
    deps.info(formatDataQuestionReport(report));
    write(report);
    return 0;
  }
  if (values.provider !== 'ollama') throw new Error('--provider must be fake or ollama');
  const model = values.model ?? '';
  if (!isLocalOllamaModel(model)) throw new Error('--model must name a local Ollama model');
  const profile = await runtimeProfile(model, baseUrl);
  const guard = createProfileGuard(profile, deps.fetch);
  const provider = new OllamaProvider({ baseUrl, fetch: guard.fetch, maxResponseBytes: profile.maxResponseBytes, model });
  const run = await runDataQuestionEvaluation({ dataset, maxCalls, maxOutputTokens: profile.generation.numPredict, provider, timeoutMs: profile.timeoutMs });
  const report = buildDataQuestionReport({ dataset, digest, finishedAt: now().toISOString(), git: gitState(), profile, profileCheck: guard.check(), run, startedAt });
  deps.info(formatDataQuestionReport(report));
  write(report);
  return 0;
}
