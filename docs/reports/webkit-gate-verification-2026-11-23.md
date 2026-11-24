# Bounded WebKit gate: verification report (release step 6, ADR-0100)

- Date: 2026-11-23. Kind of evidence: **agent-run workstation automation** (fresh checks run in this change). Not run in
  hosted CI. No physical device was used.
- Baseline: clean `main` at `72d540a` (step 5). Candidate: the uncommitted working tree on top of it (nothing staged or
  committed).
- Scope: [ADR-0100](../adr/0100-bounded-webkit-gate.md). Commands: `npm run test:e2e:webkit` and its parts
  ([reference](../reference.md#browser-end-to-end-tests)).
- Step status: see [completion](#completion).

## 1. Environment

| Item | Value |
|---|---|
| Host | Windows 11 Home 10.0.26300, Node 24.11.1, npm 11, Docker Desktop 29.9.3 |
| Playwright | `@playwright/test` 1.63.0 (unchanged; no dependency changed) |
| WebKit | Playwright WebKit **26.6** (browser build `webkit-2359`), installed with `npx playwright install webkit` from `tests/e2e`. Automation of WebKit on Windows: **not Safari, not iOS, not an iPhone** |
| Other engines (same run) | Chromium 153.0.8010.12, Firefox 155.0 |
| WebKit user agent (both settings) | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15`: Playwright's default, which names macOS Safari although the host is Windows. No user agent was set; the string is not evidence of Safari |
| Desktop setting | 1280 × 720 CSS px, device scale 1, no `isMobile`, no `hasTouch` |
| Phone-sized setting | 390 × 844 CSS px, device scale 3, `isMobile`, `hasTouch`. Observed in the page: `innerWidth` 390, `innerHeight` 844, `devicePixelRatio` 3, `(pointer: coarse)` true, `navigator.maxTouchPoints` 0 |
| Locale, zone | `en-GB`, Europe/Warsaw (application specs); `en-GB`, Pacific/Auckland (showcase); real clock |
| Database (write-based parts) | see section 3 |

## 2. Scenario list (documented before the results)

47 tests, all reused from existing specs; selection only (ADR-0100, decision 3):

| Part | Project | Server | Tests |
|---|---|---|---|
| Development servers | `webkit-desktop` | `playwright.config.ts` (Vite dev servers, development-session API) | 28: `record` 1, `reload-offline` 3, `second-tab` 2, `gps-recovery` 3, `run-sharing` 2, `archive-sharing` 4, `coach-map` 3 (fake runtime), `session-revalidation` 6, `primary-journey` 4 |
| | `webkit-phone` | same | 4: `primary-journey` |
| Production build | `production-webkit` | `vite preview` of the measured production build, development-session API, AI off | 4: `production-build/deferred-views` |
| Showcase static build | `showcase-webkit` | `vite preview` of the showcase build, **no API server** | 8: every showcase test |
| | `showcase-webkit-phone` | same | 3: the tests tagged `@phone` (journey, every view, keyboard and 375 px) |

Requested coverage, and where it is:

| Requested | Scenario(s) |
|---|---|
| Recording, upload, pause/finish, offline recovery, reload | `record`; `reload-offline` (reload recovery, offline buffering delivered once, failed upload delivered once); `primary-journey` capture test (pause and finish away from Runner); `gps-recovery` (pause while waiting for a fix) |
| Competing-tab ownership; session loss/revalidation | `second-tab` (2); `session-revalidation` (6) |
| Today → Weekly review → Trends → records, date context kept | `primary-journey` journey and scope tests (desktop and phone-sized); showcase journey (desktop and phone-sized) |
| Navigation away from Runner while capture/upload continue | `primary-journey` capture test (desktop and phone-sized); `production-build` recording test (the deferred chunk unavailable) |
| Showcase journey, read-only boundary, missing/zero states | showcase journey and every-view tests (both settings), broken snapshot files, request guard, built files |
| Keyboard and horizontal overflow at a phone-sized viewport | `primary-journey` 375 px test and showcase keyboard/375 px test, both at the phone-sized setting (and at desktop) |
| Production loading: delayed/failed secondary imports, leaving while loading, recovery after the network returns | `production-webkit`: held chunk (loading state), aborted chunk (failure), Try again still failing (a real new request), network back (recovery on the date Today chose), leaving Activity before its code arrives, organization change while held |

**Excluded** (ADR-0100, decision 4): `coach-map smoke … installed Mapbox runtime` (`@real-map-runtime`, real WebGL);
OpenID Connect sign-in (`oidc/`); the rest of the Chromium suite; the LAN pilot and dataset configurations. The three
`coach-map` tests that ran use a fake runtime served in place of `mapbox-gl`: **no real basemap, WebGL context or Mapbox
request was exercised in WebKit**, and nothing here supports a real-basemap claim.

## 3. Test database identity (read-only, before any write-based run)

`TEST_DATABASE_URL`, `TEST_MAINTENANCE_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` reach `running_tracker_test` on
`127.0.0.1:5433` (container `running-tracker-postgres-1`, image `postgis/postgis:17-3.5@sha256:8dfee83d…32ba`, PostgreSQL
17.5) as `running_tracker_runtime`, `running_tracker_maintenance` and `running_tracker_owner` respectively
(current_user = session_user), system identifier `7687193163643084838` (the same as recorded for step 5). 43 migrations
applied of 43 on disk. `.env` has `APP_ENV=development` and `DATABASE_URL` naming `running_tracker`, which the browser
suites never use (their guard requires `_test`). The portfolio dataset's container (`somalane-portfolio-dataset-postgres-1`)
stayed stopped throughout; the dataset was not touched. Write-based suites ran one at a time; no build ran while any
suite's servers were up.

## 4. Initial runs (first execution of each part)

Kept separately from the final run. Failure traces were copied before any rerun.

| Part | Result | Notes |
|---|---|---|
| Showcase, `npm run e2e:webkit:showcase` | **9 passed, 2 failed** (45.1 s) | Both failures were the same step of the keyboard/375 px test, at both settings: after the first Tab, the application link was not focused. Traces: `.local/webkit-gate/failures/initial-showcase/`. Cause in section 5.1 |
| Showcase, after the keyboard fix | **11 passed** (20.5 s) | |
| Production build, `npm run e2e:webkit:production-build` | **4 passed** (25.8 s) | Before the WebKit assertion of section 5.2 was added; the test then checked recovery but no WebKit-specific request pattern |
| Development servers, `npm run e2e:webkit:dev-server` | **32 passed** (6.3 min), first run | 28 desktop, 4 phone-sized; no failure, no retry |

No test was skipped (no `test.skip` was added; the journey tests' existing week-boundary guard did not trigger), and
retries stayed 0.

## 5. Observed WebKit behaviour and the narrow changes made

### 5.1 Tab skips links

Reproduced outside the application with a minimal page (a link, two buttons, a link, an input):

| Engine, setting | Tab × 4 | Alt+Tab × 4 |
|---|---|---|
| WebKit 26.6, desktop | button, button, input, body | button, button, input, body |
| WebKit 26.6, phone-sized | button, button, input, body | button, button, input, body |
| Chromium 153, both | link, button, button, link | (focus stays on body) |

WebKit, like Safari with its default setting, never focuses a link with Tab. Change: in WebKit only, the showcase
keyboard test asserts that the first Tab lands on the first view (the link is skipped), then focuses the link directly
and checks the same Tab order (link → Today → Weekly review → Trends) and everything after it. The Chromium and Firefox
paths are unchanged. The application's own 375 px keyboard test (`primary-journey`) moves between buttons and passed
unchanged.

### 5.2 Deferred-module retry (`deferred-module.ts`)

Observed against the real built `secondary-views` chunk, served locally, the chunk's route made to fail and then served
(`import()` from the page each time; request counts from the route handler):

| Engine | Error when the chunk fails (network failure, and HTTP 503 alike) | URL in the message | 2nd `import()` of the same URL, still failing | 3rd, network back | `?retry=1`, network back |
|---|---|---|---|---|---|
| Chromium 153 | `TypeError: Failed to fetch dynamically imported module: <url>` | yes | rejected, **no request** | rejected, **no request** | loads (new request) |
| Firefox 155 | `TypeError: error loading dynamically imported module: <url>` | yes | rejected, new request | **loads** | loads |
| WebKit 26.6 | `TypeError: Importing a module script failed.` | **no** | rejected, new request | **loads** | loads |

So in WebKit `failedModuleUrl` returns null and the `?retry=` fallback is never taken; recovery comes from the importer's
own second call, which WebKit really fetches again. `deferred-module.ts` needed no change. Added:

- a WebKit branch in the production retry test: at least three chunk requests (first failure, failed Try again,
  recovery) and every one of them the plain file, never a `retry` URL;
- a unit test in `deferred-module.spec.ts` with WebKit's exact message: two failures, the third load succeeds through the
  importer, `importUrl` is never called, and `failedModuleUrl` returns null.

### 5.3 Formatting

No formatting difference appeared: WebKit 26.6 printed the same `en-GB` dates as Chromium (for example "Sun, 27 Sept
2026", "Sat, 21 Nov 2026") and the same numbers ("70.73 kg", "8,424", "+11.60 km (+18.8%)"), so no assertion was changed
for formatting.

## 6. Existing behaviour preserved

| Check | Result |
|---|---|
| `--list` of `chromium` + `chromium-oidc`, `firefox-core`, `production-chromium` + `production-firefox`, smoke, before and after | byte-identical: 192, 18, 5, 48 |
| `--list` of `showcase-chromium` + `showcase-firefox` | 10, same titles and projects; only line numbers moved (comment lines added above them) |
| `npm run test:e2e`, `test:e2e:firefox` | already select their projects; unchanged |
| `npm run test:e2e:production-build`, `test:e2e:showcase` | now name their projects explicitly, so the selection equals the old default and never includes WebKit; `scripts/ci-workflow.test.mjs` pins this |
| Application source | unchanged (`git diff -- apps/web/src ':!*.spec.ts'` empty); no API, schema, configuration guard, timeout, retry or security setting changed |
| Showcase guards | the request guard (any `/api` or other-origin request aborts and fails the test) and the storage-write instrumentation ran in every WebKit showcase test; the guard test proved them in WebKit |
| Showcase 375 px screenshot | the Chromium file name is unchanged; other projects write `showcase-375-scrolled-<project>.png` |

## 7. Final run on the final code

One sequential script, from `C:\ForMe\Learning\SomaLane`, each command after the previous one exited, so no build ran
while any suite's servers were up. Code identity: the production-build measurement printed `apps/web` tree
`1a0b3105765b583f2b11f4b658a21e6d603c7275` in both runs that build it (the step-5 tree changed only by the new unit
test); initial JS 625,949 B raw / 175,239 B gzip, the same as step 5's candidate. Later edits are documentation, one
comment in `support/webkit-gate.ts`, and line-ending normalisation of `ci.yml` and the two `package.json` files (the
CI structural test passed again afterwards).

| # | Command | Result |
|---|---|---|
| 1 | `npm run verify` | exit 0 (4.1 min): lint, typecheck, scripts 124, API 2,832, web 1,530, contracts 325, fixtures 14, simulator 3, build |
| 2 | **`npm run test:e2e:webkit`** | **47 passed, 0 failed** (7.2 min): development servers 32 (6.2 min), production build 4 (26.5 s), showcase 11 (20.7 s); 0 skipped, retries 0 |
| 3 | `npm run test:e2e:production-build` (existing) | **5 passed** (4 Chromium, 1 Firefox), 31.8 s |
| 4 | `npm run test:e2e:showcase` (existing) | **10 passed** (8 Chromium, 2 Firefox), 21.8 s |
| 5 | `npm run test:e2e:firefox` | **18 passed**, 3.5 min |
| 6 | `npm run test:e2e` (full Chromium + OIDC; run because the shared `playwright.config.ts` gained projects) | **192 passed**, 0 failed, 20.2 min, one run (the harness's deliberate `test.fail()` case counts as passed, as before) |

Other checks: `deferred-module.spec.ts` 12 passed; `scripts/ci-workflow.test.mjs` 9 passed; E2E typecheck exit 0;
ESLint of the changed files exit 0; `git diff --check` and `--no-index --check` of the new files clean; 191 relative links
and anchors of the changed documents (with the progress entry) resolve. `packages/contracts/openapi/openapi.json`, rewritten by the contracts
builds with line endings only (content identical after removing CR: SHA-256 `83580536…8e72` both), was restored to
`HEAD`; no other generated file was in the working tree. The portfolio dataset's container stayed stopped.

## 8. CI

A new job `e2e (webkit gate)` in `.github/workflows/ci.yml` (ADR-0100, decision 7) with the existing pinned PostGIS
image, the compose init script, bootstrap and migrations, the WebKit build cached as `playwright-<os>-<version>-webkit`
(`--with-deps` install, or `install-deps` on a cache hit), the three parts as three steps, and a failure artifact
`playwright-webkit-gate` (`webkit-results/`, blob reports). `scripts/ci-workflow.test.mjs` adds the job to the database
jobs (needs `verify`, same image, init script before bootstrap and migrations) and pins its steps and that no existing
job or command selects WebKit (9 tests pass). **Hosted CI of this change and its new WebKit job: NOT RUN** (the change
is uncommitted; nothing was pushed). The baseline is covered: run
[45145194048](https://github.com/AlexTikhon/SomaLane/actions/runs/45145194048), a push to `main` for `72d540a` (the
committed step-5 baseline), concluded `success`; `verify`, `integration`, `e2e (chromium 1/3, 2/3, 3/3)` and
`e2e (firefox-core)` succeeded, `e2e-report` skipped (checked with `gh run view` on 2026-11-23). That run predates the
WebKit job and is not WebKit evidence. The earlier run 45055752618 for `1dac6ed` (step 4) stays recorded in the step-4
report. Physical Safari remains NOT RUN (section 9).

## 9. Physical evidence: NOT RUN

No owner observation was supplied. The physical Safari checklist in [iphone-lan-pilot.md](iphone-lan-pilot.md) is left
exactly as it was: every row NOT RUN, its 2026-11-09 workstation results kept as history. Nothing in this report is an
iPhone, iOS, Safari, background-recording or real-GPS result. The release remains described as **desktop-scoped**.

## Completion

Step 6's acceptance criteria, against the evidence:

- "The WebKit gate's scenarios are listed, it has run, and its result is recorded; failures are fixed or listed as known
  limitations. Playwright WebKit is recorded as WebKit automation, not as Safari." Listed in section 2 (and ADR-0100),
  run and recorded in sections 4 and 7 (final: 47/47); the initial failures (Tab skips links) are explained and handled
  in the test for WebKit only (section 5.1); the remaining limits are listed below. Recorded throughout as WebKit
  automation.
- "The physical checklist is either recorded … or explicitly left NOT RUN. If it is not run, no iPhone or Safari
  compatibility is claimed and the release is described as desktop-scoped." Left NOT RUN (section 9); no such claim is
  made; the release stays desktop-scoped.

**Step 6 is done (agent-run workstation automation; hosted CI NOT RUN; physical checklist NOT RUN).** Gate G6 ("the
bounded WebKit gate has run and its result is recorded") holds locally.

## Not covered, and limits

- Playwright WebKit on Windows is not Safari: different build and platform integration, no iOS process model, keyboard,
  permission prompts, background throttling, storage eviction or GPS. The phone-sized setting is a viewport with touch
  emulation (`maxTouchPoints` stayed 0), not a phone.
- No real WebGL or Mapbox basemap in WebKit (fake runtime only); no OpenID Connect sign-in in WebKit.
- Keyboard reachability of links under Safari's default setting is not shown (WebKit skips links on Tab).
- Not run in hosted CI; the Linux WebKit build in CI may behave differently from the Windows build observed here.
- AI-quality limitations are unchanged; no model was run.
