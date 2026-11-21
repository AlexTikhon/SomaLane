# ADR-0096: Nutrition Trends v2 — 28-day recorded nutrition with per-metric coverage and a Meal log drill-down

- Status: accepted; implemented and verified on the workstation (see the verification report). No hosted CI run and no
  physical device.
- Date: 2026-11-21
- Amends: [ADR-0084](0084-daily-trends.md) (the daily-trends response and the Trends view: food energy becomes one of
  four nutrition metrics, `daily-trends-2`).
- Relates to: ADR-0083 (manual meal log: optional user-reported totals, one decimal, stored `local_date`), ADR-0093 (the
  weekly review's recorded nutrition: the same counting rules and the same `GROUPING SETS` shape for seven dates),
  ADR-0082 (scoped navigation intents), ADR-0094/0095 (Ask my data, unchanged).
- Scope: `packages/contracts/src/daily-trends.ts` (`daily-trends-2`), OpenAPI, `apps/api/src/daily-trends/*`, a small
  shared parser `apps/api/src/meals/meal-nutrition-summary.ts` (moved out of `weekly-review-meals.ts`, behaviour
  unchanged), the web Trends presentation and screen, the navigation intent, App and the Meal log's way back, tests,
  docs. No migration, table, route, dependency, job, cache, materialized view or model call.

## Context

Trends (ADR-0084) shows food energy per date with two coverage levels. Protein, carbohydrate and fat are stored on the
same entries (ADR-0083) and the weekly review already shows all four for seven dates (ADR-0093), but there is no
multi-week view of them, and from a Trends date a person can only open Today, not the Meal log where the entries are
edited. Across 28 dates the risks of ADR-0093 grow: four independent coverages, partly recorded dates, title-only entries,
recorded zeros, and a total that must never read as "what I ate".

## Decision 1: one canonical `nutrition` part, `daily-trends-2`, no legacy energy fields

The daily-trends response replaces `days[].foodEnergy` and `summary.foodEnergy` with `nutrition`:

```text
days[]: { localDate, weightKg, sleepMinutes, steps,
          nutrition: { loggedEntries,
                       energyKcal | proteinG | carbohydrateG | fatG: { recordedEntries, total } } }
summary.nutrition: { source: 'manual', daysInRange, loggedEntries, daysWithEntries,
                     energyKcal | proteinG | carbohydrateG | fatG: { recordedEntries, recordedDays, total } }
```

The field names are `MealNutritionField` and the per-metric objects have the weekly review's shape, so the same words
mean the same thing in both views. `daysInRange` repeats `range.days` (the denominator) inside the part, as the review's
`daysInWeek` does; the schema requires them equal.

**Compatibility.** One representation, not two. Keeping `foodEnergy` beside `nutrition.energyKcal` would carry the same
numbers twice under different names (`entriesWithEnergy`/`recordedEntries`, `recordedKcal`/`total`,
`recordedTotalKcal`/`total`), with a cross-check that exists only to keep them equal. The only consumer of the response is
this repository's web app, which ships with the API, so the old fields are removed and the version moves to
`daily-trends-2`. A client of `daily-trends-1` that reads `foodEnergy` breaks loudly (strict schemas on both sides) rather
than silently reading a different meaning. The old values map one to one: `foodEnergy.loggedEntries` →
`nutrition.loggedEntries`, `entriesWithEnergy` → `nutrition.energyKcal.recordedEntries`, `recordedKcal` →
`nutrition.energyKcal.total`, `summary.foodEnergy.daysWithEnergy` → `summary.nutrition.energyKcal.recordedDays`,
`recordedTotalKcal` → `summary.nutrition.energyKcal.total`, `daysWithEntries` and `loggedEntries` keep their names.
Weight, sleep, steps, `range`, `provenance` (apart from the version string), the query and every error are unchanged.

The web series identifier `foodEnergyKcal` is kept (it is not on the wire), so a kept selection and the existing Food
energy series behave as before; `proteinG`, `carbohydrateG` and `fatG` are added. `DAILY_TRENDS_NUTRITION_FIELD` maps
each nutrition series to its `MealNutritionField`.

## Decision 2: counting rules

| Rule | Consequence |
|---|---|
| Missing is null, never zero | A metric's `total` is null exactly when no entry of the date (or range) records it |
| A recorded 0 is a value | It counts in `recordedEntries` / `recordedDays` and its total is 0 |
| A title-only entry is a logged entry | It counts in `loggedEntries` and `daysWithEntries`, and in no metric |
| Metrics are independent | Protein's coverage says nothing about fat's; each has its own entries, days and total |
| No logged entry is unknown | A date without entries has `loggedEntries` 0 and every total null; it is not "nothing eaten" |
| Coverage is not completeness | Even when every logged entry records a metric, unlogged food is unknown; the screen says so |
| Stored dates | An entry counts on its stored `local_date`, whatever zone it was saved in; the requested zone decides only "today" |
| Range rules unchanged | 28 dates ending on `endDate`, cut and disclosed at 2000-01-01; `endDate` after today in the zone by the server clock is `400` |

**Invariants the schema enforces** (tests mutate them one at a time): `recordedEntries ≤ loggedEntries` per date and for
the range; `total` null ⇔ `recordedEntries` 0; `recordedDays` 0 ⇔ `recordedEntries` 0 and `recordedDays ≤
recordedEntries`; `recordedDays ≤ daysWithEntries ≤ daysInRange`; `daysWithEntries` 0 ⇔ `loggedEntries` 0;
`daysInRange = range.days`; every total finite, non-negative, at most one decimal and at most `recordedEntries ×` the
per-entry bound; the whole summary equals `summarizeDailyTrendDays(days)` (range counts are sums of the dates, recorded
days are dates with a recorded entry, range totals are sums of the date totals in integer tenths); dates are every date
of the range, oldest first, once each.

**Bounds** are technical, not dietary: 10,000 entries per stored date (as the daily overview and the review), so 280,000
per range; per entry the meal log's own bounds (20,000 kcal, 2,000 g). The largest range total, 5.6e9 kcal, is 5.6e10
tenths, far inside the range where a JSON number holds one decimal exactly and inside the ten integer digits the parser
accepts.

## Decision 3: the same three statements; the meal statement becomes a bounded `GROUPING SETS` aggregate

The read stays one authenticated `REPEATABLE READ READ ONLY` transaction (membership check included) with exactly three
source statements: check-ins, manual movement, meals. The meal statement now reads all four nutrients:

```sql
/* daily-trends:meals */
SELECT CASE WHEN grouping(meal.local_date) = 0 THEN to_char(meal.local_date, 'YYYY-MM-DD') END AS local_date,
       count(*) ..., count(DISTINCT meal.local_date) ...,
       count(meal.energy_kcal), count(DISTINCT meal.local_date) FILTER (WHERE meal.energy_kcal IS NOT NULL),
       sum(meal.energy_kcal)::text, ... (the same three for protein_g, carbohydrate_g, fat_g)
  FROM meals AS meal
 WHERE meal.org_id = $1 AND meal.user_id = $2 AND meal.source = 'manual'
   AND meal.local_date BETWEEN $3::date AND $4::date
 GROUP BY GROUPING SETS ((meal.local_date), ())
```

| Option | Against |
|---|---|
| Four per-nutrient statements, or one per date | More round trips; a per-date or per-metric pattern the ADR-0084 design ruled out |
| Load the range's entries and add them in TypeScript | Loads individual meals (and titles by temptation); floating-point or hand-written decimal sums |
| Per-date `GROUP BY` and the range in TypeScript | The range's day coverage and totals would no longer be the database's computation |
| Call the weekly review per week | Up to five reads of a different shape and range; weeks do not align with the 28 dates |
| **`GROUPING SETS ((local_date), ())`** (chosen) | One statement, at most 29 rows; PostgreSQL computes every count and exact `numeric` sum per date **and** for the range; the empty grouping set always yields exactly one range row |

No title, type, description, zone or identifier is selected (a unit test checks the select list). Each sum is parsed from
its text into integer tenths by the existing `nutritionTenthsOf` (a meaningful second decimal, a sign or an exponent
throws rather than rounding); that function and the row parser move unchanged into `meals/meal-nutrition-summary.ts`, and
the weekly review imports them from there (its tests and statement are untouched). The service throws on rows the
statement cannot produce (no or several range rows, a date outside the range or twice). The range row is PostgreSQL's
own aggregate; the service places it in `summary.nutrition` and the contract refuses it if it differs from the sum of the
dates, so the two computations check each other.

**Index.** The existing `meals_owner_date_created_idx (org_id, user_id, local_date, created_at, id)` serves the range; no
migration. An EXPLAIN test on synthetic data (runtime role, RLS in force, 100,000 entries of five people) records the plan
and asserts what matters: one scan of `meals` bounded by the owner's range (no sequential scan of the large table), the
rows read are the person's entries of the 28 dates, and the answer is at most 29 rows.

Preserved: explicit organization and owner predicates, runtime-role RLS, `source = 'manual'`, `no-store` on every
response, computation on every request, nothing persisted or cached. The snapshot hook (`afterCheckInsRead`) still sits
between the first statement and the others.

## Decision 4: the Trends view

The series selector gains **Protein**, **Carbohydrate** and **Fat** after **Food energy**, reusing the same chart and
table. For a nutrition series the card shows its name and unit, its coverage ("Recorded on 1 of 28 days. Protein is
recorded on 2 of 4 logged entries. …"), the recorded range total with the entries and days it covers, the days with
logged entries (and how many of them have no value for this metric), and that the total covers only logged values and is
not a complete food diary. The table shows the exact value or "Not recorded" with the metric's entry coverage beneath it:
"No entry logged", "3 entries logged, no protein recorded", "Partial: 1 of 3 entries with fat", "All 2 logged entries
with protein". A partially recorded date keeps its known total, labelled as partial; it is never presented as the day's
intake. A recorded zero is a dot on the baseline; a missing value is a gap with a short mark under the axis; lines join
only adjacent dates with values; each dot's title names the metric, date, value and unit, and the SVG description names
the metric and unit. A range with only macronutrients or only title-only entries is not "Nothing is recorded"
(`isEmptyDailyTrends` counts logged entries). No targets, balances, macro-derived calories, estimates, averages,
comparisons or advice.

## Decision 5: Trends → Meal log → Trends

A nutrition row has **Meal log** beside **Open** (Today). It opens the existing Meal log on that stored date through the
existing typed editor intent (`section: 'meals'`), plus a scoped **return intent** `{ endDate, metric, scope }` taken from
the loaded answer the row belongs to (its `range.endDate`, not the date field being typed). While it is in scope the
Meal log shows **Back to Trends** beside the existing **Back to Today**. Back to Trends sets the kept end date and series
to the intent's and opens Trends, which mounts and reads again, so saved edits and deletions are reflected.

The return intent lives in App memory only (no routing library, no browser storage). It carries the scope (session
generation, person, organization) and is ignored under any other; it is cleared by sign-out, by any ordinary navigation
(the view switcher, Back to Today, a Today action), by being used, and as soon as the scope changes, so returning to the
same organization later does not resurrect it. The Trends and Meal log controllers keep their own cancellation and
"latest request wins" rules: a date change aborts the previous request, a late answer for an abandoned range or a
disposed screen is dropped, and the row actions exist only for the answer currently shown. Meal editing, idempotency,
deletion and recording lifecycles are unchanged.

## Consequences

- One wire break of the daily-trends response, versioned and documented; OpenAPI regenerated. Weight, sleep and steps
  are byte-for-byte the same values.
- The meal statement returns up to 29 rows instead of up to 28 and computes three more sums; it is still one indexed
  range read.
- `packages/contracts/src/daily-trends.ts` is one of the files the Ask-my-data evaluation fingerprints (for
  `dailyTrendsRangeOf`). Changing it changes that fingerprint; the saved v2 reports were already stale (NOT_RUN) after the
  `data-question-constraints-2` correction, so their status is unchanged and no model evidence is claimed either way.
  Ask my data's operations, plans and answers are untouched.
- Meals stay outside weekly AI facts and inputs; every optional AI default is unchanged.

## Not established

- **No physical iPhone or Safari evidence**: the narrow-viewport checks are Chromium on Windows with a wide font.
- No hosted CI run.
- The per-date bound (10,000 entries) is not enforced by the database; more would make the read fail its own schema
  rather than show a wrong number (as for Today and the review).
- Seven series make the selector longer; grouping it is a later presentation decision if it proves awkward.
- "Today" on the Trends and Meal log screens is fixed when the screen opens (ADR-0084).
