import { z } from 'zod';

import type { Clock } from '../clock.js';
import { mealDraftsEnvironmentFields } from '../config/meal-drafts-config.js';
import { isLocalOllamaModel } from '../config/run-search-ai-config.js';
import { isLocalOllamaBaseUrl } from '../config/weekly-insights-config.js';
import type { LlmProvider } from '../insights/llm-provider.js';
import {
  buildMealDraftReport,
  formatMealDraftReport,
  loadMealDraftDataset,
  MEAL_DRAFT_EVALUATION_MAX_CALLS,
  MEAL_DRAFT_EVALUATION_SETS,
  MEAL_DRAFT_REPORT_VERSION,
  runMealDraftEvaluation,
  type MealDraftEvaluationDataset,
  type MealDraftEvaluationSet,
  type MealDraftNotRunReport,
} from './meal-draft-evaluation.js';
import {
  buildMealDraftGateReport,
  buildMealDraftSafetyReport,
  evaluateModelGate,
  evaluateVerifierGate,
  formatModelGate,
  formatVerifierGate,
  gateExitCode,
  MEAL_DRAFT_GATE_PERMITS,
} from './meal-draft-gates.js';
import { collectReproducibilityMetadata, currentVerifierDigests, type GitRunner, type ReproducibilityMetadata } from './meal-draft-metadata.js';
import { buildExecutionProfile, createProfileGuard, type MealDraftExecutionProfile } from './meal-draft-profile.js';
import {
  formatChallengeScore,
  loadMealDraftChallengeSet,
  runMealDraftChallenge,
  scoreMealDraftChallenge,
  type ChallengeCaseResult,
  type MealDraftChallengeSet,
} from './meal-draft-challenge.js';
import { loadMealDraftSafetyCorpus, runMealDraftSafety, type MealDraftSafetyCorpus, type SafetyCaseResult } from './meal-draft-safety.js';

// The command line of the meal draft evaluation (docs/runbooks/meal-drafts.md), separated from its entry point so that
// its exit codes are tested. Never part of `npm test`, `npm run verify` or CI.
//
//   --set safety [--out F]                                   deterministic verifier safety corpus (no model)
//   --set challenge [--out F]                                vessel-scope engineering challenge set (no model; not held-out
//                                                            evidence, not a gate input, reported separately)
//   --set development|heldout --provider fake|ollama [--max-calls N] [--dry-run] [--out F]
//   --check [--model F]... [--out F]                         both gates: the verifier live, the model from reports
//
// Exit codes: 0 PASS (or a measurement that finished), 1 an error that prevented a run or a verdict, 2 FAIL,
// 3 NOT_RUN (no inference possible, or a gate without evidence). A report is written before the exit code is decided.

export interface MealDraftCliDependencies {
  clock: Pick<Clock, 'monotonicNow'>;
  /** Builds the production adapter; `fetch` is the profile guard every request must pass. */
  createOllamaProvider: (options: { baseUrl: string; fetch: typeof fetch; maxResponseBytes: number; model: string }) => LlmProvider;
  createFakeProvider: () => LlmProvider;
  environment: Record<string, string | undefined>;
  /** GET a local Ollama endpoint (version, tags), never an inference. */
  fetchOllamaJson: (baseUrl: string, path: string) => Promise<unknown>;
  git?: GitRunner;
  info: (line: string) => void;
  /** The network under the profile guard (default: the global fetch); tests replace it. */
  networkFetch?: typeof fetch;
  loadDataset?: (set: MealDraftEvaluationSet) => { dataset: MealDraftEvaluationDataset; digest: string };
  now: () => Date;
  readJson: (path: string) => unknown;
  runSafety?: () => { corpus: MealDraftSafetyCorpus; digest: string; results: SafetyCaseResult[] };
  runChallenge?: () => { digest: string; results: ChallengeCaseResult[]; set: MealDraftChallengeSet };
  writeText: (path: string, text: string) => void;
}

export interface MealDraftCliArguments {
  check: boolean;
  dryRun: boolean;
  maxCalls: string | undefined;
  models: string[];
  out: string | undefined;
  provider: string | undefined;
  set: string | undefined;
}

