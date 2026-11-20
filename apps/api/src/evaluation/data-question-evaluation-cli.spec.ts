import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { invocationDirectory, runDataQuestionEvaluationCli, type DataQuestionCliDependencies } from './data-question-evaluation-cli.js';
import { DATA_QUESTION_PROMPT_VERSION, dataQuestionPromptDigest } from '../data-questions/data-question-prompt.js';
import { buildDataQuestionReport, dataQuestionCodeFingerprint, loadDataQuestionDataset, runDataQuestionEvaluation, type DataQuestionEvalCase } from './data-question-evaluation.js';
import { buildExecutionProfile } from './meal-draft-profile.js';

// The command line of the "Ask my data" evaluation (ADR-0094 review correction): user-supplied relative --report and --out
// paths mean the directory the command was typed in (npm's INIT_CWD, else the process's working directory), absolute paths
// stay as typed, and repository-owned datasets stay anchored to the repository. A check and a fake run never reach the
// network. Nothing here runs a model.

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const artifactsRelative = 'docs/reports/artifacts/ask-my-data-2026-11-19';
const savedReport = (name: string) => JSON.parse(readFileSync(join(repositoryRoot, artifactsRelative, name), 'utf8')) as { codeFingerprint: string; promptDigest: string; promptVersion: string };
// The saved reports are judged as measured (their own code, prompt and prompt version), so these tests judge paths, not currency.
const measured = { codeFingerprint: savedReport('qwen3-8b-development.json').codeFingerprint, promptDigest: savedReport('qwen3-8b-development.json').promptDigest, promptVersion: savedReport('qwen3-8b-development.json').promptVersion };

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { force: true, recursive: true });
});
/** A fresh directory whose path contains spaces. */
function spacedDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'ask data cli '));
  scratch.push(root);
  const directory = join(root, 'typed here');
  mkdirSync(directory);
  return directory;
}

function dependencies(directory: string, current: { codeFingerprint: string; promptDigest: string; promptVersion?: string } | undefined = measured) {
  const lines: string[] = [];
  const requests: string[] = [];
  const deps: DataQuestionCliDependencies = {
    ...(current === undefined ? {} : { current }),
    fetch: (input) => {
      requests.push(String(input instanceof Request ? input.url : input));
      return Promise.reject(new Error('no network in this test'));
    },
    gitState: () => ({ dirty: false, dirtyPathCount: 0, dirtyPaths: [], sha: null }),
    info: (line) => lines.push(line),
    invocationDirectory: directory,
    now: () => new Date('2026-11-19T12:00:00.000Z'),
  };
  return { deps, lines, requests };
}

const checkArgs = (development: string, heldout: string, out?: string) => ['--check', '--report', development, '--report', heldout, ...(out === undefined ? [] : ['--out', out])];

describe('the invocation directory', () => {
  it("is npm's INIT_CWD when present, the working directory otherwise", () => {
    expect(invocationDirectory({ INIT_CWD: 'C:\\repo' }, 'C:\\repo\\apps\\api')).toBe('C:\\repo');
    expect(invocationDirectory({}, 'C:\\repo\\apps\\api')).toBe('C:\\repo\\apps\\api');
    expect(invocationDirectory({ INIT_CWD: '' }, '/work')).toBe('/work');
  });
});

