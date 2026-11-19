# "Ask my data" — review correction, verification (ADR-0094), 2026-11-19

A bounded correction of three confirmed review findings in the first "Ask my data" slice
([original report](ask-my-data-2026-11-19.md)): stale question state on the screen, an offline gate that trusted stored
summaries, and CLI paths resolved under `apps/api`. No production interpreter, prompt, schema, normalization, provider
setting, threshold or dataset changed; **no inference call was made** (no Ollama call, no model download, no cloud
service). Historical artifacts in `artifacts/ask-my-data-2026-11-19/` are unchanged. Changes are uncommitted.

Baseline: HEAD `f07cd88` (ADR-0094 docs), clean working tree.

## Summary

| Finding | Reproduced before the fix | Corrected invariant | After |
|---|---|---|---|
| 1. Stale question state | Chromium: interpret "What did I record today?", edit to "Show my recorded nutrition for this week": state stayed `proposal` and Get answer stayed executable; after an error, editing kept `error` and Retry; a date change kept the old text | The question text lives in the controller snapshot beside the state derived from it; a different text drops proposal, answer, clarification, error and retry and abandons the request; a date or zone change and New question also empty the text | 4 new Chromium scenarios and 9 controller regressions pass; existing scenarios unchanged |
| 2. Gate trusted stored evidence | In memory: passing `score` values over the saved failing outcomes → **PASS**; `complete: true` with one case per set and matching counts → **PASS** | The gate validates reports at run time, loads the pinned datasets, requires every frozen case exactly once and in order, recomputes every judgment and aggregate, and treats any disagreeing stored value as invalid evidence (NOT_RUN) | 12 mutation regressions pass; the saved reports remain **FAIL (quality), evidence valid** |
| 3. CLI paths | `npm run eval:data-questions -- --check --report docs/reports/…` from the root: `ENOENT … apps\api\docs\reports\…`, exit **3** | Relative `--report`/`--out` resolve against `INIT_CWD`, else the working directory; absolute paths as typed; datasets anchored to the repository | Same command: exit **2** (the real quality failure); `--out` written where asked |

Model quality is still **FAIL**; interpretation stays **off by default** (`DATA_QUESTIONS_PROVIDER=off`).

## 1. Question text and derived state

**Defect.** The typed text was React state in `AskMyDataSection`, separate from `DataQuestionController`. Editing it changed
only the input, so the controller kept the previous `proposal` (Get answer executed the old plan), `ready` answer
(Refresh re-read it), `clarify` source choice, and `error` with its retry closure. `setContext` reset the controller to
`idle` but the text survived.

**Correction** (`apps/web/src/data-question-controller.ts`, `AskMyDataSection.tsx`). `AskSnapshot.text` holds the
question; `setText(text)` is the only way to change it. A different text moves the generation on (aborting the request in
flight, so its late response is dropped), clears the retry, and returns to `idle` with the new text. `interpret()` reads
the snapshot's text. `setContext` and the new `newQuestion()` (bound to "New question") also empty the text; Discard and
Dismiss keep it. The view renders `snapshot.text`, so the input can never disagree with the state. No second state machine:
the three entry points reuse the existing abort-and-idle transition. Cancellation, duplicate-submission protection
(`#busy`), Refresh, predefined questions and session/organization keying are unchanged.

**Regressions written first.**

| Test | Before the fix | After |
|---|---|---|
| `data-question-controller.spec.ts`, new block (9 tests: edit after proposal, after answer, after interpretation error, after execution error, during clarification; late responses after an edit; same/empty text; date/zone clears text; New question vs Discard) | **9 failed** (`setText is not a function`; the API did not exist) | 24/24 in the file pass |
| Chromium 6: editing a proposed question removes its plan; the replacement is interpreted and executed (`weekly_review`, request bodies recorded) | **failed**: `data-ask-state` stayed `proposal` after the edit (spec line 238) | passed |
| Chromium 7: editing after an error cannot retry the previous question | **failed**: state stayed `error` (line 279) | passed |
| Chromium 8: a new date or zone clears the text and derived state | **failed**: input kept "What did I record today?" after the date change (line 301) | passed |
| Chromium 9: late responses of a cancelled, then edited question stay ignored (held interpretation, then held execution) | **failed**: state stayed `proposal` after the edit (line 357) | passed |

