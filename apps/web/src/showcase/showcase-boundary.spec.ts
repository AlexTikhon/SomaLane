import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// The showcase's static module graph (ADR-0099): what src/showcase/main.tsx reaches through value imports. It reuses the
// application's pure content blocks and formatters and must never reach App, a Screen wrapper, a controller, the API
// client, session or sign-in code, browser storage, capture or the writer lease. And the other way round: the
// application's entry (src/main.tsx) reaches nothing of the showcase, so none of it is in the application's bundle.

const sourceRoot = join(import.meta.dirname, '..');

/** Value imports and re-exports of a module (type-only ones are erased), as written in its source. */
function staticImports(file: string): string[] {
  const text = readFileSync(join(sourceRoot, file), 'utf8');
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?'([^']+)'/gu)].map((match) => match[1]!);
}

function localFile(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(from), specifier)).replace(/\.js$/u, '');
  const candidate = [`${base}.ts`, `${base}.tsx`, `${base}.js`, normalize(join(dirname(from), specifier))].find((path) => existsSync(join(sourceRoot, path)));
  if (candidate === undefined) throw new Error(`${from} imports ${specifier}, which does not exist`);
  return relative('.', candidate).replaceAll('\\', '/');
}

function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of staticImports(file)) {
      const local = localFile(file, specifier);
      if (local !== null) visit(local);
      else packages.add(specifier);
    }
  };
  visit(entry);
  return { files, packages };
}

describe('the showcase’s static module graph', () => {
  const showcase = graph('showcase/main.tsx');

  it('reuses the application’s pure content blocks and formatters', () => {
    for (const file of ['TodayOverviewContent.tsx', 'WeeklyReviewContent.tsx', 'TrendsContent.tsx', 'ActivityTrendsSection.tsx', 'MealEntryValues.tsx', 'daily-overview.ts', 'daily-trends.ts', 'activity-trends.ts', 'journey-navigation.ts']) {
      expect(showcase.files, file).toContain(file);
    }
  });

  it('reaches no App, Screen wrapper, controller, API client, session, sign-in, storage, capture or lease code', () => {
    const forbidden = [...showcase.files].filter(
      (file) =>
        /(?:^|\/)(?:App|TodayScreen|WeeklyReviewScreen|WeeklyReviewPanel|TrendsScreen|MealLogScreen|DailyCheckInScreen|ActivityScreen|CoachScreen|ArchiveScreen|RunDetailScreen|RunnerView|AskMyDataSection|MealDraftPanel|WeeklyInsightPanel|DemoSignIn|SessionBar|OrganizationPicker|DeferredView)\.tsx$/u.test(file) ||
        /(?:^|\/)(?:runner-api|request|health|sign-in|demo-sign-in|demo-simulator|session-revalidation|use-runner-session|use-organizations|organization-selection|runner-storage|runner-storage-test-support|writer-lease|writer-presence|capture-controller|capture-source|point-upload-worker|run-authority|runner-requests|unsent-work|live-track-sync|coach-live-client|secondary-views|deferred-module|mapbox-runtime|create-mapbox-map)\.(?:ts|tsx|js)$/u.test(file) ||
        /-controller\.ts$/u.test(file),
    );
    expect(forbidden).toEqual([]);
    expect([...showcase.packages].sort()).toEqual(['@running-tracker/contracts', '@running-tracker/contracts/showcase', 'react', 'react-dom/client']);
  });

  it('touches no browser storage, cookie, IndexedDB or service worker in its own code', () => {
    for (const file of [...showcase.files].filter((path) => path.startsWith('showcase/'))) {
      const text = readFileSync(join(sourceRoot, file), 'utf8');
      expect(text, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|serviceWorker|\/api\b/u);
    }
  });

  it('is not reachable from the application’s entry', () => {
    const application = graph('main.tsx');
    expect([...application.files].filter((file) => file.startsWith('showcase/'))).toEqual([]);
    expect(application.packages).not.toContain('@running-tracker/contracts/showcase');
  });
});
