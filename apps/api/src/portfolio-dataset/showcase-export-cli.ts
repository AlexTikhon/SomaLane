import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { describeIsolationFailure } from './dataset-writer.js';
import { datasetPaths, repositoryRoot, type DatasetPaths } from './local-environment.js';
import { exportShowcaseSnapshot, SHOWCASE_SNAPSHOT_PATH, type ShowcaseExportOptions, type ShowcaseExportResult } from './showcase-export.js';

// `npm run portfolio:showcase:export -- [--check] [--out <file>]` (docs/runbooks/showcase.md): exports the public
// read-only showcase's snapshot from the isolated synthetic dataset. It never seeds, bootstraps, migrates or resets the
// dataset, and writes nothing but the output file (atomically, through a temporary file next to it). `--check` writes
// nothing at all: it exports in memory and compares with the committed file byte for byte. Nothing printed contains a
// password: connections are described as role@host:port/database.

export interface ShowcaseExportArguments {
  check: boolean;
  out: string;
}

const usage = `Usage: npm run portfolio:showcase:export -- [--check] [--out <file>]

  --out    where to write the snapshot (default ${SHOWCASE_SNAPSHOT_PATH.join('/')})
  --check  export in memory and compare with the file instead of writing it (exit 1 when they differ)

Needs the isolated dataset (npm run portfolio:dataset) and Docker running. See docs/runbooks/showcase.md.`;

export function parseShowcaseExportArguments(argv: readonly string[], root = repositoryRoot): ShowcaseExportArguments | 'help' {
  const parsed: { check: boolean; out: string | undefined } = { check: false, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--help' || flag === '-h') return 'help';
    if (flag === '--check') {
      if (parsed.check) throw new Error('--check was given twice');
      parsed.check = true;
    } else if (flag === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--out needs a value');
      if (parsed.out !== undefined) throw new Error('--out was given twice');
      parsed.out = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${flag} (try --help)`);
    }
  }
  const out = parsed.out === undefined ? join(root, ...SHOWCASE_SNAPSHOT_PATH) : resolve(parsed.out);
  const inside = relative(datasetPaths(root).directory, out);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error('--out must not point into the dataset directory .local/portfolio-dataset/');
  }
  return { check: parsed.check, out };
}

export interface ShowcaseExportRun {
  export?: (options: ShowcaseExportOptions) => Promise<ShowcaseExportResult>;
  paths?: DatasetPaths;
  print?: (line: string) => void;
}

/** Runs the export; returns the process exit code. */
export async function runShowcaseExport(argv: readonly string[], run: ShowcaseExportRun = {}): Promise<number> {
  const print = run.print ?? console.log;
  const parsed = parseShowcaseExportArguments(argv);
  if (parsed === 'help') {
    print(usage);
    return 0;
  }
  const result = await (run.export ?? exportShowcaseSnapshot)({ log: (line) => print(`  ${line}`), paths: run.paths ?? datasetPaths() });
  const { snapshot } = result;
  const counts = snapshot.responses;
  print(`showcase snapshot of ${snapshot.dataset.datasetVersion} (seed ${snapshot.dataset.seed}, anchor ${snapshot.dataset.anchorDate}, ${snapshot.dataset.timeZone})`);
  print(`  dataset digest  ${snapshot.dataset.digest}`);
  print(`  read at         ${snapshot.snapshot.readAt} (fixed: the first instant after the anchor)`);
  print(
    `  responses       ${String(Object.keys(counts.dailyOverview).length)} days, ${String(Object.keys(counts.weeklyReview).length)} weeks, ` +
      `${String(Object.keys(counts.dailyTrends).length)} Trends ranges, ${String(Object.keys(counts.activityTrends).length)} activity selections, ` +
      `${String(Object.keys(counts.meals).length)} meal lists`,
  );
  print(`  content digest  ${snapshot.contentDigest}`);
  if (parsed.check) {
    const current = existsSync(parsed.out) ? readFileSync(parsed.out, 'utf8') : null;
    if (current === result.serialized) {
      print(`check: ${parsed.out} is byte-identical to a fresh export`);
      return 0;
    }
    print(`check: ${parsed.out} ${current === null ? 'does not exist' : 'differs from a fresh export'}; run npm run portfolio:showcase:export to regenerate it`);
    return 1;
  }
  mkdirSync(dirname(parsed.out), { recursive: true });
  const temporary = `${parsed.out}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, result.serialized, 'utf8');
  renameSync(temporary, parsed.out);
  print(`wrote ${parsed.out} (${String(Buffer.byteLength(result.serialized))} bytes)`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<void> {
  try {
    process.exitCode = await runShowcaseExport(argv);
  } catch (error) {
    console.error(`portfolio:showcase:export: ${describeIsolationFailure(error)}`);
    process.exitCode = 1;
  }
}
