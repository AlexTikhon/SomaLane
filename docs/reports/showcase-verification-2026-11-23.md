# Public read-only showcase: verification report (release step 5, ADR-0099)

- Date: 2026-11-23. Workstation: Windows 11, Node 24.11.1, Vite 8.3.0, Docker Desktop, PostgreSQL 17.5 / PostGIS 3.5
  (pinned image), Playwright 1.63.0 (Chromium, Firefox).
- Baseline: clean `main` at `1dac6ed` (step 4, closed by hosted CI run 45055752618). Candidate: the uncommitted working
  tree on top of it (nothing staged or committed).
- Scope: [ADR-0099](../adr/0099-public-read-only-showcase.md), [runbook](../runbooks/showcase.md). Fresh checks, run in
  this change, on the workstation. Not run in hosted CI. Nothing was hosted or deployed.
- Step status: see [completion](#completion).

## 1. Snapshot provenance

| Item | Value |
|---|---|
| Source | the isolated step-2 dataset: Compose project `somalane-portfolio-dataset`, database `somalane_portfolio_demo` on `127.0.0.1:5442`, container `7d0a04dbb856…`, system identifier `…6329`, cluster `somalane-portfolio-dataset` |
| Dataset | `portfolio-dataset-v1`, seed `somalane-portfolio-v1`, anchor 2026-11-21, Europe/Warsaw; canonical digest `sha256:b6222c858f464e8d4fe465b3f9c29a95f5c8f0f3e0cf3403b0021d49012e857d` (`portfolio-dataset-digest-v1`), equal to `manifest.json` and `seed-state.json`, before and after each export |
| Read as | `running_tracker_runtime` (the services, as the synthetic runner, no session) and `running_tracker_owner` (the digest), each connection identity-checked and `default_transaction_read_only = on` |
| Fixed instant | `2026-11-21T23:00:00.000Z` (the first instant of 22 Nov in Warsaw) for every read; every `computedAt` equals it |
| Reads | 119: 34 overviews, 34 meal lists, 5 weekly reviews, 2 daily trends, 44 activity trends (22 source/type candidates × 2 end dates) |
| Catalog | sample date 2026-11-21; Trends ending 2026-11-15 and 2026-11-21; 34 days (2026-10-19 … 2026-11-21); weeks from 2026-10-19 to 2026-11-16; 7 activity selections with entries (manual run, walk, strength; GPX ride, hike; TCX swim; recorded run) → 14 activity responses |
| File | `apps/web/showcase/public/showcase-snapshot.json`, 471,413 bytes, SHA-256 `8ccbbcd0406a11a0467bb2d915bb565c42b5147b9ace23692e154388b4fd7628`; content digest `sha256:a717379d84b42ff0fd854dc14c85c88e82a1831e559e9c29c14fd0f969600a9c` (`showcase-snapshot-normalization-v1`) |
| Contract versions | `daily-overview-4`, `weekly-review-5`, `daily-trends-2`, `activity-trends-1` |

Values checked against the manifest's independently planned expectations: Today 21 Nov (weight 70.73 kg, 8,424 steps,
3 meals with a coffee recorded as 0, a GPS run); 29 Oct no meal (`recordedEntries 0`, `total null`); 11 Nov nothing at
all; 14 Nov carbohydrate on 1 of 2 entries (51 g); 20 Nov a title-only dinner; manual runs ending 21 Nov 9 vs 8 (+1,
+12.5 %), 73.20 vs 61.60 km (+11.60 km, +18.8 %).

## 2. Export: determinism, read-only, dataset unchanged

