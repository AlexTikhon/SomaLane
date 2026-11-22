import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The first page's module graph (release step 4, ADR-0098): what main.tsx reaches through static imports. A static
// import of a secondary view, of secondary-views.ts, or of the Mapbox stylesheet from any of these modules would put that
// code back into the initial bundle; the production build's own measurement is `npm run measure:web-bundle`.

const sourceDirectory = import.meta.dirname;
const sources = new Set(readdirSync(sourceDirectory).filter((file) => /\.(?:tsx?|jsx?|css)$/u.test(file) && !/\.spec\./u.test(file)));

/** Value imports and re-exports of a module (type-only ones are erased), as written in its source. */
function staticImports(file: string): string[] {
  const text = readFileSync(join(sourceDirectory, file), 'utf8');
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gu)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function localFile(specifier: string): string | null {
  if (!specifier.startsWith('./')) return null;
  const base = specifier.slice(2).replace(/\.js$/u, '');
  return [`${base}.ts`, `${base}.tsx`, `${base}.js`, specifier.slice(2)].find((candidate) => sources.has(candidate)) ?? null;
}

function initialGraph(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of staticImports(file)) {
      const local = localFile(specifier);
      if (local !== null) visit(local);
      else if (!specifier.startsWith('.')) packages.add(specifier);
    }
  };
  visit('main.tsx');
  return { files, packages };
}

describe('the first page’s static module graph', () => {
  const graph = initialGraph();

  it('keeps Today, the Weekly review, Trends, Runner and the run machinery App owns', () => {
    for (const file of [
      'App.tsx', 'TodayScreen.tsx', 'WeeklyReviewScreen.tsx', 'TrendsScreen.tsx', 'RunnerView.tsx', 'RunStatusNotice.tsx',
      'runner-storage.ts', 'capture-controller.ts', 'point-upload-worker.ts', 'writer-lease.ts', 'run-authority.ts',
      'runner-requests.ts', 'use-runner-session.ts', 'DeferredView.tsx',
    ]) {
      expect(graph.files, file).toContain(file);
    }
  });

  it('reaches none of the secondary views, their chunk or the map code', () => {
    for (const file of [
      'secondary-views.ts', 'CoachScreen.tsx', 'ArchiveScreen.tsx', 'ActivityScreen.tsx', 'DailyCheckInScreen.tsx',
      'MealLogScreen.tsx', 'RunDetailScreen.tsx', 'mapbox-runtime.js', 'create-mapbox-map.ts',
    ]) {
      expect(graph.files, file).not.toContain(file);
    }
    expect([...graph.packages].filter((name) => name.startsWith('mapbox-gl'))).toEqual([]);
  });
});
