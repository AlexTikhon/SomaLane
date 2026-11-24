import { resolve } from 'node:path';

import { defineConfig } from '@playwright/test';

import { showcaseBuild } from './support/showcase.js';
import { webkitDesktop, webkitPhone, webkitResults } from './support/webkit-gate.js';

// The public read-only showcase against its STATIC PRODUCTION OUTPUT (release step 5, ADR-0099):
// `npm run test:e2e:showcase`. The npm script builds the output first (support/showcase-build.ts); here `vite preview`
// only serves those files. There is no API server, no database and no proxy in this configuration, and the tests fail on
// any request to /api or to another origin. No test database variables are read: nothing here can write anywhere.
const webRoot = resolve(import.meta.dirname, '..', '..', 'apps', 'web');

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  outputDir: 'test-results/showcase',
  reporter: 'list',
  retries: 0,
  testDir: 'showcase',
  timeout: 60_000,
  use: {
    baseURL: showcaseBuild.webOrigin,
    locale: 'en-GB',
    screenshot: 'only-on-failure',
    // The visitor's own zone and clock play no part: the showcase follows the snapshot. A zone far from the dataset's
    // makes that visible.
    timezoneId: 'Pacific/Auckland',
    trace: 'retain-on-failure',
    viewport: { height: 900, width: 1280 },
  },
  projects: [
    { name: 'showcase-chromium', use: { browserName: 'chromium' } },
    // The journey and the request guard also in Firefox.
    { grep: /@cross-browser/u, name: 'showcase-firefox', use: { browserName: 'firefox' } },
    // The WebKit gate (release step 6, ADR-0100), selected only by `npm run test:e2e:webkit`: every test at the desktop
    // setting, and the journey, the read-only boundary with its missing and zero states, and keyboard and 375 px at the
    // phone-sized setting. The request and storage guards apply to every one of them.
    { name: 'showcase-webkit', outputDir: webkitResults('showcase'), use: webkitDesktop },
    { grep: /@phone/u, name: 'showcase-webkit-phone', outputDir: webkitResults('showcase-phone'), use: webkitPhone },
  ],
  webServer: {
    command: `node ${JSON.stringify(resolve(webRoot, '..', '..', 'node_modules', 'vite', 'bin', 'vite.js'))} preview --config vite.showcase.config.ts --outDir ${JSON.stringify(showcaseBuild.outDir)} --host 127.0.0.1 --port ${new URL(showcaseBuild.webOrigin).port} --strictPort`,
    cwd: webRoot,
    // Serves the built files as they are; `vite preview` never rebuilds them.
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    url: showcaseBuild.webOrigin,
  },
  workers: 1,
});