| Check | Result |
|---|---|
| `npm run portfolio:showcase:export` (writes the committed file) | exit 0; digest matched before and after; 119 reads |
| Second export, `-- --out <scratch file>` | byte-identical (SHA-256 `8ccbbcd0…7628` for both) |
| `-- --check` | `byte-identical to a fresh export`, exit 0 |
| Server write counters (`pg_stat_user_tables`, summed ins/upd/del over 58 tables, read inside the owned container) before the first export and after the third | `19915 / 4546 / 28` both times: no row was inserted, updated or deleted by three exports |
| `manifest.json`, `seed-state.json`, `settings.json`, `compose.env` | SHA-256 and modification times unchanged (`6d6afc51…5a0f`, `0554f917…f5ce`, `0a2a6829…2f14`, `e28bb67c…1bc8`) |
| Nothing bootstrapped, migrated, seeded or reset | the export calls none of them; its connections cannot write |

## 3. Unit and static checks

| Check | Result |
|---|---|
| Web, new: `showcase-snapshot.spec.ts` | the committed file: every response valid by its existing contract schema, envelope cross-checks clean, synthetic and versioned metadata, canonical form and recomputed content digest, closed catalog, missing/partial/zero/title-only states, no forbidden field, identifier, note or demo identity; 11 refusals (format, contract version, non-synthetic, invalid value, extra field, wrong date, missing range day, unoffered response, wall-clock timestamp, other `computedAt`, a date after the snapshot) |
| Web, new: `showcase-state.spec.ts` | defaults from the snapshot (not the clock); the policy with "today" = the last date (unfinished week → 21 Nov; completed week → its Sunday); Trends row → day or meals and back with the same range and series; ordinary navigation keeps them; every out-of-catalog action ignored; loader: one request without credentials, every failure one local message |
| Web, new: `showcase-config.spec.ts` | link validation: none by default; https, http for loopback only; relative, plain http, other schemes, credentials, fragment refused |
| Web, new: `showcase-boundary.spec.ts` | the showcase's static graph reaches the pure blocks and no App, Screen wrapper, controller, API client, session, sign-in, storage, capture or lease module; its own code mentions no storage API or `/api`; the application's entry reaches nothing of the showcase |
| Web, new: `ShowcaseViews.spec.tsx` | label, data line, link (and "not configured"), AI-off note on every view; no editing/deletion/import/recording/generation/sign-in control, form, text or date input; offered dates, weeks, end dates and activity choices only; "not included" sentences instead of dead actions; loading and failure states |
| Web, new: `read-only-content.spec.tsx` | the extracted blocks: with actions as before, without actions no control and the same figures; the meal action's words |
| API, new: `showcase-export.spec.ts`, `showcase-export-cli.spec.ts` | catalog from the manifest; fixed instant (CET and CEST); manifest refusals; derived meal ids and normalised meal pages; a cursor refused; the committed file rebuilt byte for byte from its responses; allowlist refusals; refusals before Docker (production, no manifest, no or mismatched completion) and before any connection (container not running); read-only connection option; CLI default path, refusal of the dataset directory, atomic write, `--check` writes nothing |
| `npm run verify` | exit 0: lint, typecheck, scripts 122, API 2,832, web 1,529 (125 files), contracts 325, fixtures 14, simulator 3, build (application and showcase) |
| E2E typecheck (`tsc -p tests/e2e`, now including `showcase/`) | exit 0 |

## 4. The application's initial bundle

`npm run measure:web-bundle`, same settings, clean `1dac6ed` vs this candidate:

| | `1dac6ed` | Candidate | Change |
|---|---|---|---|
| Initial JS raw / gzip | 625,755 / 175,156 B | 625,949 / 175,239 B | +194 / +83 B (the optional-action branches of the shared blocks) |
| Initial CSS raw / gzip | 43,020 / 8,276 B | 43,020 / 8,276 B | 0 |
| Deferred `secondary-views` raw / gzip | 179,628 / 46,896 B | 179,788 / 46,952 B | +160 / +56 B (`MealEntryValues` extraction) |

The candidate build contains no `Read-only showcase`, `showcase-snapshot`, `somalane-showcase-snapshot`, showcase-only
wording or dataset identifier (searched in every output file). A first candidate measurement, with the showcase's
read-only wording still inside the shared blocks, was +533 B; that wording moved into the showcase.

## 5. Showcase browser evidence: static production build, no API server