describe('offline check paths', () => {
  it('reads repository-relative report paths from the repository root and exits 2 for the saved quality failure', async () => {
    const { deps, lines, requests } = dependencies(repositoryRoot);
    const code = await runDataQuestionEvaluationCli(checkArgs(`${artifactsRelative}/qwen3-8b-development.json`, `${artifactsRelative}/qwen3-8b-heldout.json`), deps);
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/MODEL GATE \(data questions\): FAIL; evidence valid/u);
    expect(lines.join('\n')).toMatch(/development: exact 18\/20/u);
    expect(lines.join('\n')).toMatch(/heldout: exact 17\/20/u);
    expect(requests).toEqual([]);
  });

  it('resolves relative --report and --out against the invocation directory, spaces included', async () => {
    const directory = spacedDirectory();
    mkdirSync(join(directory, 'saved reports'));
    for (const name of ['qwen3-8b-development.json', 'qwen3-8b-heldout.json']) copyFileSync(join(repositoryRoot, artifactsRelative, name), join(directory, 'saved reports', name));
    const { deps, requests } = dependencies(directory);
    const code = await runDataQuestionEvaluationCli(checkArgs('saved reports/qwen3-8b-development.json', 'saved reports/qwen3-8b-heldout.json', 'gate out/gates check.json'), deps);
    expect(code).toBe(2);
    const written = JSON.parse(readFileSync(join(directory, 'gate out', 'gates check.json'), 'utf8')) as { gate: { evidenceValid: boolean; status: string } };
    expect(written.gate).toMatchObject({ evidenceValid: true, status: 'FAIL' });
    expect(requests).toEqual([]);
  });

  it('keeps absolute paths as typed, whatever the invocation directory', async () => {
    const elsewhere = spacedDirectory();
    const target = spacedDirectory();
    const { deps } = dependencies(elsewhere);
    const out = join(target, 'gates.json');
    const code = await runDataQuestionEvaluationCli(
      checkArgs(join(repositoryRoot, artifactsRelative, 'qwen3-8b-development.json'), join(repositoryRoot, artifactsRelative, 'qwen3-8b-heldout.json'), out),
      deps,
    );
    expect(code).toBe(2);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(elsewhere, 'gates.json'))).toBe(false);
  });

  it('a missing, malformed-JSON or malformed-structure report is NOT_RUN (exit 3) with a bounded reason, and the gate is still written', async () => {
    const directory = spacedDirectory();
    writeFileSync(join(directory, 'broken report.json'), '{"set": "development",');
    writeFileSync(join(directory, 'empty report.json'), '{}');
    const heldout = join(repositoryRoot, artifactsRelative, 'qwen3-8b-heldout.json');
    for (const [report, reason] of [
      ['absent report.json', /report 1 \(absent report\.json\): cannot be read/u],
      ['broken report.json', /report 1 \(broken report\.json\): not valid JSON/u],
      ['empty report.json', /report 1: malformed/u],
    ] as const) {
      const { deps, lines, requests } = dependencies(directory);
      const code = await runDataQuestionEvaluationCli(checkArgs(report, heldout, 'gates.json'), deps);
      expect(code, report).toBe(3);
      expect(lines.join('\n'), report).toMatch(reason);
      expect(lines.join('\n')).not.toContain(directory);
      expect(JSON.parse(readFileSync(join(directory, 'gates.json'), 'utf8'))).toMatchObject({ gate: { status: 'NOT_RUN' } });
      expect(requests).toEqual([]);
    }
  });
});

describe('a report whose validation throws', () => {
  it('--check answers NOT_RUN (exit 3), names the report as malformed and still writes --out', async () => {
    const directory = spacedDirectory();
    const report = JSON.parse(readFileSync(join(repositoryRoot, artifactsRelative, 'qwen3-8b-development.json'), 'utf8')) as {
      results: Array<{ got: { outcome: string; plan?: { operation: string; period: { weekStart?: string } } } }>;
    };
    const weekly = report.results.find((result) => result.got.plan?.operation === 'weekly_review')!;
    weekly.got.plan!.period.weekStart = '2026-02-30';
    writeFileSync(join(directory, 'impossible date.json'), JSON.stringify(report));
    const { deps, lines, requests } = dependencies(directory);
    const code = await runDataQuestionEvaluationCli(checkArgs('impossible date.json', join(repositoryRoot, artifactsRelative, 'qwen3-8b-heldout.json'), 'out/gates.json'), deps);
    expect(code).toBe(3);
    expect(lines.join('\n')).toMatch(/MODEL GATE \(data questions\): NOT_RUN/u);
    expect(lines.join('\n')).toMatch(/report 1: malformed \(validation failed: RangeError/u);
    const written = JSON.parse(readFileSync(join(directory, 'out', 'gates.json'), 'utf8')) as { gate: { quality: { heldout: unknown }; status: string } };
    expect(written.gate.status).toBe('NOT_RUN');
    expect(written.gate.quality.heldout).toMatchObject({ exact: 17, total: 20 });
    expect(requests).toEqual([]);
  });
});

describe('a fake-provider run', () => {
  it("writes --out where the caller asked, never under apps/api, and makes no network request", async () => {
    const directory = spacedDirectory();
    const { deps, requests } = dependencies(directory, undefined);
    const code = await runDataQuestionEvaluationCli(['--set', 'development', '--provider', 'fake', '--out', 'fake run/development.json'], deps);
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(directory, 'fake run', 'development.json'), 'utf8')) as { callsMade: number; evidence: string };
    expect(report).toMatchObject({ callsMade: 20, evidence: 'harness_self_check_not_model_evidence' });
    expect(requests).toEqual([]);
  });
});

