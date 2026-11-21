# Nutrition Trends v2 — verification report (ADR-0096)

- Date: 2026-11-21. Workstation: Windows 11, Node 24.11.1, Docker Desktop, PostgreSQL 17.5 (PostGIS image) on
  `127.0.0.1:5433`, Chromium (Playwright). On top of HEAD `fb861c5`; changes uncommitted.
- Scope: [ADR-0096](../adr/0096-nutrition-trends-v2.md). No physical device, Safari or hosted CI was used; the 375 px
  checks are a Chromium viewport with a wide font.

## What was verified

| Area | Evidence |
|---|---|
| Contract `daily-trends-2` | `packages/contracts/src/daily-trends.spec.ts` (21 tests): the required fixture, exact tenths (ten 0.1 → 1, the largest 5.6e9 kcal range total), every per-date and per-range invariant mutated one at a time for all four nutrients, denominator = `range.days`, range nutrition = sum of the dates, the `daily-trends-1` shape refused, macro-only and title-only ranges not empty |
| API unit | `apps/api/src/daily-trends/daily-trends.spec.ts`: three statements only (no per-date or per-nutrient statement), no free text in the meal select list, all four nutrients aggregated with `GROUPING SETS ((local_date), ())` and no float or rounding, row guards (no / two range rows, a date outside the range or twice, a second decimal), the fixture through `buildDailyTrends`, six internally-consistent range rows that disagree with their dates all refused. Weekly review spec unchanged and passing after the parser move |
| Real PostgreSQL, HTTP | `apps/api/test/daily-trends-http.integration.test.ts` (23 tests), runtime role, RLS, sessions; see below |
| EXPLAIN | `apps/api/test/daily-trends-meals-explain.integration.test.ts`; plan below |
| Web unit | presentation (`daily-trends.spec.ts`), screen (`TrendsScreen.spec.tsx`), Meal log (`MealLogScreen.spec.tsx`), navigation intent, controller, App: 105 tests in the focused run |
| Chromium | `tests/e2e/trends-nutrition.spec.ts` (2 tests, new) with `trends.spec.ts` and `activity-trends.spec.ts`: 8 passed; Meal log, Weekly review, Ask my data, Today, Meal draft: 29 passed |

### Integration cases (real database)

The required fixture on dates A, B, C, answered exactly (A's fat a recorded zero covering 1 of 3 entries; B's protein null
at 0/1; C zero entries, every total null; range: 4 entries, 2 days; energy 100.1/2/2, protein 10.1/2/1, carbohydrate
20.2/2/2, fat 5.3/2/2); ten 0.1 values = 1 for every nutrient on one date and across ten dates; macro-only and title-only
ranges; one entry per nutrient covering only that nutrient; a range shortened by 2000-01-01 (denominator 10, nothing after
the end counted); both DST transitions (2026-03-29, 2026-10-25) with entries saved in Tokyo, New York, Kiritimati, Pago
Pago and Warsaw, viewed from six zones; a future end date refused (400, `no-store`); another member, another organization,
a run-sharing grantee and a **coach of the organization holding live and history grants on the owner's run** (inserted in
the test; the coach sees zero entries); an inactive member (403 `ORG_ACCESS_DENIED`) and an unauthenticated request (401
`AUTH_REQUIRED`), both `no-store`; a committed meal **edit**, deletion and insertions between the check-in statement and
the meal statement excluded from that answer and present in the next; edit (macros dropped, changed, a 0 recorded) and
deletion through the Meal log API reflected on the next read; reads change no row count, no `meals.updated_at`, the
erasure ledger or weekly insights (also after a refused request).

### Mutation checks (each red, then restored byte-identical, SHA-256 `e239eeee…06db`)

| Mutation in `daily-trends-service.ts` | Failing test |
|---|---|
| Transaction without `read-only snapshot` | "reads every source in one snapshot, even when writes commit between its statements" |
| `sum(meal.protein_g::float8)` | "adds ten recorded 0.1 values to exactly 1 for every nutrient" (the parser refuses `0.9999999999999999`) |
| Date bound widened to `$3::date - 1` | "includes both end dates and nothing outside them" (the row guard refuses the date before the range) |