`npm run test:e2e:showcase`: builds the output with `SHOWCASE_APP_URL=http://127.0.0.1:5999/` (an explicit local test
address; nothing listens there) into `.local/showcase/e2e/dist`, then `vite preview` serves it on `127.0.0.1:4381`. No
API, database or proxy exists in this configuration. Browser zone Pacific/Auckland, real clock. Every test aborts and
fails on any request to `/api` or another origin, and records every attempt to write Web Storage, IndexedDB, cookies,
Cache Storage or a service worker.

| Test | What it asserts |
|---|---|
| Journey (Chromium, Firefox) | Today on Sat 21 Nov (sample date); Today 15 Nov → Weekly review 9–15 Nov (focus on the heading) → Trends ending Sun 15 Nov; Food energy: 29 Oct "Not recorded" (missing row); a row's Meals → 14 Nov's 2 entries (a value "Not recorded") → Back to Trends with the same end date and series; a row's Open → Today 29 Oct (no meal logged) → navigation Trends keeps range and series; carbohydrate 14 Nov partial; Trends ending 21 Nov: +1 (+12.5%), +11.60 km (+18.8%); the coffee of 21 Nov recorded as 0 kcal; label, link and no mutation control on every view; no storage write |
| Every view | the label, the view's date or range, `aria-current`, the link and no forbidden control on Today, Weekly review and Trends; the unfinished week's policy sentence; an October week's range "not included" with no Trends button; an unlogged date and its empty meal list ("unknown, not zero"); the AI-off note; no storage write |
| Keyboard and 375 px | no horizontal scroll on each view; Tab order link → Today → Weekly review → Trends; Enter opens and focuses the heading; arrow keys choose a series; Enter on a row's Open and on Back to Trends; the label stays in view at the end of the page |
| A missing (404), a non-JSON and an other-format snapshot | the local message, "it never asks the application for data", label and link shown, no navigation; Try again asks for the same file only; no storage write |
| Request guard (Chromium, Firefox) | `fetch` of `/api/health/ready`, `/api/session` and `/api/auth/login` from the page fails and is recorded (the instrument works); after a reload the page requested only `/`, its assets and `showcase-snapshot.json` |
| Built files | no `/api/`, storage API, CSRF header or demo sign-in text in any asset; relative asset paths; the page title carries the label |

## 6. The application's suites (test database identity verified first)

Before the write-based suites, read-only: `TEST_DATABASE_URL`, `TEST_MAINTENANCE_DATABASE_URL` and
`TEST_MIGRATION_DATABASE_URL` reach `running_tracker_test` on `127.0.0.1:5433` (container `running-tracker-postgres-1`)
as `running_tracker_runtime`, `_maintenance` and `_owner` (current_user = session_user), system identifier
`7687193163643084838`; the dataset server is another cluster (`7710906452649996329`). Suites ran one at a time; no
source was built or edited while their servers ran.

