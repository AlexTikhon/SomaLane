# Verification report: static publication preparation (release step 7)

- Date: 2026-11-24
- Change: [ADR-0101](../adr/0101-github-pages-showcase-publication.md), the showcase's source link and the GitHub Pages
  workflow; [release plan, step 7](../portfolio-v1-release-plan.md#step-7-static-publication-preparation);
  [runbook](../runbooks/showcase.md#3-publishing-on-github-pages).
- Baseline: `main` at `68b5e4b`, uncommitted changes on top.
- Kind of evidence: **fresh local checks** on the Windows 11 workstation (Node 24.11.1, npm 11.6.2, browsers pinned by
  `@playwright/test` 1.63.0), plus read-only GitHub API queries. **Not run**: hosted CI for this change, and the Pages
  workflow itself. No repository setting changed, nothing was dispatched, deployed, staged, committed or pushed.

## What changed

| Area | Change |
|---|---|
| Showcase page | `ApplicationLink` (a configurable link, or "The address of the invite-only application is not configured in this build.") replaced by `SourceLink`: "Source code on GitHub" → `https://github.com/AlexTikhon/SomaLane` and "The full application, with sign-in, recording and editing, is not hosted: it runs locally from the source, as the README describes." It is in the shared frame, so it appears in the loading state, the data-file error state and every view. CSS class renamed `showcase-banner__source` |
| Configuration | `SHOWCASE_APP_URL` removed: `showcase-config.ts`, its spec, the `__SHOWCASE_APP_URL__` define and the `appUrl` props. `SHOWCASE_OUT_DIR` is the build's only setting |
| Unit tests | the view tests assert the source link and that it is the only `href` in every view, with no "not configured" or "invite-only" text; the loading and error states show the label and the source link |
| Browser check | `vite preview --base /SomaLane/`; tests open `./`; the request guard fails any request outside `/SomaLane/` (proved by a deliberate root-level fetch); a new test (`@cross-browser`, `@phone`) checks a direct reload and `./index.html`, with every file loaded from under `/SomaLane/` and every response 200; the file test asserts the exact published file set, relative references only, the source URL in the script and none of the old text |
| Workflow | `.github/workflows/showcase-pages.yml` (manual, `main` only, `build` with `contents: read`, `deploy` with `pages: write` and `id-token: write` in `github-pages`, upload of `apps/web/dist-showcase` only after unit tests, the browser check in four projects and `diff -r` against the tested build) |
| Structural test | `scripts/showcase-pages-workflow.test.mjs` (6 tests): trigger, default permissions, per-job permissions, ref fences, environment and URL, the single upload path and step order, no secret, database, Docker, export or API server, and the CI workflow's unchanged read-only boundary |

The full application, the API, authentication, `apps/api/src/config/environment.ts`, `.github/workflows/ci.yml`, the
snapshot file and every dependency are unchanged.

## Inputs checked (read-only)

| Command | Result |
|---|---|
| `gh repo view AlexTikhon/SomaLane --json visibility,defaultBranchRef,isPrivate` | `PUBLIC`, default branch `main` |
| `gh api repos/AlexTikhon/SomaLane/pages` | `404 Not Found`: no Pages site is configured |
| `gh api repos/<action>/git/ref/tags/<major>` for `actions/configure-pages` v6, `actions/upload-pages-artifact` v5, `actions/deploy-pages` v5, `actions/checkout` v5, `actions/setup-node` v5 | all five tags resolve |
| `actions/upload-pages-artifact` v5 `action.yml` | archives `path` with `tar --dereference --hard-dereference`, always excludes `.git` and `.github`, excludes other dot-files unless `include-hidden-files: true` (not set) |
| GitHub's documentation (custom workflows, publishing source, the three actions' READMEs, the static starter workflow) | deploy job needs `pages: write` and `id-token: write`; environment `github-pages` with `url: ${{ steps.deployment.outputs.page_url }}`; starter concurrency `pages` without cancelling; source set under Settings → Pages → Build and deployment → GitHub Actions |

## Checks run

| # | Command (from `C:\ForMe\Learning\SomaLane` unless noted) | Result |
|---|---|---|
| 1 | `npx vitest run src/showcase` (in `apps/web`), and later `npm run test --workspace=@running-tracker/web -- src/showcase` | 4 files, **55 passed** (first run of the edited spec: 4 failed on a test-regex typo, fixed; then 55 passed) |
| 2 | `npx tsc --noEmit -p tsconfig.json` and ESLint of the changed files (in `tests/e2e`) | exit 0, exit 0 |
| 3 | `npm run test:e2e:showcase` (before the guard test gained its root-level fetch) | **12 passed** (Chromium 9, Firefox 3), 34.0 s |
| 4 | The workflow's build sequence, locally: `node --import tsx support/showcase-build.ts`, then `npx playwright test --config=playwright.showcase.config.ts --project=showcase-chromium --project=showcase-firefox --project=showcase-webkit --project=showcase-webkit-phone` (in `tests/e2e`), final code | **25 passed** (Chromium 9, Firefox 3, WebKit desktop 9, WebKit phone-sized 4), 0 failed, 1.1 min |
| 5 | `npm run build:showcase`, then `diff -r .local/showcase/e2e/dist apps/web/dist-showcase` | build exit 0; **identical**. Output: `index.html` (612 B), `showcase-snapshot.json` (471,413 B), `assets/index-CSFkCBR5.js` (464,346 B), `assets/index-DeAHiD62.css` (44,593 B); no dot-file, no link; both directories git-ignored |
| 6 | `node --test scripts/showcase-pages-workflow.test.mjs scripts/ci-workflow.test.mjs` | **15 passed** (6 new, 9 existing) |
| 7 | `npx --yes yaml@2.8.1 --json < .github/workflows/showcase-pages.yml` (in the scratch directory) | parses; trigger, permissions, jobs, `needs`, `if`, environment and steps as written |
| 8 | `npm run verify` | **exit 0**: lint; typecheck; scripts 130, API 2,832, web 1,523 (was 1,530: the 10 removed link-validation tests, 3 net new view tests), contracts 325, fixtures 14, simulator 3; build (application and showcase) |
| 9 | `npm run e2e:webkit:showcase` (in `tests/e2e`; the existing command, unchanged) | **13 passed** (9 + 4), 22.3 s |
| 10 | `vite preview --base /SomaLane/` of the built output, probed with `curl` | `/` → 302 to `/SomaLane/`; `/SomaLane` → 404; `/SomaLane/` → 200 `text/html`; `/SomaLane/index.html` → 200; `/SomaLane/showcase-snapshot.json` → 200 `application/json`; `/SomaLane/nope` → 200 `text/html` (preview's fallback); `/showcase-snapshot.json` → 404 |
| 11 | `npm run test:e2e:showcase`, final code | **12 passed** (Chromium 9, Firefox 3), 25.8 s |
| 12 | Relative links and anchors of the changed documents; `git diff --check`; `git diff --no-index --check` for each new file | see the [progress entry](../progress.md) of 2026-11-24 |

`packages/contracts/openapi/openapi.json`, rewritten with line endings only by the contracts builds, was restored
(`git diff --ignore-cr-at-eol` empty).

## Observations

- **Determinism.** Two builds of the same sources into different directories are byte-identical, so the workflow can
  compare the published output with the tested one instead of re-testing it.
- **`vite preview` is not GitHub Pages.** It answers `/SomaLane` with 404 (Pages is expected to redirect to the slash)
  and serves the page for unknown paths under the base (Pages answers 404). The local tests do not rely on either; the
  hosted checks H3 and H5 of the runbook cover them.
- **Address case.** GitHub serves project sites at `https://<account in lower case>.github.io/<repository>/`; the
  repository path is case-sensitive. The expected address is therefore `https://alextikhon.github.io/SomaLane/`; only
  the deployment's reported URL confirms it.

## Not verified

- The workflow on GitHub: neither job has run; whether the `github-pages` environment's default branch rule is exactly
  `main` is observed only when Pages is enabled (runbook 3.2).
- The published page, its status codes, headers and the snapshot digest at the hosted address (release step 8).
- Hosted CI (`ci.yml`) for this change.
- Suites unaffected by this change and not rerun: the full Chromium/OIDC suite, the Firefox core gate, the production-build
  check, the WebKit gate's development-server and production-build parts, the integration suite, and
  `npm run portfolio:showcase:export -- --check` (the snapshot did not change).
- Safari or any phone: Playwright WebKit is WebKit automation.
