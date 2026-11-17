# ADR-0093: Recorded meal nutrition in the deterministic weekly review

- Status: accepted; implemented and verified on the workstation (unit, real PostgreSQL integration including an EXPLAIN on
  synthetic data, Chromium end-to-end with generation off, a 375 px viewport). No hosted CI run and no physical device.
- Date: 2026-11-17
- Relates to: ADR-0077 (deterministic weekly review: one snapshot, code-written statements, explicit denominators),
  ADR-0079 (movement as a review-only part, its own statement in the same transaction), ADR-0083 (manual meal log:
  `meals`, optional user-reported totals, one decimal, stored `local_date`; its "not established" list named this),
  ADR-0084 (food energy in Trends: entry and day coverage, never a complete diary), ADR-0092 (meal drafts, unchanged).
- Scope: `packages/contracts/src/weekly-review.ts` (`weekly-review-5`), `apps/api/src/insights/weekly-review-meals.ts`
  (new), `weekly-review.ts`, `weekly-review-service.ts`, OpenAPI, `apps/web/src/weekly-review-meals.ts` (new), the
  Weekly review panel and one CSS rule, tests, docs. No migration, table, route, dependency, background job, cache,
  model call or persisted review. AI insights (aggregate, facts, input hash, prompts, policies, gates, triggers) and meal
  drafts are unchanged.

## Context

The weekly review is the primary weekly view and covers check-ins, manual activities, GPS runs, imports and movement.
Meals were left out on purpose by ADR-0083 ("a later decision"). A person who logs meals but nothing else saw "Nothing is
recorded for this week". Today (`daily-overview-2`) already shows one day's recorded totals with independent coverage,
and Trends shows food energy per date; the week had nothing. The risk is wording and arithmetic, not data access: a total
of what was logged must never read as what was eaten, missing must never become zero, and the numbers must be exact.

## Decision 1: the contract (`meals`, `weekly-review-5`)

A review-only part, strict at every level:

```text
meals: {
  source: 'manual', daysInWeek: 7,
  loggedEntries,            // entries logged for the week's 7 stored dates (title-only ones included)
  daysWithEntries,          // stored dates with >= 1 entry
  energyKcal | proteinG | carbohydrateG | fatG: { recordedEntries, recordedDays, total },
  days: 7 x { localDate, loggedEntries, energyKcal | proteinG | carbohydrateG | fatG: { recordedEntries, total } }
}
```

Invariants the schema enforces (and tests mutate one by one):

| Rule | Where |
|---|---|
| `total` is null exactly when `recordedEntries` is 0; recorded zeros give 0 | every day metric and week metric |
| `recordedDays` is 0 exactly when `recordedEntries` is 0, and never exceeds it | week metrics |
| a metric's `recordedEntries` never exceeds the logged entries | each day and the week |
| a total is finite, non-negative, has at most one decimal and is at most `recordedEntries x` the per-entry bound | every metric |
| week `loggedEntries`, each metric's `recordedEntries` = sum of the days; `daysWithEntries`, `recordedDays` = number of days with > 0 | week vs days |
| week `total` = sum of the day totals, compared in integer tenths; null when no day has one | week vs days |
| seven days, Monday to Sunday of `week.start`, in order; only `manual`; no extra field (no title, target, average) | structure |

