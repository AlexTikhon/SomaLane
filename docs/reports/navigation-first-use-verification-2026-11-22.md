# Navigation and first-use flow — verification report (release step 3, ADR-0097)

- Date: 2026-11-22. Workstation: Windows 11, Node 24.11.1, Docker Desktop, PostgreSQL 17.5 (PostGIS image), Chromium
  and Firefox (Playwright 1.63.0). On top of HEAD `3ef549d`; changes uncommitted.
- Scope: [ADR-0097](../adr/0097-navigation-and-first-use-flow.md). Fresh checks, run in this change. No hosted CI,
  physical device or Safari; the 375 px checks are a Chromium viewport.

## What changed

- A fresh page or reload opens **Today**. Navigation: **Today**, **Weekly review**, **Trends** first, then **Records**
  (Check-in, Meal log, Activity) and **Runs** (Runner, Coach, Archive), in one "Application view" landmark.
- **Weekly review** view: the existing `WeeklyReviewPanel` and controller with a level-1 heading and a Trends action.
  Today has a **Weekly review** action for the week of its date; an Ask-my-data answer opens this view.
- Date policy in `journey-navigation.ts` (see the ADR's table). Kept selections are App memory, scoped and cleared on
  sign-out.
- **Run status** away from Runner, derived in `run-attention.ts` from existing state; **Go to Runner**.
- App still owns restoration, authority, capture, uploads and the writer lease; no effect changes the view.

## Test data isolation

| Check | Result |
|---|---|
| Fixture suite targets, read-only (`TEST_DATABASE_URL`, `TEST_MAINTENANCE_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`) | each connects to `running_tracker_test` on `127.0.0.1:5433` as `running_tracker_runtime` / `_maintenance` / `_owner` (current_user = session_user); server system identifier `7687193163643084838`, the `running-tracker` Compose container |
| Portfolio dataset server | container `somalane-portfolio-dataset-postgres-1` (`127.0.0.1:5442`), system identifier `7710906452649996329`: a different cluster |
| Portfolio dataset unchanged | read-only fingerprint (row count and an MD5 over the canonical text of every row of the 13 record tables; sessions excluded, since signing in writes one) identical before and after the portfolio runs; `manifest.json` and `seed-state.json` SHA-256 unchanged (`6d6afc51…5a0f`, `0554f917…f5ce`) |
| Portfolio screenshots | the five step-2 screenshots, overwritten by the existing walkthrough, restored byte-identical (SHA-256 checked); the new journey screenshots are new ignored files under `.local/portfolio-dataset/screenshots/` |
| Seeder guards | untouched (no file under `apps/api` changed) |

## Unit and static checks

| Check | Result |
|---|---|
| Focused web unit run (App, navigation intents, journey policy, run status, Weekly review view, Today, review panel, Check-in, movement) | 115 passed in 10 files |
| New unit coverage | `journey-navigation.spec.ts` (week containing a date across month, year and DST dates; invalid and future dates; kept versus default week; older week offered; Sunday versus today, never after today; labels), `run-attention.spec.tsx` (Recording only with an active watch; six not-recording cases; paused, pending, blocked kinds; the region's markup), `WeeklyReviewScreen.spec.tsx` (level-1 heading, no AI section or editor, kept/older/invalid weeks, the Trends end date), `navigation-intent.spec.ts` (start view, groups cover every view once, review intent scoped, review → Trends), `TodayScreen.spec.tsx` (the week action and its disabled state), `App.spec.tsx` (Today current, grouped navigation markup, Runner mounted but hidden from the first render) |
| `npm run verify` | exit 0: lint, typecheck, scripts 115, API 2,810, web 1,440, contracts 325, fixtures 14, simulator 3, build. Its contracts build rewrote `packages/contracts/openapi/openapi.json` with line-ending changes only (empty content diff); restored |
| E2E typecheck (`tsc -p tests/e2e`) | exit 0 |
| `git diff --check`, and `git diff --no-index --check` for each new file | clean |

## Fixture-based browser evidence (`running_tracker_test`, suite fixtures, one worker)

New `tests/e2e/primary-journey.spec.ts` (Chromium, Europe/Warsaw):

1. **Journey and date policy.** A fresh signed-in page and a reload open Today. Today's own action adds a check-in on a
   date of last week; Today shows it on the kept date. Today → **Weekly review** opens that week (heading focused, no
   editor form, no AI section) with "1 of 7 days". **28-day trends** ends on that week's Sunday; a Trends row opens
   Today on the record's date. Direct openings keep the week, the range and the series. The current week's action ends
   the range today. After sign-out and sign-in again every selection is back to its default.
2. **Scope and late answers.** Two organizations: A's week, date and range never show in B. A's review read is held,
   the person switches to B, the held read is released: B keeps its own default week and none of A's data (the
   disposed screen's read was aborted or ignored). Another identity (coach, after sign-out) gets defaults only.
3. **Recording independent of the view.** Demo simulator run started on Runner, then Today and the Weekly review
   shown: the Run status says Recording, server point counts for the same run rise by at least 3 on each view, one
   capture segment, gap-free sequence numbers, one run in the organization, the same writer fencing token, nothing
   queued. A reload on Today opens Today, the status returns to Recording, new points arrive for the same run, the
   lease record is live (not released, unexpired), the durable active run is the same, still one run; **Go to Runner**
   shows the same run id, `owned`, `recording`, `capturing`. Paused away from Runner says Paused, never Recording; after
   Finish and an empty buffer the status disappears.
4. **375 px and keyboard.** No horizontal scroll on Today, the Weekly review and Check-in; all nine view buttons inside
   the viewport and at least 32 px high; the three groups named; Tab follows the visual order and Enter opens a view.

Selectors updated only where the start view changed: `RunnerPage.showView()` (and `reload()` shows Runner before reading
the Writer card; the ownership wait and its 10 s bound are unchanged), and an explicit Runner opening after a fresh page
or reload in organizations, sign-out, lifecycle-takeover, new-run-takeover, archive-sharing, session-revalidation,
finish-result, the OIDC expiry scenario and today.spec's start-view assertion. Ask my data now expects the Weekly
review view (level-1 heading, `aria-current`).

| Run | Result |
|---|---|
| Focused Chromium (new spec, today, ask-my-data, organizations, sign-out, lifecycle-takeover, new-run-takeover) | 36 passed |
| Full `npm run test:e2e`, first run | 188 passed, 4 failed. Two were environmental: Chromium got `net::ERR_ADDRESS_IN_USE` loading Vite modules (blank page; archive-sharing:437, trends:278). One was an Ask-my-data interpretation error (ask-my-data:236) in code this change does not touch. The fourth was genuine: the OIDC expiry scenario started a run without opening Runner and reauthenticated through a full page load. Its test was fixed |
| The four rerun | 4 passed |
| Full `npm run test:e2e`, second run (final code) | **192 passed** (183 `chromium`, 9 `chromium-oidc`; harness's deliberately failing test counted as designed) in 19.0 min |
| Firefox core gate `npm run test:e2e:firefox` | **18 passed** (3.6 min); includes record, reload-offline, second-tab, gps-recovery, run-sharing, archive-sharing, coach-map, unchanged in intent |

The existing reload-offline, runner-recovery, second-tab, lifecycle-takeover, new-run-takeover, session-revalidation,
finish-result, sign-out, authority and Today/Trends-while-recording scenarios all passed in both browsers where they
run.

## Portfolio-dataset evidence (read-only, `npm run test:e2e:portfolio-dataset`, verified launcher)

A second walkthrough test drives the journey with selections from `manifest.json`. A fresh page opens Today. Today on the
review week's Sunday (2026-11-15) → Weekly review on week 2026-11-09 (coverage "6 of 7", "14 entries …") → Trends ending
2026-11-15, by the policy computed in the test from today's date in the dataset zone. Protein: 28 rows from the end
date. A row's **Meal log** on the last week date with meals, **Back to Trends** keeps the end and series, **Open**
shows the day on Today. A direct opening keeps the week. No unexpected private-API failure.

| Run | Result |
|---|---|
| Before the final CSS adjustment | 2 passed |
| Final code | **2 passed** (19.3 s); fingerprint and manifest hashes unchanged after both runs; step-2 screenshots restored |

## Not covered, and limits

- No hosted CI, Safari, WebKit or physical phone; 375 px is a Chromium viewport.
- `npm run test:e2e:smoke` (pre-demo smoke) and `npm run test:integration` were not run: no API or database code
  changed, and neither is in this step's required set.
- Returning to the same organization in the same session finds that scope's own kept selections (as for Today's date
  since ADR-0082). Another scope never sees them.
- The Weekly review appears both in its own view and in the Check-in tab, as the same component.
- Pre-existing and not changed here: at 1280 px the Trends table's action column is narrow enough that "Open" and
  "Meal log" wrap one letter per line (also visible in the step-2 screenshot `trends-nutrition.png`). It is usable but
  should be fixed in a later presentation pass.
