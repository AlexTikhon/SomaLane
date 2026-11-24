# Changelog

The meaningful product and engineering milestones of SomaLane, summarised from the Git history. The project has one
release, **portfolio v1**, marked by the annotated tag `portfolio-v1`. The release, and the freeze that follows it,
take effect when that tag and its GitHub release are published. Both record the released commit, its CI and Pages runs
and the hosted checks ([closeout](docs/portfolio-v1-closeout.md)). If the tag does not exist, the section below
describes the release candidate. There are no version numbers.

Dates are the commits' author dates in the workstation's local time. Decision records (ADR-NNNN) are in [docs/adr/](docs/adr/), and
how each change was verified is in [docs/progress.md](docs/progress.md). The project started as **Running Tracker**.
Package names, database identifiers, cookies and environment variables keep the `running-tracker` names.

## portfolio-v1: Portfolio v1 (2026-11-22 to 2026-11-24)

A finite release phase of ten steps, with no new product features, under
[docs/portfolio-v1-release-plan.md](docs/portfolio-v1-release-plan.md). It ends feature development: after the tag,
future work needs an explicitly reopened scope, and recorded defect fixes are separate maintenance changes.

- **Published:** the read-only synthetic showcase, at <https://alextikhon.github.io/SomaLane/>.
- **Local only:** the full application.
- **Licence:** MIT.
- **Scope:** desktop. There is no Safari, phone or real-GPS evidence.
- **Deferred:** a real identity provider, hosting the full application and a hosted restore.

- **Release scope** (step 1): the release plan defines the product, the primary journey, the publication model,
  gates, the evidence each claim needs, and what is deferred.
- **Synthetic dataset** (step 2): `npm run portfolio:dataset` creates a reproducible 56-date dataset for one fictional
  person in its own Compose project and PostgreSQL server. It proves its isolation before any write and records a
  canonical digest.
- **Today-first navigation** (step 3, ADR-0097): the app opens on Today, and the navigation leads with Today, Weekly
  review and Trends. A run status is shown away from Runner. Run recovery, capture and the writer lease stay owned by
  App.
- **Smaller first page** (step 4, ADR-0098): Coach, Archive, Activity, Check-in, Meal log and the run result load on
  demand, measured with `npm run measure:web-bundle`.
- **Public read-only showcase** (step 5, ADR-0099): a separate static build renders the application's content blocks
  from one committed snapshot of the synthetic dataset. The snapshot is exported read-only through the API's read
  services. The build has no API request, no sign-in and no storage.
- **Bounded WebKit gate** (step 6, ADR-0100): `npm run test:e2e:webkit` runs Playwright WebKit at a desktop and a
  phone-sized viewport. This is WebKit automation, not Safari, and the physical Safari checklist was not run.
- **GitHub Pages preparation** (step 7, ADR-0101): every showcase state links to the source repository. A manual,
  least-privilege workflow validates, builds and publishes only the showcase. Scope change of 2026-11-24: only the
  showcase is published; full-application hosting, a real identity provider and a hosted restore are deferred.
- **Showcase published** (step 8): live at <https://alextikhon.github.io/SomaLane/> from `3bbe2b2`, after a successful
  hosted CI run for the same commit. Checked on the live site in desktop Chromium and Firefox automation.
- **Portfolio materials** (step 9): a rewritten README with screenshots of the live showcase, a rewritten interview
  package ([docs/interview.md](docs/interview.md)), this changelog, and the [MIT licence](LICENSE).
- **Fixed: Trends row actions** (2026-11-24, the defect recorded in step 9): each row's Open and Meals (or Meal log)
  button no longer wraps one letter per line. The buttons sit side by side on desktop and stack at narrow widths, in
  the application and the showcase. A browser assertion now counts each label's line boxes
  ([report](docs/reports/trends-row-actions-repair-2026-11-24.md)).
- **Final verification, tag and freeze** (step 10): final documentation, including the
  [closeout and restart instructions](docs/portfolio-v1-closeout.md). Hosted CI, a Pages publication and the hosted
  checks for one commit, which is then tagged `portfolio-v1`. Their results are in the tag and the GitHub release.

## History before portfolio v1

No releases were made in this period.

### Nutrition analytics and optional AI experiments (2026-11-14 to 2026-11-21)

- **Meal "Draft from text"** (ADR-0092): a local model may propose meal values from a description. Only values the
  server finds next to their unit and nutrient are offered, with the excerpt as evidence; the person applies, edits and
  saves. Off by default. Seven grounding amendments and frozen evaluation sets followed. The latest model measurement
  failed the quality bar.
