# Portfolio v1 release step 2: synthetic dataset, verification (2026-11-22)

- Scope: [release plan, step 2](../portfolio-v1-release-plan.md#step-2-reproducible-isolated-synthetic-dataset-over-56-calendar-dates);
  how to use it: [runbook](../runbooks/portfolio-dataset.md).
- Baseline: `main` at `1696d39` (step 1 committed), working tree clean before this change. Changes are uncommitted.
- Machine: the Windows 11 workstation, Node 24.11.1, Docker Engine 29.7.2, Docker Compose 5.4.0, image
  `postgis/postgis:17-3.5@sha256:8dfe…32ba` (PostgreSQL 17.5).
- Evidence kind: **fresh checks** (release plan, section 2), run in this change. Sanitised: no password, token or
  connection secret appears here; database URLs are shown as `role@host:port/database`.

## What was built

`npm run portfolio:dataset [-- --seed <label> --anchor YYYY-MM-DD --port <n>]` prepares an isolated Compose project
(`somalane-portfolio-dataset`: own PostgreSQL server, database `somalane_portfolio_demo`, network, volume, loopback
port 5442), proves isolation, bootstraps and migrates with the existing scripts, and seeds a deterministic 56-date
dataset through the application's own services, then writes a manifest with a canonical digest. Code in
`apps/api/src/portfolio-dataset/`. No schema, migration, public contract, production default, authentication rule or CI
file changed. One existing function (`parseDatabaseConnection` in `apps/api/src/config/environment.ts`) is now exported
so the tooling reuses the API's URL rules; its behaviour is unchanged.

## Isolation proof (observed)

| Check | Observed |
|---|---|
| Owned container | exactly one running container labelled `com.docker.compose.project=somalane-portfolio-dataset`, service `postgres`, started from `docker-compose.portfolio-dataset.yml`, publishing only `5432/tcp` on `127.0.0.1:5442` |
| Server identity | system identifier read inside the container (`docker exec … psql`) equal to the one read over TCP by every role |
| Administrator connection (before bootstrap) | database `somalane_portfolio_demo`, `current_user = session_user = somalane_portfolio_admin`, `cluster_name = somalane-portfolio-dataset` |
| Seeding connections | owner `running_tracker_owner@127.0.0.1:5442/somalane_portfolio_demo` (identities only), runtime `running_tracker_runtime@…` (records), maintenance `running_tracker_maintenance@…` (summaries), each with `current_user = session_user` and the same system identifier |
| Development server | untouched: still `running-tracker-postgres-1` on `127.0.0.1:5433`; the only statement sent to it in this change was one read-only privilege check (`has_function_privilege` for `pg_control_system()`), before any code existed |
| `.env` | SHA-256 `A0B6…EB7A` and modification time `2026-10-01T09:26:45Z` unchanged |

## Dataset (default parameters)

Seed `somalane-portfolio-v1`, anchor `2026-11-21`, zone Europe/Warsaw, version `portfolio-dataset-v1`. Previous range
2026-09-27 – 2026-10-24, current range 2026-10-25 – 2026-11-21 (it starts on the CEST→CET change).

| | Count |
|---|---|
| Users / organizations / memberships | 2 (demo runner, demo coach) / 1 / 2 |
| Check-ins / movement days / manual activities | 48 / 46 / 27 |
| GPX / TCX imports | 2 / 2 |
| Recorded runs (finished, current summaries) / points ingested / shares | 6 / 2,178 / 1 |
| Meals | 121 |
| Unlogged dates | 2026-10-14, 2026-11-11 |

Digest: `sha256:b6222c858f464e8d4fe465b3f9c29a95f5c8f0f3e0cf3403b0021d49012e857d` (`portfolio-dataset-digest-v1`).
First run: 291 write operations, 43 migrations applied; reruns: 0 writes, same digest (three times, including after the
browser walkthrough had run the real API against it). Published anchor-run summary 6,716.912 m and 2,040 s against a
planned 6,703 m (haversine sphere) and 2,040 s.

## Commands and results

### Unit (no database)

| Command | Result |
|---|---|
| `npx vitest run --config vitest.config.ts src/portfolio-dataset` (apps/api) | 4 files, 78 tests passed: planner determinism, the 56-date calendar, DST crossings (Warsaw autumn and spring, New York), skipped wall times, contract-valid requests, gaps and zeros, comparison definedness, real GPX/TCX importer summaries, bounded volumes, anchor/seed/zone refusals; target, role, host and URL-override refusals; the Docker ownership proof (9 refusal cases); connection identity (7 refusal cases); core-writer refusals before Docker or a connection is used; existing-data classification; local environment, child environment scrubbing, app env, CLI arguments |
| `npm run verify` | exit 0 (195 s): lint, typecheck, scripts 115/115, API 2,769/2,769 (169 files), web 1,418, contracts 325, fixtures 14, simulator 3, build. The first attempt failed one existing guard (`scripts/lan-pilot.test.mjs` pins the main Chromium project's `testIgnore`); the assertion now expects `oidc\|lan-pilot\|portfolio-dataset`, with the same intent |

### Real PostgreSQL (throwaway databases inside the dataset server only)

`npm run test:portfolio-dataset`: 1 file, 16 tests, about 33 s; five `somalane_portfolio_t_<hex>` databases created,
bootstrapped, migrated and dropped by name; afterwards the server holds only `postgres`, `somalane_portfolio_demo` and
the templates.

| Covered | |
|---|---|
| Seeding and rerun | empty → complete; rerun writes 0, same digest, no duplicate rows (31 activities, 121 meals, 6 runs, 6 summaries) |
| Digest across databases | an independently prepared database gives the same digest and the same snapshot |
| Concurrency | two simultaneous seeds of one database: one completes, the other is refused with `DatasetBusyError` |
| Interruption | failure injected after write 120 (meals), then inside the second run's point upload (run left `recording`); each leaves a `partial` state; the third run resumes to the identical digest |
| Conflicts | another seed or another anchor over a complete dataset is refused before any write, digest unchanged; an unexpected outsider user is refused the same way |
| Core-writer refusals on the real environment | `running_tracker`, `running_tracker_test`, the development port 5433 (no owned container publishes it, nothing connects), a URL whose role does not match its use |
| Summaries and provenance | 6 summaries current for their data revision and the current algorithm, geometry present, distance within 1 % of plan, duration exact; `find_stale_run_summaries` empty; 6 finish commands; imports `source` tcx/gpx with 32-byte fingerprints, planned idempotency keys and planned totals (TCX exact, GPX within tolerance); every other record `manual` |
| Read models (HTTP, runtime role, fixed clock the day after the anchor) | Today, an unlogged date (empty, not zero), the weekly review, nutrition Trends (range and four named dates), the manual-run comparison (count, duration, distance, percentage), the recorded-run comparison (3 vs 3, available) and GPX (`previous_period_no_entries`), the anchor run's summary: all equal to values computed from the plan |
| Isolation of owner-only data | the coach reads empty check-ins, movement, meals, activities and an empty Today, reads the shared run and gets 404 for an unshared one; a member of another organization gets 403 `ORG_ACCESS_DENIED` |

Runs of this suite on the final code: one run failed one test with `connect ETIMEDOUT 127.0.0.1:5442` (a TCP connect
through Docker Desktop's published port); the next two consecutive runs passed 16/16 without any change. Earlier runs
during development failed on test-side mistakes, which were fixed.

### Browser (desktop Chromium, isolated stack)

`npm run test:e2e:portfolio-dataset`: 1 test passed (about 11 s); of its two passes, the second ran on the final code
(the first preceded lint-only edits to the writer and tests). It started the existing API
(127.0.0.1:3300) and Vite (127.0.0.1:5373) with `node --env-file=.local/portfolio-dataset/api.env`/`web.env`, which the
review found unsafe (superseded; see "Review repair" below, where the walkthrough was rerun through the new launcher),
signs in with the
existing **Demo runner** button and checks Today on 2026-11-21, the weekly review of 2026-11-09, nutrition Trends
(entries with fat 37 of 61, 22 of 28 days, a "No entry logged" date, "Partial: 1 of 2 entries with fat"), the
manual-run comparison ("+1 (+12.5%)", all three changes available), and the run details (6.72 km, 34:00); no private
API answer failed except the app's designed 404s (today's not-yet-recorded check-in and movement, and the absent AI
insight); then **Demo coach** sees an empty Today. Screenshots went to `.local/portfolio-dataset/screenshots/` (not
committed). The shared E2E harness and `running_tracker_test` were not used.

### Other

| Check | Result |
|---|---|
| Different seed against the complete dataset (CLI) | exit 1, every stored record listed as "not in this plan", nothing written |
| Anchor 2026-11-22 (today) | exit 1, "must be a completed date" |
| `git diff --check` and `git diff --no-index --check` for each new file | clean |

## Review repair (2026-11-22, same day)

An independent review confirmed two defects in the work above. Both are fixed; the results below are fresh checks of
the repaired code. The earlier results in this report are historical for the code they ran on.

### Defect 1: inherited variables could redirect the "isolated" app

**Defect.** The runbook and `tests/e2e/playwright.portfolio-dataset.config.ts` launched Node with `--env-file`. Shell
variables win over an `--env-file`, and the API's loader also falls back to `.env`. The reviewer showed, configuration
only, that inherited `DATABASE_URL`/`MAINTENANCE_DATABASE_URL` to `127.0.0.1:5433/running_tracker` were accepted by
`loadEnvironment()`, and that an inherited `API_PROXY_TARGET=http://127.0.0.1:3000` redirected the web proxy to the
normal API.

**Fix.** One launcher, `apps/api/src/portfolio-dataset/serve-cli.ts`, used by `npm run portfolio:dataset:api`,
`npm run portfolio:dataset:web`, the CLI's printed instructions, the runbook and the Playwright configuration. The API's
configuration source is only the dataset's generated settings and secrets, given to the application's
`loadEnvironment` with no `.env` file; the result is asserted (loopback 3300, one origin, the two demo identities, no
OIDC, metrics or journal directory, every AI provider off, both URLs on `somalane_portfolio_demo`); the process
environment is reduced to operating-system variables (no `PG*` default reaches the driver); the configured runtime and
maintenance URLs are proven against the owned container with the existing isolation checks; then `main()` starts through
its `loadConfig` injection point. Vite gets operating-system variables plus the one proxy target, on 127.0.0.1:5373.
No env file with credentials is written any more. Normal production configuration and authentication are unchanged.

| Evidence | Kind | Result |
|---|---|---|
| `serve-cli.spec.ts` (6 tests) | configuration only; decoy listeners count connections; fake Docker | control: the application loader with the poisoned process environment and `.env` returns the decoy URL and port 3000 (the probe is real); the launcher's configuration with the same poison plus `DATABASE_URL_FILE` and poisoned `./.env` and `../../.env` is the dataset's URLs, 127.0.0.1:3300, the one origin, the demo identities and no OIDC/AI/metrics/journal; 7 non-isolated configurations refused; settings pointing at a decoy port refused before connecting or starting (decoy saw 0 connections, `main` not called, the given environment reduced to `Path`); `NODE_OPTIONS`, `PG*`, `npm_*` and application variables removed; Vite's environment and arguments fixed |
| `local-environment.spec.ts` (updated) | configuration only | settings contain no `TEST_`, `_FILE`, OIDC, metrics or journal values; no `api.env` is written; the OS filter keeps only OS variables |
| `startup.dataset.test.ts` (4 tests) | real processes against the preserved demo dataset; decoys only | the real launcher started from a parent whose variables and `./.env`/`../../.env` point at a decoy TCP "database", a decoy HTTP API and other ports, origins, identities, OIDC, metrics, journal and fake providers: it printed `verified running_tracker_runtime@127.0.0.1:5442/somalane_portfolio_demo and running_tracker_maintenance@…` with the owned container, no password or key in its output; the decoy database got 0 connections and the decoy API 0 requests; an evil origin and a foreign identity got 403; the runner read the demo's 2026-11-21 weight (70.73); the session cookie was not `Secure`; `/api/auth/login` 404; the inherited API and metrics ports were not listening; `http://127.0.0.1:5373/api/health/ready` reached the isolated API |
| `npm run portfolio:dataset:api` and `:web` from a poisoned `cmd` shell (by hand) | real processes; decoys on port 9 (nothing listens) | both ready; listeners only on 127.0.0.1:3300 and 127.0.0.1:5373, nothing on the inherited port 3999; the API printed the verified targets; both stopped with their process trees |
| `npm run test:e2e:portfolio-dataset` | browser, through the launcher | 1 passed (twice on the repaired code) |

### Defect 2: changed run data was accepted as a complete dataset

**Defect.** `classifySnapshot()` checked only the requested start, the finish time and whether a summary was current.
A stored snapshot copied and changed in memory (summary distance `999999`, display geometry `null`, run start
`2001-01-01`, finish-command payload `{}`) was classified `{ reasons: [], state: 'complete' }`, and the CLI then
recorded the drifted digest as its new manifest.

**Fix.** In the core writer: `validateRun` requires each stored run to be a state the plan's lifecycle can produce
(requested and effective start; per-batch upload with each point equal to the planned point and the data revision equal
to the uploaded batches; the planned finish instant, control and data revisions, and the finish command's exact
canonical payload and response; a summary current for the data revision, of the current algorithm, with valid quality
statistics, a display geometry, the planned duration and a distance within 2 % of the planned polyline). Raw retention
stays compatible: `purging` (a subset of the planned points) and `purged` (none) are accepted only with a current
summary; the digest still excludes raw points and `raw_state`. A complete dataset is also compared with the digest
recorded at its completion (`seed-state.json`, else the manifest) before anything is written or replaced, and a
resumed seed must end on it. The CLI writes the completion state and the manifest only after the writer accepted the
dataset; on a refusal it writes nothing. Nothing was excluded from the digest, and the digested snapshot is unchanged
(the default dataset's digest is the same).

| Evidence | Kind | Result |
|---|---|---|
| `dataset-writer.spec.ts` (23 new cases) | unit, synthetic stored state | accepted: a finished summarised run, partial uploads of 0, 1 and all batches, a finish without its summary yet, `purging` with a subset, `purged`; refused: the four reproduced changes, a replaced response, another requested start, wrong revisions, a stale summary, another algorithm, invalid quality statistics, another duration, a missing command, missing points with raw history available, purged without a summary, a moved point while purging; partial runs with a gap, half a batch, a foreign point, a revision behind the uploads, a command while recording, a pause, purged raw history |
| `prepare-cli.spec.ts` (4 tests) | unit, temporary files | the recorded digest is found for the same parameters only and passed to the writer; a drift refusal leaves `seed-state.json` and `manifest.json` identical in content and modification time; an interruption records `interrupted` without touching the manifest; artifacts are replaced only after acceptance |
| `seed.dataset.test.ts` (5 new tests) | real PostgreSQL, throwaway databases in the dataset server | the four reproduced in-memory changes of an actual stored snapshot are no longer complete; a stored summary set to 999999 m is refused before any write (digest unchanged); then a 0.5 m change passes the run checks but is refused by the recorded digest (digest unchanged); the real raw purge (`runRawPurgeOnce` at the current time) purges all 6 runs, and a rerun is complete with 0 writes and the same digest; a partial run holding foreign points, or the second batch without the first (both uploaded through `ingestRunPoints` as the runner), is refused with no further write (digest and points unchanged). Existing positives kept: unchanged rerun (0 writes, same digest, `baseline: matched`), interrupted seeds resuming, digest agreement across independently prepared databases |
| `npm run portfolio:dataset -- --seed somalane-portfolio-v1 --anchor 2026-11-21` on the preserved demo | real | `existing data: complete`, `recorded digest: matched`, 0 writes, digest `sha256:b622…857d`; `manifest.json` byte-identical; `seed-state.json` differs only in `updatedAt` |

### Fresh verification of the repaired code

| Command | Result |
|---|---|
| Independent identity check (`docker exec` in the dataset container) before the database-writing tests | `cluster_name` `somalane-portfolio-dataset`; databases `postgres`, `somalane_portfolio_demo` and templates only |
| `npx vitest run --config vitest.config.ts src/portfolio-dataset` (apps/api) | 6 files, 112 tests passed |
| `npm run test:portfolio-dataset` | 2 files, 25 tests passed (21 dataset, 4 poisoned startup), 99 s; afterwards only `postgres`, `somalane_portfolio_demo` and templates remain; ports 3300/5373 free |
| `npm run test:e2e:portfolio-dataset` | 1 passed |
| `npm run verify` | exit 0: scripts 115, API 2,803 (171 files), web 1,418, contracts 325, fixtures 14, simulator 3, build |
| `.env` | SHA-256 and modification time unchanged |
| `git diff --check`; new files with `git diff --no-index --check` | clean |

## Remaining P2 finding: the recorded completion baseline (2026-11-22, same day)

The results in the sections above are historical: they ran on the code before this fix. Everything in this section was
run fresh on the fixed code.

**Defect.** The recorded completion digest (`expectedDigest`, read by `seedAndRecord` from `seed-state.json`, else
`manifest.json`) was compared before writing only when the stored dataset classified as `complete`. Reproduced in an
isolated throwaway database: seed a complete dataset and keep its digest; raise one run summary's distance by 0.5 m
(within the run checks' 2 % tolerance) and delete one planned meal; rerun `seedPortfolioDataset` with that digest. The
dataset classified `partial`, the pre-write digest guard was skipped, the writer performed 254 operations and recreated
the meal (120 → 121), and only the final digest check refused the result, with a message saying nothing was written.
The same gap let a recorded completion that had lost only a meal be silently re-completed, and an empty target with a
recorded completion be seeded as a first seed.

Red run of the new regression tests on the unfixed writer (`-t "recorded completion baseline"`, 5 tests): 3 failed as
the defect predicts. The drift-plus-deleted-meal case reached the write hook (meal and run operations listed) before
being refused; the deleted-meal-only and empty-target cases were accepted. The unchanged-completion and
interrupted-first-seed cases passed.

**Fix** (`apps/api/src/portfolio-dataset/dataset-writer.ts`, no other behaviour). The pre-write check is now
`baselineRefusal(state, digest, expectedDigest)`, applied right after classification and before provisioning or any
service write:

| Recorded completion | Stored state | Outcome |
|---|---|---|
| none | empty / partial / complete | seeded / resumed (an interrupted first seed) / accepted, as before |
| present | complete, same digest | accepted, 0 writes (a legitimate raw purge stays here: complete, same digest) |
| present | complete, another digest | refused before any write (unchanged message) |
| present | partial or empty | refused before any write: "a completion was recorded for these parameters (…), but the dataset database is now partial/empty …" |

`DatasetConflictError` now carries `writes`, the seed write operations this attempt had performed when it was refused,
and its message follows it: 0 → "this attempt wrote nothing and overwrote nothing"; more (the final check of a finished
seed, now reachable only without a recorded completion) → the count, and that what was committed stays committed and
nothing was rolled back. `seedAndRecord` (`prepare-cli.ts`) repeats this ("This attempt wrote nothing to the database,
and no manifest or state file was replaced." only for 0), labels the state line as what is recorded on this computer
(not what the database holds), and points to "Starting over". It still replaces no artifact on any refusal. No outer
transaction, rollback, reset or new storage was added; the launcher, dataset contents, digest normalisation,
configuration, schema, migrations and contracts are unchanged.

| Evidence (fresh) | Kind | Result |
|---|---|---|
| `dataset-writer.spec.ts` (6 new tests) | unit | without a baseline every state passes the guard; with one, only complete with the same digest; partial and empty refused for any digest with the new reason; the error says "wrote nothing" only for 0 writes and, for 254, the count and "nothing was rolled back" and never "wrote nothing" |
| `prepare-cli.spec.ts` (1 new, 1 updated) | unit, temporary files | a refusal with 0 writes says "This attempt wrote nothing to the database…"; a refusal with 254 writes says they stay in the database, never that nothing was written; both leave `seed-state.json` and `manifest.json` identical in content and modification time |
| `seed.dataset.test.ts` (5 new tests) | real PostgreSQL, throwaway databases in the dataset server | each case completes a database through `seedAndRecord` (real artifacts in a temporary `.local/portfolio-dataset/`). Refused through the core writer with the recorded digest **and** through `seedAndRecord`: the exact reproduction (+0.5 m summary distance and a deleted meal, classified `partial`), a deleted meal alone, and an empty database with the record kept. For each refusal: `DatasetConflictError` with `writes` 0 and the reason above; the injected `afterWrite` hook never reached; the meal count unchanged (`plan − 1`, or 0 users for the empty target); a fingerprint of every owner table (row count, the MD5 of every full row, of every row version `xmin`, and of every timestamp column) identical before and after; `seed-state.json` and `manifest.json` byte-identical with the same modification time; the CLI message says the attempt wrote nothing and never claims a rollback. Accepted: an unchanged recorded completion (0 writes, `baseline: matched`, same digest, no hook reached, no row version changed); a genuine interrupted first seed (failure after write 120, `seed-state.json` `interrupted`, no manifest) resumed to `complete` with `baseline: not recorded` and the same digest. The existing raw-purge test still passes (complete, same digest, 0 writes) |

### Fresh verification of the baseline fix

| Command | Result |
|---|---|
| Identity check before the database-writing tests (`docker exec` in `somalane-portfolio-dataset-postgres-1`, published only on `127.0.0.1:5442`) | `cluster_name` `somalane-portfolio-dataset`, system identifier `7710906452649996329`; databases `postgres`, `somalane_portfolio_demo` and templates only; the development container `running-tracker-postgres-1` on 5433 was not addressed. The suite's own helpers verify database, `current_user = session_user` and system identifier on every connection |
| `npx vitest run --config vitest.config.ts src/portfolio-dataset` (apps/api) | 6 files, 119 tests passed |
| `npm run test:portfolio-dataset` | 2 files, 30 tests passed (26 dataset, 4 poisoned startup), 92 s; afterwards only `postgres`, `somalane_portfolio_demo` and templates remain |
| `npm run verify` | first attempt exit 2: one typecheck error in the new test helper (`exactOptionalPropertyTypes`, an optional `hooks` passed as `undefined`), fixed in the test only; second attempt exit 0: scripts 115, API 2,810 (171 files), web 1,418, contracts 325, fixtures 14, simulator 3, build. `npm run test:portfolio-dataset` was then rerun on the final test file: 30 passed again (97 s), identity checked again first |
| `git diff --check`; every untracked file with `git diff --no-index --check` | clean |
| Preserved demo dataset after all checks | 121 meals, 6 runs, raw history `available`; `seed-state.json` and `manifest.json` SHA-256 and modification times unchanged (`10:15:40`); `.env` hash and time unchanged |
| Generated files | `npm run test:portfolio-dataset` and `npm run verify` rebuild the contracts, which rewrote `packages/contracts/openapi/openapi.json` with line-ending changes only (`git diff` empty); restored with `git checkout`, as it was clean before |

The browser walkthrough (`npm run test:e2e:portfolio-dataset`) was not rerun: the change does not touch the launcher, the
served data or any screen.

## Limits

- Synthetic loops, synthetic GPX/TCX files and desktop Chromium say nothing about real GPS accuracy, real device exports,
  Safari or a phone. Every AI provider was off; nothing here concerns AI quality.
- The digest is stable on one PostgreSQL/PostGIS build (summary floating-point digits).
- The API's raw purge (raw points of runs finished more than 7 days ago) is expected once the API has run for a minute;
  it was not observed in the 10–12 s browser sessions. By design the digest excludes raw points and `raw_state`.
- The real-PostgreSQL suite and the walkthrough need Docker and the dataset environment and are not in CI.
- One transient `ETIMEDOUT` to the published port was seen (above); not seen again in the repair runs.
- The recorded-digest comparison needs the local record (`seed-state.json` or `manifest.json`); without it a complete
  dataset is checked by the run and record rules only, and the command says so. Without the record, a partial dataset
  is likewise treated as an interrupted first seed and resumed: nothing else distinguishes the two.
- An infrastructure failure (for example a lost connection) while a completion is recorded is still handled as an
  interruption: `seed-state.json` is rewritten as `interrupted` (the manifest keeps the digest, so the baseline still
  applies on the next run) and the message calls the dataset incomplete, although with a recorded completion the writer
  performs no writes. Refusals (`DatasetConflictError`) do not take this path.
- The raw-purge path was exercised on a throwaway database; it had not yet fired on the demo dataset during the short
  API sessions (all 6 runs still `available`).
- The launcher keeps a fixed list of operating-system variables; a platform that needs another one to run Node or Vite
  would have to be added to that list.
