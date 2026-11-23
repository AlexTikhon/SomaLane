import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseShowcaseSnapshot } from '@running-tracker/contracts/showcase';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { datasetPaths, repositoryRoot } from './local-environment.js';
import { parseShowcaseExportArguments, runShowcaseExport } from './showcase-export-cli.js';
import { SHOWCASE_SNAPSHOT_PATH, type ShowcaseExportResult } from './showcase-export.js';

// The export command (docs/runbooks/showcase.md): where it writes, that --check writes nothing, and that it never writes
// into the dataset's own directory.

const committedText = readFileSync(join(repositoryRoot, ...SHOWCASE_SNAPSHOT_PATH), 'utf8');
const result = (serialized = committedText): ShowcaseExportResult => ({
  identities: {} as ShowcaseExportResult['identities'],
  proof: {} as ShowcaseExportResult['proof'],
  reads: 119,
  serialized,
  snapshot: parseShowcaseSnapshot(JSON.parse(committedText)),
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'showcase-cli-'));
  directories.push(directory);
  return directory;
};

describe('the showcase export command', () => {
  it('writes to the showcase’s public folder by default and refuses the dataset’s own directory', () => {
    expect(parseShowcaseExportArguments([], 'C:/repo')).toEqual({ check: false, out: join('C:/repo', 'apps', 'web', 'showcase', 'public', 'showcase-snapshot.json') });
    expect(parseShowcaseExportArguments(['--check', '--out', 'x.json'], 'C:/repo')).toMatchObject({ check: true });
    expect(parseShowcaseExportArguments(['--help'])).toBe('help');
    const root = temporary();
    expect(() => parseShowcaseExportArguments(['--out', join(datasetPaths(root).directory, 'manifest.json')], root)).toThrow(/must not point into the dataset directory/u);
    expect(() => parseShowcaseExportArguments(['--out', datasetPaths(root).directory], root)).toThrow(/must not point into the dataset directory/u);
    expect(() => parseShowcaseExportArguments(['--seed', 'x'])).toThrow(/Unknown argument/u);
    expect(() => parseShowcaseExportArguments(['--out'])).toThrow(/needs a value/u);
  });

  it('writes the exported bytes atomically and prints the provenance, never a password', async () => {
    const out = join(temporary(), 'nested', 'snapshot.json');
    const lines: string[] = [];
    const exported = vi.fn(() => Promise.resolve(result()));
    expect(await runShowcaseExport(['--out', out], { export: exported, print: (line) => lines.push(line) })).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(committedText);
    expect(readdirSync(join(out, '..'))).toEqual(['snapshot.json']);
    const printed = lines.join('\n');
    expect(printed).toContain('dataset digest  sha256:b6222c858f464e8d4fe465b3f9c29a95f5c8f0f3e0cf3403b0021d49012e857d');
    expect(printed).toContain('read at         2026-11-21T23:00:00.000Z');
    expect(printed).toContain('34 days, 5 weeks, 2 Trends ranges, 14 activity selections, 34 meal lists');
    expect(printed).not.toMatch(/password|postgresql:\/\//iu);
  });

  it('--check compares with the file and writes nothing', async () => {
    const out = join(temporary(), 'snapshot.json');
    writeFileSync(out, committedText);
    expect(await runShowcaseExport(['--check', '--out', out], { export: () => Promise.resolve(result()), print: () => undefined })).toBe(0);
    const lines: string[] = [];
    expect(await runShowcaseExport(['--check', '--out', out], { export: () => Promise.resolve(result(`${committedText} `)), print: (line) => lines.push(line) })).toBe(1);
    expect(lines.at(-1)).toMatch(/differs from a fresh export/u);
    expect(readFileSync(out, 'utf8')).toBe(committedText);
    const missing = join(temporary(), 'missing.json');
    expect(await runShowcaseExport(['--check', '--out', missing], { export: () => Promise.resolve(result()), print: () => undefined })).toBe(1);
    expect(existsSync(missing)).toBe(false);
  });
});