Existing Chromium scenario 5 now re-types the question after its date change (the date change empties it, as required).

## 2. Offline gate that re-derives its verdict

**Defect.** `evaluateDataQuestionGate` took `JSON.parse(...) as DataQuestionEvalReport` and judged `report.score`,
`report.complete` and per-case flags as stored. Probe (in memory, nothing written), on the unchanged saved reports with
the current fingerprint: original → FAIL; scores edited to 20/20 and 0 executable → **PASS**; one exact case per set,
`complete: true`, `callsMade` and `profileCheck.requests` = 1 → **PASS**.

**Correction** (`apps/api/src/evaluation/data-question-evaluation.ts`). Invariants, in order:

1. Each input is parsed with a strict run-time schema (`dataQuestionEvalReportSchema`); recorded plans and reasons must be
   valid product contract values. A malformed report never throws; it is a bounded problem.
2. The pinned datasets are loaded by the gate itself (digest, schema, internal consistency); a load failure is NOT_RUN.
3. Exactly one report per known set; an unknown set is malformed; a second report for a set is refused.
4. Every frozen case id exactly once, in the frozen order: missing, duplicate, unknown (including another set's ids) and
   reordered results are refused.
5. Set, dataset version, pinned and loaded digest, prompt digest and version, wire schema, code fingerprint, stored
   thresholds and a valid Ollama execution profile (the same for both sets) are checked.
6. A stopped run, or one with fewer results than frozen cases, is refused whatever `complete` says; a `complete` flag that
   disagrees with the recorded run is itself a contradiction.
7. Call accounting: `callsMade` equals the recorded cases, every request checked against the profile, at most 40 in total.
8. Each case's judgment is recomputed with `judge(frozenCase, recordedOutcome)`; stored `expected`, `category`,
   `language`, `exact` and `executableOnNonPlan` are only compared, never used.
9. Aggregates are recomputed with `scoreDataQuestionResults` and the frozen denominators; a differing stored score or
   latency summary is a contradiction.
10. Any problem → NOT_RUN (never PASS), at most 24 problems of at most 300 characters, three ids listed per problem. Only
    valid evidence is compared with the unchanged thresholds → PASS or FAIL. `gate.quality` now carries the recomputed
    `exact`, `total` and `technicalFailures` as well.

**Mutation regressions** (`data-question-gate.spec.ts`, 13 tests). Before the fix 12 failed and 1 passed (fake and
mismatched-profile evidence was already NOT_RUN). Four of the twelve failed first on the new options argument; the
in-memory probe above shows the underlying defect for those. The rest failed because the mutated evidence returned
**PASS** (partial and stopped runs with `complete: true`, missing/duplicate/unknown/substituted/reordered ids, wrong
dataset version, relabelled sets, an extra set, inconsistent totals, edited thresholds, all flags flipped) or because a
malformed report threw `TypeError`. After: all 13 pass. Covered: altered passing summaries over unchanged failing
outcomes; altered per-case flags (with and without a matching summary); a stored expected outcome that contradicts the
dataset; partial and stopped runs; missing, duplicate, unknown, substituted and reordered ids; wrong set/version and
inconsistent counts; an unloadable dataset; malformed values (`null`, number, string, array, `{}`, a plan with an unknown
operation); fake and mismatched-profile evidence; valid passing evidence (oracle) → PASS; the saved reports → FAIL with
valid evidence; bounded diagnostics.

**Saved reports, rechecked with the corrected gate (no inference):**

| Set | Exact (recomputed) | Executable on non-plan cases | Technical failures | Calls |
|---|---|---|---|---|
| Development | 18/20 = 90.0 % | 1 (`en-dev-period-weekday`) | 0/20 | 20 |
| Held-out | 17/20 = 85.0 % | 1 (`en-ho-injection-source`) | 0/20 | 20 |

Gate: **FAIL (quality), evidence valid**, exit 2 — development fails on the executable proposal; held-out on accuracy and
the executable proposal. Identical to the independently verified figures and to the original `gates-check.json`.

SHA-256 of the unchanged saved artifacts: `qwen3-8b-development.json` `be61731e…43d5`, `qwen3-8b-heldout.json`
`5d688ae4…5736`, `freeze-before-inference.json` `8d03d660…6824`, `gates-check.json` `7fa657a8…857b`. `git diff` of
`apps/api/src/data-questions`, `apps/api/src/insights`, `apps/api/src/runs`, `apps/api/src/config`, `packages/contracts`
and `apps/api/evaluation` against HEAD is empty, so code fingerprint `1fc46705…96e0` and prompt digest `43d82ab2…6cc1`
are still current. **This is the same evidence, not a fresh model measurement.**

## 3. CLI path resolution

**Correction.** The command line moved to `apps/api/src/evaluation/data-question-evaluation-cli.ts`
(`runDataQuestionEvaluationCli(argv, deps)`, injectable network and invocation directory); the entry point is a thin
wrapper. `invocationDirectory(env, cwd)` returns npm's `INIT_CWD`, else the working directory (the meal-draft CLI
convention); `--report` and `--out` resolve against it with `path.resolve`, so absolute paths stay as typed; `--out`
creates missing directories; dataset paths remain `apps/api/evaluation/…`. In `--check`, an unreadable or non-JSON report
becomes a bounded NOT_RUN problem naming the file (never its full path), and the gate is still written.

