import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

import { loadE2eEnvironment } from './support/environment.js';
import { productionBuild } from './support/production-build.js';
import { localSessionApi, suiteSettings } from './support/suite-config.js';

// The bounded browser check of the PRODUCTION build (release step 4, ADR-0098): `npm run test:e2e:production-build`.
// The development-server suites cannot show how the production bundle is split, so this one serves the real build
// output with `vite preview` and asserts the chunk requests a browser actually makes. The build is made by the npm
// script before Playwright starts (scripts/measure-web-bundle.mjs, the same settings as the measurement); nothing here
// builds or edits sources while a server runs. A development-session API on its own port, with every AI provider off,
// against the suite's test database: records are the suite's own fixtures, created and removed by each test.

// Throws before any server starts when the test database variables are missing or point elsewhere.
const environment = loadE2eEnvironment();
const webRoot = resolve(import.meta.dirname, '..', '..', 'apps', 'web');

export default defineConfig({
  ...suiteSettings(environment),
  outputDir: 'test-results/production-build',
  projects: [
    { name: 'production-chromium', use: { baseURL: productionBuild.webOrigin, browserName: 'chromium' } },
    // Firefox fetches a failed module again where Chromium does not, so the loading, failure and retry check runs in
    // both; the rest is Chromium only.
    { grep: /@cross-browser/u, name: 'production-firefox', use: { baseURL: productionBuild.webOrigin, browserName: 'firefox' } },
  ],
  testDir: 'production-build',
  webServer: [
    localSessionApi(environment, {
      allowedOrigins: [productionBuild.webOrigin],
      apiOrigin: productionBuild.apiOrigin,
      dataQuestions: 'off',
      mealDrafts: 'off',
      runSearchAi: { RUN_SEARCH_AI_ENABLED: 'false' },
      weeklyInsights: 'off',
    }),
    {
      // Serves the existing build only; `vite preview` proxies /api as the dev server does (vite.config.ts).
      command: `node ${JSON.stringify(resolve(webRoot, '..', '..', 'node_modules', 'vite', 'bin', 'vite.js'))} preview --outDir ${JSON.stringify(productionBuild.outDir)} --host 127.0.0.1 --port ${new URL(productionBuild.webOrigin).port} --strictPort`,
      cwd: webRoot,
      env: { API_PROXY_TARGET: productionBuild.apiOrigin },
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'pipe',
      url: productionBuild.webOrigin,
    },
  ],
});