| Suite | Result |
|---|---|
| `npm run test:e2e:production-build` (step 4's production-build check) | **5 passed** (4 Chromium, 1 Firefox), 33.1 s |
| Full `npm run test:e2e` (Chromium + OIDC) | **192 passed**, 0 failed, 17.4 min, in one full run (no rerun) |
| `npm run test:e2e:firefox` (Firefox core gate) | **18 passed**, 3.3 min |
| `npm run test:e2e:portfolio-dataset` (verified launcher, dataset server) | **2 passed**, 18.6 s. Afterwards: dataset digest unchanged (`--check` byte-identical, digest checked before and after); record tables' write counters unchanged; `auth_sessions` +3 inserts / +11 deletes (sign-in sessions, which the walkthrough is documented to write); manifest, seed-state, settings and compose.env hashes and times unchanged; its seven screenshots, overwritten by the run, restored byte-identical |

## 7. Production guard and the public boundary

- `apps/api/src/config/environment.ts` is unchanged (empty diff); its refusal of `LOCAL_AUTH_ENABLED=true` with
  `APP_ENV=production` is still covered by `environment.spec.ts` ("LOCAL_AUTH_ENABLED must be false in production"),
  which passed inside `npm run verify`.
- No API route, middleware, session or authentication code changed; no anonymous endpoint was added.
- The showcase build has no demo sign-in (no sign-in module in its graph; no "Demo runner"/"Demo coach" text in its
  assets) and no AI section.

## Completion

Every acceptance criterion of step 5 has fresh evidence: reproducible snapshots validated by the existing contract
schemas in a test (sections 1–3), rendered with the existing content blocks (section 3, boundary test); the label and
the application link on every view, no request to a private route and no write (section 5); the production guard
unchanged and no demo sign-in (section 7); no AI section. The application's gates on the final code: `npm run verify`,
the production-build check, a full Chromium/OIDC run free of failures, the Firefox core gate and the dataset walkthrough
(section 6). **Step 5 is done (local evidence; not hosted, not in CI).**

Code identity: the four browser suites of section 6 and the final `npm run test:e2e:showcase` (10 passed: 8 Chromium,
2 Firefox, 22.6 s) ran on the same working tree, `apps/web` tree `c090bf182cc6e413aaa997902ee49bd86bf5cd68` (printed by
the production-build run's measurement); later changes are documentation only. `npm run verify` and the bundle
measurement of section 4 ran just before two test-file-only lint fixes (no source or build output changed: the
production-build run measured the same 625,949 B). During development the showcase run first failed 4 of 10 on test
locators (a `Week` label that also matched the region "Weekly review", and an `aria-label` button name); the traces were kept
in `.local/showcase/failures/dev-run-1/` before the tests were corrected. `openapi.json`, rewritten with line endings
only by each contracts build (empty content diff), was restored.

## Not covered, and limits

- Not run in hosted CI: neither the showcase browser check nor the export (which needs the local dataset) is part of the
  workflow; `npm run verify` there would build the showcase and run its unit tests on the committed file.
- Not hosted: the showcase has run only from `vite preview` on the workstation. The application link is a local test
  address; no live address exists or is claimed.
- No WebKit, Safari or phone (release step 6). The 375 px check is Chromium automation.
- The snapshot is a picture at one instant of synthetic data; regenerating it is manual (runbook section 7).
- AI quality limitations are unchanged; no model was run.

## Follow-up: showcase build output excluded from lint (2026-11-23)

Regression: `npm run build` and `npm run build:showcase` write `apps/web/dist-showcase/` (already git-ignored), but
ESLint's global ignores listed only `**/coverage/**`, `**/dist/**` and `**/node_modules/**`. With that directory
present, `eslint .` linted the generated minified JavaScript, so `npm run verify` failed after a build (1,446 errors as
reported; the count was not reproduced here before the fix).

Fix: `'**/dist-showcase/**'` added to the existing global `ignores` in `eslint.config.js`. No rule, file pattern or
other ignore changed; source linting is as before.

Checks, run on the workstation from `C:\ForMe\Learning\SomaLane` with `apps/web/dist-showcase/` present throughout:

| Check | Result |
|---|---|
| `npm run build:showcase` | exit 0; `dist-showcase/index.html` 0.61 kB, `assets/index-DugQtuVx.css` 44.58 kB, `assets/index-vrgfub2a.js` 465.30 kB (134.04 kB gzip); directory kept |
| `npm run verify` (no CLI ignore override) | exit 0: lint clean (no problems printed), typecheck, scripts 122, API 2,832 (173 files), web 1,529 (125 files), contracts 325 (16 files), fixtures 14, simulator 3, build (application and showcase; the build rewrote `dist-showcase/`) |
| `npm run lint` after verification's build | exit 0, no problems printed |
| `git diff --check` | clean (exit 0), also after these documentation edits |

`openapi.json`, rewritten with line endings only by the contracts builds (empty content diff), was restored; the rest
of the working tree (status and untracked-file hashes) matched a snapshot taken before the checks. Browser suites were
not rerun: the change only widens lint's ignore list and alters no source or build output.
