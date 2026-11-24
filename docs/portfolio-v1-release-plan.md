# SomaLane portfolio v1: release plan

- Status: **active**. Steps 1 (this document), 2 (the isolated 56-date synthetic dataset), 3 (navigation and first-use
  flow), 4 (measured initial-bundle reduction; its full-suite gate closed by hosted CI run 45055752618 on 2026-11-23) and
  5 (the public read-only synthetic showcase, 2026-11-23, local evidence) and 6 (the bounded WebKit gate, 2026-11-23,
  local evidence; physical Safari checklist NOT RUN, so the release is desktop-scoped) and 7 (static publication
  preparation for GitHub Pages, 2026-11-24, local evidence) and 8 (the showcase published on GitHub Pages at
  <https://alextikhon.github.io/SomaLane/> from `3bbe2b2`, 2026-11-24: hosted CI run 45385170103, Pages run 45387434787,
  hosted checks H1–H11 passed) and 9 (portfolio materials, screenshots of the live showcase, a changelog and the MIT
  licence, 2026-11-24) of 10 are done. The **next task is step 10** (final verification, release tag and project
  freeze). Step 9's recorded Trends row-action defect was repaired before step 10 (2026-11-24, one CSS rule, local
  evidence; [report](reports/trends-row-actions-repair-2026-11-24.md)). The live showcase shows it until the next
  publication.