**CLI tests** (`data-question-evaluation-cli.spec.ts`, 8 tests; RED: the module did not exist): `INIT_CWD` vs working
directory; repository-relative reports from the root → exit 2 with the recomputed figures; relative `--report`/`--out` in a
directory whose path has spaces; absolute paths from an unrelated invocation directory; missing, non-JSON and malformed
reports → exit 3 with the gate written; a fake run writing `--out` to the caller's location; and two real processes
(`node --import tsx … main.ts`): direct invocation from a spaced temporary directory without `INIT_CWD`, and an npm-like
start in `apps/api` with `INIT_CWD` set. Every check and fake run asserts **zero** network requests.

## Commands executed and results

| Step | Command | Result |
|---|---|---|
| Reproduce 3 | `npm run eval:data-questions -- --check --report docs/reports/artifacts/ask-my-data-2026-11-19/qwen3-8b-{development,heldout}.json` (before) | `ENOENT … apps\api\docs\reports\…`, exit 3 |
| Reproduce 2 | in-memory probe through `evaluateDataQuestionGate` (temporary file, deleted) | original FAIL; edited scores PASS; one case per set PASS |
| RED | API: `vitest run src/evaluation/data-question-gate.spec.ts src/evaluation/data-question-evaluation-cli.spec.ts` | gate 12 failed / 1 passed; CLI suite failed to import (module missing) |
| RED | web: `vitest run src/data-question-controller.spec.ts` | 9 failed / 15 passed |
| RED | Chromium: `playwright test --project=chromium ask-my-data.spec.ts --grep " [6-9]\. "` | 4 failed (as in section 1) |
| GREEN, focused | contracts `src/data-questions.spec.ts`; API `src/data-questions src/config src/evaluation test/openapi-routes.spec.ts`; web `AskMyDataSection`, `data-question*`, navigation, Today, activity trends, weekly review | contracts 11; API **24 files, 445 passed**; web **8 files, 109 passed** |
| Gate recheck | the reproduce-3 command, after the fix, with `--out docs/reports/artifacts/ask-my-data-review-2026-11-19/gates-recheck.json` | exit **2**, FAIL, evidence valid, figures above; file written at the repository-relative path |
| Fake run | `npm run eval:data-questions -- --set development --provider fake --out docs/reports/artifacts/ask-my-data-review-2026-11-19/fake-development-harness-self-check.json` | exit 0; written at the requested path (nothing under `apps/api/docs`); 17/20, labelled harness self-check, not evidence |
| No network | both commands above with `NODE_OPTIONS=--import=<scratchpad>/no-network.mjs` (every `fetch` fails and is counted) | **0** fetch calls in every process |
| Verify | `npm run verify` with `VITEST_MAX_WORKERS=2` | exit **0**: lint, typecheck, scripts 115, API **2,508**, web **1,373**, contracts **322**, fixtures 14, simulator 3, build |
| DB identity | read-only probe through `loadIntegrationTestConfiguration` (`BEGIN READ ONLY` … `ROLLBACK`; scratchpad file), before the browser run and again before the integration run | each connection: target `127.0.0.1:5433/running_tracker_test`, server `172.18.0.2:5432`, PostgreSQL 17.5, `current_database()` = `running_tracker_test`, `current_user` = `session_user` = `running_tracker_runtime` / `running_tracker_owner` / `running_tracker_maintenance` |
| Integration | `VITEST_MAX_WORKERS` unset: the 18 files of the original report (data questions, daily overview, weekly review + meals explain, activity trends + explain, daily trends, meals/movement/activity/check-in/insights access, tenant isolation, HTTP session tenant, observability, meal drafts, run-search interpretation, session runtime) | **18 files, 376 passed** |
| Integration, authentication | `oidc-identity`, `oidc-login`, `oidc-login-restart` | **3 files, 19 passed** |
| Chromium | `ask-my-data` (9) + `today`, `today-activity-history`, `trends`, `activity-trends`, `weekly-review`, `daily-checkin`, `daily-movement`, `meal-draft`, `meal-log`, `record`, `sign-out` | **44 passed** (40 before + 4 new) |
| Whitespace | `git diff --check` | clean |

