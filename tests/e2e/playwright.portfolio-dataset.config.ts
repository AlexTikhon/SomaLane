import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

// A bounded Chromium walkthrough of the EXISTING screens populated by the portfolio dataset (release step 2,
// docs/runbooks/portfolio-dataset.md): `npm run test:e2e:portfolio-dataset`, after `npm run portfolio:dataset`. Both
// servers start through the dataset's shared launcher (apps/api/src/portfolio-dataset/serve-cli.ts), the same code as
// `npm run portfolio:dataset:api` and `:web`: the API's configuration comes only from the dataset's own generated
// settings (never an inherited variable or .env) and its database connections are proven to reach the owned portfolio
// server before it starts; Vite proxies only to that API. The shared E2E harness, its fixtures and the
// running_tracker_test database are not used. It only reads: signing in creates a session row, nothing else is written.
// Desktop Chromium automation, not a claim about Safari or a phone.
const root = resolve(import.meta.dirname, '..', '..');
if (!existsSync(resolve(root, '.local', 'portfolio-dataset', 'settings.json'))) {
  throw new Error('No portfolio dataset environment: run npm run portfolio:dataset first (docs/runbooks/portfolio-dataset.md)');
}
const launcher = (target: 'api' | 'web') => `node --import tsx src/portfolio-dataset/serve-main.ts ${target}`;

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  outputDir: 'test-results/portfolio-dataset',
  reporter: 'list',
  retries: 0,
  testDir: 'portfolio-dataset',
  timeout: 180_000,
  use: {
    baseURL: 'http://127.0.0.1:5373',
    browserName: 'chromium',
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    viewport: { height: 900, width: 1280 },
  },
  projects: [{ name: 'portfolio-dataset-chromium' }],
  webServer: [
    {
      command: launcher('api'),
      cwd: resolve(root, 'apps', 'api'),
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 120_000,
      url: 'http://127.0.0.1:3300/api/health/ready',
    },
    {
      command: launcher('web'),
      cwd: resolve(root, 'apps', 'api'),
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 120_000,
      url: 'http://127.0.0.1:5373',
    },
  ],
  workers: 1,
});
