# Verification report: Trends table row-action layout repair (recorded defect, before step 10)

- Date: 2026-11-24
- Change: one CSS rule in the shared stylesheet, plus browser-test assertions. It repairs the defect recorded in the
  [step-9 report, section 8, finding 1](portfolio-materials-verification-2026-11-24.md#8-findings) (first noted as
  pre-existing in the [step-3 report](navigation-first-use-verification-2026-11-22.md#not-covered-and-limits)). The
  [release plan](../portfolio-v1-release-plan.md#step-9-portfolio-materials-screenshots-changelog-and-licence) allows
  only recorded defects to change at this stage. No component, data, contract, API, authentication, workflow or
  dependency change. A follow-up adds one global ESLint ignore for the git-ignored `tests/e2e/.local/**` so that the
  standard `npm run verify` passes on this workstation (section 7.1).
- Baseline: `8f66554` (step 9, committed, not pushed). The live showcase still serves `3bbe2b2`.
- Kind of evidence: **local checks only**, on the Windows 11 workstation. Node 24.11.1 and `@playwright/test` 1.63.0
  with Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6, all headless. **No hosted CI, no Pages run, no check
  against the live site.** Playwright WebKit is not Safari, and nothing here was run on a phone.

## 1. The change

`apps/web/src/styles.css`:

```diff
-.trends-table__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.35rem; }
+/* The actions cell is shrink-to-fit (width: 1%): unbroken labels and one row keep its minimum at the buttons' real width. */
+.trends-table__actions { display: flex; justify-content: flex-end; gap: 0.35rem; }
+.trends-table__actions button { white-space: nowrap; }
```

`.trends-table__actions` exists only in the "Every date" table of `TrendsContent.tsx`, which the application's Trends
screen and the showcase both render. The rules that the activity and comparison tables share
(`.trends-table td:last-child { width: 1% }`, `overflow-wrap: anywhere` on cells) are unchanged. So is the existing
`@media (max-width: 420px)` rule that stacks the actions in a column.

## 2. Root cause

- `.trends-table td:last-child { width: 1% }` makes the actions column as narrow as its **min-content** width.
- Every cell has `overflow-wrap: anywhere`, which buttons inherit. It allows a break between any two letters, and,
  unlike `break-word`, it counts those breaks when computing min-content. The narrowest a label could be was one glyph.
- With `flex-wrap: wrap`, the min-content of the actions container is that of its widest item, so Meals also wrapped
  under Open.
- Together, the column shrank to about 50 px, and each label broke after every letter or two.

The fix gives the buttons `white-space: nowrap`, so a label has no break opportunities and its min-content is its whole
width. Removing `flex-wrap: wrap` makes the container's min-content the buttons side by side, so the shrink-to-fit
column fits both on one row. At 420 px and below, the existing media query still stacks them in a column. Dates, values
and coverage details keep `overflow-wrap: anywhere` and wrap as before.

## 3. Reproduction before the fix

The showcase's production build at `8f66554` (`node --import tsx tests/e2e/support/showcase-build.ts`). Its assets
were `index-CSFkCBR5.js` and `index-DeAHiD62.css`, the same names the live site serves, recorded in step 8. It was served
by `vite preview` under `/SomaLane/`. A git-ignored measuring script (`tests/e2e/.local/layout/measure.mjs`, not
committed) opened Trends, chose a series, and for every row button counted the label's line boxes (distinct tops of
`Range.getClientRects()`). It also recorded box sizes, the column widths of all three `.trends-table` tables and
`document.documentElement.scrollWidth`.

| Engine, width, series | Buttons | On more than one line | Lines per label | First row's Open (w × h) | Actions column | `scrollWidth` |
|---|---|---|---|---|---|---|
| Chromium 1280, Weight (Open only) | 28 | 28 | 4 | 38.5 × 98 px | 49.7 px | 1280 |
| Chromium 1280, Food energy (Open + Meals) | 56 | 56 | 4 | 41.4 × 98 px, Meals below it | 52.6 px | 1280 |
| Chromium 375, Weight | 28 | 28 | 4 | 32.1 × 96.4 px | 43.3 px | 375 |
| Chromium 375, Food energy | 56 | 56 | 4 | 35.0 × 96.4 px | 46.2 px | 375 |
| Firefox 1280 / 375, both series | 28 / 56 | all | 4 | 38.6 × 98 / 32.2 × 96.4 px (Weight) | 49.8 / 43.4 px (Weight) | 1280 / 375 |
| WebKit 1280 / 375, both series | 28 / 56 | all | 4 | 38.5 × 98 / 32.1 × 96.4 px (Weight) | 49.7 / 43.3 px (Weight) | 1280 / 375 |

The page never overflowed, which is why the existing 375 px `scrollWidth` checks passed while every label was broken.

**The application had the same defect.** This was "most likely" in the step-9 report and is now observed. On the
development server of the full application (the `chromium` project's demo-enabled origin and the `_test` database;
section 6), "Open" broke over 4 lines and "Meal log" over 5 at both 1280 and 375 px.

## 4. After the fix

The same script and settings against the rebuilt showcase:

| Engine, width, series | Buttons | On more than one line | First row (w × h) | Actions column | `scrollWidth` |
|---|---|---|---|---|---|
| Chromium 1280, Weight | 28 | 0 | Open 64 × 38 px | 75.1 px | 1280 |
| Chromium 1280, Food energy | 56 | 0 | Open 64 × 38, Meals 67.3 × 38 px, **side by side** | 148.1 px | 1280 |
| Chromium 375, Weight | 28 | 0 | Open 57.5 × 36.4 px | 68.7 px | 375 |
| Chromium 375, Food energy | 56 | 0 | Open and Meals 60.9 × 36.4 px, **stacked** | 72.1 px | 375 |
| Firefox, same four cases | 28 / 56 | 0 | 1280: Open 64.9, Meals 69.3 px wide, side by side; 375: stacked | 76.1 / 151.1 / 69.8 / 74.1 px | 1280 / 375 |
| WebKit, same four cases | 28 / 56 | 0 | identical to Chromium to 0.1 px | 75.1 / 148.1 / 68.7 / 72.1 px | 1280 / 375 |

In between: at 421, 440, 480, 520, 600 and 768 px (Food energy), in each engine, the buttons stay on one row, no label
wraps or is clipped, and the page does not overflow. That stays true even with the application's longer label "Meal log"
and the wide Verdana font the application's 375 px specs use for Linux CI. Script: `tests/e2e/.local/layout/band.mjs`,
not committed.

**Build output.** Only the stylesheet's content changed (`index-BhEpXX7g.css`; the diff is the two declarations
above). The JavaScript is byte-identical to `index-CSFkCBR5.js`, and only its file name changed, to
`index-EGfbrE9Q.js`, because the entry's hash covers its stylesheet. `showcase-snapshot.json` is byte-identical.

## 5. What did not change

- **The other tables.** In each engine, at 1280 and 375 px, the column widths of the activity comparison table and the
  activity "every date" table are identical before and after, to 0.1 px. So are the line counts of their values and
  details. In the Every date table, only the share of width between the date and value columns changed, because the
  actions column now has its real width. At 375 px the dates still wrap at spaces ("Sat, 21 Nov / 2026"), and the
  coverage details still wrap.
- **Accessible names, focus, keyboard and navigation.** No markup changed, so the `aria-label`s ("Open Today on …",
  "Open the logged meals of …", "Open Meal log on …") are as before. The `button:focus-visible` outline rule is
  untouched. The keyboard test (Tab order, Enter on a row's Open, Back to Trends) and every navigation path in the
  showcase journey pass in all four showcase projects. The application's Trends specs, which click both actions and
  return, pass as well.

## 6. Tests added, and proof that they catch the defect

- `tests/e2e/support/trends-layout.ts`: `expectTrendsRowActionsOnOneLine(scope)` reads each row action's line boxes
  and fails if any label has more than one line or overflows its button (`scrollWidth > clientWidth`). It returns the
  number checked. A page-width check alone did not catch this defect; this check does.
- `tests/e2e/showcase/showcase.spec.ts`: a new test, "keeps each Trends row action on one line, Open alone and Open
  with Meals, at 1280 and 375 px", tagged `@cross-browser` and `@phone`, so all four showcase projects run it. It
  checks Weight (28 Open buttons) and Food energy (28 Open + 28 Meals), no horizontal scrolling, and, at 1280 px, Open
  and Meals on the same row.
- `tests/e2e/trends.spec.ts` (Open only) and `tests/e2e/trends-nutrition.spec.ts` (Open + Meal log): the same
  assertion at the default 1280 px and in the existing 375 px tests (28 and 56 buttons).

**Red before green.**

- The new showcase test **failed** against the pre-fix build: "row actions whose label wraps or is clipped", listing
  every button with `"lines": 4`.
- With only the old CSS rule put back temporarily (the development server reads the source), all four application
  tests **failed** on that same assertion, with `"lines": 4` (Open) and `"lines": 5` (Meal log).
- With the fix restored, all of them pass.

**Database used by the application specs (checked before running).** The application specs create the demo people
through the `demoScenario` fixture, and the `_test` guard in `tests/e2e/support/environment.ts` refuses any other
database. No shell variable overrode `.env`. All three URLs point at `127.0.0.1:5433`, database
`running_tracker_test`, as the roles `running_tracker_runtime`, `running_tracker_maintenance` and
`running_tracker_owner`. That is the local Docker container `running-tracker-postgres-1` (healthy), where `psql` listed
the database and those roles. The fixture's cleanup removes the scenario's records.

## 7. Checks run (local)

| Check | Result |
|---|---|
| New showcase test against the pre-fix build (`showcase-chromium`) | **failed** as intended (all 28 Open labels on 4 lines) |
| Application `trends.spec.ts` (2 tests) and `trends-nutrition.spec.ts` (2 tests) with the old rule restored | **4 failed** as intended, each on the new assertion |
| `npm run test:e2e:showcase` (`showcase-chromium`, `showcase-firefox`) | **14 passed** (10 + 4) |
| `npm run e2e:webkit:showcase -w @running-tracker/e2e` (`showcase-webkit`, `showcase-webkit-phone`) | **15 passed** (10 + 5) |
| `playwright test --project=chromium trends.spec.ts trends-nutrition.spec.ts` (the filter also selects `activity-trends.spec.ts`) | **8 passed**: Trends 3, nutrition Trends 2, activity Trends 3 |
| `npm run verify` (lint, typecheck, unit tests, build), first run, before the ESLint ignore of section 7.1 | `npm run verify` itself **failed at lint**, only on git-ignored agent scripts under `tests/e2e/.local/` (`hosted/` and `screenshots/` from steps 8–9, and `layout/` from this repair), which ESLint reads because it does not use `.gitignore`. No tracked file had a problem. The same chain with only that folder excluded (`eslint . --ignore-pattern "tests/e2e/.local/**"`, then `npm run typecheck`, `npm test` and `npm run build`) **passed**: lint clean; typecheck clean; tests 130 (migration scripts) + 2832 + 1523 + 325 + 14 + 3, 0 failed; build OK (only Vite's existing large-chunk warning for Mapbox) |
| `git diff --check` | clean (exit 0); the new files have no whitespace errors |
| `npm run verify`, second run, after the ESLint ignore, with no command-line exclusion | **passed** (exit 0); see section 7.1 |
| `git diff --check`, after the ESLint ignore | clean (exit 0) |

Not run: the WebKit dev-server and production-build projects, the Firefox core gate, the full Chromium and OIDC suites,
integration tests and the pre-demo smoke. The change is one CSS rule in the Trends table, which the showcase and the
focused Trends specs above cover.

### 7.1 Lint scope: the git-ignored scratch folder (follow-up, 2026-11-24)

The first `npm run verify` above failed because ESLint does not read `.gitignore`. It linted the agent-run scratch
scripts in the git-ignored `tests/e2e/.local/`: `hosted/` and `screenshots/` from steps 8–9, and `layout/` from this
repair. Those scripts have no tsconfig, so the type-aware parser could not load them, and the `.mjs` ones lacked browser
globals. That result is kept above as recorded.

- **Change.** `eslint.config.js` gets one more entry in its existing global `ignores` list: `'tests/e2e/.local/**'`,
  with a comment explaining it. It is anchored at the repository root. No rule, `files` block, parser option or other
  pattern changed, so `tests/e2e/**/*.ts` and its `support/`, `showcase/` and other tracked folders are linted as before.
- **Scope checked.**
  - `npx eslint tests/e2e/.local/layout/measure.mjs` now reports "File ignored because of a matching ignore pattern".
  - `npx eslint` on `tests/e2e/support/trends-layout.ts`, `tests/e2e/showcase/showcase.spec.ts`,
    `tests/e2e/trends.spec.ts` and `tests/e2e/trends-nutrition.spec.ts` lints all four with the type-aware rules (0
    errors, 0 warnings; the existing `unbound-method` suppressions in `showcase.spec.ts` are still reported as
    suppressed, so those rules run).
- **Scratch scripts preserved.** All files under `tests/e2e/.local/` (`hosted/`, `layout/`, `screenshots/` with their
  results and outputs) are still on disk, untouched.
- **Second run.** The standard `npm run verify`, with no command-line exclusion, **passed (exit 0)**:
  - lint clean;
  - typecheck clean;
  - tests: 130 migration-script tests and 2832 + 1523 + 325 + 14 + 3 workspace tests, 0 failed;
  - build OK, with only Vite's existing large-chunk warning for Mapbox.
- **Then** `git diff --check`: clean (exit 0).

## 8. Screenshots

Under [docs/assets/evidence/trends-row-actions-2026-11-24/](../assets/evidence/trends-row-actions-2026-11-24/).
Playwright Chromium 153.0.8010.12, headless, scale 1, `en-GB`, `Europe/Warsaw`, viewport screenshots with animations
disabled, Food energy series.

- Showcase images: the local `vite preview` builds of section 3 (before) and section 4 (after), end date Sat 21 Nov 2026.
- Application images: the development server with the old rule and with the fix. The demo runner logged one synthetic
  entry ("Soup", 350.5 kcal) for 24 Nov 2026 through the Meal log, in `running_tracker_test`. Capture spec:
  `tests/e2e/.local/layout/app-trends-shot.spec.ts`, not committed.

| File | Size | SHA-256 | Shows |
|---|---|---|---|
| `showcase-1280-food-energy-before.png` | 1280 × 900, 51,447 B | `b61798d2…3307fec8`¹ | Open and Meals one letter per line, stacked |
| `showcase-1280-food-energy-after.png` | 1280 × 900, 104,008 B | `18fbf428…c78633d0`¹ | Open and Meals on one line each, side by side |
| `showcase-375-food-energy-before.png` | 375 × 812, 29,028 B | `a8185150…2d77e48a`¹ | Labels one letter per line |
| `showcase-375-food-energy-after.png` | 375 × 812, 55,855 B | `df34751a…0d1ed852`¹ | Labels on one line, buttons stacked; dates and details wrap |
| `app-1280-food-energy-before.png` | 1280 × 900, 74,252 B | `dde97e8b…19ece887`¹ | Application: "Open" and "Meal log" broken over 4 and 5 lines |
| `app-1280-food-energy-after.png` | 1280 × 900, 88,531 B | `dda1d175…e9ec8d8a`¹ | Application: one line each, side by side |
| `app-375-food-energy-before.png` | 375 × 812, 40,416 B | `c013425d…6bb76419`¹ | Application at 375 px, before |
| `app-375-food-energy-after.png` | 375 × 812, 51,805 B | `d07fefa2…1aaad280`¹ | Application at 375 px: one line each, stacked |

¹ Full digests:
`b61798d2ec075dd7535bc872c578423886c289b6fe1d294b9ee662fa3307fec8`,
`18fbf4286eaca8fb48dddcb7b5ba6e2d9757cd6c1dfa52c606f233ddc78633d0`,
`a818515055a399301490d09c239bfbe304a4840ce8611e45e98839b22d77e48a`,
`df34751ad9e85684b2ac137ebcb6ed6f72c25e8e7a07b7787c4fff9a0d1ed852`,
`dde97e8b7ed8aa4b2509b34ffafaac17ad80c30a4ca06f6ff22f041c19ece887`,
`dda1d1759eb206b361bfac581990077663c6a27c269b5ae9d9d57777e9ec8d8a`,
`c013425d14562d3887f458a7c41cc5ba9bbb01cdee716e967594fc006bb76419`,
`d07fefa22ee0ae81e7660ff1db3099303ead2d55ed52272d1cbde2ae1aaad280` (table order).

Each image was opened and inspected, and each contains synthetic data only. The step-9 README screenshots in
`docs/assets/screenshots/` are unchanged. They frame the Trends summary and chart above the table, so they never showed
the defect, and they stay dated evidence of the live site at `3bbe2b2`.

## 9. Local versus hosted

All of the above is local. **The live showcase at <https://alextikhon.github.io/SomaLane/> still serves `3bbe2b2`, with
the defect,** until this change is committed, pushed and published by the Pages workflow. Hosted CI and the hosted
checks for the commit to tag belong to step 10, which this change does not start.

## 10. Remaining issues

- After the fix, the activity comparison table's last column ("Change") still has `width: 1%` from the shared rule.
  It was measured as unaffected (its values fit on one line at 1280 px, and its widths are identical before and after)
  and was deliberately left alone.
- Building `@running-tracker/contracts` rewrites `packages/contracts/openapi/openapi.json` with byte-identical
  content. With `core.autocrlf=true`, `git status` may then list it as modified, while `git diff` is empty. This is
  not part of this change.