export function parseMealDraftCliArguments(argv: readonly string[]): MealDraftCliArguments {
  const parsed: MealDraftCliArguments = { check: false, dryRun: false, maxCalls: undefined, models: [], out: undefined, provider: undefined, set: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      index += 1;
      return next;
    };
    switch (name) {
      case '--check':
        parsed.check = true;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--max-calls':
        parsed.maxCalls = value();
        break;
      case '--model':
        parsed.models.push(value());
        break;
      case '--out':
        parsed.out = value();
        break;
      case '--provider':
        parsed.provider = value();
        break;
      case '--set':
        parsed.set = value();
        break;
      default:
        throw new Error(`Unknown argument ${name ?? ''}`);
    }
  }
  return parsed;
}

const settingsSchema = z.object({
  MEAL_DRAFTS_MAX_OUTPUT_TOKENS: mealDraftsEnvironmentFields.MEAL_DRAFTS_MAX_OUTPUT_TOKENS,
  MEAL_DRAFTS_MAX_RESPONSE_BYTES: mealDraftsEnvironmentFields.MEAL_DRAFTS_MAX_RESPONSE_BYTES,
  MEAL_DRAFTS_MODEL: mealDraftsEnvironmentFields.MEAL_DRAFTS_MODEL,
  MEAL_DRAFTS_OLLAMA_BASE_URL: mealDraftsEnvironmentFields.MEAL_DRAFTS_OLLAMA_BASE_URL,
  MEAL_DRAFTS_TIMEOUT_MS: mealDraftsEnvironmentFields.MEAL_DRAFTS_TIMEOUT_MS,
});

const defaultRunSafety = () => {
  const { corpus, digest } = loadMealDraftSafetyCorpus();
  return { corpus, digest, results: runMealDraftSafety(corpus.cases) };
};

const defaultRunChallenge = () => {
  const { digest, set } = loadMealDraftChallengeSet();
  return { digest, results: runMealDraftChallenge(set.cases), set };
};

function write(deps: MealDraftCliDependencies, out: string | undefined, value: unknown): void {
  if (out === undefined) return;
  deps.writeText(out, `${JSON.stringify(value, null, 2)}\n`);
  deps.info(`Report written to ${out}`);
}

