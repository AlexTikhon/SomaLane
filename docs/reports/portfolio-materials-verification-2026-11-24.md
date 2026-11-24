# Verification report: portfolio materials, screenshots, changelog and licence (release step 9)

- Date: 2026-11-24
- Change: documentation and image assets only. No application, API, authentication, workflow, dependency or
  `package.json` change. [Release plan, step 9](../portfolio-v1-release-plan.md#step-9-portfolio-materials-screenshots-changelog-and-licence).
- **Owner decisions:** licence **MIT**, with the copyright line "Copyright (c) 2026 Alex Tikhon".
- Baseline: `main` at `8ab6c5c`, which holds the step-8 documentation (committed, one commit ahead of `origin/main`,
  not pushed). The step-8 report, release-plan entries and other historical evidence are carried forward unchanged.
- Kinds of evidence: **fresh checks** run in this change on the Windows 11 workstation, plus **agent-run captures**
  from the live showcase. Node 24.11.1 and `@playwright/test` 1.63.0 with its Chromium 153.0.8010.12, headless. No
  physical device, Safari or phone was used.

## 1. Deliverables

| Deliverable | File | Notes |
|---|---|---|
| README | [README.md](../../README.md) | Rewritten as an entry point: what it does, the primary journey with four screenshots, the showcase link, architecture and the strongest decisions, local setup with runbook links, verification, limitations, status and licence. Release-process detail moved behind links to the release plan; test counts removed |
| Screenshots | [docs/assets/screenshots/](../assets/screenshots/) | Four PNGs from the live showcase (section 2) |
| Interview package | [docs/interview.md](../interview.md) | Full rewrite for SomaLane, replacing the Running Tracker framing and its in-place status corrections. Contains a pitch, architecture with the showcase boundary, delivery semantics, three stories (deterministic analytics; RLS isolation; offline recovery, idempotency and writer fencing), shorter notes on SSE, archive revisions and restore, follow-up questions, a public-showcase walkthrough, the local engineering demo, scaling, AI status and what is not established |
| Changelog | [CHANGELOG.md](../../CHANGELOG.md) | Milestones from the Git history; portfolio v1 under "Unreleased" (section 5) |
| Licence | [LICENSE](../../LICENSE) | Standard MIT text, "Copyright (c) 2026 Alex Tikhon" (section 4) |
| Status | [release plan](../portfolio-v1-release-plan.md), [progress](../progress.md), [product direction](../product-direction.md) | Step 9 done, step 10 next |

## 2. Screenshots

| Item | Value |
|---|---|
| Source URL | <https://alextikhon.github.io/SomaLane/> |
| Published commit | `3bbe2b2f44ba57aba52ecbc8f5087f43b6cf5095`, GitHub Pages deployment 8026957134 (Pages run 45387434787). `gh api repos/AlexTikhon/SomaLane/deployments` listed it as the latest deployment before the capture |
| Proof that the live site is that commit | The live `showcase-snapshot.json` SHA-256 `8ccbbcd0406a11a0467bb2d915bb565c42b5147b9ace23692e154388b4fd7628` equals `git show 3bbe2b2:apps/web/showcase/public/showcase-snapshot.json`; the live page loads `assets/index-CSFkCBR5.js` and `assets/index-DeAHiD62.css`, the asset names recorded in step 8 |
| Capture time | 2026-11-24, 12:20:50–12:21:00 UTC |
| Browser and settings | Playwright Chromium 153.0.8010.12, headless; viewport **1280 × 900**, device scale factor 1, locale `en-GB`, time zone `Europe/Warsaw`; viewport screenshots (not full page), animations disabled, caret hidden, focus cleared |
| Requests during the capture | Exactly 4, all `GET` to `https://alextikhon.github.io/SomaLane/`: the page, `assets/index-CSFkCBR5.js`, `assets/index-DeAHiD62.css`, `showcase-snapshot.json` |
| How | An agent-run Playwright script in the git-ignored `tests/e2e/.local/screenshots/`, not committed. It uses the step-7 browser check's selectors and asserts the label "Read-only showcase · synthetic data" is in the viewport before each capture |

| File | Bytes | SHA-256 | What it shows | How it was reached |
|---|---|---|---|---|
| `showcase-today.png` | 274,159 | `a9d40c7d…81efae00`¹ | Today, Sat 21 Nov 2026 (sample date): check-in with soreness "Not recorded", steps and active energy, meals, manual activities | Page load |
| `showcase-weekly-review.png` | 265,095 | `ce3bb024…aebce9bc`¹ | Weekly review 9–15 Nov 2026: coverage sentences with explicit denominators | Date → Sun 15 Nov, **Weekly review of …** |
| `showcase-trends-food-energy.png` | 117,022 | `9315974b…402bc3e`¹ | Trends, 28 days ending Sun 15 Nov 2026, Food energy: 21 of 28 days, 53 of 58 entries, "unknown, not zero", a chart with gaps | **Open 28-day trends ending on Sun, 15 Nov 2026**, series Food energy, scrolled so the range line sits under the sticky label |
| `showcase-logged-meals.png` | 251,306 | `873a5a20…7eb005d`¹ | Logged meals of Sat 14 Nov 2026: two entries, the lunch with carbohydrate and fat "Not recorded" | Table row **Open the logged meals of Sat, 14 Nov 2026** |

¹ Full digests:
`a9d40c7d029c8a3e213d5527f0094c608bbb54a7a955723a678e786b81efae00` (Today),
`ce3bb0240315597b34c9671f306f12cf012195ecd4e667025d8ba5a4aebce9bc` (Weekly review),
`9315974b9db01e40949eb3c87632baccb5da2ceae2ebb03f7a12fe750402bc3e` (Trends),
`873a5a204617defdcf3b63f9a50c05d70c4e16f7606d67ae00006544b7eb005d` (Logged meals). All four are 1280 × 900 PNGs
(read from their headers).

**Inspection.** Each image was opened and checked by eye after the capture. All four show the label "Read-only
showcase · synthetic data". Three show the full banner, with "Generated data of one fictional person …", the "Source
code on GitHub" link and the local-application sentence; the scrolled Trends image shows the sticky label line. The
content is the synthetic snapshot only: generic meal titles ("Yoghurt with granola", "Canteen salad"), dates within the
dataset's 27 Sep–21 Nov 2026 range, and the time zone Europe/Warsaw. No real person, name, email address, account,
location, map, browser chrome, developer tool or AI output appears. No real health data was used anywhere in step 9.

The README presents them in a two-column table, each with alt text that states what it shows and a caption, and
records the source, viewport, date and published commit under the table.

## 3. Public claims checked against their evidence

Each current-tense claim in the README and the interview package was checked against the code at `8ab6c5c` or
against a row of [release plan, section 5](../portfolio-v1-release-plan.md#5-capability-claims-and-the-evidence-each-needs).

| Claim | Evidence checked |
|---|---|
| Showcase published at the Pages URL, static, no API, no sign-in, no storage | Section 5 row "Public read-only showcase": met (step 8, H1–H11). Re-observed in this capture: 4 same-origin `GET`s |
| Full application runs locally; not hosted; real sign-in, hosting and hosted restore deferred | Section 5 rows "Real sign-in", "Hosted full application", "Backup and restore of hosted data"; section 6.1 |
| Trends: one `REPEATABLE READ READ ONLY` transaction, fixed statements, `GROUPING SETS`, per-nutrient `count`/`sum`, `NULL` when none, integer tenths, throws on unexpected sums | `apps/api/src/daily-trends/daily-trends-service.ts` (header comment and `dailyTrendsMealsSql`), `apps/api/src/meals/meal-nutrition-summary.ts` (`nutritionTenthsOf`) |
| The contract checks recorded entries ≤ logged entries and that the range equals the sum of the dates | `packages/contracts/src/daily-trends.ts` (`superRefine` and the `summarizeDailyTrendDays` message) |
| Weekly review written by code, computed on every read, imports no model provider | `apps/api/src/insights/weekly-review.ts` and `weekly-review-service.ts` (header comments) |
| `set_config(..., true)` tenant context | `apps/api/src/database/tenant-transaction.ts` |
| Meals owner-only under RLS | `db/migrations/0039_meals.sql` (`meals_select_owner`, `meals_insert_owner`, `meals_update_owner`, `meals_delete_owner`); `apps/api/test/meals-access.integration.test.ts` test names |
| SQL budgets 5 s / 2 s; SSE poll 2 s, 64 connections, concurrency 2, 10 s backpressure; journal export 30 s; summary interval 60 s | Defaults in `apps/api/src/config/environment.ts` |
| Development sign-in refused with `APP_ENV=production` | `apps/api/src/config/environment.ts` (the `LOCAL_AUTH_ENABLED must be false in production` refinement) |
| Batches of 100, 1 s base, 30 s cap | `apps/web/src/point-upload-worker.ts` (`BATCH_LIMIT`, `BASE_RETRY_MS`, `MAX_RETRY_MS`) |
| Run row locked, `409 POINT_CONFLICT` on a changed payload | `apps/api/src/runs/run-service.ts` (`ingestRunPoints`, `FOR UPDATE`) |
| 15 s lease with a fencing token; Web Lock presence | `apps/web/src/writer-lease.ts`, `apps/web/src/writer-presence.ts` |
| Firefox core gate covers reload/offline and second tab | `firefoxCoreSpecs` in `tests/e2e/playwright.config.ts` |
| Sessions and pending OIDC logins in PostgreSQL; restart keeps them; restore clears them | `apps/api/src/main.ts` (`PostgresSessionStore`, `PostgresPendingLoginStore`); `apps/api/test/session-restart.integration.test.ts`; `restore:clear-sessions` in `package.json` |
| Restore order deletions → access → erasures → clear sessions | `package.json` scripts; release plan 6.1; [deletion-journal runbook](../runbooks/deletion-journal-and-recovery.md#restore-procedure-ordered) |
| The restore drill runs in CI on throwaway databases, and no host's backup has been restored | `.github/workflows/ci.yml` (integration job comment naming `backup-restore.integration.test.ts`); section 5 row "Backup and restore of hosted data" |
| Two SDD endpoints not built (`/archive/runs`, `/live/nearby`) | `x-implemented` appears twice in `packages/contracts/openapi/openapi.json`; `docs/reference.md`. The old interview's "three" was outdated (ADR-0066 built the track read) |
| Showcase module boundary | `apps/web/src/showcase/showcase-boundary.spec.ts` (header comment) |
| AI off by default and its evaluation status | Release plan section 2.1 (unchanged; no inference rerun) |
| CI run 45385170103 for `3bbe2b2` succeeded | Step-8 report section 1; `gh run list --workflow ci.yml` on 2026-11-24 |
| Desktop-scoped; no Safari, phone, real GPS, basemap or AI-quality claim | Section 5 rows marked "must not be claimed": the README and interview state each as a limitation |

The historical P11 load figures (2026-09-30) and the restore drill (2026-10-01) are quoted with their dates, workload
and machine. Test counts were removed from the README rather than refreshed, because they go stale.

## 4. Licence

- `LICENSE` is GitHub's MIT template, the source of <https://choosealicense.com/licenses/mit/>, fetched with
  `gh api licenses/mit --jq .body`. Only `[year] [fullname]` was replaced with `2026 Alex Tikhon`. `diff` against the
  template with that one substitution shows no difference except the template output's extra final newline.
- The README links to it from a badge and from its "Licence" section.
- No `package.json` was changed: all seven keep `"private": true` (root, `apps/api`, `apps/web`,
  `packages/contracts`, `packages/fixtures`, `tools/simulator`, `tests/e2e`), and no `license` field was added, so
  `package-lock.json` is untouched.
- The repository had no third-party notice file (`git ls-files` has no LICENSE, NOTICE or COPYING file), so none
  needed preserving; dependencies keep their own licences in their packages.

## 5. Changelog sources

`CHANGELOG.md` summarises `git log` (287 commits on `main` before this change, 2026-09-19 to 2026-11-24). `git tag`
lists no tags. It invents no version number, release date or completed release. Portfolio v1 steps 1–9 are under
"Unreleased", and the earlier work is grouped into four dated periods with its ADR numbers, each of which was checked
to exist in `docs/adr/`.

## 6. Link, anchor, image and Markdown checks

- A Node script (scratchpad, not committed) extracted every Markdown link and image from the changed and new files:
  `README.md`, `CHANGELOG.md`, `docs/interview.md`, this report, `docs/portfolio-v1-release-plan.md`,
  `docs/progress.md` (the new entry) and `docs/product-direction.md`. It resolved each relative path from the file's
  directory and checked that it exists. For each `#anchor`, it checked that a heading in the target produces that
  GitHub slug. Result in [the progress entry](../progress.md#portfolio-v1-release-step-9-portfolio-materials-screenshots-changelog-and-licence-2026-11-24).
- The four image paths in the README exist; each image is used once, as both the image and its link target.
- The Mermaid block in `docs/interview.md` uses only `flowchart`, `subgraph`, edges and quoted labels with `<br/>`,
  the same constructs as the block it replaces. Its rendering on GitHub was not checked, because nothing was pushed.
- `git diff --check`: clean.

## 7. Not run in this step

- `npm run verify`, the integration suite, the browser suites and any database or demo: not needed for documentation
  and assets, and excluded by the task. No database-writing command was started.
- No hosted CI run, Pages dispatch, push, commit, tag or GitHub release. **The new README, screenshots, changelog and
  licence are not on GitHub until they are committed and pushed.** The live showcase is unchanged (still `3bbe2b2`).

## 8. Findings

1. **Trends table row buttons wrap one letter per line at desktop width (recorded defect, not fixed).** On the live
   showcase at 1280 px, the last cell of every Trends table row is 50 px wide, and its "Open" button is 39 × 98 px,
   with "Open" and "Meals" stacked letter by letter. Cause, in the shared stylesheet `apps/web/src/styles.css`:
   `.trends-table td:last-child { width: 1% }` together with `overflow-wrap: anywhere` on every table cell shrinks the
   cell to a one-character min-content width. The application's Trends screen uses the same stylesheet and most
   likely shows the same layout; that was not checked, since no application was run in this step. The buttons still
   work: the step-5 to step-8 browser checks click them, and the keyboard test focuses them. The screenshots frame the
   Trends summary and chart above the table. A fix changes application CSS, so it is left for an explicit decision
   before step 10 (the release plan allows only recorded defects to change).
2. `docs/pause-handoff.md` and `docs/implementation-plan.md` still carry their dated "current status (2026-11-22)"
   sections naming step 2 as next. They are dated snapshots under the release plan's authority clause and were not
   rewritten here; step 10's final status pass can reconcile them.
3. `docs/reference.md` and older reports keep their historical test counts. The README no longer repeats any of them.

## 9. Outcome

Step 9's acceptance holds:

- **README and screenshots:** both exist; the screenshots come from the hosted showcase and use synthetic data only.
- **Interview package:** rewritten in full.
- **CHANGELOG:** exists.
- **Licence:** decided as MIT, recorded and applied.
- **Public claims:** each maps to a section-5 row with existing evidence, or to the code.
- **Deferred scope:** stated wherever it matters (local full application; no real identity provider, hosted
  application or hosted restore).

**Step 9 is complete. Step 10 (final verification, release tag and project freeze) is next.**

## 10. Review corrections (2026-11-24)

A review of step 9 found four documentation problems. All four are corrected in the documents below. No code, CSS,
screenshot, licence or changelog changed, and the Trends layout defect (section 8, finding 1) stays open.

| # | Finding | Correction | Checked against |
|---|---|---|---|
| 1 | The README stated absolute recovery and security guarantees: "Deleted stays deleted after a restore", "journaled off the database host", "A showcase that cannot leak" | The recovery bullet now says that a restore replays the **exported** journals, and that a change not exported before the host is lost can reappear (one export interval plus any backlog, with a link to the recovery limits). It also says that off-host storage for `DELETION_JOURNAL_DIR` must be configured by the operator. The showcase bullet now lists the tested boundaries: the module-graph test; the allowlisted, contract-validated synthetic snapshot; the pre-publication browser check that fails on `/api`, other paths or origins, and storage writes; and the same request and storage checks against the live site. `docs/interview.md`'s restore note no longer says the job exports "off the database host"; it exports files to `DELETION_JOURNAL_DIR`, and placing that directory off-host is the operator's job | [Deletion-journal runbook](../runbooks/deletion-journal-and-recovery.md) (the `DELETION_JOURNAL_DIR` row: "The application cannot check that the mount is really off-host or durable"; [failure modes](../runbooks/deletion-journal-and-recovery.md#failure-modes-and-honest-limits)); `tests/e2e/showcase/showcase.spec.ts` (request guard, storage instrumentation, `NO_STORAGE`); `apps/web/src/showcase/showcase-boundary.spec.ts`; [showcase runbook, section 5](../runbooks/showcase.md#5-what-the-snapshot-contains-an-allowlist); step-8 report H9 and H10 |
| 2 | `docs/interview.md` credited SSE with "native reconnects" | The interview now describes `CoachLiveClient`. On an error it closes the EventSource and clears positions. It then retries after 1, 2 and 4 seconds, resetting after a valid state, and schedules no automatic attempt that would not start before the session expires. The **Reconnect** button stays for a manual retry | `apps/web/src/coach-live-client.ts` (`defaultReconnectDelaysMs = [1_000, 2_000, 4_000]`, `source.close()` in `onerror`, `#scheduleAutomaticReconnect`, `retryNow`); `apps/web/src/CoachScreen.tsx` (the Reconnect button on `disconnected` or `error`) |
| 3 | The README architecture block put "HTTPS" on the browser-to-API path for every setup | It now says that the local default is HTTP on `127.0.0.1:5173`, with Vite proxying `/api`. HTTPS comes only through nginx in the configured production, loopback-TLS and iPhone pilot profiles | `apps/web/vite.config.ts`; `infra/compose/` (`docker-compose.production.yml`, `docker-compose.transport.yml`, `docker-compose.lan-pilot.yml`); README "Run it locally" (`http://127.0.0.1:5173`) |
| 4 | `docs/runbooks/showcase.md` linked to `README.md#quick-start`, a heading removed in step 9 | The link is now `[README, Run it locally](../../README.md#run-it-locally)` | The README heading "Run it locally" |

Two rows of section 3 are superseded on these points. "Restore order …" is unchanged, but the README now states the
export window and the operator's responsibility next to it. "Showcase module boundary" is now one of several tested
boundaries the README lists, not a claim that the showcase "cannot leak".

**Checks.**

- The link checker of section 6 was run on `README.md`, `docs/interview.md`, `docs/runbooks/showcase.md` and this
  report: every relative link, anchor and image path resolves.
- Incoming references to the README and interview headings renamed in step 9 were searched for with
  `git grep -n -iE "README(\.md)?#|interview\.md#"` across the repository, `docs/progress.md` included. The only one
  was the runbook link fixed above. This correction renames no heading.
- `git diff --check`: clean.
- Nothing was staged, committed, pushed, deployed or tagged.

## 11. Finding 1 repaired (2026-11-24)

Section 8, finding 1 is kept above as recorded. It was repaired after this report, before step 10, in a separate
change: [Trends table row-action layout repair](trends-row-actions-repair-2026-11-24.md). One CSS rule changed in
`apps/web/src/styles.css`, and a browser assertion was added that counts each label's line boxes. The repair report
confirms that the application showed the same defect. The four screenshots of section 2 are unchanged and remain dated
evidence of the live site at `3bbe2b2`, which still has the defect until the next publication.