- **Meal nutrition in the weekly review** (ADR-0093): recorded totals with entry and day coverage.
- **Ask my data** (ADR-0094, ADR-0095): one read-only question answered by exactly one existing deterministic read.
  Predefined and guided questions need no model; interpreting typed questions is optional and off by default.
- **Nutrition Trends v2** (ADR-0096): per-nutrient day and entry coverage on Trends, and a drill-down from a date to
  its Meal log and back.

### SomaLane: daily health and nutrition records (2026-11-06 to 2026-11-13)

- **Owner-only health records**: manual activities with an erasure ledger and idempotent creation (ADR-0072,
  ADR-0073), a daily check-in (ADR-0074), manual daily movement (ADR-0078) and a meal log (ADR-0083). Run sharing never
  grants access to any of them.
- **Deterministic weekly review** (ADR-0077, ADR-0079): coverage and values written by code on every read. Optional
  weekly insights from a local model (ADR-0076) stayed off after its evaluation.
- **Durable sessions and pending OIDC logins in PostgreSQL** (ADR-0080, ADR-0081): an API restart keeps them; backups
  exclude them and a restore clears them.
- **Today** (ADR-0082) and **28-day Trends** (ADR-0084), read-only views over the stored daily records. The product was
  renamed SomaLane.
- **iPhone LAN pilot tooling** (ADR-0085): an isolated stack over trusted LAN HTTPS. The physical checks are still not
  run.
- **Review fixes F01–F06**: connection failure isolation, meal edit stability, listener disposal, route labels in
  metrics, journal backlog age and migration login checks.
- **Activity imports and history**: one GPX 1.1 track (ADR-0086) or one TCX v2 activity (ADR-0091) imported after a
  preview; a unified activity history with a local-day filter (ADR-0087, ADR-0088); activity trends with a
  previous-period comparison (ADR-0089, ADR-0090).
- CI became a gated workflow with sharded browser tests (ADR-0075).

### Hardening, search, sharing and the local demo (2026-10-06 to 2026-11-06)

- Organizations chosen from memberships, explicit sign-out and a split app shell (ADR-0049).
- **Runtime SQL budgets** (ADR-0050): PostgreSQL-enforced statement and lock timeouts, mapped to a retryable 503.
- **Writer fencing fixes**: a monotonic fencing epoch that closes an ABA bug (ADR-0053); run authority, lifecycle
  requests and the finished-run clear fenced inside each write (ADR-0055, ADR-0059, ADR-0060).
- **My runs search** over published summaries (ADR-0056), and optional "describe the search in words" proposals
  (ADR-0057, OpenAI or local Ollama, off by default).
- Coach access shared and revoked from the Runner and My runs, live positions on a map, finished-run deletion and a
  finished-run detail view.
- **Browser gates**: an 18-test Firefox core gate and a pre-demo smoke.
- **One-command local demo**: `demo:doctor` and `demo:up`.
- Maintenance SQL budgets (ADR-0069), failure backoff with retry and recovery visibility (ADR-0070), and map runtime
  lifecycle fixes (ADR-0071).

### Running Tracker foundation (2026-09-19 to 2026-10-03)

The original P00–P12 plan.

- **Workspace and database boundary**: Express 5 in place of NestJS, versioned SQL migrations, three database roles,
  and row-level security with transaction-scoped tenant context (ADR-0003 to ADR-0005).
- **Runs**: idempotent lifecycle commands and point ingestion keyed by sequence number, clock-driven auto-finish, and
  a deterministic GPS simulator with test-only fault injection.
- **Browser recording**: an IndexedDB point buffer, a retrying upload worker and a fenced writer lease for one writing
  tab (ADR-0008 to ADR-0010).
- **Revision-bound processing**: summaries published only for the exact source revision, revision-fixed live-track
  pages with signed cursors, an authorized SSE live board with revalidation (ADR-0022, ADR-0023), and archive vector
  tiles keyed by an archive revision (ADR-0027 to ADR-0032).
- **Retention and deletion**: raw-point purge, owner deletion with tombstones, and a durable deletion journal with an
  idempotent replay (ADR-0036, ADR-0037).
- **Measurement**: in-process metrics, seeded load datasets, a concurrent load scenario and EXPLAIN tooling, and
  set-based RLS policies that removed the measured bottleneck (ADR-0038 to ADR-0042).
- **Operations, workstation-verified**: a single-host production profile (ADR-0043), encrypted backups with an
  executed restore drill (ADR-0044), an access-restriction journal (ADR-0045) and invite-only OpenID Connect sign-in
  (ADR-0046).
- **Testing**: a Playwright browser suite for recording, reload, offline, a second tab, coach live view and OIDC
  sign-in, run in GitHub Actions in its own CI job.
