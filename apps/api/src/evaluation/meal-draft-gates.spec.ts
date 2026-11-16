import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { MEAL_NUTRITION_FIELDS } from '@running-tracker/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import type { LlmProvider } from '../insights/llm-provider.js';
import { OllamaProvider } from '../insights/ollama-provider.js';
import { FakeMealDraftProvider } from '../meals/drafts/fake-meal-draft-provider.js';
import type { FieldDisposition, GroundedProposal } from '../meals/drafts/meal-draft-grounding.js';
import { runMealDraftEvaluationCli, parseMealDraftCliArguments, type MealDraftCliDependencies } from './meal-draft-evaluation-cli.js';
import {
  buildMealDraftReport,
  loadMealDraftDataset,
  scoreMealDraftResults,
  type MealDraftCaseResult,
  type MealDraftEvaluationCase,
  type MealDraftEvaluationReport,
  type MealDraftEvaluationSet,
} from './meal-draft-evaluation.js';
import {
  buildMealDraftGateReport,
  evaluateModelGate,
  evaluateVerifierGate,
  gateExitCode,
  MEAL_DRAFT_MODEL_GATE,
  overallStatus,
  type GateReason,
  type ModelGate,
  type ModelGateContext,
} from './meal-draft-gates.js';
import {
  currentVerifierDigests,
  defaultFingerprintSources,
  fingerprintChanges,
  NODE_ESM_IMPORT_CONDITIONS,
  runtimeConditions,
  verifierFingerprint,
  type FingerprintSources,
  type ReproducibilityMetadata,
  type VerifierFingerprint,
} from './meal-draft-metadata.js';
import { buildExecutionProfile, type MealDraftExecutionProfile } from './meal-draft-profile.js';
import { judgeSafetyCase, loadMealDraftSafetyCorpus, type MealDraftSafetyCase, type SafetyCaseResult, type VerifiedClaims } from './meal-draft-safety.js';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: a verifier that does exactly what the corpus expects, and model runs (report version 3, with the current
// fingerprint and one execution profile) that answer exactly what the sets expect. Each test breaks one thing.

const { corpus, digest: corpusDigest } = loadMealDraftSafetyCorpus();

function expectedClaims(entry: MealDraftSafetyCase): VerifiedClaims {
  const proposed = { carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null } as VerifiedClaims['proposed'];
  if (entry.expect.outcome !== 'draft') return { outcome: entry.expect.outcome, proposed };
  for (const field of MEAL_NUTRITION_FIELDS) {
    const wanted = entry.expect.nutrition[field];
    proposed[field] = wanted === 'not_proposed' ? null : wanted;
  }
  return { outcome: 'draft', proposed };
}
const perfectSafety = (): SafetyCaseResult[] => corpus.cases.map((entry) => judgeSafetyCase(entry, expectedClaims(entry)));

const datasets = { development: loadMealDraftDataset('development'), heldout: loadMealDraftDataset('heldout') };
const current = currentVerifierDigests();
const context: ModelGateContext = { current, datasets };
const modelDigest = 'b'.repeat(64);
const baseProfile = buildExecutionProfile({ maxOutputTokens: 600, maxResponseBytes: 32_768, model: 'qwen3:8b', modelDigest, ollamaVersion: '0.40.16', timeoutMs: 45_000 });

function perfectResult(entry: MealDraftEvaluationCase): MealDraftCaseResult {
  const { expected } = entry;
  if (expected.outcome !== 'draft') {
    return { audit: { fields: null, multipleMealsOverride: false }, case: entry, durationMs: 1_000, failure: null, proposal: { outcome: expected.outcome, reason: expected.reason } as GroundedProposal };
  }
  const fields = {} as Record<(typeof MEAL_NUTRITION_FIELDS)[number], FieldDisposition>;
  const nutrition = {} as Extract<GroundedProposal, { outcome: 'draft' }>['nutrition'];
  for (const field of MEAL_NUTRITION_FIELDS) {
    const value = expected.nutrition[field];
    fields[field] = value === null ? 'not_stated' : 'proposed';
    nutrition[field] = value === null ? { status: 'not_stated' } : { excerpt: `${value}`, status: 'proposed', value };
  }
  return {
    audit: { fields, multipleMealsOverride: false },
    case: entry,
    durationMs: 1_000,
    failure: null,
    proposal: {
      mealType: expected.mealType === null ? { status: 'not_stated' } : { excerpt: expected.mealType, status: 'proposed', value: expected.mealType },
      nutrition,
      outcome: 'draft',
      title: expected.titleIncludes.join(' '),
    },
  };
}

type Json = Record<string, unknown>;

function report(
  set: MealDraftEvaluationSet,
  options: {
    edit?: (results: MealDraftCaseResult[]) => MealDraftCaseResult[];
    profile?: MealDraftExecutionProfile;
    provider?: 'fake' | 'ollama';
    stopped?: MealDraftEvaluationReport['stopped'];
    tamper?: (raw: Json & { metadata: Json }) => void;
  } = {},
): Json {
  const { dataset, digest } = datasets[set];
  const results = (options.edit ?? ((value) => value))(dataset.cases.map(perfectResult));
  const fake = options.provider === 'fake';
  const profile = fake ? null : (options.profile ?? baseProfile);
  const metadata: ReproducibilityMetadata = {
    ...current,
    datasetDigest: digest,
    generation: profile?.generation ?? null,
    git: { dirty: false, dirtyPathCount: 0, dirtyPaths: [], sha: 'a'.repeat(40) },
    model: profile?.model ?? 'fake',
    modelDigest: profile?.modelDigest ?? null,
    nodeVersion: 'v24',
    ollamaVersion: profile?.ollamaVersion ?? null,
    recordedAt: '2026-11-16T00:00:00.000Z',
    timeoutMs: profile?.timeoutMs ?? 45_000,
  };
  const built = buildMealDraftReport({
    dataset,
    digest,
    executionProfile: profile,
    generation: profile?.generation ?? {},
    metadata,
    model: profile?.model ?? 'fake',
    profileCheck: profile === null ? null : { mismatches: 0, requests: results.length },
    provider: fake ? 'fake' : 'ollama',
    run: { calls: results.length, results, stopped: options.stopped ?? null },
    runtimeVersion: profile?.ollamaVersion ?? null,
    timeoutMs: profile?.timeoutMs ?? 45_000,
  });
  // Through JSON, as the check reads a report from disk.
  const raw = JSON.parse(JSON.stringify(built)) as Json & { metadata: Json };
  options.tamper?.(raw);
  return raw;
}

const codes = (gate: ModelGate) => gate.reasons.filter((entry) => entry.kind !== 'note').map((entry) => entry.code);
const messages = (gate: ModelGate, kind?: GateReason['kind']) => gate.reasons.filter((entry) => kind === undefined || entry.kind === kind).map((entry) => entry.message);

/** Replaces the first `count` results with a failure of `reason`. */
const failFirst =
  (count: number, reason: MealDraftCaseResult['failure'] = 'timeout') =>
  (results: MealDraftCaseResult[]) =>
    results.map((result, index) => (index < count ? { ...result, audit: null, failure: reason, proposal: null } : result));

// ---------------------------------------------------------------------------------------------------------------

describe('verifier gate', () => {
  it('passes only a complete corpus with no forbidden value accepted and every control proposed', () => {
    const gate = evaluateVerifierGate({ corpus, digest: corpusDigest, results: perfectSafety() });
    expect(gate.status).toBe('PASS');
    expect(gate.reasons).toEqual([]);
  });

  it('is NOT_RUN without a run, and never takes evidence from a model', () => {
    expect(evaluateVerifierGate(null)).toMatchObject({ reasons: ['The safety corpus was not run.'], status: 'NOT_RUN' });
    // A model that abstained on every adversarial case: no claim reached the verifier, and the verifier gate cannot
    // take anything from that run. Its abstentions are reported as such, not as values the verifier withheld.
    const score = scoreMealDraftResults(datasets.heldout.dataset.cases.map(perfectResult));
    expect(score.nullExpectations.verifierWithheld).toBe(0);
    expect(score.nullExpectations.modelDidNotClaim + score.nullExpectations.nonDraft).toBe(score.nullExpectations.total);
    expect(buildMealDraftGateReport(evaluateVerifierGate(null), evaluateModelGate([report('development'), report('heldout')], context), null).overall).toBe('NOT_RUN');
  });

  it('fails on one forbidden value, one missed control, an outcome mismatch, an incomplete run or another corpus', () => {
    const results = perfectSafety();
    const crossField = results.findIndex((result) => result.id === 'en-cross-field-postfix-bound');
    const entry = corpus.cases[crossField]!;

    const forbidden = [...results];
    forbidden[crossField] = judgeSafetyCase(entry, { outcome: 'draft', proposed: { carbohydrateG: null, energyKcal: 500, fatG: null, proteinG: 20 } });
    const failed = evaluateVerifierGate({ corpus, digest: corpusDigest, results: forbidden });
    expect(failed.status).toBe('FAIL');
    expect(failed.reasons[0]).toMatch(/1 forbidden value\(s\) accepted in 1 case\(s\): en-cross-field-postfix-bound/u);

    // Over-withholding (the exact energy lost together with the bounded protein) is a FAIL too.
    const missed = [...results];
    missed[crossField] = judgeSafetyCase(entry, { outcome: 'draft', proposed: { carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null } });
    expect(evaluateVerifierGate({ corpus, digest: corpusDigest, results: missed }).reasons).toEqual([
      '1 positive control value(s) not proposed in 1 case(s): en-cross-field-postfix-bound.',
    ]);

    const wire = results.findIndex((result) => result.id === 'en-wire-numeric-value');
    const mismatch = [...results];
    mismatch[wire] = judgeSafetyCase(corpus.cases[wire]!, { outcome: 'ungrounded_output', proposed: { carbohydrateG: null, energyKcal: null, fatG: null, proteinG: null } });
    expect(evaluateVerifierGate({ corpus, digest: corpusDigest, results: mismatch }).status).toBe('FAIL');

    expect(evaluateVerifierGate({ corpus, digest: corpusDigest, results: results.slice(1) }).reasons[0]).toMatch(/^Incomplete/u);
    expect(evaluateVerifierGate({ corpus, digest: '0'.repeat(64), results }).reasons[0]).toMatch(/not the frozen one/u);
  });

  it('refuses a corpus without positive controls, where withholding everything would pass', () => {
    const adversarialOnly = { ...corpus, cases: corpus.cases.filter((entry) => entry.expect.outcome !== 'draft' || Object.values(entry.expect.nutrition).every((value) => value === 'not_proposed')) };
    const results = adversarialOnly.cases.map((entry) => judgeSafetyCase(entry, expectedClaims(entry)));
    const gate = evaluateVerifierGate({ corpus: adversarialOnly, digest: corpusDigest, results });
    expect(gate.status).toBe('FAIL');
    expect(gate.reasons).toContain('The corpus has no positive control, so a verifier that withholds everything would pass.');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('verifier fingerprint (isolated copies of the effective files)', () => {
  const real = defaultFingerprintSources();
  const actual = verifierFingerprint(real);
  const roots: string[] = [];
  /** The installed contracts package, relative to the repository (`packages/contracts`). */
  const contractsId = relative(real.root, real.contractsPackage).split(sep).join('/');
  /** Every file of the package the resolution may read: its manifest and its built modules (not only the hashed ones). */
  const packageFiles = [`${contractsId}/package.json`, ...readdirSync(join(real.contractsPackage, 'dist')).filter((name) => name.endsWith('.js')).map((name) => `${contractsId}/dist/${name}`)];

  /**
   * A temporary tree holding the fingerprinted API files and the contracts package (manifest and built modules),
   * optionally transformed, plus `extra` files. No runtime loads it, so the runtime entry is not cross-checked.
   */
  function copy(transform: (path: string, text: string) => string = (_path, text) => text, extra: Record<string, string> = {}): FingerprintSources {
    const root = mkdtempSync(join(tmpdir(), 'meal-draft-fingerprint-'));
    roots.push(root);
    for (const path of new Set([...actual.files.map((file) => file.path), ...packageFiles])) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, transform(path, readFileSync(join(real.root, path), 'utf8')));
    }
    for (const [path, text] of Object.entries(extra)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return { ...real, contractsPackage: join(root, contractsId), exists: existsSync, root, runtimeEntry: null };
  }
  const mutate = (path: string, from: string | RegExp, to: string) => (file: string, text: string) => {
    if (file !== path) return text;
    const next = text.replace(from, to);
    if (next === text) throw new Error(`The probe found nothing to change in ${path}`);
    return next;
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, { force: true, recursive: true });
  });

  it('covers the grounding, wire, prompt and adapter sources and the BUILT contract modules they load, with stable relative paths', () => {
    const paths = actual.files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
    for (const path of [
      'apps/api/src/meals/drafts/meal-draft-grounding.ts',
      'apps/api/src/meals/drafts/meal-draft-wire.ts',
      'apps/api/src/meals/drafts/meal-draft-prompt.ts',
      'apps/api/src/insights/ollama-provider.ts',
      'apps/api/src/insights/llm-provider.ts',
      'apps/api/src/runs/interpretation/bounded-fetch.ts',
      'packages/contracts/dist/meal-draft.js',
      'packages/contracts/dist/meals.js',
      'packages/contracts/dist/primitives.js',
    ]) {
      expect(paths).toContain(path);
    }
    expect(paths.some((path) => path.startsWith('packages/contracts/src/') || path.startsWith('docs/') || path.includes('evaluation/'))).toBe(false);
    expect(actual.packages.map((entry) => entry.name)).toEqual(['zod']);
    expect(verifierFingerprint(copy()).digest).toBe(actual.digest);
  });

  it('does not change with line endings alone, or with unrelated documentation and contracts', () => {
    expect(verifierFingerprint(copy((_path, text) => text.replace(/\r?\n/gu, '\r\n'))).digest).toBe(actual.digest);
    expect(verifierFingerprint(copy((_path, text) => text.replace(/\r\n/gu, '\n'))).digest).toBe(actual.digest);
    const unrelated = { 'docs/adr/0092-meal-draft-from-text.md': '# changed\n', 'docs/runbooks/meal-drafts.md': 'changed', 'packages/contracts/dist/run-search-interpretation.js': 'export const changed = 1;\n' };
    expect(verifierFingerprint(copy(undefined, unrelated)).digest).toBe(actual.digest);
  });

  it.each([
    ['an energy limit', 'packages/contracts/dist/meals.js', 'MEAL_ENERGY_KCAL_MAX = 20_000', 'MEAL_ENERGY_KCAL_MAX = 30_000'],
    ['the precision', 'packages/contracts/dist/meals.js', 'MEAL_VALUE_DECIMALS = 1', 'MEAL_VALUE_DECIMALS = 2'],
    ['title validation', 'packages/contracts/dist/meals.js', 'MEAL_TITLE_MAX_LENGTH = 120', 'MEAL_TITLE_MAX_LENGTH = 200'],
    ['the excerpt bound of the response contract', 'packages/contracts/dist/meal-draft.js', 'MEAL_DRAFT_EXCERPT_MAX = 160', 'MEAL_DRAFT_EXCERPT_MAX = 400'],
    ['a shared primitive', 'packages/contracts/dist/primitives.js', /export /u, 'export /* changed */ '],
    ['the grounding', 'apps/api/src/meals/drafts/meal-draft-grounding.ts', 'When in doubt, the field is withheld.', 'When in doubt, propose.'],
    ['the wire schema', 'apps/api/src/meals/drafts/meal-draft-wire.ts', 'z.string().max(600)', 'z.string().max(6000)'],
    ['the adapter', 'apps/api/src/insights/ollama-provider.ts', 'stream: false,', 'stream: true,'],
    ['the bounded fetch', 'apps/api/src/runs/interpretation/bounded-fetch.ts', /export /u, 'export /* changed */ '],
  ])('changes with %s (%s) and invalidates evidence measured before', (_label, path, from, to) => {
    const changed = verifierFingerprint(copy(mutate(path, from, to)));
    expect(changed.digest).not.toBe(actual.digest);
    expect(fingerprintChanges(actual, changed)).toEqual([`${path} (changed)`]);
    const gate = evaluateModelGate([report('development'), report('heldout')], { ...context, current: { ...current, fingerprint: changed } });
    expect(gate.status).toBe('FAIL');
    expect(codes(gate)).toEqual(['FINGERPRINT_MISMATCH', 'FINGERPRINT_MISMATCH']);
    expect(messages(gate, 'evidence')[0]).toContain(`${path} (changed)`);
    expect(gate.qualityThresholdsMet).toBe(true);
    expect(gate.evidenceValid).toBe(false);
  });

  it('follows a new import and records an external package version', () => {
    const added = copy(mutate('apps/api/src/meals/drafts/meal-draft-wire.ts', "import { z } from 'zod';", "import { z } from 'zod';\nimport './extra.js';"), {
      'apps/api/src/meals/drafts/extra.ts': 'export {};\n',
    });
    expect(fingerprintChanges(actual, verifierFingerprint(added))).toEqual(['apps/api/src/meals/drafts/extra.ts (added)', 'apps/api/src/meals/drafts/meal-draft-wire.ts (changed)']);
    const upgraded = verifierFingerprint({ ...copy(), packageVersion: () => '9.9.9' });
    expect(fingerprintChanges(actual, upgraded)).toEqual(['package zod 4.6.5 → 9.9.9']);
  });

  it('refuses to fingerprint a tree where an imported file is missing', () => {
    const broken = copy();
    rmSync(join(broken.root, 'packages/contracts/dist/primitives.js'));
    expect(() => verifierFingerprint(broken)).toThrow(/cannot resolve \.\/primitives\.js/u);
  });

  // --- The package as the runtime resolves it (fingerprint version 2) ---------------------------------------------

  const INDEX = `${contractsId}/dist/index.js`;
  const MEALS = `${contractsId}/dist/meals.js`;
  const ALTERNATE = `${contractsId}/dist/meals-alt.js`;
  const MANIFEST = `${contractsId}/package.json`;
  const mealsSource = readFileSync(join(real.root, MEALS), 'utf8');
  /** The meals module with another energy limit: the grounding withholds "Soup, 12000 kcal" against it. */
  const alternateMeals = (limit: string) => {
    const next = mealsSource.replace('MEAL_ENERGY_KCAL_MAX = 20_000', `MEAL_ENERGY_KCAL_MAX = ${limit}`);
    if (next === mealsSource) throw new Error('The probe found no energy limit in the meals module');
    return next;
  };
  const redirectMeals = mutate(INDEX, "export * from './meals.js';", "export * from './meals-alt.js';");
  const manifest = (change: (parsed: Record<string, unknown>) => void) => (file: string, text: string) => {
    if (file !== MANIFEST) return text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    change(parsed);
    return `${JSON.stringify(parsed, null, 2)}\n`;
  };
  const both =
    (...transforms: Array<(file: string, text: string) => string>) =>
    (file: string, text: string) =>
      transforms.reduce((current, transform) => transform(file, current), text);
  /** Both sets, otherwise valid version 3 evidence, recorded with `fingerprint`. */
  const evidenceWith = (fingerprint: VerifierFingerprint) =>
    (['development', 'heldout'] as const).map((set) =>
      report(set, {
        tamper: (raw) => {
          raw.metadata['fingerprint'] = JSON.parse(JSON.stringify(fingerprint)) as unknown;
        },
      }),
    );
  const judge = (reports: Json[], fingerprint: VerifierFingerprint) => evaluateModelGate(reports, { ...context, current: { ...current, fingerprint } });
  const expectStale = (gate: ModelGate) => {
    expect(gate.status).toBe('FAIL');
    expect(codes(gate)).toEqual(['FINGERPRINT_MISMATCH', 'FINGERPRINT_MISMATCH']);
    expect(gate.evidenceValid).toBe(false);
    expect(gate.qualityThresholdsMet).toBe(true);
    for (const message of messages(gate, 'evidence')) expect(message).toMatch(/Re-run both sets with the current tool \(40 calls\)\.$/u);
  };

  it('binds the package as Node.js resolves it: manifest, condition path, entry and the module defining each imported name', () => {
    expect(actual.fingerprintVersion).toBe(2);
    expect(actual.contracts).toMatchObject({ conditionPath: ['.', 'default'], entry: INDEX, manifest: MANIFEST, package: '@running-tracker/contracts' });
    expect(actual.contracts.bindings.map((binding) => binding.name)).toEqual([
      'MEAL_DRAFT_CLARIFICATION_REASONS',
      'MEAL_DRAFT_EXCERPT_MAX',
      'MEAL_DRAFT_UNSUPPORTED_REASONS',
      'MEAL_NUTRITION_FIELDS',
      'MEAL_NUTRITION_MAX',
      'MEAL_VALUE_DECIMALS',
      'mealCarbohydrateGSchema',
      'mealEnergyKcalSchema',
      'mealFatGSchema',
      'mealProteinGSchema',
      'mealTitleSchema',
    ]);
    expect([...new Set(actual.contracts.bindings.map((binding) => binding.module))].sort()).toEqual([`${contractsId}/dist/meal-draft.js`, MEALS]);
    // The barrel routes the names (recorded above) but is not hashed, and neither are contracts nothing imports from.
    const paths = actual.files.map((file) => file.path);
    expect(paths).not.toContain(INDEX);
    expect(paths.filter((path) => path.startsWith(`${contractsId}/`))).toEqual([`${contractsId}/dist/daily-metrics.js`, `${contractsId}/dist/meal-draft.js`, MEALS, `${contractsId}/dist/primitives.js`]);
    // The real runtime agrees (defaultFingerprintSources asked it); a test runner's extra condition changes nothing here.
    expect(real.runtimeEntry).not.toBeNull();
    expect(verifierFingerprint({ ...real, conditions: [...NODE_ESM_IMPORT_CONDITIONS] }).digest).toBe(actual.digest);
    expect(verifierFingerprint({ ...real, conditions: [...NODE_ESM_IMPORT_CONDITIONS, 'development'] }).digest).toBe(actual.digest);
    expect(runtimeConditions(['--import', 'tsx'], '')).toEqual([...NODE_ESM_IMPORT_CONDITIONS]);
    expect(runtimeConditions(['--conditions', 'development', '--conditions=edge'], '-C worker')).toEqual([...NODE_ESM_IMPORT_CONDITIONS, 'development', 'edge', 'worker']);
  });

  it('accepts otherwise valid version 3 evidence against the unchanged runtime tree', () => {
    const unchanged = verifierFingerprint(copy());
    expect(unchanged.digest).toBe(actual.digest);
    const gate = judge(evidenceWith(unchanged), unchanged);
    expect(gate.reasons).toEqual([]);
    expect(gate.status).toBe('PASS');
    expect(gate.evidenceValid).toBe(true);
  });

  it('refuses that evidence once the barrel redirects the meals export to a module with another energy limit', () => {
    const redirected = verifierFingerprint(copy(redirectMeals, { [ALTERNATE]: alternateMeals('10_000') }));
    expect(redirected.digest).not.toBe(actual.digest);
    expect(redirected.contracts.bindings.filter((binding) => binding.module === ALTERNATE).map((binding) => binding.name)).toHaveLength(8);
    expect(fingerprintChanges(actual, redirected)).toEqual([`MEAL_NUTRITION_FIELDS (+7) bound to ${ALTERNATE} (was ${MEALS})`, `${ALTERNATE} (added)`]);
    const gate = judge(evidenceWith(actual), redirected);
    expectStale(gate);
    expect(messages(gate, 'evidence')[0]).toContain(`MEAL_NUTRITION_FIELDS (+7) bound to ${ALTERNATE} (was ${MEALS}), ${ALTERNATE} (added)`);

    // An explicit re-export of one name wins over every `export *`, and is bound as such.
    const single = verifierFingerprint(copy(mutate(INDEX, "export * from './meals.js';", "export * from './meals.js';\nexport { MEAL_NUTRITION_MAX } from './meals-alt.js';"), { [ALTERNATE]: alternateMeals('10_000') }));
    expect(fingerprintChanges(actual, single)).toEqual([`MEAL_NUTRITION_MAX bound to ${ALTERNATE} (was ${MEALS})`, `${ALTERNATE} (added)`]);
    expectStale(judge(evidenceWith(actual), single));
  });

  it('hashes the redirected target itself: editing it again with the barrel unchanged invalidates evidence measured on it', () => {
    const redirected = verifierFingerprint(copy(redirectMeals, { [ALTERNATE]: alternateMeals('10_000') }));
    const measured = evidenceWith(redirected);
    expect(judge(measured, redirected).status).toBe('PASS'); // the supported redirect itself is measurable
    const editedAgain = verifierFingerprint(copy(redirectMeals, { [ALTERNATE]: alternateMeals('5_000') }));
    expect(editedAgain.contracts).toEqual(redirected.contracts);
    expect(fingerprintChanges(redirected, editedAgain)).toEqual([`${ALTERNATE} (changed)`]);
    expectStale(judge(measured, editedAgain));
  });

  it('detects a changed package entry or condition path, and refuses a manifest the runtime does not follow', () => {
    const entryCopy = { [`${contractsId}/dist/entry.js`]: readFileSync(join(real.root, INDEX), 'utf8') };
    const moved = verifierFingerprint(
      copy(
        manifest((parsed) => {
          parsed['exports'] = { '.': { types: './dist/index.d.ts', default: './dist/entry.js' }, './openapi.json': './openapi/openapi.json' };
        }),
        entryCopy,
      ),
    );
    expect(fingerprintChanges(actual, moved)).toEqual([`contracts entry ${INDEX} (. → default) → ${contractsId}/dist/entry.js (. → default)`]);
    expectStale(judge(evidenceWith(actual), moved));

    const importCondition = manifest((parsed) => {
      parsed['exports'] = { '.': { types: './dist/index.d.ts', import: './dist/entry.js', default: './dist/index.js' } };
    });
    expect(fingerprintChanges(actual, verifierFingerprint(copy(importCondition, entryCopy)))).toEqual([`contracts entry ${INDEX} (. → default) → ${contractsId}/dist/entry.js (. → import)`]);

    // A condition the runtime adds is followed; one it lacks is not.
    const development = copy(
      manifest((parsed) => {
        parsed['exports'] = { '.': { development: './dist/entry.js', default: './dist/index.js' } };
      }),
      entryCopy,
    );
    expect(verifierFingerprint({ ...development, conditions: [...NODE_ESM_IMPORT_CONDITIONS] }).contracts.entry).toBe(INDEX);
    expect(verifierFingerprint({ ...development, conditions: [...NODE_ESM_IMPORT_CONDITIONS, 'development'] }).contracts.conditionPath).toEqual(['.', 'development']);

    // The manifest must lead where the runtime itself goes.
    const disagreeing = { ...copy(undefined, entryCopy) };
    expect(verifierFingerprint({ ...disagreeing, runtimeEntry: join(disagreeing.root, INDEX) }).digest).toBe(actual.digest);
    expect(() => verifierFingerprint({ ...disagreeing, runtimeEntry: join(disagreeing.root, contractsId, 'dist/entry.js') })).toThrow(
      new RegExp(`resolves to ${INDEX}, but the runtime loads ${contractsId}/dist/entry\\.js`, 'u'),
    );
  });

  it.each([
    ['no "exports"', manifest((parsed) => delete parsed['exports']), /has no "exports"; resolution through "main" or an index file is not supported/u],
    ['a fallback array', manifest((parsed) => void (parsed['exports'] = { '.': ['./dist/index.js'] })), /is a fallback array/u],
    ['a null target', manifest((parsed) => void (parsed['exports'] = { '.': { default: null } })), /is null \(not exported\)/u],
    ['a pattern target', manifest((parsed) => void (parsed['exports'] = { '.': './dist/*.js' })), /is not a plain relative file inside the package/u],
    ['a target outside the package', manifest((parsed) => void (parsed['exports'] = { '.': './../api/package.json' })), /is not a plain relative file inside the package/u],
    ['a missing target', manifest((parsed) => void (parsed['exports'] = { '.': './dist/missing.js' })), /"\.\/dist\/missing\.js" in .* does not exist/u],
    ['no matching condition', manifest((parsed) => void (parsed['exports'] = { '.': { types: './dist/index.d.ts', browser: './dist/index.js' } })), /no condition of "exports" → "\." .* matches the runtime conditions/u],
    ['a CommonJS target', manifest((parsed) => void (parsed['exports'] = { '.': './dist/index.cjs' })), /is not an ES module/u],
    ['subpaths mixed with conditions', manifest((parsed) => void (parsed['exports'] = { '.': './dist/index.js', default: './dist/index.js' })), /mixes subpaths and conditions/u],
    ['a missing re-export target', mutate(INDEX, "export * from './meals.js';", "export * from './gone.js';"), new RegExp(`cannot resolve \\./gone\\.js from ${INDEX}`, 'u')],
    ['a re-export from another package', mutate(INDEX, "export * from './meals.js';", "export * from './meals.js';\nexport * from 'zod';"), /re-exports from "zod"; only relative modules inside the package are supported/u],
    ['a barrel that also runs code', mutate(INDEX, "export * from './meals.js';", "export * from './meals.js';\nglobalThis.patched = true;"), /passes MEAL_DRAFT_CLARIFICATION_REASONS on but also contains statements other than re-exports/u],
    ['an export statement the reader cannot name', mutate(`${contractsId}/dist/activities.js`, /$/u, '\nexport const { destructured } = {};\n'), /activities\.js has an export statement this reader cannot name/u],
    ['a name the package no longer exports', mutate(`${contractsId}/dist/meal-draft.js`, 'export const MEAL_DRAFT_EXCERPT_MAX', 'const MEAL_DRAFT_EXCERPT_MAX'), /does not export MEAL_DRAFT_EXCERPT_MAX \(imported by apps\/api\/src\/meals\/drafts\/meal-draft-grounding\.ts/u],
    [
      'a namespace import of the package',
      mutate('apps/api/src/meals/drafts/meal-draft-wire.ts', "import { MEAL_DRAFT_CLARIFICATION_REASONS, MEAL_DRAFT_UNSUPPORTED_REASONS } from '@running-tracker/contracts';", "import * as contracts from '@running-tracker/contracts';"),
      /meal-draft-wire\.ts loads it other than by named imports from the package root/u,
    ],
    ['a dynamic import of the package', mutate('apps/api/src/meals/drafts/meal-draft-wire.ts', "import { z } from 'zod';", "import { z } from 'zod';\nconst later = () => import('@running-tracker/contracts');"), /meal-draft-wire\.ts loads it dynamically/u],
    ['a subpath import of the package',mutate('apps/api/src/meals/drafts/meal-draft-wire.ts', "from '@running-tracker/contracts';", "from '@running-tracker/contracts/dist/meal-draft.js';"), /meal-draft-wire\.ts loads it other than by named imports/u],
  ])('fails closed on %s', (_label, transform, expected) => {
    expect(() => verifierFingerprint(copy(transform))).toThrow(expected);
  });

  // --- Export statements sharing a line (the reader reads statements where they start a line) --------------------

  const STAR_MEALS = "export * from './meals.js';";
  const withAlternate = () => ({ [ALTERNATE]: alternateMeals('10_000') });
  const notAtLineStart = (id: string) => new RegExp(`${id.replaceAll('.', '\\.')} has an \`export\` that does not start a line .*put each export statement on its own line`, 'u');

  it.each([
    ['an explicit override after a star export', `${STAR_MEALS} export { MEAL_NUTRITION_MAX } from './meals-alt.js';`],
    ['the same with a block comment between them', `${STAR_MEALS} /* override */ export { MEAL_NUTRITION_MAX } from './meals-alt.js';`],
    ['the override as the third statement on the line', `${STAR_MEALS} export * from './models.js'; export { MEAL_NUTRITION_MAX } from './meals-alt.js';`],
  ])('refuses %s on one line, so the unread override cannot leave evidence passing', (_label, line) => {
    expect(() => verifierFingerprint(copy(mutate(INDEX, STAR_MEALS, line), withAlternate()))).toThrow(notAtLineStart(INDEX));
    // The same statements one per line: the override is bound to the module Node.js takes it from, the fingerprint
    // changes, and otherwise valid version 3 evidence measured before is refused.
    const ownLines = verifierFingerprint(copy(mutate(INDEX, STAR_MEALS, line.replaceAll('; ', ';\n')), withAlternate()));
    expect(ownLines.contracts.bindings.find((binding) => binding.name === 'MEAL_NUTRITION_MAX')?.module).toBe(ALTERNATE);
    expect(ownLines.digest).not.toBe(actual.digest);
    expect(fingerprintChanges(actual, ownLines)).toEqual([`MEAL_NUTRITION_MAX bound to ${ALTERNATE} (was ${MEALS})`, `${ALTERNATE} (added)`]);
    expectStale(judge(evidenceWith(actual), ownLines));
  });

  it('refuses a same-line export in any contract module it reads, and counts same-line code as barrel content', () => {
    const activities = `${contractsId}/dist/activities.js`;
    const definedTwice = copy(mutate(activities, /$/u, '\nexport const ACTIVITY_PROBE = 1; export const MEAL_NUTRITION_MAX = {};\n'));
    expect(() => verifierFingerprint(definedTwice)).toThrow(notAtLineStart(activities));
    // Barrel classification uses the statements parsed: code after a re-export on its line makes the barrel impure.
    const codeOnTheLine = copy(mutate(INDEX, STAR_MEALS, `${STAR_MEALS} globalThis.patched = true;`));
    expect(() => verifierFingerprint(codeOnTheLine)).toThrow(/passes MEAL_DRAFT_CLARIFICATION_REASONS on but also contains statements other than re-exports/u);
  });

  it('keeps multi-line export statements and ordinary barrels with comments supported', () => {
    const multiLineStar = verifierFingerprint(copy(mutate(INDEX, STAR_MEALS, "export *\n  from './meals.js';")));
    expect(multiLineStar.digest).toBe(actual.digest);
    expect(judge(evidenceWith(actual), multiLineStar).status).toBe('PASS');

    const multiLineOverride = verifierFingerprint(copy(mutate(INDEX, STAR_MEALS, `${STAR_MEALS}\nexport {\n  MEAL_NUTRITION_MAX,\n} from './meals-alt.js';`), withAlternate()));
    expect(fingerprintChanges(actual, multiLineOverride)).toEqual([`MEAL_NUTRITION_MAX bound to ${ALTERNATE} (was ${MEALS})`, `${ALTERNATE} (added)`]);
    expectStale(judge(evidenceWith(actual), multiLineOverride));

    const commented = verifierFingerprint(copy(mutate(INDEX, STAR_MEALS, `// meals\n/* the meal log,\n   two lines */\n\n${STAR_MEALS} // a trailing note`)));
    expect(commented.digest).toBe(actual.digest);
    expect(judge(evidenceWith(actual), commented).status).toBe('PASS');
  });

  it('fails closed on a name two star-exported modules supply', () => {
    const extra = { [`${contractsId}/dist/zz-extra.js`]: 'export const MEAL_NUTRITION_MAX = {};\n' };
    const twice = copy(mutate(INDEX, "export * from './meals.js';", "export * from './meals.js';\nexport * from './zz-extra.js';"), extra);
    expect(() => verifierFingerprint(twice)).toThrow(new RegExp(`MEAL_NUTRITION_MAX is ambiguous in ${INDEX}: ${MEALS} and ${contractsId}/dist/zz-extra\\.js both supply it`, 'u'));
  });

  it('does not change with what the runtime does not load for the verifier', () => {
    const unrelated = both(
      // Another contract module (still exporting nothing the verifier imports), and a new one in the barrel.
      mutate(`${contractsId}/dist/activities.js`, /$/u, '\nexport const ACTIVITY_PROBE = 1;\n'),
      mutate(INDEX, "export * from './weekly-review.js';", "export * from './weekly-review.js';\nexport * from './new-contract.js';"),
      // Manifest fields an ESM import of the package root does not read.
      manifest((parsed) => {
        parsed['version'] = '9.9.9';
        parsed['scripts'] = {};
        parsed['exports'] = { '.': { types: './dist/other.d.ts', require: './dist/other.cjs', default: './dist/index.js' }, './openapi.json': './openapi/openapi.json' };
      }),
    );
    expect(verifierFingerprint(copy(unrelated, { [`${contractsId}/dist/new-contract.js`]: 'export const somethingElse = 1;\n' })).digest).toBe(actual.digest);
    expect(verifierFingerprint(copy(both(unrelated, (_path, text) => text.replace(/\r?\n/gu, '\r\n')), { [`${contractsId}/dist/new-contract.js`]: 'export const somethingElse = 1;\r\n' })).digest).toBe(actual.digest);
  });

  it('names the version change when judging a report recorded with fingerprint version 1', () => {
    const versionOne = { digest: 'e2b8f5e425c1a383bb088ea6a00ddb99e42592f78ff163fa34cb1ab270e47780', files: actual.files, fingerprintVersion: 1, packages: actual.packages };
    const reports = (['development', 'heldout'] as const).map((set) =>
      report(set, {
        tamper: (raw) => {
          raw.metadata['fingerprint'] = versionOne;
        },
      }),
    );
    expect(fingerprintChanges(versionOne, actual)).toEqual(['fingerprint version 1 → 2', 'contract resolution not recorded']);
    const gate = judge(reports, actual);
    expectStale(gate);
    expect(messages(gate, 'evidence')[0]).toContain('(fingerprint version 1 → 2, contract resolution not recorded)');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('model gate', () => {
  it('records thresholds frozen before the baseline calls', () => {
    expect(MEAL_DRAFT_MODEL_GATE).toEqual({
      frozenOn: '2026-11-16',
      maxIncorrectAccepted: 0,
      maxTechnicalFailureRate: 0.1,
      minExtractionRecall: 0.85,
      minOutcomeAccuracy: 0.85,
      requiredSets: ['development', 'heldout'],
    });
    expect(Object.isFrozen(MEAL_DRAFT_MODEL_GATE)).toBe(true);
  });

  it('passes complete runs of both sets with one valid profile that meet every threshold, and exposes that profile', () => {
    const gate = evaluateModelGate([report('development'), report('heldout')], context);
    expect(gate.reasons).toEqual([]);
    expect(gate.status).toBe('PASS');
    expect(gate.evidenceValid).toBe(true);
    expect(gate.profile).toEqual(baseProfile);
    expect(gate.fingerprint).toEqual({ current: current.fingerprint.digest, reports: { development: current.fingerprint.digest, heldout: current.fingerprint.digest } });
    expect(gate.metrics).toMatchObject({ cases: 40, extractionPrecision: 1, extractionRecall: 1, incorrectAccepted: 0, outcomeAccuracy: 1, technicalFailureRate: 0 });
    expect(gate.metrics?.byLanguage.en.cases).toBe(20);
  });

  it.each([
    ['the deadline', { timeoutMs: 55_000 }],
    ['the temperature', { generation: { ...baseProfile.generation, temperature: 0.7 } }],
    ['thinking', { generation: { ...baseProfile.generation, think: true } }],
    ['the context window', { generation: { ...baseProfile.generation, numCtx: 8_192 } }],
    ['the output limit', { generation: { ...baseProfile.generation, numPredict: 800 } }],
    ['the response-size limit', { maxResponseBytes: 65_536 }],
    ['the runtime version', { ollamaVersion: '0.41.0' }],
    ['the model digest', { modelDigest: 'c'.repeat(64) }],
    ['the model', { model: 'qwen3:4b' }],
  ] as const)('does not pass when the held-out set was measured with another %s', (_label, change) => {
    const profile = { ...baseProfile, ...change } as MealDraftExecutionProfile;
    const gate = evaluateModelGate([report('development'), report('heldout', { profile })], context);
    expect(gate.status).toBe('FAIL');
    expect(codes(gate)).toEqual(['PROFILE_MISMATCH']);
    expect(gate.profile).toBeNull();
    expect(gate.qualityThresholdsMet).toBe(true);
  });

  it('does not pass a report whose profile is missing, invalid, or disagrees with its own duplicated fields', () => {
    const without = evaluateModelGate([report('development'), report('heldout', { tamper: (raw) => delete raw['executionProfile'] })], context);
    expect(codes(without)).toEqual(['PROFILE_INVALID']);
    const retried = evaluateModelGate([report('development'), report('heldout', { tamper: (raw) => (raw['executionProfile'] = { ...baseProfile, retries: 1 }) })], context);
    expect(codes(retried)).toEqual(['PROFILE_INVALID']);
    expect(messages(retried)[0]).toMatch(/retries/u);

    const cases: Array<[string, (raw: Json & { metadata: Json }) => void]> = [
      ['timeoutMs', (raw) => (raw['timeoutMs'] = 55_000)],
      ['runtimeVersion', (raw) => (raw['runtimeVersion'] = '0.41.0')],
      ['generation.temperature', (raw) => (raw['generation'] = { ...baseProfile.generation, temperature: 0.7 })],
      ['metadata.generation', (raw) => delete raw.metadata['generation']],
      ['metadata.timeoutMs', (raw) => (raw.metadata['timeoutMs'] = null)],
      ['metadata.modelDigest', (raw) => (raw.metadata['modelDigest'] = 'c'.repeat(64))],
      ['metadata.ollamaVersion', (raw) => (raw.metadata['ollamaVersion'] = '0.40.15')],
      ['metadata.model', (raw) => (raw.metadata['model'] = 'qwen3:4b')],
      ['model', (raw) => (raw['model'] = 'qwen3:4b')],
    ];
    for (const [field, tamper] of cases) {
      const gate = evaluateModelGate([report('development'), report('heldout', { tamper })], context);
      expect(gate.status, field).toBe('FAIL');
      expect(codes(gate), field).toEqual(['PROFILE_INCONSISTENT']);
      expect(messages(gate)[0], field).toContain(field);
    }
  });

  it('does not pass when the requests were not all checked against the profile', () => {
    const unchecked = evaluateModelGate([report('development'), report('heldout', { tamper: (raw) => (raw['profileCheck'] = null) })], context);
    expect(codes(unchecked)).toEqual(['PROFILE_UNVERIFIED']);
    const mismatched = evaluateModelGate([report('development'), report('heldout', { tamper: (raw) => (raw['profileCheck'] = { mismatches: 1, requests: 20 }) })], context);
    expect(codes(mismatched)).toEqual(['PROFILE_UNVERIFIED']);
    const fewer = evaluateModelGate([report('development'), report('heldout', { tamper: (raw) => (raw['profileCheck'] = { mismatches: 0, requests: 19 }) })], context);
    expect(codes(fewer)).toEqual(['PROFILE_UNVERIFIED']);
  });

  it('refuses legacy reports as evidence with an actionable reason, while still showing what they measured', () => {
    const v2 = (set: MealDraftEvaluationSet) =>
      report(set, {
        tamper: (raw) => {
          raw['reportVersion'] = 2;
          delete raw['executionProfile'];
          delete raw['profileCheck'];
          delete raw.metadata['fingerprint'];
        },
      });
    const gate = evaluateModelGate([v2('development'), v2('heldout')], context);
    expect(gate.status).toBe('FAIL');
    expect(codes(gate)).toEqual(['LEGACY_REPORT', 'LEGACY_REPORT']);
    expect(gate.reasons[0]?.kind).toBe('evidence');
    expect(messages(gate)[0]).toMatch(/report version 2: no verifier fingerprint over contracts and adapter, no execution profile; .* Re-run both sets with the current tool \(40 calls\)\.$/u);
    expect(gate.evidenceValid).toBe(false);
    expect(gate.qualityThresholdsMet).toBe(true);
    expect(gate.profile).toBeNull();

    // The 2026-11-14 format (version 1: no version field, no metadata, no audits).
    const v1 = (set: MealDraftEvaluationSet) =>
      report(set, {
        tamper: (raw) => {
          for (const key of ['reportVersion', 'status', 'metadata', 'executionProfile', 'profileCheck', 'byCategory', 'maxCalls']) delete raw[key];
          for (const entry of raw['cases'] as Json[]) delete entry['audit'];
        },
      });
    const legacy = evaluateModelGate([v1('development'), v1('heldout')], context);
    expect(codes(legacy)).toEqual(['LEGACY_REPORT', 'LEGACY_REPORT']);
    expect(messages(legacy)[0]).toMatch(/report version 1/u);
  });

  it('is NOT_RUN without reports, with NOT_RUN reports, with fake reports only, or when the runtime never answered', () => {
    expect(evaluateModelGate([], context).status).toBe('NOT_RUN');
    const notRun = { reason: 'Model qwen3:8b is not installed', reportVersion: 3, set: 'development', status: 'NOT_RUN' };
    const gate = evaluateModelGate([notRun, { ...notRun, set: 'heldout' }], context);
    expect(gate.status).toBe('NOT_RUN');
    expect(gate.reasons[0]?.message).toBe('development: NOT_RUN: Model qwen3:8b is not installed.');

    const fake = evaluateModelGate([report('development', { provider: 'fake' }), report('heldout', { provider: 'fake' })], context);
    expect(fake.status).toBe('NOT_RUN');
    expect(fake.reasons.map((entry) => entry.code)).toContain('FAKE_IGNORED');

    const unavailable = (set: MealDraftEvaluationSet) =>
      report(set, {
        edit: (results) => failFirst(3, 'provider_unavailable')(results).slice(0, 3),
        stopped: { afterCases: 3, reason: 'provider_unavailable' },
      });
    expect(evaluateModelGate([unavailable('development'), unavailable('heldout')], context).status).toBe('NOT_RUN');
  });

  it('fails a partial run, a stopped run or a missing set, whatever the scores', () => {
    const missing = evaluateModelGate([report('development')], context);
    expect(missing.status).toBe('FAIL');
    expect(messages(missing, 'completeness')).toContain('Incomplete execution: the heldout set is not run (no report).');

    const truncated = evaluateModelGate([report('development'), report('heldout', { edit: (results) => results.slice(0, 19) })], context);
    expect(truncated.status).toBe('FAIL');
    expect(truncated.sets.heldout.state).toBe('partial');

    const stopped = evaluateModelGate([report('development'), report('heldout', { stopped: { afterCases: 20, reason: 'timeout' } })], context);
    expect(messages(stopped, 'completeness')[0]).toMatch(/heldout set is partial/u);

    // A fake report beside real ones is ignored, not counted.
    const withFake = evaluateModelGate([report('development'), report('heldout', { provider: 'fake' })], context);
    expect(withFake.status).toBe('FAIL');
    expect(withFake.sets.heldout.state).toBe('not_run');
  });

  it('fails on a single incorrectly accepted value, as a quality failure with valid evidence', () => {
    const wrongValue = (results: MealDraftCaseResult[]) =>
      results.map((result) =>
        result.case.id === 'en-dev-full' && result.proposal?.outcome === 'draft'
          ? { ...result, proposal: { ...result.proposal, nutrition: { ...result.proposal.nutrition, energyKcal: { excerpt: '650', status: 'proposed' as const, value: 600 } } } }
          : result,
      );
    const gate = evaluateModelGate([report('development', { edit: wrongValue }), report('heldout')], context);
    expect(gate.status).toBe('FAIL');
    expect(gate.reasons).toEqual([{ code: 'INCORRECT_ACCEPTED', kind: 'quality', message: '1 nutrition value(s) incorrectly accepted (allowed 0).' }]);
    expect(gate.evidenceValid).toBe(true);
    expect(gate.metrics?.incorrectAcceptedFields).toEqual([{ actual: 600, expected: 650, field: 'energyKcal', id: 'en-dev-full' }]);
  });

  it('re-scores from the per-case results, not from the summary a report carries', () => {
    const tampered = report('development', { edit: failFirst(6) });
    const perfect = report('development');
    const forged = { ...tampered, byLanguage: perfect['byLanguage'], score: perfect['score'] };
    expect(evaluateModelGate([forged, report('heldout')], context).status).toBe('FAIL');
  });

  it('applies each threshold at its boundary', () => {
    // 4 failures in 40 cases is 10 %: allowed; 5 is 12.5 %. (Failed cases also lose their outcome and values, so other
    // thresholds may fail on the same runs; only the failure-rate reason is checked here.)
    const four = evaluateModelGate([report('development', { edit: failFirst(4) }), report('heldout')], context);
    expect(four.metrics).toMatchObject({ outcomeAccuracy: 0.9, technicalFailureRate: 0.1 });
    expect(codes(four)).not.toContain('FAILURE_RATE');
    const five = evaluateModelGate([report('development', { edit: failFirst(5) }), report('heldout')], context);
    expect(messages(five, 'quality').some((message) => message.startsWith('Technical failure rate 0.125'))).toBe(true);

    // 6 wrong outcomes of 40 is exactly 85 %: allowed; 7 is not. Clarifications instead of drafts, with no failure.
    const asClarify = (count: number) => (results: MealDraftCaseResult[]) =>
      results.map((result, index) => (index < count ? { ...result, audit: { fields: null, multipleMealsOverride: false }, proposal: { outcome: 'clarify' as const, reason: 'no_food_named' as const } } : result));
    const six = evaluateModelGate([report('development', { edit: asClarify(6) }), report('heldout')], context);
    expect(six.metrics?.outcomeAccuracy).toBe(0.85);
    expect(codes(six)).not.toContain('OUTCOME_ACCURACY');
    const seven = evaluateModelGate([report('development', { edit: asClarify(7) }), report('heldout')], context);
    expect(messages(seven, 'quality').some((message) => message.startsWith('Outcome accuracy 0.825'))).toBe(true);
  });

  it('fails when precision is undefined because no value was accepted', () => {
    const abstainAll = (results: MealDraftCaseResult[]) =>
      results.map((result) => {
        if (result.proposal?.outcome !== 'draft') return result;
        const nutrition = Object.fromEntries(MEAL_NUTRITION_FIELDS.map((field) => [field, { status: 'not_stated' }])) as Extract<GroundedProposal, { outcome: 'draft' }>['nutrition'];
        return { ...result, proposal: { ...result.proposal, nutrition } };
      });
    const gate = evaluateModelGate([report('development', { edit: abstainAll }), report('heldout', { edit: abstainAll })], context);
    expect(gate.status).toBe('FAIL');
    expect(gate.metrics).toMatchObject({ extractionPrecision: null, extractionRecall: 0, incorrectAccepted: 0 });
    expect(codes(gate)).toContain('PRECISION_UNDEFINED');
  });

  it('fails a report measured with another prompt, another dataset, a malformed report or two reports for one set', () => {
    const prompt = evaluateModelGate([report('development', { tamper: (raw) => (raw['promptDigest'] = '0'.repeat(64)) }), report('heldout')], context);
    expect(codes(prompt)).toContain('PROMPT_MISMATCH');
    const dataset = evaluateModelGate([report('development', { tamper: (raw) => (raw['datasetDigest'] = '0'.repeat(64)) }), report('heldout')], context);
    expect(codes(dataset)).toContain('DATASET_MISMATCH');
    expect(codes(evaluateModelGate([{ hello: 'world' }, report('development'), report('heldout')], context))).toEqual(['REPORT_INVALID']);
    expect(codes(evaluateModelGate([report('development'), report('development'), report('heldout')], context))).toEqual(['DUPLICATE_REPORT']);
  });
});

describe('overall status and exit codes', () => {
  it('lets FAIL win over NOT_RUN and NOT_RUN over PASS', () => {
    expect(overallStatus(['PASS', 'PASS'])).toBe('PASS');
    expect(overallStatus(['PASS', 'NOT_RUN'])).toBe('NOT_RUN');
    expect(overallStatus(['NOT_RUN', 'FAIL'])).toBe('FAIL');
    expect(overallStatus([])).toBe('NOT_RUN');
    expect([gateExitCode('PASS'), gateExitCode('FAIL'), gateExitCode('NOT_RUN')]).toEqual([0, 2, 3]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('evaluation command line', () => {
  /** An Ollama chat reply carrying one wire answer (a refusal: enough to exercise the real adapter end to end). */
  const ollamaReply = () =>
    new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ outcome: 'unsupported', reason: 'not_a_meal' }), role: 'assistant' } }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });

  function harness(overrides: Partial<MealDraftCliDependencies> = {}) {
    const written = new Map<string, string>();
    const lines: string[] = [];
    let inferences = 0;
    let runtimeReads = 0;
    let adapters = 0;
    const counting = (provider: LlmProvider): LlmProvider => ({
      generateStructured: (...args) => {
        inferences += 1;
        return provider.generateStructured(...args);
      },
      model: provider.model,
    });
    const files = new Map<string, unknown>([
      ['dev.json', report('development')],
      ['heldout.json', report('heldout')],
    ]);
    const deps: MealDraftCliDependencies = {
      clock: { monotonicNow: () => performance.now() },
      createFakeProvider: () => counting(new FakeMealDraftProvider()),
      // The PRODUCTION adapter, behind the profile guard the CLI hands it, over a fake network.
      createOllamaProvider: (options) => {
        adapters += 1;
        return counting(new OllamaProvider(options));
      },
      environment: { MEAL_DRAFTS_MODEL: 'qwen3:8b' },
      fetchOllamaJson: (_baseUrl, path) => {
        runtimeReads += 1;
        return Promise.resolve(path === '/api/version' ? { version: '0.40.16' } : { models: [{ digest: modelDigest, name: 'qwen3:8b' }] });
      },
      git: (args) => (args[0] === 'rev-parse' ? 'a'.repeat(40) : ''),
      info: (line) => lines.push(line),
      networkFetch: () => Promise.resolve(ollamaReply()),
      now: () => new Date('2026-11-16T00:00:00.000Z'),
      readJson: (path) => {
        if (!files.has(path)) throw new Error(`ENOENT ${path}`);
        return files.get(path);
      },
      runSafety: () => ({ corpus, digest: corpusDigest, results: perfectSafety() }),
      writeText: (path, text) => written.set(path, text),
      ...overrides,
    };
    return { adapters: () => adapters, deps, files, inferences: () => inferences, lines, runtimeReads: () => runtimeReads, written };
  }

  it('parses repeated --model and refuses unknown or valueless arguments', () => {
    expect(parseMealDraftCliArguments(['--check', '--model', 'a.json', '--model', 'b.json', '--out', 'g.json'])).toMatchObject({ check: true, models: ['a.json', 'b.json'], out: 'g.json' });
    expect(() => parseMealDraftCliArguments(['--sett', 'safety'])).toThrow(/Unknown argument --sett/u);
    expect(() => parseMealDraftCliArguments(['--out'])).toThrow(/--out needs a value/u);
    expect(() => parseMealDraftCliArguments(['--model', '--check'])).toThrow(/--model needs a value/u);
  });

  it('--check exits 0 only when both gates pass, writes the verdict with the judged profile, and stays offline', async () => {
    const run = harness();
    expect(await runMealDraftEvaluationCli(['--check', '--model', 'dev.json', '--model', 'heldout.json', '--out', 'gates.json'], run.deps)).toBe(0);
    const verdict = JSON.parse(run.written.get('gates.json')!) as {
      exitCode: number;
      model: { evidenceValid: boolean; profile: unknown; status: string };
      overall: string;
      permits: string;
      verifier: { status: string };
    };
    expect(verdict).toMatchObject({ exitCode: 0, model: { evidenceValid: true, profile: baseProfile, status: 'PASS' }, overall: 'PASS', verifier: { status: 'PASS' } });
    expect(verdict.permits).toMatch(/further local experimentation only/u);
    expect([run.runtimeReads(), run.adapters(), run.inferences()]).toEqual([0, 0, 0]);
  });

  it('--check exits 3 without model reports and 2 when the verifier fails, whatever the model', async () => {
    const { deps } = harness();
    expect(await runMealDraftEvaluationCli(['--check'], deps)).toBe(3);
    const failing = harness({
      runSafety: () => {
        const results = perfectSafety();
        const index = results.findIndex((result) => result.id === 'en-bound-within');
        results[index] = judgeSafetyCase(corpus.cases[index]!, { outcome: 'draft', proposed: { carbohydrateG: null, energyKcal: 600, fatG: null, proteinG: null } });
        return { corpus, digest: corpusDigest, results };
      },
    });
    expect(await runMealDraftEvaluationCli(['--check'], failing.deps)).toBe(2);
    expect(await runMealDraftEvaluationCli(['--check', '--model', 'dev.json', '--model', 'heldout.json'], failing.deps)).toBe(2);
    expect(failing.lines.join('\n')).toMatch(/VERIFIER GATE: FAIL/u);
  });

  it('--check exits 2 on legacy evidence and says it is an evidence problem, not a quality failure', async () => {
    const run = harness();
    const legacy = (set: MealDraftEvaluationSet) => report(set, { tamper: (raw) => (raw['reportVersion'] = 2) });
    run.files.set('dev-v2.json', legacy('development'));
    run.files.set('heldout-v2.json', legacy('heldout'));
    expect(await runMealDraftEvaluationCli(['--check', '--model', 'dev-v2.json', '--model', 'heldout-v2.json'], run.deps)).toBe(2);
    const output = run.lines.join('\n');
    expect(output).toMatch(/MODEL GATE: FAIL/u);
    expect(output).toMatch(/\[evidence LEGACY_REPORT\] The development report is report version 2/u);
    expect(output).toMatch(/NOT validated evidence.*thresholds met/u);
  });

  it('--check refuses an unreadable report instead of judging without it', async () => {
    const { deps } = harness();
    await expect(runMealDraftEvaluationCli(['--check', '--model', 'missing.json'], deps)).rejects.toThrow(/ENOENT/u);
  });

  it('--set safety writes its report and exits 2 on FAIL, 0 on PASS, without any provider', async () => {
    const passing = harness();
    expect(await runMealDraftEvaluationCli(['--set', 'safety', '--out', 's.json'], passing.deps)).toBe(0);
    expect(JSON.parse(passing.written.get('s.json')!)).toMatchObject({
      gate: { status: 'PASS' },
      kind: 'deterministic-verifier-safety',
      metadata: { fingerprint: { digest: current.fingerprint.digest }, git: { sha: 'a'.repeat(40) } },
      reportVersion: 3,
    });
    expect(passing.inferences()).toBe(0);
    const failing = harness({ runSafety: () => ({ corpus, digest: corpusDigest, results: perfectSafety().slice(2) }) });
    expect(await runMealDraftEvaluationCli(['--set', 'safety', '--out', 's.json'], failing.deps)).toBe(2);
    await expect(runMealDraftEvaluationCli(['--set', 'safety', '--provider', 'ollama'], passing.deps)).rejects.toThrow(/calls no provider/u);
  });

  it('writes a NOT_RUN report and exits 3 when the runtime is unreachable, the model is not installed or its digest is unknown', async () => {
    const unreachable = harness({ fetchOllamaJson: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434')) });
    expect(await runMealDraftEvaluationCli(['--set', 'development', '--provider', 'ollama', '--out', 'd.json'], unreachable.deps)).toBe(3);
    const notRun = JSON.parse(unreachable.written.get('d.json')!) as { executionProfile: unknown; reason: string; set: string; status: string };
    expect(notRun).toMatchObject({ executionProfile: null, set: 'development', status: 'NOT_RUN' });
    expect(notRun.reason).toMatch(/could not be reached \(connect ECONNREFUSED/u);
    expect(unreachable.inferences()).toBe(0);

    const absent = harness({ fetchOllamaJson: (_baseUrl, path) => Promise.resolve(path === '/api/version' ? { version: '0.40.16' } : { models: [{ name: 'qwen3:4b' }] }) });
    expect(await runMealDraftEvaluationCli(['--set', 'heldout', '--provider', 'ollama', '--out', 'h.json'], absent.deps)).toBe(3);
    expect(JSON.parse(absent.written.get('h.json')!)).toMatchObject({ reason: 'Model qwen3:8b is not installed in the local Ollama; nothing was pulled.', status: 'NOT_RUN' });

    const undigested = harness({ fetchOllamaJson: (_baseUrl, path) => Promise.resolve(path === '/api/version' ? { version: '0.40.16' } : { models: [{ name: 'qwen3:8b' }] }) });
    expect(await runMealDraftEvaluationCli(['--set', 'heldout', '--provider', 'ollama', '--out', 'h.json'], undigested.deps)).toBe(3);
    expect((JSON.parse(undigested.written.get('h.json')!) as { reason: string }).reason).toMatch(/execution profile cannot be established: modelDigest/u);
    expect([undigested.adapters(), undigested.inferences()]).toEqual([0, 0]);
  });

  it('a dry run makes no inference; a real run records the profile captured before its calls and checks every request', async () => {
    const dry = harness();
    expect(await runMealDraftEvaluationCli(['--set', 'development', '--provider', 'ollama', '--dry-run'], dry.deps)).toBe(0);
    expect(dry.inferences()).toBe(0);

    const run = harness();
    expect(await runMealDraftEvaluationCli(['--set', 'development', '--provider', 'ollama', '--max-calls', '2', '--out', 'd.json'], run.deps)).toBe(0);
    expect(run.inferences()).toBe(2);
    const written = JSON.parse(run.written.get('d.json')!) as MealDraftEvaluationReport;
    expect(written).toMatchObject({ executedCount: 2, executionProfile: baseProfile, kind: 'real-model', maxCalls: 2, partial: true, profileCheck: { mismatches: 0, requests: 2 }, reportVersion: 3, timeoutMs: 45_000 });
    expect(written.generation).toEqual(baseProfile.generation);
    expect(written.metadata).toMatchObject({ fingerprint: { digest: current.fingerprint.digest }, generation: baseProfile.generation, modelDigest, ollamaVersion: '0.40.16', timeoutMs: 45_000 });
    // That partial run can never pass the model gate.
    expect(evaluateModelGate([written, report('heldout')], context).status).toBe('FAIL');
  });

  it('complete runs written by the CLI are accepted as evidence and judged on quality alone', async () => {
    const run = harness();
    expect(await runMealDraftEvaluationCli(['--set', 'development', '--provider', 'ollama', '--out', 'd.json'], run.deps)).toBe(0);
    expect(await runMealDraftEvaluationCli(['--set', 'heldout', '--provider', 'ollama', '--out', 'h.json'], run.deps)).toBe(0);
    const gate = evaluateModelGate([JSON.parse(run.written.get('d.json')!), JSON.parse(run.written.get('h.json')!)], context);
    // The fake network refuses every text, so the quality is poor: a measured FAIL with valid evidence.
    expect(gate.evidenceValid).toBe(true);
    expect(gate.profile).toEqual(baseProfile);
    expect(gate.status).toBe('FAIL');
    expect(new Set(gate.reasons.map((entry) => entry.kind))).toEqual(new Set(['quality']));
  });

  it('refuses a call budget above 40 and an unstated provider', async () => {
    const { deps } = harness();
    await expect(runMealDraftEvaluationCli(['--set', 'development', '--provider', 'ollama', '--max-calls', '41'], deps)).rejects.toThrow(/--max-calls/u);
    await expect(runMealDraftEvaluationCli(['--set', 'development'], deps)).rejects.toThrow(/--provider must be fake or ollama/u);
  });
});