describe('the entry point as a process', () => {
  const tsxLoader = pathToFileURL(join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const main = join(repositoryRoot, 'apps', 'api', 'src', 'evaluation', 'data-question-evaluation-main.ts');
  const run = (cwd: string, environment: NodeJS.ProcessEnv, args: string[]) => {
    const env = { ...process.env, ...environment };
    if (environment['INIT_CWD'] === undefined) delete env['INIT_CWD'];
    return spawnSync(process.execPath, ['--import', tsxLoader, main, ...args], { cwd, encoding: 'utf8', env, timeout: 60_000 });
  };

  it('direct invocation resolves relative paths against the working directory', () => {
    const directory = spacedDirectory();
    writeFileSync(join(directory, 'broken report.json'), 'not json');
    const result = run(directory, {}, ['--check', '--report', 'broken report.json', '--out', 'out/gates.json']);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toMatch(/not valid JSON/u);
    expect(result.stdout + result.stderr).not.toMatch(/ENOENT/u);
    expect(existsSync(join(directory, 'out', 'gates.json'))).toBe(true);
  }, 60_000);

  it('under npm (started in apps/api) resolves them against INIT_CWD', () => {
    const directory = spacedDirectory();
    writeFileSync(join(directory, 'broken report.json'), 'not json');
    const result = run(join(repositoryRoot, 'apps', 'api'), { INIT_CWD: directory }, ['--check', '--report', 'broken report.json', '--out', 'gates.json']);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).toMatch(/not valid JSON/u);
    expect(existsSync(join(directory, 'gates.json'))).toBe(true);
    expect(existsSync(join(repositoryRoot, 'apps', 'api', 'gates.json'))).toBe(false);
  }, 60_000);
});