### EXPLAIN (runtime role, RLS in force, 100,000 synthetic entries of five people, 28 dates = 196 of the person's rows)

```text
daily-trends:meals (1.34 ms execution, index meals_owner_date_created_idx)
Sort (actual rows=29 loops=1)
  ->  GroupAggregate (actual rows=29 loops=1)
        Group Key: local_date
        Group Key: ()
        ->  Result (actual rows=196 loops=1)
              One-Time Filter: (current_org_id() = ... AND current_user_id() = ...)
              ->  Index Scan using meals_owner_date_created_idx on meals meal (actual rows=196 loops=1)
                    Index Cond: (org_id = ... AND user_id = ... AND local_date >= '2026-10-19' AND local_date <= '2026-11-15')
                    Filter: (source = 'manual' AND has_active_membership())
                    Buffers: shared hit=611
```

The test asserts what matters, not the planner's choice: exactly one read of `meals`, executed once, not a sequential
scan of the large table, 196 rows read (the person's 28 dates), 29 rows out with exactly one range row. The index scan above
is what the planner chose on this data; no migration was needed.

## Database identity (read-only probe before any write)

| Connection | Configured | `current_database()` | `current_user` / `session_user` |
|---|---|---|---|
| `TEST_DATABASE_URL` | `127.0.0.1:5433/running_tracker_test` | `running_tracker_test` | `running_tracker_runtime` / same |
| `TEST_MIGRATION_DATABASE_URL` | `127.0.0.1:5433/running_tracker_test` | `running_tracker_test` | `running_tracker_owner` / same |
| `TEST_MAINTENANCE_DATABASE_URL` | `127.0.0.1:5433/running_tracker_test` | `running_tracker_test` | `running_tracker_maintenance` / same |

Server `172.18.0.2:5432`, PostgreSQL 17.5, probed inside `BEGIN READ ONLY`. Docker Desktop had to be started first.

## Commands and results

| Command | Result |
|---|---|
| `npx vitest run --root packages/contracts src/daily-trends.spec.ts` | 21 passed |
| API `vitest run src/daily-trends/daily-trends.spec.ts src/insights/weekly-review.spec.ts` | 2 files passed |
| Integration (sequential): daily-trends HTTP, daily-trends EXPLAIN, meals access, meals HTTP, weekly review HTTP, weekly-review meals EXPLAIN, weekly insights HTTP, data questions HTTP, daily overview HTTP | **9 files, 200 passed** |
| Chromium: `trends-nutrition`, `trends`, `activity-trends` | **8 passed** |
| Chromium: `meal-log`, `weekly-review`, `ask-my-data`, `today`, `meal-draft` | **29 passed** |
| `npm run verify` (`VITEST_MAX_WORKERS=2`) | exit **0**: lint, typecheck, scripts 115, API **2,691** (165 files), web **1,418** (112 files), contracts **325**, fixtures 14, simulator 3, build |
| `npm run eval:data-questions -- --check --dataset-version v2` | NOT_RUN, exit 3, no inference call (no valid saved report; unchanged status) |
| `git diff --check` (new files included) | clean |

## Compatibility notes

- The daily-trends wire shape changed (`foodEnergy` → `nutrition`, version `daily-trends-2`); the only consumer is this
  repository's web app, migrated in the same change. OpenAPI regenerated.
- `packages/contracts/src/daily-trends.ts` is in the Ask-my-data evaluation fingerprint; its saved reports were already
  NOT_RUN before this change and remain so. No dataset, prompt, policy or AI default changed.
- `nutritionTenthsOf` and the meal summary row parser moved unchanged to `apps/api/src/meals/meal-nutrition-summary.ts`;
  `insights/weekly-review-meals.ts` re-exports them and its statement is untouched (its EXPLAIN test still passes).

## Not established

- No physical iPhone/Safari evidence (the pilot remains a separate milestone) and no hosted CI run.
- The browser checks ran in Chromium only.
