# Initial-bundle reduction — verification report (release step 4, ADR-0098)

- Date: 2026-11-22. Workstation: Windows 11, Node 24.11.1, Vite 8.3.0, Docker Desktop, PostgreSQL 17.5 (PostGIS image),
  Chromium and Firefox (Playwright 1.63.0).
- Baseline: commit `a3bf4e2` (clean HEAD when the step began). Candidate: commit **`dff831a`**
  (`dff831a50d93982f17094b1a51659275ebc717be`). When the local checks below ran it was the uncommitted working tree,
  identified by git tree ids; the ids match that commit (checked 2026-11-23, [candidate identity](#candidate-identity)).
- Scope: [ADR-0098](../adr/0098-initial-bundle-reduction.md). Fresh checks, run in this change, on the Windows
  workstation; development-server coverage and production-build evidence are reported separately. Hosted CI evidence was
  added afterwards, in its own section.
- Step status: **done (2026-11-23).** No local full Chromium/OIDC run was free of failures (two runs below, one more in
  the [independent review](#independent-review-recorded-2026-11-22)); the gate was closed by a successful hosted CI run
  for a commit containing the candidate unchanged ([hosted CI evidence](#hosted-ci-evidence-recorded-2026-11-23)). See
  the [completion gate](#completion-gate).

## Measurement

One command, the same settings for both builds:

```text
npm run measure:web-bundle -- --ref a3bf4e2      # baseline (apps/web of that commit)
npm run measure:web-bundle                       # candidate (the working tree)
```

Settings (both): `vite build` of `apps/web` through `apps/web/vite.config.ts`, Vite 8.3.0, mode `production`,
`build.manifest`, an empty env directory with every `VITE_*` variable removed (no Mapbox token, no demo flag), gzip by
zlib at level 6. **Initial** = the HTML entry chunk, the closure of its static imports and their CSS, checked against
the built `index.html`. **Deferred** = chunks reached only by a dynamic import, reported separately and not counted as
initial.

| | Baseline `a3bf4e2` | Candidate | Change |
|---|---|---|---|
| Initial JS, raw | 799,724 B | 625,755 B | −173,969 B (−21.8 %) |
| Initial JS, gzip | 220,581 B | 175,156 B | −45,425 B (−20.6 %) |
| Initial CSS, raw | 91,478 B | 43,020 B | −48,458 B (−53.0 %) |
| Initial CSS, gzip | 13,681 B | 8,276 B | −5,405 B (−39.5 %) |
| Initial JS + CSS, gzip | 234,262 B | 183,432 B | −50,830 B (−21.7 %) |
| Initial files | `index-BilXPEX0.js`, `index-Xkp15NwL.css` | `index-D0ESd0tD.js`, `index-BgEf5SdT.css` | |
| `modulepreload` links in `index.html` | none | none | |

Deferred, candidate (fetched only when used):

| Chunk | Raw | Gzip | When it is fetched |
|---|---|---|---|
| `secondary-views-CrbWzmXD.js` (Coach, Archive, Activity, Check-in, Meal log, Runner's result) | 179,628 B | 46,896 B | the first time one of those views opens |
| `mapbox-gl-DsZBW-Fw.css` (URL asset of that chunk) | 48,829 B | 5,781 B | with the Mapbox runtime, when a map is created |
| `mapbox-gl-DduiJ_dh.js` | 1,839,378 B | 505,724 B | when a map is created (already deferred at the baseline: 1,839,375 B) |

Opening one secondary view therefore costs 46,896 B gzip once; opening a map adds the Mapbox runtime and stylesheet as
before. The saving is not a target that was set in advance; it is what this boundary measures.

Reproducibility: measuring the clean working tree at `a3bf4e2` and `--ref a3bf4e2` gave byte-identical output names and
sizes (`index-BilXPEX0.js`, 799,724 B). The browser check's build (below) produced the same candidate file names and
sizes as the candidate measurement. Vite's "chunks larger than 500 kB" warning appears for both builds (the initial chunk
is still 611 KiB) and was not suppressed.

Candidate identity (git object ids of the uncommitted working tree, through a temporary index; check a later commit
with `git rev-parse <commit>:<path>`):

| Path | Candidate | At `a3bf4e2` |
|---|---|---|
| `apps/web` (the measured source) | `c35605e4d1be84c2e5312f22deb62495ff50e280` | `73c482a8c04565ca7853770be735e08bd0a643bb` |
| `packages`, `package-lock.json`, `tsconfig.base.json` (the other build inputs) | unchanged: `ec8553d8…`, `78088919…`, `f654947f…` | the same |
| `scripts/measure-web-bundle.mjs`, `scripts/web-bundle.mjs` (the measuring tool) | `a8479778365ed6bf41700482c6a01e535cf6c6d3`, `a6f127656c21964c3e75a7b1bb368d1380c9d2fe` | (new) |

**Candidate commit: pending** (the changes are uncommitted). The whole-tree id is not quoted because this report is part
of the tree.

### Candidate identity

Added 2026-11-23: the candidate was committed as **`dff831a`**. `git rev-parse dff831a:apps/web` is
`c35605e4d1be84c2e5312f22deb62495ff50e280`, and `dff831a:scripts/measure-web-bundle.mjs` and
`dff831a:scripts/web-bundle.mjs` are `a8479778…` and `a6f12765…`: the ids in the table above. The next commit,
`1dac6ed`, changes only documentation (`git diff --stat dff831a 1dac6ed`: README, ADR-0098, the release plan, progress,
reference and this report), so its `apps/web` tree is the same. A fresh `npm run measure:web-bundle` of the clean tree at
`1dac6ed` on 2026-11-23 reproduced the candidate's measurement exactly (`index-D0ESd0tD.js` 625,755 B raw, 175,156 B gzip;
`index-BgEf5SdT.css` 43,020 B raw, 8,276 B gzip).

## Why one deferred chunk: the retry probe

Playwright's Chromium and Firefox, a page importing `/screen.js` (which statically imports `/dep.js`); the first fetch of
the failing module is aborted, later fetches are served.

| Case | Chromium | Firefox |
|---|---|---|
| Top-level module failed; `import()` of the same URL again | rejects, **no request** | fetches again, loads |
| Its static dependency failed; same URL again | rejects, no request | fetches the dependency again, loads |
| Dependency failed; `import('/screen.js?retry=1')` | rejects (the dependency stays failed) | loads |
| The dependency failed as a `modulepreload` first | rejects, no request | loads |

So in Chromium a retry can only succeed through a new URL whose static imports have all loaded: one chunk whose only
static imports are the initial chunk (ADR-0098, Decision 2). The built dynamic import has an empty preload list
(`re(()=>import("./secondary-views-CrbWzmXD.js"),[])`).

## Unit and static checks

| Check | Result |
|---|---|
| New `deferred-module.spec.ts` | one attempt at a time and the value kept; a first failure rejected as is; retry by importing again (Firefox behaviour); retry through `?retry=1`, `?retry=2` when the import keeps failing (Chromium behaviour); never another origin, an error without a URL (Safari's message) or a module without the six exports; a closed view reports nothing and the code is kept; a scope that replaced the view is served by the same single import |
| New `DeferredView.spec.tsx` | loading markup (`aria-busy`, polite status), failure alert and Try again, Back to Runner in both states, the view once loaded, no import while rendering, the real `secondary-views.ts` exports exactly the six views |
| New `initial-bundle-boundary.spec.ts` | the static graph from `main.tsx` keeps Today, the Weekly review, Trends, Runner, the Run status and the run machinery, and reaches no secondary view, `secondary-views.ts`, map code or `mapbox-gl`. Mutation: a static `CoachScreen` import added to `TodayScreen.tsx` made it fail; reverted |
| New `mapbox-runtime.spec.ts` | one stylesheet link per page, resolved on load; a failed link removed and fetched again next time |
| New `scripts/web-bundle.test.mjs` | initial closure with CSS, deferred groups without initial files, HTML parsing, HTML/manifest disagreements refused, sums, malformed manifests refused |
| `scripts/lan-pilot.test.mjs` | its pinned `testIgnore` pattern of the main Chromium project now also names `production-build` |
| Focused web unit run (the four new specs and `create-mapbox-map.spec.ts`) | 28 passed (5 files) |
| `npm run verify` | exit 0: lint, typecheck, scripts 122, API 2,810, web 1,462 (119 files), contracts 325, fixtures 14, simulator 3, build. Run on the final code (only documentation changed afterwards). Its contracts build rewrote `packages/contracts/openapi/openapi.json` with line endings only (empty content diff); restored |
| E2E typecheck (`tsc -p tests/e2e`) | exit 0 |
| `git diff --check`, and `git diff --no-index --check` for each of the 15 new files | clean |

## Test data isolation (read-only, before the write-based browser runs)

| Check | Result |
|---|---|
| Fixture suite targets | `running_tracker_test` on `127.0.0.1:5433` (container `running-tracker-postgres-1`) as `running_tracker_runtime`, `_maintenance` and `_owner` (current_user = session_user); system identifier `7687193163643084838` |
| Portfolio dataset server | `somalane_portfolio_demo` on `127.0.0.1:5442` (container `somalane-portfolio-dataset-postgres-1`), system identifier `7710906452649996329`: another cluster |
| Portfolio dataset before | canonical digest (`portfolio-dataset-digest-v1`, owner role, one REPEATABLE READ READ ONLY transaction) `sha256:b6222c85…857d`, equal to `manifest.json`'s; `manifest.json` `6d6afc51…5a0f`, `seed-state.json` `0554f917…f5ce` |

## Production-build browser evidence (`npm run test:e2e:production-build`)

The npm script builds with the measurement script (the output above, same file names) **before** Playwright starts;
`vite preview` serves that build with `/api` proxied to a development-session API on its own port (every AI provider
off). Fixture-based (`running_tracker_test`).

1. **Cold load and the journey.** Signed in, a fresh page opens Today; Today, the Weekly review, Trends and Runner fetch
   exactly the initial files (`index-*.js`, `index-*.css`) and no deferred chunk. Opening Check-in fetches
   `secondary-views-*.js` once; Meal log, Activity, Coach, Archive and Runner again fetch nothing more. No Mapbox file is
   requested (this build has no token, so no map is created).
2. **Loading, failure and Try again** (Chromium and Firefox). Today's "Add a meal" on a chosen date opens the Meal log
   while the chunk is held: `aria-busy` and "Opening the meal log…", the nine navigation buttons present. The fetch is
   aborted: an alert in the view's area, no navigation or reload. Try again while still failing sends a new request
   (Chromium: `?retry=N`; Firefox: the same URL again). Network back, Try again: the Meal log opens **on the date Today
   chose** (the editor intent survived). Today still has its date; Check-in then opens with no further request.
3. **Leaving and scope changes during the import.** Activity opened and left for Today before its chunk arrives: when it
   arrives Today stays, with its date, and Activity is not shown; the next Activity opening is immediate with no new
   request. After a reload (chunk not loaded), Check-in is opened in organization A, B is chosen while the chunk is held;
   when it arrives the Check-in screen's requests name organization B only.
4. **Recording with the chunk unavailable.** Every request for the chunk aborted. A simulator run started on Runner;
   Coach fails to open, the Run status names the run, all six points reach the server (gap-free) while the failed view
   is shown. A reload opens Today and restores the same run: the Run status names it, the durable active run is the same,
   the writer lease is live (not released, unexpired), still one run. Go to Runner: same run id, writer `owned`; Finish,
   empty buffer, server status `finished`. The chunk was requested and never served.

Mutation: with Try again reduced to calling `import()` again, test 2 failed in Chromium (`Expected: > 1, Received: 1`
chunk requests: no new fetch) and passed in Firefox. Reverted.

| Run | Result |
|---|---|
| First run | 5 passed (4 `production-chromium`, 1 `production-firefox`) in 31.2 s |
| Final code (after the mutation was reverted; `apps/web` tree `c35605e4…`, the same build file names) | **5 passed** in 29.8 s |

## Development-server browser evidence

| Run | Result |
|---|---|
| Full `npm run test:e2e` (Chromium + OIDC, Vite dev servers), run 1 | 190 passed, 2 failed (18.2 min): `authority-reconciliation.spec.ts:123` (after Finish the Recording card read `error`, not `finished`; a Runner lifecycle path this change does not touch) and `run-sharing.spec.ts:19` (after `page.goto` the navigation never rendered; the test timed out waiting for the Coach button). Their traces were cleared by the rerun, so the cause was not established |
| Those two, rerun alone | 2 passed |
| Full `npm run test:e2e`, run 2 (final code) | 190 passed, 2 failed (17.0 min): `ask-my-data.spec.ts:141` and `trends-nutrition.spec.ts:77`. Both traces show `net::ERR_ADDRESS_IN_USE` on API requests through the demo dev server's proxy (`/api/session`; `/api/organizations` after the re-sign-in, so App showed "Your organizations could not be loaded" instead of any view): the Windows socket exhaustion also seen in step 3, not chunk loading |
| Those two, rerun alone | 2 passed |

Every test passed in at least one of the two full runs, and each of the four failures passed when rerun; no full run
was free of failures. The harness's deliberately failing test is counted as designed in each run.
| Firefox core gate `npm run test:e2e:firefox` | **18 passed** (3.5 min): record, reload-offline, second-tab, gps-recovery, run-sharing, archive-sharing, coach-map (the map specs open Coach and Archive through the deferred chunk and create maps with the fake runtime, so the Mapbox stylesheet now loads with it) |

These run on Vite development servers, where each module is served separately: they show that the views, intents,
maps and run lifecycle behave as before with the deferred import, not how the production bundle is split.

## Portfolio-dataset evidence (read-only, `npm run test:e2e:portfolio-dataset`, verified launcher, development server)

| Check | Result |
|---|---|
| Walkthrough | **2 passed** (19.4 s): the populated screens, and the journey Today → Weekly review → Trends → records |
| Dataset after the run | canonical digest `sha256:b6222c85…857d`, unchanged; `manifest.json` and `seed-state.json` hashes unchanged |
| Screenshots | the walkthrough overwrites its seven screenshots; all seven restored byte-identical (SHA-256 compared) |

## Not covered, and limits

- No hosted CI; `npm run test:e2e:production-build` is not part of CI or `npm run test:e2e`.
- No Safari/WebKit: Safari's import error names no URL, so Try again there relies on the browser fetching the module
  again (not verified).
- A deploy that replaces the chunk names makes Try again fail until the person reloads the page; nothing reloads
  automatically.
- The measured and browser-checked build has no Mapbox token, so the stylesheet-with-runtime path is not exercised against
  the production build; it is covered by `mapbox-runtime.spec.ts` and the development-server map specs (fake and real
  runtime) in the full suite.
- `npm run test:e2e:smoke` and `npm run test:integration` were not run: no API or database code changed.

## Independent review (recorded 2026-11-22)

Recorded separately from the author's checks above, which are left as they were reported.

| Check | Result |
|---|---|
| `npm run verify` | passed |
| E2E typecheck (`tsc -p tests/e2e`) | passed |
| `npm run test:e2e:production-build` | **5/5** passed |
| `npm run test:e2e:firefox` (Firefox core) | **18/18** passed |
| `npm run test:e2e:portfolio-dataset` (walkthrough) | **2/2** passed; dataset unchanged |
| Full `npm run test:e2e` (Chromium + OIDC) | 190 passed, **2 failed during startup** with `net::ERR_NETWORK_CHANGED` and `net::ERR_ADDRESS_IN_USE` |
| The two affected cases, rerun | each passed twice |

No functional code defect was identified.

## Completion gate

Step 4's acceptance requires the full Chromium suite and the Firefox core gate to pass. The Firefox core gate has
passed. The full Chromium/OIDC suite has run three times (two runs above, one in the independent review), and each run had
two failures, which passed when rerun alone. **Step 4 is complete only after a successful full Chromium/OIDC run, or a CI
run, for the candidate.** Rerunning individual cases does not close this gate. The acceptance criteria are unchanged.

**Closed on 2026-11-23** by the hosted CI run below for `1dac6ed`, which contains the candidate `dff831a` unchanged. The
local results above stay as recorded: none of the three local full runs was free of failures, and the individual reruns
did not close the gate.

## Hosted CI evidence (recorded 2026-11-23)

Recorded separately from the local evidence above. Checked at its source with
`gh run view 45055752618 --json headSha,conclusion,status,event,headBranch,workflowName,jobs` on 2026-11-23.

| Field | Value |
|---|---|
| Run | [45055752618](https://github.com/AlexTikhon/SomaLane/actions/runs/45055752618), workflow `CI`, event `push`, branch `main` |
| Commit | `1dac6edae7b2377e565f1460655b89063f34e107` (contains the candidate `dff831a`; the difference is documentation only) |
| Conclusion | `success` (status `completed`; 2026-11-22 18:33:23Z to 18:47:48Z) |
| `verify` | success |
| `integration` | success |
| `e2e (chromium 1/3)`, `e2e (chromium 2/3)`, `e2e (chromium 3/3)` | success, success, success (the full Chromium/OIDC suite, sharded) |
| `e2e (firefox-core)` | success |
| `e2e-report` | skipped (it runs only when a browser job failed) |

This is hosted CI evidence for that commit on GitHub's Linux runners. It does not change or explain the local Windows
failures above (`ERR_ADDRESS_IN_USE`, `ERR_NETWORK_CHANGED` and two whose traces were cleared), which remain local
observations. `npm run test:e2e:production-build` is not part of CI.