/** Runs one command and returns its exit code. Throws only for a usage or configuration error (exit 1 by the caller). */
export async function runMealDraftEvaluationCli(argv: readonly string[], deps: MealDraftCliDependencies): Promise<number> {
  const args = parseMealDraftCliArguments(argv);
  const loadDataset = deps.loadDataset ?? ((set: MealDraftEvaluationSet) => loadMealDraftDataset(set));
  const runSafety = deps.runSafety ?? defaultRunSafety;
  const metadataFor = (input: Omit<Parameters<typeof collectReproducibilityMetadata>[0], 'git' | 'now'>): ReproducibilityMetadata =>
    collectReproducibilityMetadata({ ...input, ...(deps.git === undefined ? {} : { git: deps.git }), now: deps.now() });

  if (args.check) {
    if (args.set !== undefined || args.provider !== undefined) throw new Error('--check takes only --model and --out');
    const safety = runSafety();
    const verifier = evaluateVerifierGate(safety);
    const reports = args.models.map((path) => deps.readJson(path));
    const datasets = Object.fromEntries(MEAL_DRAFT_EVALUATION_SETS.map((set) => [set, loadDataset(set)])) as Record<
      MealDraftEvaluationSet,
      { dataset: MealDraftEvaluationDataset; digest: string }
    >;
    // Offline: the reports and the source tree only; the runtime is never contacted by a check.
    const model = evaluateModelGate(reports, { current: currentVerifierDigests(), datasets });
    const judged = model.profile;
    const metadata = metadataFor({
      datasetDigest: null,
      generation: judged?.generation ?? null,
      model: judged?.model ?? null,
      modelDigest: judged?.modelDigest ?? null,
      ollamaVersion: judged?.ollamaVersion ?? null,
      timeoutMs: judged?.timeoutMs ?? null,
    });
    const report = buildMealDraftGateReport(verifier, model, metadata);
    deps.info(formatVerifierGate(verifier));
    deps.info(formatModelGate(model));
    deps.info(`OVERALL: ${report.overall}. ${MEAL_DRAFT_GATE_PERMITS}`);
    write(deps, args.out, report);
    return report.exitCode;
  }

  if (args.set === 'safety') {
    if (args.provider !== undefined) throw new Error('--set safety calls no provider; leave out --provider');
    const safety = runSafety();
    const report = buildMealDraftSafetyReport({ ...safety, metadata: metadataFor({ datasetDigest: safety.digest, generation: null, model: null, modelDigest: null, ollamaVersion: null, timeoutMs: null }) });
    deps.info(formatVerifierGate(report.gate));
    write(deps, args.out, report);
    return gateExitCode(report.gate.status);
  }

  if (args.set === 'challenge') {
    if (args.provider !== undefined) throw new Error('--set challenge calls no provider; leave out --provider');
    const challenge = (deps.runChallenge ?? defaultRunChallenge)();
    const score = scoreMealDraftChallenge(challenge.results);
    const report = {
      caseCount: challenge.set.cases.length,
      challengeDigest: challenge.digest,
      challengeVersion: challenge.set.challengeVersion,
      kind: 'deterministic-vessel-scope-challenge',
      metadata: metadataFor({ datasetDigest: challenge.digest, generation: null, model: null, modelDigest: null, ollamaVersion: null, timeoutMs: null }),
      results: challenge.results,
      score,
      set: 'challenge',
      statement: 'Engineering challenge and regression set with supplied claims and no model: a statement about the verifier only, not held-out evidence and not a gate input.',
    };
    deps.info(formatChallengeScore(score, challenge.set.challengeVersion));
    write(deps, args.out, report);
    return score.status === 'PASS' ? 0 : 2;
  }

  const set = args.set as MealDraftEvaluationSet | undefined;
  if (set === undefined || !MEAL_DRAFT_EVALUATION_SETS.includes(set)) throw new Error(`--set must be safety, challenge, ${MEAL_DRAFT_EVALUATION_SETS.join(' or ')}`);
  const providerName = args.provider;
  if (providerName !== 'fake' && providerName !== 'ollama') throw new Error('--provider must be fake or ollama (stated explicitly, never inferred)');
  const { dataset, digest } = loadDataset(set);
  const maxCalls = Number(args.maxCalls ?? String(Math.min(dataset.cases.length, MEAL_DRAFT_EVALUATION_MAX_CALLS)));
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MEAL_DRAFT_EVALUATION_MAX_CALLS) {
    throw new Error(`--max-calls must be an integer from 1 to ${MEAL_DRAFT_EVALUATION_MAX_CALLS}`);
  }
  const settings = settingsSchema.parse(deps.environment);

  let provider: LlmProvider;
  /** Set for a real-model run before its first call; every call setting below is read from it. */
  let profile: MealDraftExecutionProfile | null = null;
  let guard: ReturnType<typeof createProfileGuard> | null = null;
  if (providerName === 'ollama') {
    const model = settings.MEAL_DRAFTS_MODEL?.trim() ?? '';
    if (!isLocalOllamaModel(model)) throw new Error('MEAL_DRAFTS_MODEL must name a local Ollama model');
    if (!isLocalOllamaBaseUrl(settings.MEAL_DRAFTS_OLLAMA_BASE_URL)) throw new Error('MEAL_DRAFTS_OLLAMA_BASE_URL must be a local Ollama origin');
    const baseUrl = new URL(settings.MEAL_DRAFTS_OLLAMA_BASE_URL).origin;
    let ollamaVersion: string | null = null;
    let modelDigest: string | null = null;
    const notRun = (reason: string): number => {
      const report: MealDraftNotRunReport = {
        executionProfile: null,
        kind: 'real-model',
        metadata: metadataFor({ datasetDigest: digest, generation: null, model, modelDigest, ollamaVersion, timeoutMs: settings.MEAL_DRAFTS_TIMEOUT_MS }),
        model,
        provider: 'ollama',
        reason,
        reportVersion: MEAL_DRAFT_REPORT_VERSION,
        set,
        status: 'NOT_RUN',
      };
      deps.info(`Real-model evaluation: NOT_RUN. ${reason}`);
      write(deps, args.out, report);
      return 3;
    };
    // Two reads, no inference: the runtime's version and whether the model is ALREADY installed. Nothing is pulled.
    let tags: { models?: Array<{ digest?: string; name: string }> };
    try {
      ollamaVersion = ((await deps.fetchOllamaJson(baseUrl, '/api/version')) as { version?: string }).version ?? null;
      tags = (await deps.fetchOllamaJson(baseUrl, '/api/tags')) as typeof tags;
    } catch (error) {
      return notRun(`The local Ollama at ${baseUrl} could not be reached (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}).`);
    }
    const installed = (tags.models ?? []).find((entry) => entry.name === model);
    if (installed === undefined) return notRun(`Model ${model} is not installed in the local Ollama; nothing was pulled.`);
    modelDigest = installed.digest ?? null;
    // The profile is fixed here, before the first call, and validated: a run whose configuration cannot be described
    // exactly (no digest, no runtime version, an out-of-range setting) makes no call.
    try {
      profile = buildExecutionProfile({
        maxOutputTokens: settings.MEAL_DRAFTS_MAX_OUTPUT_TOKENS,
        maxResponseBytes: settings.MEAL_DRAFTS_MAX_RESPONSE_BYTES,
        model,
        modelDigest,
        ollamaVersion,
        timeoutMs: settings.MEAL_DRAFTS_TIMEOUT_MS,
      });
    } catch (error) {
      return notRun(error instanceof Error ? error.message : 'The execution profile cannot be established.');
    }
    guard = createProfileGuard(profile, deps.networkFetch ?? globalThis.fetch.bind(globalThis));
    provider = deps.createOllamaProvider({ baseUrl, fetch: guard.fetch, maxResponseBytes: profile.maxResponseBytes, model: profile.model });
  } else {
    provider = deps.createFakeProvider();
  }

  // For the fake provider: the settings it was given, for the record only (it never sees them).
  const fakeGeneration = { maxOutputTokens: settings.MEAL_DRAFTS_MAX_OUTPUT_TOKENS, timeoutMs: settings.MEAL_DRAFTS_TIMEOUT_MS };
  const maxOutputTokens = profile?.generation.numPredict ?? settings.MEAL_DRAFTS_MAX_OUTPUT_TOKENS;
  const timeoutMs = profile?.timeoutMs ?? settings.MEAL_DRAFTS_TIMEOUT_MS;
  const calls = Math.min(maxCalls, dataset.cases.length);
  deps.info(
    [
      `Set: ${set} v${dataset.datasetVersion} (${dataset.cases.length} cases; digest ${digest.slice(0, 12)}…)`,
      profile === null
        ? 'Provider: fake (harness verification only; NOT model evidence)'
        : `Provider: ollama ${profile.model} (${profile.modelDigest.slice(0, 12)}…), Ollama ${profile.ollamaVersion}; profile ${JSON.stringify(profile.generation)}, response ≤ ${profile.maxResponseBytes} B`,
      `Calls: at most ${calls}, one per case, sequential, no retries; deadline ${timeoutMs} ms each`,
    ].join('\n'),
  );
  if (args.dryRun) {
    deps.info('Dry run: the set, the configuration and the execution profile are valid. No inference request was made.');
    return 0;
  }

  const run = await runMealDraftEvaluation({
    cases: dataset.cases,
    clock: deps.clock,
    maxCalls,
    maxOutputTokens,
    onCase: ({ done, id, total }) => deps.info(`  ${done}/${total} ${id}`),
    provider,
    timeoutMs,
  });
  const generation = profile?.generation ?? fakeGeneration;
  const report = buildMealDraftReport({
    dataset,
    digest,
    executionProfile: profile,
    generation,
    maxCalls,
    metadata: metadataFor({
      datasetDigest: digest,
      generation: profile === null ? null : profile.generation,
      model: profile?.model ?? 'fake',
      modelDigest: profile?.modelDigest ?? null,
      ollamaVersion: profile?.ollamaVersion ?? null,
      timeoutMs,
    }),
    model: profile?.model ?? 'fake',
    profileCheck: guard?.check() ?? null,
    provider: providerName,
    run,
    runtimeVersion: profile?.ollamaVersion ?? null,
    timeoutMs,
  });
  deps.info(formatMealDraftReport(report));
  write(deps, args.out, report);
  // A measurement that finished: its verdict belongs to --check, which judges it against the frozen thresholds.
  return 0;
}
