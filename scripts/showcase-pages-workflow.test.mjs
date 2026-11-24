import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

// Structural guards for .github/workflows/showcase-pages.yml (ADR-0101, release step 7). They run without GitHub; only a
// dispatched run on main proves the workflow itself (release step 8).

const root = resolve(import.meta.dirname, '..');
// Normalized to LF at this single read boundary (core.autocrlf checkouts on Windows).
const read = (path) => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');
const workflow = read('.github/workflows/showcase-pages.yml');
// Comments name what the workflow must NOT do; the checks below look only at what it does.
const code = workflow.replace(/^ *#.*\n/gmu, '');

function jobBlock(name) {
  const start = code.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} is missing`);
  const rest = code.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

/** The lines of a job's `permissions:` block, in order. */
function permissionsOf(name) {
  const match = jobBlock(name).match(/\n {4}permissions:\n((?: {6}\S[^\n]*\n)+)/u);
  assert.ok(match, `${name} must declare its own permissions`);
  return match[1].trim().split('\n').map((line) => line.trim());
}

test('Pages: manual dispatch is the only trigger, and nothing is granted by default', () => {
  assert.match(code, /\non:\n {2}workflow_dispatch:\n\npermissions: \{\}\n/u);
  assert.doesNotMatch(code, /^\s*(?:push|pull_request|pull_request_target|schedule|workflow_run|release|repository_dispatch):/mu);
  assert.match(code, /\nconcurrency:\n {2}group: pages\n {2}cancel-in-progress: false\n/u);
  assert.deepEqual([...code.matchAll(/\n {2}([a-z][\w-]*):\n {4}name:/gu)].map((match) => match[1]), ['build', 'deploy']);
});

test('Pages: the build job reads the repository only and runs from main only', () => {
  assert.deepEqual(permissionsOf('build'), ['contents: read']);
  const build = jobBlock('build');
  assert.match(build, /- name: Refuse any ref but main\n {8}if: github\.ref != 'refs\/heads\/main'\n {8}run: \|\n[^\n]+\n {10}exit 1\n/u);
  assert.ok(build.indexOf('Refuse any ref but main') < build.indexOf('actions/checkout'), 'the ref check comes first');
  assert.match(build, /- uses: actions\/checkout@v5\n {8}with:\n {10}persist-credentials: false\n/u);
  assert.doesNotMatch(build, /deploy-pages|configure-pages|pages: write|id-token/u);
});

test('Pages: only the deploy job may deploy, after the build job, in the github-pages environment, and reports the real URL', () => {
  assert.deepEqual(permissionsOf('deploy'), ['pages: write', 'id-token: write']);
  const deploy = jobBlock('deploy');
  assert.match(deploy, /\n {4}needs: build\n {4}if: github\.ref == 'refs\/heads\/main'\n/u);
  assert.match(deploy, /\n {4}environment:\n {6}name: github-pages\n {6}url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}\n/u);
  assert.match(deploy, /- id: deployment\n {8}uses: actions\/deploy-pages@v5\n/u);
  assert.match(deploy, /PAGE_URL: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/u);
  assert.match(deploy, />> "\$GITHUB_STEP_SUMMARY"/u);
  // It publishes job 1's artifact and nothing it could build or fetch itself.
  assert.doesNotMatch(deploy, /actions\/checkout|setup-node|npm |upload-pages-artifact/u);
  assert.equal(code.split('actions/deploy-pages@').length - 1, 1);
  assert.equal(code.split('pages: write').length - 1, 1);
  assert.equal(code.split('id-token: write').length - 1, 1);
});

test('Pages: the only upload is apps/web/dist-showcase, after the browser checks and the comparison with the tested build', () => {
  const build = jobBlock('build');
  assert.equal(code.split('actions/upload-pages-artifact@').length - 1, 1);
  assert.match(build, /uses: actions\/upload-pages-artifact@v5\n {8}with:\n {10}path: apps\/web\/dist-showcase\n/u);
  assert.doesNotMatch(code, /actions\/upload-artifact|include-hidden-files/u);
  const steps = [
    'npm run test --workspace=@running-tracker/web -- src/showcase',
    'npx playwright install --with-deps chromium firefox webkit',
    'node --import tsx support/showcase-build.ts',
    'npx playwright test --config=playwright.showcase.config.ts --project=showcase-chromium --project=showcase-firefox --project=showcase-webkit --project=showcase-webkit-phone',
    'run: npm run build:showcase',
    'run: diff -r .local/showcase/e2e/dist apps/web/dist-showcase',
    'actions/upload-pages-artifact@v5',
  ].map((step) => build.indexOf(step));
  assert.ok(steps.every((index) => index >= 0), 'every validation step is present');
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, 'unit tests, browsers, test build, browser checks, build, comparison, upload');
  // The compared directories are the ones the code writes.
  assert.match(read('tests/e2e/support/showcase.ts'), /outDir: resolve\(import\.meta\.dirname, '\.\.', '\.\.', '\.\.', '\.local', 'showcase', 'e2e', 'dist'\)/u);
  assert.match(read('apps/web/vite.showcase.config.ts'), /resolve\(import\.meta\.dirname, 'dist-showcase'\)/u);
});

test('Pages: built from the committed snapshot, with no secret, database, Docker, dataset export or API server', () => {
  assert.doesNotMatch(code, /secrets\.|services:|docker|postgres|DATABASE_URL|APP_ENV|portfolio:dataset|portfolio:showcase:export|db:|npm run dev|test:e2e(?!:)|e2e:webkit|SHOWCASE_APP_URL/iu);
  assert.doesNotMatch(code, /\n {6}env:\n/u, 'no job-level environment variables');
});

test('Pages: the CI workflow keeps its read-only boundary and deploys nothing', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /\npermissions:\n {2}contents: read\n/u);
  assert.doesNotMatch(ci, /pages: write|id-token|deploy-pages|upload-pages-artifact|github-pages/u);
});