// Dataset versions on the command line (ADR-0095): v1 by default, --dataset-version v2 selects the new sets, and a check
// judges exactly the selected version. Oracle reports are built in memory; nothing runs a model.
describe('--dataset-version', () => {
  /** The CURRENT code and prompt (the oracle reports below are built with them). */
  const currentCode = { codeFingerprint: dataQuestionCodeFingerprint(), promptDigest: dataQuestionPromptDigest(), promptVersion: DATA_QUESTION_PROMPT_VERSION };
  const profile = buildExecutionProfile({ maxOutputTokens: 300, maxResponseBytes: 32_768, model: 'qwen3:8b', modelDigest: 'a'.repeat(64), ollamaVersion: '0.12.0', timeoutMs: 45_000 });
  const oracle = (entry: DataQuestionEvalCase): unknown => {
    const expected = entry.expected;
    if (expected.outcome !== 'proposal') return { outcome: expected.outcome, reason: expected.reason };
    const intent = expected.intent;
    if (intent.operation === 'day_overview') return { outcome: 'day_overview', period: intent.period };
    if (intent.operation === 'weekly_review') return { focus: intent.focus, outcome: 'weekly_review', period: intent.period };
    return { activityType: intent.type, outcome: 'activity_comparison', period: intent.period, source: intent.source };
  };
  async function writeOracleReports(directory: string, version: '1' | '2'): Promise<[string, string]> {
    const names: string[] = [];
    for (const set of ['development', 'heldout'] as const) {
      const { dataset, digest } = loadDataQuestionDataset(set, undefined, version);
      const provider = { generateStructured: (input: { user: string }) => Promise.resolve({ value: oracle(dataset.cases.find((entry) => entry.text === input.user)!) }), model: 'test' };
      const run = await runDataQuestionEvaluation({ dataset, maxCalls: 20, maxOutputTokens: 300, provider, timeoutMs: 45_000 });
      const report = buildDataQuestionReport({ dataset, digest, finishedAt: 'x', git: { dirty: false, dirtyPathCount: 0, dirtyPaths: [], sha: null }, profile, profileCheck: { mismatches: 0, requests: run.callsMade }, run, startedAt: 'x' });
      const name = `v${version} ${set}.json`;
      writeFileSync(join(directory, name), JSON.stringify(report));
      names.push(name);
    }
    return [names[0]!, names[1]!];
  }

  it('a fake run of v2 records the v2 dataset version and makes no network request', async () => {
    const directory = spacedDirectory();
    const { deps, requests } = dependencies(directory, currentCode);
    const code = await runDataQuestionEvaluationCli(['--set', 'heldout', '--provider', 'fake', '--dataset-version', 'v2', '--out', 'fake v2.json'], deps);
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(join(directory, 'fake v2.json'), 'utf8')) as { datasetVersion: string; evidence: string; results: Array<{ id: string }> };
    expect(report.datasetVersion).toBe('data-question-eval-2');
    expect(report.evidence).toBe('harness_self_check_not_model_evidence');
    expect(report.results.every((result) => result.id.includes('-ho2-'))).toBe(true);
    expect(requests).toEqual([]);
  });

  it('--check judges exactly the selected version: v2 evidence passes as v2 and is NOT_RUN under the v1 default', async () => {
    const directory = spacedDirectory();
    const [development, heldout] = await writeOracleReports(directory, '2');
    const asV2 = dependencies(directory, currentCode);
    const v2Code = await runDataQuestionEvaluationCli([...checkArgs(development, heldout, 'v2 gate.json'), '--dataset-version', 'v2'], asV2.deps);
    expect(v2Code, asV2.lines.join('\n')).toBe(0);
    expect(asV2.lines.join('\n')).toMatch(/MODEL GATE \(data questions\): PASS; evidence valid\n {2}dataset version judged: data-question-eval-2/u);
    expect(JSON.parse(readFileSync(join(directory, 'v2 gate.json'), 'utf8'))).toMatchObject({ gate: { datasetVersion: 'data-question-eval-2', status: 'PASS' }, inferenceCallsMade: 0 });
    const asDefault = dependencies(directory, currentCode);
    expect(await runDataQuestionEvaluationCli(checkArgs(development, heldout, 'v1 gate.json'), asDefault.deps)).toBe(3);
    expect(asDefault.lines.join('\n')).toMatch(/dataset version data-question-eval-2 is not the selected frozen data-question-eval-1/u);
    expect([...asV2.requests, ...asDefault.requests]).toEqual([]);
  });

  it('mixed versions are NOT_RUN, and an unknown version is refused before anything is read', async () => {
    const directory = spacedDirectory();
    const [development1] = await writeOracleReports(directory, '1');
    const [, heldout2] = await writeOracleReports(directory, '2');
    const { deps, lines } = dependencies(directory, currentCode);
    expect(await runDataQuestionEvaluationCli([...checkArgs(development1, heldout2, 'mixed.json'), '--dataset-version', 'v2'], deps)).toBe(3);
    expect(lines.join('\n')).toMatch(/the reports mix dataset versions/u);
    expect(existsSync(join(directory, 'mixed.json'))).toBe(true);
    await expect(runDataQuestionEvaluationCli([...checkArgs(development1, heldout2), '--dataset-version', 'v3'], dependencies(directory, currentCode).deps)).rejects.toThrow(
      /--dataset-version must be v1 or v2/u,
    );
  });

  it('a v2 report with an impossible date is NOT_RUN (exit 3) and --out is still written', async () => {
    const directory = spacedDirectory();
    const [development, heldout] = await writeOracleReports(directory, '2');
    const report = JSON.parse(readFileSync(join(directory, development), 'utf8')) as { results: Array<{ got: { plan?: { operation: string; period: { weekStart?: string } } } }> };
    report.results.find((result) => result.got.plan?.operation === 'weekly_review')!.got.plan!.period.weekStart = '2026-02-30';
    writeFileSync(join(directory, 'impossible v2.json'), JSON.stringify(report));
    const { deps, lines, requests } = dependencies(directory, currentCode);
    expect(await runDataQuestionEvaluationCli([...checkArgs('impossible v2.json', heldout, 'out/gates.json'), '--dataset-version', 'v2'], deps)).toBe(3);
    expect(lines.join('\n')).toMatch(/report 1: malformed \(validation failed: RangeError/u);
    expect(JSON.parse(readFileSync(join(directory, 'out', 'gates.json'), 'utf8'))).toMatchObject({ gate: { status: 'NOT_RUN' } });
    expect(requests).toEqual([]);
  });
});