Workspace packages were not rebuilt while the Vite browser suite ran (`npm run verify` ran before it).

New artifacts, in a separate directory `artifacts/ask-my-data-review-2026-11-19/`: `gates-recheck.json` (the corrected
gate on the unchanged saved reports) and `fake-development-harness-self-check.json` (proof of the `--out` location; not
model evidence).

## Follow-up: exceptions during report validation

**Defect.** A cloned model report with one weekly proposal's `got.plan.period.weekStart` set to `"2026-02-30"` (or
`"not-a-date"`) made `evaluateDataQuestionGate` throw `RangeError: Not a calendar date`: a calendar-date refinement in the
plan contract raises instead of reporting an issue, and `safeParse` does not contain exceptions. The CLI then exited 3
from its error handler, with no structured verdict and no `--out` file. Reproduced in memory for both values.

**Correction.** Report validation runs inside `parseReport`, which contains any exception. The affected report becomes
`report N: malformed (validation failed: RangeError: Not a calendar date)` (reason capped at 120 characters), so the gate
answers NOT_RUN. The other reports are still validated and scored. The schema and the production contracts are
unchanged.

| Regression | Before | After |
|---|---|---|
| Gate: `weekStart` `"2026-02-30"` and `"not-a-date"` → NOT_RUN, bounded malformed problem, held-out still scored (17/20), no throw | failed (`RangeError` thrown) | passes |
| CLI `--check` with such a report → exit 3, NOT_RUN printed, `--out` written with the held-out quality, no network | failed (`RangeError` escaped) | passes |
| Saved reports → FAIL (quality), evidence valid (existing gate and CLI tests) | passed | passes |

Commands: `vitest run src/evaluation/data-question-gate.spec.ts src/evaluation/data-question-evaluation-cli.spec.ts
src/evaluation/data-question-evaluation.spec.ts`: **32 passed** (gate 14, CLI 9, evaluation 9). API `tsc --noEmit`
clean; ESLint on the changed files clean; `git diff --check` clean. Root command with the broken report and a scratchpad
`--out`: NOT_RUN, exit 3, file written. Root command on the unchanged saved reports: FAIL, exit 2. No database, browser or
Ollama runs were needed; no artifact changed.

## Limitations

- **No fresh model evidence.** The model verdict is the 2026-11-19 measurement, rechecked; quality is still FAIL and
  interpretation stays off by default.
- **Zone change in the browser.** The app reads the device zone once per page load (`App.tsx`), so a running page cannot
  change zone. Chromium scenario 8 proves a date change clears the text and, for the zone, that the same session opened in
  another zone starts empty (that half would also have passed before the fix); the in-page zone path is the same
  `setContext` as the date, covered for the zone by the controller test.
- **Edits during a request.** The input is disabled while a request is in flight, so an edit cannot race a pending
  response through the screen; the controller tests cover it (abort, then the late response is dropped), and the browser
  covers late responses after Cancel followed by an edit.
- **Frozen order.** The gate refuses results out of the frozen order. The runner always preserves it, so this only rejects
  edited or assembled reports.
- **Discard keeps the text** (only New question, a date or zone change empties it); the kept text is only interpreted on an
  explicit Interpret.
- Chromium on one workstation only; no physical Safari, hosted CI, real GPS or production verification.