Bounds are technical, not dietary: 10,000 entries per stored date (the daily overview's bound), so 70,000 per week, each
value within ADR-0083's per-entry bound (20,000 kcal; 2,000 g). The largest weekly total, 1.4e9 kcal, is 1.4e10 tenths,
well inside the range where a JSON number holds one decimal exactly. A day carries no `recordedDays` (it would always be
0 or 1); coverage per day is its entries.

Every metric's coverage is independent: energy can cover 3 of 5 entries on 2 days while protein covers 2 entries on 2
other days. Coverage counts the logged entries and days that hold a value; it never says that everything eaten was logged.

## Decision 2: one date-bounded aggregate statement in PostgreSQL

`weekMealsSql` (in `weekly-review-meals.ts`) runs in the review's existing authenticated `REPEATABLE READ READ ONLY`
transaction, after the AI-shared source statement, imports and movement. It names `org_id`, `user_id` and
`source = 'manual'` explicitly and runs under the owner-only RLS of migration 0039. It selects no title, type,
description, zone or identifier (a unit test checks the select list).

```sql
... WHERE meal.org_id = $1 AND meal.user_id = $2 AND meal.source = 'manual'
      AND meal.local_date BETWEEN $3::date AND $3::date + 6
GROUP BY GROUPING SETS ((meal.local_date), ())
```

| Option | For | Against |
|---|---|---|
| Load the week's entries and add them in TypeScript | Simple SQL | Loads individual meals; floating-point or hand-written decimal arithmetic in the API |
| Seven per-day queries (the overview's statement) | Reuses SQL | Seven round trips; the week total still added in the API |
| Per-day `GROUP BY` and add the week in TypeScript | One statement | The week total is no longer computed by the database; day coverage of the week needs API logic |
| **`GROUPING SETS ((local_date), ())`** (chosen) | One statement, at most 8 rows; PostgreSQL computes every count and exact numeric total for each date **and** for the week; the empty grouping set always yields exactly one week row, also with no entry | Slightly less common SQL (commented in place) |

`count(col)` is a metric's entry coverage (a recorded 0 counts), `count(DISTINCT local_date) FILTER (WHERE col IS NOT
NULL)` its day coverage, `sum(col)` the exact numeric total (NULL when none). The API parses each total from its text with
a strict pattern into integer tenths (a meaningful second decimal, a sign or an exponent throws instead of rounding), so
0.1 + 0.2 kcal is 0.3 and ten entries of 0.1 g are 1. It throws on rows the statement cannot produce (no or two week
rows, a date outside the week or twice); the contract then refuses any disagreement between days and week.

**Dates.** An entry counts on its stored `local_date`, Monday to Sunday of the requested week, whatever zone it was saved
in and whatever zone the review's activities are read in (ADR-0074, as for movement). Meal zones do not take part in the
week's zone rule and are not reported: there is no instant to reconcile.

**Index.** The existing `meals_owner_date_created_idx (org_id, user_id, local_date, created_at, id)` serves the range;
no migration. Evidence (`weekly-review-meals-explain.integration.test.ts`, runtime role, RLS in force, 100,000 synthetic
entries of five people): one `Index Scan using meals_owner_date_created_idx` with `org_id`, `user_id` and the date range
as the index condition, 49 rows read (the person's week), 155 shared buffers, one `GroupAggregate` with both group keys,
8 rows out, 0.51 ms execution on the workstation.

## Decision 3: statements and the "Recorded nutrition" block

Appended after the movement statements, stable codes: `meals.none` ("No meals or snacks were logged this week."), or
`meals.logged` ("5 meal entries were logged on 3 of 7 days; each counts on the date it was logged for."), one statement
per metric (`meals.energy_recorded`: "Food energy was recorded for 3 of 5 logged entries, on 2 of 7 days: 1,061.1 kcal in
total for those entries; 2 other entries are unknown."; or `meals.energy_not_recorded`), and `meals.logging_limits`
("Meals were entered manually. The totals add up only the values recorded on logged entries; they do not show everything
eaten this week, and food energy is not combined with active energy."). At most six meal statements, so a week stays
within the 40-statement limit (worst case 35).

The web shows a **Recorded nutrition** block after "Steps and active energy" (its own region, so food energy is never
next to active energy as a balance): the "Manually entered" badge and what the values are; for a week with entries the
incomplete-logging explanation, the totals ("Food energy, recorded total — 1,061.1 kcal for 3 of 5 entries, on 2 of 7
days"; "Not recorded for any of the 3 entries"), and a compact list of the seven days (entries and each value with the
entries it covers, "Not recorded", or "No entries logged"). A week without entries says "No meals or snacks were logged
this week." A week with only a title-only entry is not empty (`isEmptyWeek` counts logged entries). No targets, calorie
balance, estimates, averages, advice or comparisons (unit and browser scans of the wording). The section's positioning
line now names logged meals among its sources.

**Freshness.** Meals are edited on the Meal log screen, which unmounts the Check-in tab; opening the tab again mounts a
new review section and controller, which reads afresh. Retry, Refresh, session disposal and "latest request wins" are the
existing controller's rules, unchanged and tested with meals. No new refresh signal was needed.

## Decision 4: AI boundaries are pinned

Meals stay outside the aggregate, the facts, the data gaps, the coverage, the input hash, prompts, policies, source gates
and generation. Unit: a review with meals leaves the aggregate deep-equal with an unchanged input hash, and facts, data
gaps and coverage are equal with and without meals; the insight prompt snapshots are unchanged. HTTP (FakeProvider, a
stored ready insight): a meal create, edit, delete and a review read leave the insight row (id, input hash, source
revision, status, attempts, `updated_at`, output digest), the gate revision and the insight view identical, with no
provider call; a later check-in makes the same insight stale, so the pin can fail. `MEAL_DRAFTS_PROVIDER`,
`WEEKLY_INSIGHTS_PROVIDER` and their defaults, and every meal-draft file, are untouched. No inference was run.

## Verification

See `docs/progress.md` (2026-11-17) for the exact commands and counts. Mutations, each red then restored byte-identical:
the date bound widened to `+ 7` (the stored-date test failed: the row guard refused the Monday after); the transaction
without its `read-only snapshot` mode (the meal snapshot test saw the mid-read edit, deletion and creation); the energy
sum taken as `float8` (the exact-decimal test failed: `0.30000000000000004` was refused); `isEmptyWeek` without meals
(the title-only panel test failed).

## Consequences

- The response grows by a fixed-size part (7 days x 4 metrics) and up to six statements; OpenAPI and the review version
  change. A client relying on `weekly-review-4` statement lists sees `meals.none` in every week without meals.
- One more indexed range read per review (at most 8 rows returned).
- The existing meals HTTP test that pinned "nothing in the weekly review changes" now pins that nothing AI-shared and no
  non-meal statement changes, and that the meals part follows the writes.

## Not established

- **No physical-device or hosted-CI evidence**: Chromium on Windows only; the 375 px check is a Chromium viewport with a
  wide font, not Safari or an iPhone.
- Meals are still not in multi-week trends beyond Trends' food energy, not compared between weeks, and not AI input; any
  of that needs its own decision (and, for AI, a prompt and policy version and a fresh validation set).
- A meal saved for a date in a zone far from the week's zone counts on its own date; the review does not say which zone
  each entry was saved in.
- The per-day bound (10,000 entries) is not enforced by the database; more would make the review fail its own schema
  rather than show a wrong number (as for Today).