- **Scope change (2026-11-24, the owner's decision).** Only the public read-only synthetic showcase is published (on
  GitHub Pages), and the full application stays available for local demonstrations. Deferred: real external OIDC
  verification, full-application hosting and hosted backup/restore verification
  ([section 6.1](#61-deferred-by-the-scope-change-of-2026-11-24)). The full application's existing authentication and
  production safeguards stay as they are. Steps 7–10 were replanned; steps 1–6 and their evidence are unchanged.
- Date: 2026-11-22. Baseline: `main` at `6f3dc46` (Nutrition Trends v2, ADR-0096). Replanned on 2026-11-24 at
  `68b5e4b`.
- Authority: this is the single source of truth for what portfolio v1 contains, which evidence it needs, and what is
  deferred. Where an older document names a different "next milestone" (for example the iPhone pilot of ADR-0085 as
  the next step in a dated section of [product-direction.md](product-direction.md)), this plan takes precedence. Older
  plans, reports and dated measurements are historical snapshots and are not rewritten.

The project leaves open-ended slice-by-slice development and enters a finite release-preparation phase. The phase ends
when the ten steps below are done and the mandatory gates hold. No new product feature belongs to this phase unless a
step below names it.

## 1. What portfolio v1 is

**Product.** A personal activity, health and nutrition tracker with deterministic analytics and optional, experimental
AI. Code computes every number; a model, when one is configured, only proposes, and the person confirms. Every AI
feature is off by default and stays off in the release.

**Primary journey** (what a visitor should see first and understand):

> daily records → **Today** → **weekly review** → **Trends** → back to the original records

Daily records are the check-in, movement, manual activities, GPX/TCX imports and the meal log. Today shows one day,
the weekly review one Monday-to-Sunday week, Trends 28 dates (with the previous 28 for activity comparisons), and each
of them leads back to the records it was computed from.

**Secondary engineering demonstration** (what an engineer reviewing the project should be able to watch):

> simulated run → offline / reload recovery → explicit live sharing with a coach → finished result and archive

It uses the existing GPS simulator, IndexedDB buffer, fenced writer lease, SSE live board and revision-bound archive.
It is a demonstration of failure handling, not a claim about phone GPS.

**Publication model** (changed on 2026-11-24; until then the full application was also to be hosted). One published
surface, plus the full application for local demonstrations:

1. **Public read-only showcase.** Openly accessible, labelled on every screen as a read-only showcase of synthetic
   data. It is built from synthetic snapshots of the step-2 dataset, validated by the existing contracts
   (`packages/contracts`) and rendered with the existing presentational components wherever that is practical. It
   writes nothing and sends no request to a private API route. It is published as static files on GitHub Pages (expected
   at `https://alextikhon.github.io/SomaLane/`, [ADR-0101](adr/0101-github-pages-showcase-publication.md)) and links
   to the public source repository.
2. **Full application, local only.** The real app runs on a workstation from the source, with synthetic data only:
   `npm run demo:up`, the step-2 dataset launchers, or the iPhone LAN pilot. Its production profile
   ([ADR-0043](adr/0043-single-host-deployment-profile.md)) and invite-only OpenID Connect sign-in
   ([ADR-0046](adr/0046-oidc-sign-in.md)) stay implemented, tested and guarded as they are. No host runs them and no real
   provider has verified them; hosting is deferred ([section 6.1](#61-deferred-by-the-scope-change-of-2026-11-24)).

**Guardrails.**

- No anonymous access to any private API route (the organization-scoped `/api/orgs/:orgId/...` routes and every other
  route that requires a session). The showcase must not add an anonymous or "demo" path into the API.
- Development sign-in stays off in production: `LOCAL_AUTH_ENABLED` must remain `false` when `APP_ENV=production`,
  which the configuration already refuses otherwise (`apps/api/src/config/environment.ts`). The showcase must not
  depend on the demo sign-in panel.
- No real health data in the showcase, the screenshots or the portfolio materials.
- No claim of production-grade operation, mobile GPS accuracy, continuous background recording or AI quality without
  the evidence named in [section 5](#5-capability-claims-and-the-evidence-each-needs).

## 2. Evidence vocabulary

Every status statement in this plan and in the documents that link to it uses one of these kinds of evidence, and says
which.

| Kind | Meaning | Current example |
|---|---|---|
| **Hosted CI** | A GitHub Actions run of `.github/workflows/ci.yml` for a named commit, checked at its source | Run [44885261535](https://github.com/AlexTikhon/SomaLane/actions/runs/44885261535) for `6f3dc46`: conclusion `success`; jobs `verify`, `integration`, `e2e (chromium 1/3, 2/3, 3/3)` and `e2e (firefox-core)` succeeded, `e2e-report` skipped. Checked with `gh run view` on 2026-11-22 |
| **Recorded local verification** | Commands run on the Windows workstation and written down in [progress.md](progress.md) or a report at the time | The ADR-0096 entry of 2026-11-21: `npm run verify` exit 0, focused integration and Chromium runs |
| **Fresh check** | A command run in the current change and reported with it | For this step: link, path and diff checks only (see the progress entry) |
| **Real-provider evidence** | Behaviour observed against a real external service (identity provider, Mapbox, OpenAI) | **None yet.** OIDC was tested only against a test provider and a local `oidc-provider` process |
| **Hosted publication** | A run of `.github/workflows/showcase-pages.yml` on `main`, and the hosted checks against the page URL that run reported | Run [45387434787](https://github.com/AlexTikhon/SomaLane/actions/runs/45387434787) for `3bbe2b2`: `build` and `deploy` succeeded, reported URL `https://alextikhon.github.io/SomaLane/`; H1–H11 passed on 2026-11-24 ([report](reports/showcase-hosted-verification-2026-11-24.md)) |
| **Physical-device evidence** | An owner's observation on a real phone, recorded in a report | **None yet.** [iphone-lan-pilot.md](reports/iphone-lan-pilot.md) lists every physical check as NOT RUN; D10 has 0 real traces |
| **AI evaluation** | A frozen evaluation gate at the current code fingerprint | See [section 2.1](#21-ai-evaluation-status) |

An earlier result is never presented as newly executed. A later step that changes code under a recorded result makes
that result historical for the new code.

### 2.1 AI evaluation status

AI is off by default in code (`MEAL_DRAFTS_PROVIDER`, `DATA_QUESTIONS_PROVIDER` and `WEEKLY_INSIGHTS_PROVIDER` default to
`off`; `RUN_SEARCH_AI_ENABLED` defaults to `false`) and stays off in every release surface.

- **Meal "Draft from text"** ([ADR-0092](adr/0092-meal-draft-from-text.md)): the latest model measurement
  ([meal-draft-v2-evaluation-2026-11-18.md](reports/meal-draft-v2-evaluation-2026-11-18.md), `qwen3:8b`, v2 sets) is a
  **model FAIL on quality** with valid evidence: recall 81.0 % below the 85 % bar, 0 incorrectly accepted values,
  failures 10.0 % at the limit. The deterministic verifier and challenge set passed. D11 (content-free diagnostics for
  title/evidence failures) is **OPEN**.
- **Ask my data** ([ADR-0094](adr/0094-ask-my-data.md), [ADR-0095](adr/0095-ask-my-data-guided-questions.md)): the
  2026-11-19 v1 measurement failed. The 2026-11-20 v2 measurement **passed** (development 20/20, held-out 19/20), but it
  was taken on the code before the same-day constraints correction (`data-question-constraints-2`); the offline gate
  now reports it **NOT_RUN** (stale fingerprint), so there is **no valid model evidence for the current code**. The
  **guided question builder and the predefined questions work without any model** and are the supported way to use the
  feature.
- **Weekly insights** ([ADR-0076](adr/0076-weekly-insights.md)) and **run search in words**
  ([ADR-0057](adr/0057-natural-language-filter-proposals.md)): no model tried met the target; OpenAI has never been called.

This phase reruns no inference, changes no evaluation dataset and weakens no gate.

## 3. The ten release steps

Each step is one bounded change (or a small, reviewed series), ends with a progress entry naming the checks actually
run, and updates the [status table](#8-status) below. A step adds no feature beyond its outcome.

### Step 1. Release scope and current documentation (this change)

- **Outcome.** This plan exists; README, product direction, pause handoff, implementation plan and the interview package
  link to it and no longer state outdated current facts (sessions in memory, iPhone pilot as the next milestone).
- **Depends on.** Nothing.
- **Acceptance.** The plan names the product, journeys, publication model, ten steps, gates, capability evidence,
  deferrals and external inputs; every changed local link resolves; the interview package's architecture claims match
  `apps/api/src/main.ts`; `git diff --check` is clean; no runtime file changed.

### Step 2. Reproducible, isolated synthetic dataset over 56 calendar dates

- **Outcome.** One documented command creates a synthetic dataset for one demo person (and the coach identity the
  secondary demonstration needs) covering **56 consecutive local calendar dates**, so that a 28-date Trends range and
  its previous 28 dates are both populated. It includes check-ins, movement, manual activities, at least one GPX and one
  TCX import, finished simulated runs with published summaries, and meals with partial nutrition. Deliberate gaps and
  partial records make every coverage statement meaningful (a missing value, a recorded zero and an unlogged day all
  appear).
- **Depends on.** Step 1.
- **Acceptance.**
  - It writes only to a **dedicated, isolated demo database** (its own database or its own Compose project), never to a
    database shared with other work.
  - It **unconditionally refuses** the existing development database (`running_tracker`) and the shared test database
    (`running_tracker_test`). No flag, variable or option overrides this.
  - It refuses any non-local target and `APP_ENV=production`.
  - **Before any mutation** it verifies, read-only, the database it is actually connected to: the current database name,
    the server endpoint and the expected role identities. It stops if any of them differs. Configuration values (URLs,
    environment names) do not establish isolation on their own.
  - Reruns are idempotent. If an explicit reset is added later, it operates only on the dedicated demo database that the
    read-only check above has just verified.
  - The same inputs (seed and anchor date, both documented) produce the same rows, and a test proves this, for example by
    comparing a digest of the seeded values across two runs. Automated seed tests use their own isolated, throwaway
    database, separate from the shared test database (`running_tracker_test`).
  - Records are written through the existing contracts and rules (owner-only RLS, server-owned provenance, local dates),
    not by bypassing them in ways the application could never produce.
  - With the dataset loaded, Today, the weekly review and Trends (nutrition and activity, including the previous-period
    comparison) show non-empty values with the coverage the dataset documents for named dates.
  - Nothing in it is real personal data; a runbook names what it contains.
- **Not in this step.** No showcase, no navigation change, no deployment.
- **Status: done (2026-11-22, fresh checks).** `npm run portfolio:dataset` ([runbook](runbooks/portfolio-dataset.md)):
  its own Compose project and PostgreSQL server, isolation proven by the server's system identifier read inside the
  owned container and over every TCP connection, writes through the application's services, a canonical digest
  (default seed and anchor 2026-11-21: `sha256:b622…857d`). Evidence:
  [verification report](reports/portfolio-dataset-verification-2026-11-22.md): 78 unit tests, `npm run verify`, 16
  real-PostgreSQL tests on throwaway databases inside the dataset server (seeding, rerun, digest agreement,
  interruption and resume, conflicts, concurrency, read models against the plan, summaries, provenance, coach and
  outsider isolation), and a Chromium walkthrough of the populated screens. Two defects found by the independent review
  (inherited variables could redirect the populated app; changed run data was accepted as complete) were fixed the same
  day: a single launcher that takes its configuration only from the dataset's settings and proves its database targets
  (`npm run portfolio:dataset:api`/`:web`), and full run-state validation plus a recorded-digest check in the core
  writer; re-verified in the report's "Review repair" section.

### Step 3. Navigation and first-use flow

- **Outcome.** A first-time visitor (and the synthetic person) can follow the primary journey without knowing the app:
  records → Today → weekly review → Trends → records. Today the page opens on Runner because Runner's startup restores
  and recovers an active run (`apps/web/src/App.tsx`, ADR-0082), and the weekly review lives inside the Check-in tab
  (`DailyCheckInScreen.tsx`). This step makes the journey discoverable while keeping both properties below.
- **Depends on.** Step 2 (to check the flow with populated data).
- **Acceptance.**
  - The primary journey is reachable from the primary navigation and covered by a Chromium end-to-end scenario on the
    step-2 dataset.
  - **Active-run recovery is preserved**: a reload during a recorded run still restores and resumes it, whatever view
    opens first (the existing `reload-offline`, `runner-recovery` and takeover scenarios pass unchanged in intent).
  - **Capture lifetime is preserved**: navigating away from Runner does not stop capture, uploads or the writer lease
    (the ownership described in [pause-handoff.md](pause-handoff.md), "Product and operational state retained").
  - The Firefox core gate still passes.
- **Not in this step.** No new screen content, no new analytics, no routing library unless the step's ADR or progress
  entry justifies it.
- **Status: done (2026-11-22, fresh checks).** [ADR-0097](adr/0097-navigation-and-first-use-flow.md): the page opens on
  Today; the navigation leads with Today, Weekly review (its own view, composed of the existing review section) and
  Trends, then Records and Runs; a documented date policy (Today → the week of its date; Sunday or today, never later,
  for review → Trends); a compact Run status away from Runner. No routing library. Run recovery, capture, uploads and the
  writer lease stay owned by App. Evidence: [verification report](reports/navigation-first-use-verification-2026-11-22.md):
  `npm run verify`, the full Chromium/OIDC suite 192 passed (with the new primary-journey spec: journey, scope and late
  answers, capture and upload for the same run while Today and the Weekly review are shown, reload on Today restoring
  the same run and writer, 375 px and keyboard), the Firefox core gate 18 passed, and the journey on the step-2 dataset
  (read-only; dataset fingerprint unchanged). Not run in CI.

### Step 4. Measured initial-bundle reduction

- **Outcome.** Secondary screens (for example Coach, Archive, the importers, the AI panels) load on demand instead of
  with the first page. Mapbox GL's JavaScript is already loaded dynamically (`apps/web/src/mapbox-runtime.js`); only its
  stylesheet is imported eagerly.
- **Depends on.** Step 3 (the navigation decides what is primary).
- **Acceptance.**
  - The initial JavaScript and CSS sizes (raw and gzip) are measured with one documented command before and after, at
    named commits, and the reduction is reported as measured, without a promised target.
  - Runner recovery and capture code are not deferred behind a lazy boundary that a reload must wait for.
  - Loading and failure states of a lazily loaded screen are tested; the full Chromium suite and the Firefox core gate
    pass.
- **Not in this step.** No dependency replacement or framework change.
- **Status: done (2026-11-23; local checks of 2026-11-22 plus hosted CI).** Candidate commit **`dff831a`**. First
  recorded as done on 2026-11-22; corrected the same day to "implemented; verification pending" because the acceptance
  criterion "the full Chromium suite … pass[es]" had no successful full run; closed on 2026-11-23 by hosted CI run
  [45055752618](https://github.com/AlexTikhon/SomaLane/actions/runs/45055752618) (`success` for `1dac6ed`, the candidate
  plus documentation; `verify`, `integration`, `e2e (chromium 1/3, 2/3, 3/3)` and `e2e (firefox-core)` successful;
  checked with `gh run view` on 2026-11-23). [ADR-0098](adr/0098-initial-bundle-reduction.md): Coach, Archive,
  Activity, Check-in, Meal log and Runner's result load on demand as one chunk; Today, the Weekly review, Trends, Runner
  and everything App owns for run recovery and capture stay in the first page. The Mapbox stylesheet loads with the map
  runtime. Measured with `npm run measure:web-bundle` (same settings, baseline `a3bf4e2`, candidate `dff831a`):
  initial JS 799,724 → 625,755 B raw, 220,581 → 175,156 B gzip; initial CSS 91,478 → 43,020 B raw, 13,681 → 8,276 B
  gzip; the deferred chunk is 179,628 B raw / 46,896 B gzip. Evidence:
  [verification report](reports/initial-bundle-verification-2026-11-22.md): a production-build browser check
  (`npm run test:e2e:production-build`: chunk requests, loading, failure and a real retry in Chromium and Firefox,
  scope changes, recording and reload with the chunk unavailable), `npm run verify`, the full Chromium/OIDC suite (two
  runs of 190 passed and 2 failed each, four different tests, each passing when rerun alone; two traced to
  `ERR_ADDRESS_IN_USE` on API requests), the Firefox core gate 18 passed, and the read-only dataset walkthrough. These
  local checks were not run in CI; the hosted CI run that later closed the gate is recorded separately below.
- **Independent review (recorded 2026-11-22).** `npm run verify` and the E2E typecheck passed; production-build tests
  5/5; Firefox core 18/18; portfolio walkthrough 2/2 with the dataset unchanged. Full Chromium/OIDC run: 190 passed, 2
  failed during startup with `ERR_NETWORK_CHANGED` and `ERR_ADDRESS_IN_USE`; both affected cases passed twice each on
  rerun. No functional code defect was identified. Details in the report's
  [independent review](reports/initial-bundle-verification-2026-11-22.md#independent-review-recorded-2026-11-22).
- **To complete step 4 (as set on 2026-11-22):** a successful full Chromium/OIDC run, or a CI run, for the candidate.
  Rerunning individual failed cases does not close this gate.
- **Hosted CI (recorded 2026-11-23).** Run [45055752618](https://github.com/AlexTikhon/SomaLane/actions/runs/45055752618)
  for `1dac6edae7b2377e565f1460655b89063f34e107`: conclusion `success`; `verify`, `integration`, `e2e (chromium 1/3)`,
  `e2e (chromium 2/3)`, `e2e (chromium 3/3)` and `e2e (firefox-core)` succeeded, `e2e-report` skipped. `1dac6ed` differs
  from the candidate `dff831a` in documentation only. This closes the gate; the local failures above stay recorded as
  local observations ([report](reports/initial-bundle-verification-2026-11-22.md#hosted-ci-evidence-recorded-2026-11-23)).

### Step 5. Public read-only synthetic showcase

- **Outcome.** A read-only showcase of the primary journey, built from synthetic snapshots of the step-2 dataset and
  served without sign-in.
- **Depends on.** Steps 2, 3 and 4.
- **Acceptance.**
  - Snapshots are generated reproducibly from the step-2 dataset and validated by the existing contract schemas in a
    test; the showcase renders them with existing presentational components where practical.
  - Every screen carries a visible "read-only showcase, synthetic data" label and a link to the invite-only application.
  - An end-to-end test proves the showcase sends **no request to any private API route** and performs no write.
  - The production configuration guard is unchanged: `LOCAL_AUTH_ENABLED=true` with `APP_ENV=production` is still
    refused, and the showcase build contains no demo sign-in.
  - AI sections are absent or shown as "off by default" with no model output presented as product behaviour.
- **Not in this step.** No hosting (step 8), no anonymous API endpoint, no editable demo.
- **Status: done (2026-11-23, fresh local checks; not hosted, not run in CI).**
  [ADR-0099](adr/0099-public-read-only-showcase.md), [runbook](runbooks/showcase.md): a separate static build
  (`npm run build:showcase`, `apps/web/dist-showcase/`) renders the application's pure content blocks without actions
  from one committed snapshot file, exported read-only from the step-2 dataset through the read services by
  `npm run portfolio:showcase:export` (the dataset's isolation and identity guards, read-only connections, the recorded
  digest checked before and after, one fixed instant, deterministic and canonical: two exports and `--check`
  byte-identical, `sha256:a717…0a9c`). Bounded catalog from the manifest: sample date 21 Nov 2026, Trends ending 15 and
  21 Nov, 34 days, 5 weeks, 7 activity selections. Every view says "Read-only showcase · synthetic data" and links to the
  invite-only application (`SHOWCASE_APP_URL`, validated; none configured by default). Evidence:
  [verification report](reports/showcase-verification-2026-11-23.md): unit tests (envelope and contract validation of the
  committed file, catalog, normalisation, allowlist, refusals, navigation, views, module boundary);
  `npm run test:e2e:showcase` 10 passed against the static production build with no API server (journey and selection
  preservation, missing/zero/partial states, labels, every `/api` request failing the test, no mutation control, no
  storage write, keyboard, 375 px, broken snapshot files); `npm run verify`; production-build check 5 passed; full
  Chromium/OIDC 192 passed in one run; Firefox core 18 passed; dataset walkthrough 2 passed with the dataset unchanged.
  The production guard is unchanged. The application's initial JS grew by 194 B raw (83 B gzip); no showcase code or
  data is in its build. *(Amended in step 7, 2026-11-24: the application link and `SHOWCASE_APP_URL` are replaced by a
  fixed link to the source repository, [ADR-0101](adr/0101-github-pages-showcase-publication.md); the evidence above is
  kept as recorded.)*

### Step 6. Bounded WebKit/mobile coverage and physical Safari observations

- **Outcome.** A bounded WebKit gate in Playwright (desktop and a phone-sized viewport, in the spirit of the 18-test
  Firefox core gate), and the owner's physical Safari observations on an iPhone recorded in
  [iphone-lan-pilot.md](reports/iphone-lan-pilot.md) using the existing LAN pilot
  ([runbook](runbooks/iphone-lan-pilot.md)).
- **Depends on.** Step 3 (the flow being checked). Physical observations need the owner's iPhone and time to run the
  checklist, an optional external input ([section 7](#7-external-inputs-needed-later)).
- **Acceptance.**
  - The WebKit gate's scenarios are listed, it has run, and its result is recorded; failures are fixed or listed as known
    limitations. Playwright WebKit is recorded as WebKit automation, not as Safari.
  - The physical checklist is either recorded (with the report's privacy rules) or explicitly left NOT RUN. If it is not
    run, no iPhone or Safari compatibility is claimed and the release is described as desktop-scoped.
- **Not in this step.** No background recording, no GPS accuracy work (D10 stays PARTIAL unless real traces are
  analysed), no native app.
- **Status: done (2026-11-23, agent-run workstation automation; not run in hosted CI). Physical checklist NOT RUN; the
  release is desktop-scoped.** [ADR-0100](adr/0100-bounded-webkit-gate.md): `npm run test:e2e:webkit`, 47 tests of
  existing specs in Playwright WebKit 26.6 (build 2359, pinned by `@playwright/test` 1.63.0) on Windows 11, at a desktop
  setting (1280 × 720) and a phone-sized one (390 × 844, scale 3, `isMobile`, `hasTouch`, no iPhone user agent):
  development servers (the 18 Firefox core tests, session revalidation 6 and the primary journey 4 at desktop; the
  primary journey 4 at phone size), the production build (deferred views 4: loading, failure, Try again, recovery after
  the network returns, leaving while loading, recording without the chunk) and the showcase's static build with no API
  server (8 at desktop, 3 at phone size, request and storage guards on). Excluded: the real Mapbox/WebGL smoke (the
  Coach map ran only with a fake runtime; no real-basemap claim) and OpenID Connect sign-in. Evidence:
  [verification report](reports/webkit-gate-verification-2026-11-23.md): initial runs 32/32, 4/4 and 9 of 11 (Windows
  WebKit's Tab skips links; test adjusted for WebKit only), final run on the final code 47/47; WebKit's failed dynamic
  import names no URL, so `deferred-module.ts`'s new-URL fallback is never taken there, and recovery works because WebKit
  fetches the same URL again (observed, now asserted; no source change). A CI job `e2e (webkit gate)` was added; **hosted
  CI NOT RUN** at the time. *Hosted CI, 2026-11-24:* runs 45342998163 and 45354574755 failed the showcase keyboard test
  in both WebKit projects, because Linux WebKit focuses the link with Tab. The test now takes the link-skipping path for
  WebKit on Windows only. It passed in a local Linux container
  ([report, section 10](reports/webkit-gate-verification-2026-11-23.md#10-hosted-ci-correction-linux-webkit-tab-order-2026-11-24)),
  then in hosted CI: run [45385170103](https://github.com/AlexTikhon/SomaLane/actions/runs/45385170103) for `3bbe2b2`
  concluded `success` on 2026-11-24, `e2e (webkit gate)` 32 + 4 + 13 passed and `e2e (firefox-core)` 18 passed
  ([step-8 report](reports/showcase-hosted-verification-2026-11-24.md#1-the-commit-and-its-hosted-ci-run)).
  The physical Safari checklist in [iphone-lan-pilot.md](reports/iphone-lan-pilot.md) stays **NOT RUN**: no
  iPhone, Safari, background-recording or real-GPS claim. Playwright WebKit is recorded as WebKit automation, not Safari.

### Step 7. Static publication preparation

Replanned on 2026-11-24 after the owner's scope decision. The former steps 7 (real OIDC provider), 8 (single-host
deployment) and 9 (hosted smoke and isolated restore) are deferred with their requirements intact
([section 6.1](#61-deferred-by-the-scope-change-of-2026-11-24)).

- **Outcome.** The public showcase build is ready for visitors and for GitHub Pages. Every state links to the public
  source repository and says that the full application runs locally, in place of the unconfigured link to the
  invite-only application. A separate, manual, least-privilege workflow validates, builds and publishes only the
  showcase. The runbook gives the exact setup, the dispatch and the hosted checks.
- **Depends on.** Steps 5 and 6, and the owner's scope decision of 2026-11-24.
- **Acceptance.**
  - The public build, with no setting, shows the label and a working source link in its normal, loading and error
    states. The `SHOWCASE_APP_URL` handling is removed or reconciled, and no configuration document contradicts it.
  - The showcase boundary holds: static files only; no API or sign-in request, cookie, browser-storage write, analytics,
    real data or AI output.
  - A separate workflow:
    - runs on `workflow_dispatch` only, restricted to `main`;
    - has a build/validation job and a deployment job; the build job has `contents: read` and the deployment job alone
      has `pages: write` and `id-token: write`;
    - deploys to the `github-pages` environment with the URL the deployment reports, and only after validation
      succeeded;
    - uploads only `apps/web/dist-showcase`;
    - builds from the committed snapshot without Docker, PostgreSQL, dataset regeneration, API servers or application
      secrets.

    The CI workflow and its permission boundary are unchanged.
  - The actual public build is verified locally while served under `/SomaLane/`, in Chromium, the Firefox subset and
    the bounded WebKit projects:
    - assets and snapshot load, including on a direct reload;
    - the journey works;
    - the label and source link appear everywhere;
    - a broken data file is handled;
    - the request and storage guards pass.

    `npm run verify` and `git diff --check` pass.
  - Nothing is published: no repository setting is changed and no workflow is dispatched.
- **Not in this step.** Publication (step 8), portfolio materials (step 9) and product features.
- **Status: done (2026-11-24, fresh local checks).** The workflow has not run on GitHub, Pages is not enabled and nothing
  is published. Decided in [ADR-0101](adr/0101-github-pages-showcase-publication.md); operated by the
  [runbook](runbooks/showcase.md#3-publishing-on-github-pages).
  - **Showcase changes.** Every state shows "Source code on GitHub" (`https://github.com/AlexTikhon/SomaLane`) and says
    the full application runs locally. `SHOWCASE_APP_URL`, its validation module and its tests are removed.
  - **Workflow.** `.github/workflows/showcase-pages.yml`, pinned by `scripts/showcase-pages-workflow.test.mjs`. The
    showcase browser check now serves the build under `/SomaLane/`, fails any request outside that path, and covers a
    direct reload and the exact file set.
  - **Evidence.** [Verification report](reports/showcase-pages-preparation-2026-11-24.md):
    - showcase unit tests 55;
    - workflow structure tests 15;
    - the showcase browser check 25 passed: Chromium 9, Firefox 3, WebKit desktop 9 and WebKit phone-sized 4;
    - the publish build byte-identical to the tested build (`diff -r`);
    - `npm run verify` and `git diff --check`.

    Hosted CI and the Pages workflow: **NOT RUN**.

### Step 8. GitHub Pages publication and hosted showcase smoke

- **Outcome.** The step-7 workflow publishes the showcase on GitHub Pages, and its hosted behaviour is checked and
  recorded.
- **Depends on.** Step 7. Needs the owner to **enable Pages with "GitHub Actions" as its source** (with the
  `github-pages` environment limited to `main`) and to **dispatch the workflow** on `main`
  ([section 7](#7-external-inputs-needed-later)).
- **Acceptance.**
  - Two successful runs for the published commit, both checked at their source (`gh run view`) and recorded with their
    ids: hosted CI (`ci.yml`), then `showcase-pages.yml` on `main`.
  - The published address is the one `actions/deploy-pages` reported, and it is recorded. The expected
    `https://alextikhon.github.io/SomaLane/` counts as confirmed only if the two match.
  - The hosted checks H1–H11 of the [runbook](runbooks/showcase.md#34-hosted-checks-release-step-8) are recorded:
    - status codes and the snapshot digest;
    - the journey in desktop Chromium and Firefox, with the label and the source link;
    - a reload;
    - only the page's own files are requested, and no cookie or storage is written;
    - the broken-data-file state.
  - No Safari or phone claim is made unless a physical device is recorded.
- **Not in this step.** No custom domain, no full-application hosting, no analytics.
- **Status: done (2026-11-24; hosted CI, hosted publication and agent-run hosted checks).**
  [Verification report](reports/showcase-hosted-verification-2026-11-24.md).
  - **Published commit** `3bbe2b2f44ba57aba52ecbc8f5087f43b6cf5095`. It contains the WebKit keyboard correction
    (`a3783ae`, `3bbe2b2`), pushed to `main` without changes.
  - **Hosted CI.** Run [45385170103](https://github.com/AlexTikhon/SomaLane/actions/runs/45385170103), attempt 1:
    `success`. `verify`, `integration`, `e2e (chromium 1/3, 2/3, 3/3)` (192 passed), `e2e (firefox-core)` (18) and
    `e2e (webkit gate)` (32 + 4 + 13) all succeeded.
  - **Setup.** Pages was enabled through the REST API with `build_type: workflow`: no custom domain, HTTPS enforced.
    GitHub created the `github-pages` environment with one deployment branch policy, `main`, and it was kept. Nothing
    else was changed; `main` has no protection rules.
  - **Pages run.** Run [45387434787](https://github.com/AlexTikhon/SomaLane/actions/runs/45387434787) on `main` at
    `3bbe2b2`: `success`.
    - `validate and build the showcase`: unit tests 55; browser checks 25 (Chromium 9, Firefox 3, WebKit 9 + 4);
      `diff -r` against the tested build.
    - `deploy to GitHub Pages`: deployment 8026957134.
    - The reported URL, `https://alextikhon.github.io/SomaLane/`, equals the expected one and is **confirmed**.
  - **Hosted checks H1–H11: all passed.**
    - curl: 200 `text/html`; 301 from `/SomaLane` to `/SomaLane/`; 404 for an unknown path.
    - The snapshot is served as `application/json`, and its SHA-256 `8ccbbcd0…4fd7628` equals the file at `3bbe2b2`.
    - The live files are byte-identical to the uploaded artifact.
    - Playwright's headless Chromium 153 and Firefox 155 against the live site: 8 passed (journey and return, labels,
      source link, scrolling, reload and `index.html`).
    - Only four `GET`s per load, all to `alextikhon.github.io/SomaLane/`; no storage or cookie.
    - With the snapshot blocked in the test browser, the alert appears and **Try again** asks for the snapshot only.
  - No Safari, iPhone or phone claim; the release stays desktop-scoped.

### Step 9. Portfolio materials, screenshots, changelog and licence

- **Outcome.** These materials exist, all drawn from synthetic data:
  - the README and screenshots, from the hosted showcase where it fits;
  - a current interview package, the full editorial rewrite deferred from step 1;
  - a `CHANGELOG`;
  - the owner's licence decision, recorded and applied.
- **Depends on.** Step 8, and the owner's **licence decision**.
- **Acceptance.**
  - Every public claim maps to a row of [section 5](#5-capability-claims-and-the-evidence-each-needs) whose evidence
    exists.
  - The deferred scope is stated wherever it matters: the full application is a local demonstration, and there is no
    real identity provider, hosted application or hosted restore.
  - The licence decision (including "no licence, all rights reserved", if chosen) is written down and applied.
- **Not in this step.** No new features or late fixes outside a recorded defect.
- **Status: done (2026-11-24; documentation and assets, fresh checks).**
  [Verification report](reports/portfolio-materials-verification-2026-11-24.md).
  - **Licence.** The owner chose **MIT**. The root [LICENSE](../LICENSE) is the standard MIT text with "Copyright (c)
    2026 Alex Tikhon". No `package.json` changed: every `"private": true` stays, and no `license` field was added.
  - **Screenshots.** Four images in [docs/assets/screenshots/](assets/screenshots/): Today, Weekly review, Trends (food
    energy) and Logged meals. They were captured from <https://alextikhon.github.io/SomaLane/> (deployment of `3bbe2b2`,
    snapshot digest `8ccbbcd0…4fd7628` re-checked) on 2026-11-24 at 12:20–12:21 UTC, in Playwright Chromium 153 at
    1280 × 900. Each was inspected: the synthetic label is visible and the data is synthetic only.
  - **README.** Rewritten as the entry point: the journey with the screenshots, the showcase link, the
    showcase-versus-local distinction, architecture and decisions, local setup, verification, limitations and the
    licence. Release-process detail now sits behind links to this plan, and test counts were removed.
  - **Interview package.** [interview.md](interview.md) is rewritten for SomaLane. Its current-tense claims were
    checked against the code at `8ab6c5c` (report, section 3).
  - **Changelog.** [CHANGELOG.md](../CHANGELOG.md), from the Git history: no versions or tags, and portfolio v1 under
    "Unreleased".
  - **Checks.** Relative links, anchors and image paths in every changed file; `git diff --check`. No application,
    database or browser suite was run, and nothing was committed, pushed or redeployed.
  - **Recorded defect, not fixed.** At 1280 px the Trends table's row buttons wrap one letter per line. The cause is a
    shared CSS rule (`width: 1%` with `overflow-wrap: anywhere`). The buttons still work. Fixing it would change the
    application, so it needs a decision before step 10 ([report, section 8](reports/portfolio-materials-verification-2026-11-24.md#8-findings)).
  - **Recorded defect repaired (2026-11-24, local evidence; not committed, not published).**
    [Repair report](reports/trends-row-actions-repair-2026-11-24.md).
    - **Change.** In `apps/web/src/styles.css`, `.trends-table__actions` drops `flex-wrap: wrap`, and its buttons get
      `white-space: nowrap`. The shrink-to-fit actions column now has the buttons' real width. The rules shared with
      the activity and comparison tables are unchanged, and those tables' column widths were measured identical before
      and after.
    - **Layout.** At 1280 px, Open and Meals (or Meal log) each sit on one line, side by side. At 420 px and below they
      stack, as the existing media query intends. The application had the same defect, now observed.
    - **Tests.** A shared assertion counts each label's line boxes, because a page-width check had missed the defect.
      It runs in a new showcase test (all four showcase projects) and in the application's Trends and nutrition specs.
      It was shown to fail on the old rule.
    - **Checks.** Showcase Chromium and Firefox: 14 passed. Showcase WebKit desktop and phone-sized: 15 passed.
      Focused application Trends specs: 8 passed. The verify chain passed with the git-ignored `tests/e2e/.local/`
      excluded from lint. `npm run verify` run as it is fails only on those local agent scripts. `git diff --check` is
      clean.
    - **Lint scope follow-up.** `eslint.config.js` now ignores the git-ignored scratch folder `tests/e2e/.local/**`
      globally, and tracked e2e files are still linted. After that, the standard `npm run verify`, with no exclusion,
      **passed (exit 0)**, and `git diff --check` is clean. The earlier failed run stays recorded
      ([report, section 7.1](reports/trends-row-actions-repair-2026-11-24.md#71-lint-scope-the-git-ignored-scratch-folder-follow-up-2026-11-24)).
    - **Hosted.** Not verified. The live site still serves `3bbe2b2`, with the defect, until step 10 publishes a new
      commit.

### Step 10. Final verification, release tag and project freeze

- **Outcome.** The release is verified once more, tagged and frozen.
- **Depends on.** Steps 1–9.
- **Acceptance.**
  - Hosted CI succeeds for the commit to tag.
  - The showcase published from that commit passes the hosted checks (all of H1–H11, or a recorded subset).
  - The status table below is final.
  - The release tag points at that commit.
  - The freeze is written down: after the tag, only recorded defects may change.
- **Not in this step.** No new features.

## 4. Mandatory release gates

Portfolio v1 is published only when all of these hold.

| Gate | Holds when | Step |
|---|---|---|
| G1 Scope | This plan is current and the status table is final | 1, 7, 10 |
| G2 Synthetic dataset | The 56-date dataset is reproducible and isolated | 2 |
| G3 Primary journey | Records → Today → weekly review → Trends → records works on the dataset in Chromium, with the Firefox core gate passing; active-run recovery and capture lifetime unchanged | 3 |
| G4 Bundle | Before/after initial-bundle measurements are recorded | 4 |
| G5 Showcase safety | The showcase is labelled, read-only, synthetic and static: no API or sign-in request, cookie, storage write or analytics. The full application's guards are unchanged: no anonymous private-route access, and development sign-in refused in production | 5, 7, 8 |
| G6 WebKit gate | The bounded WebKit gate has run and its result is recorded | 6 |
| G7 Publication workflow | The separate manual Pages workflow exists with least privilege, uploads only the showcase and deploys only after validation; the public build is validated under `/SomaLane/` | 7 |
| G8 Hosted showcase | That workflow has published the showcase; the reported URL and the hosted checks are recorded | 8 |
| G9 Defaults | Every AI provider off by default in code; no AI output in the showcase | 5, 10 |
| G10 CI and materials | Successful hosted CI for the tagged commit; screenshots, changelog, licence decision, tag | 9, 10 |

Physical-device evidence is **not** a mandatory gate. Without it the release is described as desktop-scoped.

The gate table was renumbered on 2026-11-24. The former gates below are now deferred
([section 6.1](#61-deferred-by-the-scope-change-of-2026-11-24)) and no longer gate v1; none of them is met:

- G7, real identity provider;
- G8, single-host deployment;
- G9, hosted smoke and isolated restore.

The former G10 (AI off in the hosted configuration) is now G9, which covers the code defaults and the showcase.

## 5. Capability claims and the evidence each needs

A capability may be advertised only when its evidence exists. Otherwise the release materials either omit it or state
the limit.

| Claim | Evidence required | Current status (updated 2026-11-24) |
|---|---|---|
| Works in desktop Chromium; Firefox core flows | Hosted CI for the commit | Met for `3bbe2b2` (run 45385170103, checked 2026-11-24); earlier `1dac6ed` (run 45055752618) and `6f3dc46` (run 44885261535). Later commits need their own run |
| WebKit automation | Step-6 gate result | Met locally on 2026-11-23: 47/47 in Playwright WebKit 26.6 on Windows ([report](reports/webkit-gate-verification-2026-11-23.md)). Hosted CI (Linux) failed the showcase keyboard test in runs 45342998163 and 45354574755; corrected on 2026-11-24 ([section 10](reports/webkit-gate-verification-2026-11-23.md#10-hosted-ci-correction-linux-webkit-tab-order-2026-11-24)) and **met in hosted CI** for `3bbe2b2` (run 45385170103: `e2e (webkit gate)` 32 + 4 + 13 passed). Not Safari, not a phone |
| **iPhone / Safari compatibility** | Physical Safari checklist recorded on an iPhone | **NOT RUN**: must not be claimed |
| **Mobile GPS accuracy** | Analysed real-device traces (D10) | **0 traces**, D10 PARTIAL: must not be claimed |
| **Continuous or background recording** | Physical observation of a designed background mode | Not designed (capture is foreground only): must not be claimed |
| **Real sign-in** | Real-provider evidence (deferred, [section 6.1](#61-deferred-by-the-scope-change-of-2026-11-24)) | Test provider only: must not be claimed |
| **Hosted full application** | A hosted deployment and its smoke (deferred) | Not hosted; the full application is a local demonstration: must not be claimed |
| Public read-only showcase of synthetic data | Steps 5 and 7 locally; the step-8 publication run and hosted checks | **Met**: published at <https://alextikhon.github.io/SomaLane/> from `3bbe2b2` by Pages run 45387434787; hosted checks H1–H11 passed in desktop Chromium and Firefox automation on 2026-11-24 ([step 8](reports/showcase-hosted-verification-2026-11-24.md)); earlier local evidence in [step 5](reports/showcase-verification-2026-11-23.md) and [step 7](reports/showcase-pages-preparation-2026-11-24.md). A snapshot of synthetic data, not a hosted application |
| **Backup and restore of hosted data** | An isolated restore of a host's backup (deferred) | No hosted data; local drills only ([p12-4-restore-drill.md](reports/p12-4-restore-drill.md)); no production RPO/RTO: must not be claimed for a host |
| Real map basemap | A real Mapbox token rendering on a hosted application (deferred) | Never rendered; the app works without a token |
| **AI quality** (any feature) | A passing frozen gate at the current fingerprint **and** a separate decision to enable | Meal drafts FAIL; Ask my data stale (NOT_RUN); weekly insights and run search below target: must not be claimed |
| Performance and load | The P11 measurements with their stated boundaries | Workstation only ([p11-5-measurements-after.md](reports/p11-5-measurements-after.md)) |
| **Production-grade**, multi-replica or high availability | Not pursued in v1 | Must not be claimed |

## 6. Deferred work

Not part of portfolio v1. Each stays recorded where it is; nothing here is closed by this plan.

- **Product.** FIT import; HealthKit and any native app (needs macOS/Xcode); phone or watch imports; additional health
  metrics; retrieval over a knowledge base (RAG); a general chat coach; multi-activity GPX/TCX and overlap detection;
  per-category coach grants; a stored profile time zone.
- **AI.** Further AI-quality experiments and model tuning for meal drafts, Ask my data interpretation, weekly insights
  and run search; **D11** (meal-draft diagnostics, [decision-backlog.md](decision-backlog.md)) stays OPEN.
- **Engineering.** Microservices; multi-replica support (login admission limits, run-search, meal-draft and
  data-question admission, the weekly-insight queue, the archive tile cache, the SSE hub, maintenance runners and
  metrics are still per process, ADR-0081 "Explicit boundaries"); maintenance candidate fairness, durable retries and
  whole-job/I/O cancellation (ADR-0069, ADR-0070); a session list or "sign out everywhere"; provider-side logout; real
  Mapbox auth/telemetry failure behaviour.
- **Evidence.** **D10** stays PARTIAL until real traces are analysed; physical-device evidence beyond the step-6
  checklist.

### 6.1 Deferred by the scope change of 2026-11-24

The owner moved the former steps 7, 8 and 9 out of portfolio v1. Their requirements are kept here unchanged, so that
the work can resume as written. None of it is done, and the release materials must not claim it.

- **Real OIDC provider verification and reproducible provisioning** (former step 7):
  - Sign-in works against one real OpenID Connect provider chosen by the owner.
  - [identity-provider.md](runbooks/identity-provider.md) gives reproducible provisioning steps: client registration,
    redirect URI, invited identities and the secret file.
  - Real-provider evidence is recorded without secrets or personal identifiers: an invited identity signs in and out;
    an uninvited identity is refused; a restart keeps the session (ADR-0080).
  - The runbook's "Verification against a real provider: Not performed" row stays as it is until then.
- **Reproducible single-host deployment** (former step 8). The full application on one host with the production
  profile ([deployment.md](runbooks/deployment.md)): nginx with a real certificate, file-based secrets, AI off,
  `LOCAL_AUTH_ENABLED=false` and the real provider configured.
  - It is reproduced from the runbook alone on a clean host.
  - `npm run deploy:verify`-equivalent checks pass for the host.
  - The deletion-journal directory and the backup destination are named, and whether they are really off-host is
    stated.
- **Hosted critical-flow smoke and isolated backup/restore verification** (former step 9):
  - A smoke against the hosted origin: real sign-in, the primary journey and the secondary demonstration, and an
    anonymous request to a private route answering `401`.
  - A backup made on the host is restored into an **isolated** environment, never over the hosted database, following
    the documented order: `restore:reapply-deletions`, `restore:reapply-access`, `restore:reapply-erasures`,
    `restore:clear-sessions`.
  - Measured times describe that drill only.

**Unchanged while deferred.** The full application's safeguards stay implemented and tested by CI as before; nothing is
removed or weakened:

- invite-only OIDC sign-in with PKCE, state and nonce;
- durable sessions;
- the refusal of `LOCAL_AUTH_ENABLED=true` with `APP_ENV=production` (`apps/api/src/config/environment.ts`);
- no anonymous access to private routes;
- the production profile and `npm run deploy:verify`;
- backups and the restore drill.

**Known limitations that remain true** (documented, not fixed in v1): an erasure not yet exported when the host is lost
can come back after a restore (one export interval plus any backlog,
[recovery limits](runbooks/deletion-journal-and-recovery.md#failure-modes-and-honest-limits)); two devices editing the
same day overwrite each other; tables do not use `FORCE ROW LEVEL SECURITY`, so owner credentials must never reach the
API; revoked live data already delivered cannot be recalled; the archive tile cache and SSE hub are per process.

## 7. External inputs needed later

Each input must be confirmed or configured before the step that needs it starts. Having an input available is not the
same as having it verified: availability means it can be used, and verification is recorded evidence from the step
itself. This plan makes no claim about whether any deferred input (a host, a domain, a certificate, a provider
account, off-host storage) is available.
The existing documentation records that the owner has an iPhone ([ADR-0085](adr/0085-iphone-lan-pilot.md)), but every
physical Safari check is still NOT RUN ([iphone-lan-pilot.md](reports/iphone-lan-pilot.md)). The physical iPhone
checklist is optional and does not block the release (a desktop-scoped release does not need it). All other inputs
block the step named.

| Input | Needed by | Owner's decision or action |
|---|---|---|
| GitHub Pages enabled for the repository with "GitHub Actions" as its source, and the `github-pages` environment limited to `main` ([runbook, 3.2](runbooks/showcase.md#32-one-time-repository-setup-the-owner-in-githubs-web-interface)) | Step 8 | **Done 2026-11-24** with the owner's authorization: Pages `build_type: workflow`; `github-pages` allows `main` only |
| A manual run of the Pages workflow on `main` | Step 8 (and step 10 for the tagged commit) | **Done 2026-11-24** for `3bbe2b2` (run 45387434787), after CI run 45385170103 succeeded |
| Physical iPhone with Safari on the workstation's Wi-Fi | Step 6 (optional for a desktop-scoped release) | Time to run and record the checklist (the device is recorded as available; the checks are NOT RUN) |
| Licence decision | Step 9 | **Done 2026-11-24**: MIT, "Copyright (c) 2026 Alex Tikhon" ([LICENSE](../LICENSE)) |

No longer needed for v1, deferred with the work that needs them
([section 6.1](#61-deferred-by-the-scope-change-of-2026-11-24)):

- a Linux host with Docker Compose v2;
- a DNS name and a TLS certificate;
- an identity-provider tenant, client registration and invited identities;
- off-host storage for backups and the deletion journal;
- the optional Mapbox token.

## 8. Status

| Step | Status | Evidence |
|---|---|---|
| 1. Release scope and current documentation | **Done** | This plan; progress entry of 2026-11-22 |
| 2. Isolated 56-date synthetic dataset | **Done** | [Report](reports/portfolio-dataset-verification-2026-11-22.md); progress entry of 2026-11-22 (fresh checks; not run in CI) |
| 3. Navigation and first-use flow | **Done** | [Report](reports/navigation-first-use-verification-2026-11-22.md); progress entry of 2026-11-22 (fresh checks; not run in CI) |
| 4. Initial-bundle reduction | **Done** (2026-11-23) | [Report](reports/initial-bundle-verification-2026-11-22.md), including its independent review and hosted CI evidence; candidate `dff831a`; progress entries of 2026-11-22 (local checks; no local full Chromium/OIDC run free of failures) and 2026-11-23 (hosted CI run 45055752618, `success` for `1dac6ed`) |
| 5. Public read-only showcase | **Done** (2026-11-23) | [ADR-0099](adr/0099-public-read-only-showcase.md), [report](reports/showcase-verification-2026-11-23.md); progress entry of 2026-11-23 (fresh local checks; not hosted; not run in CI) |
| 6. WebKit gate and physical Safari | **Done** (2026-11-23); physical checklist **NOT RUN**, release desktop-scoped | [ADR-0100](adr/0100-bounded-webkit-gate.md), [report](reports/webkit-gate-verification-2026-11-23.md); progress entry of 2026-11-23 (agent-run workstation automation; not run in hosted CI) |
| 7. Static publication preparation | **Done** (2026-11-24) | [ADR-0101](adr/0101-github-pages-showcase-publication.md), [report](reports/showcase-pages-preparation-2026-11-24.md); progress entry of 2026-11-24 (fresh local checks; the Pages workflow has not run; nothing published) |
| 8. GitHub Pages publication and hosted showcase smoke | **Done** (2026-11-24): published at <https://alextikhon.github.io/SomaLane/> from `3bbe2b2` | [Report](reports/showcase-hosted-verification-2026-11-24.md); hosted CI run [45385170103](https://github.com/AlexTikhon/SomaLane/actions/runs/45385170103) and Pages run [45387434787](https://github.com/AlexTikhon/SomaLane/actions/runs/45387434787), both `success`; H1–H11 passed (agent-run hosted checks in desktop Chromium and Firefox automation); progress entry of 2026-11-24 (step 8) |
| 9. Portfolio materials, screenshots, changelog, licence | **Done** (2026-11-24): README, four screenshots of the live showcase, interview package, `CHANGELOG.md`, MIT `LICENSE` | [Report](reports/portfolio-materials-verification-2026-11-24.md); progress entry of 2026-11-24 (step 9; documentation and assets, fresh checks; nothing committed or redeployed). Its recorded Trends row-action defect was repaired on 2026-11-24: [repair report](reports/trends-row-actions-repair-2026-11-24.md) (local checks; not hosted) |
| 10. Final verification, release tag, project freeze | Not started (**next**) | — |
| Deferred on 2026-11-24: real OIDC provider, single-host deployment, hosted smoke and isolated restore | **Deferred, not done** | [Section 6.1](#61-deferred-by-the-scope-change-of-2026-11-24) |
