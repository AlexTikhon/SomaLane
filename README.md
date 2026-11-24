# SomaLane

[![CI](https://github.com/AlexTikhon/SomaLane/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AlexTikhon/SomaLane/actions/workflows/ci.yml)

SomaLane is a personal activity, health and nutrition tracker with an optional, evidence-based assistant. You record
GPS runs in the browser, keep a daily check-in, movement and a meal log, and see your days and weeks in views that never
invent a value. A coach can watch a run live, but only with explicit permission. A React web app and an Express API run
on PostgreSQL/PostGIS, with row-level security as the boundary between people and organizations.

It started as **Running Tracker**, a learning project in GPS run capture, live coaching and a revision-safe archive,
and grows one vertical slice at a time. Package names, database identifiers, cookies and environment variables keep the
`running-tracker` names; only the product and the visible app are called SomaLane.

> **Status (2026-11-23): preparing portfolio v1.** Feature work is paused for a finite, ten-step release plan:
> [docs/portfolio-v1-release-plan.md](docs/portfolio-v1-release-plan.md). It defines the release (a public, read-only
> showcase of synthetic data plus the full app behind invite-only OpenID Connect), its mandatory gates and what is
> deferred. Steps 1 to 5 are done: step 2, an isolated, reproducible synthetic dataset over 56 calendar dates
> (`npm run portfolio:dataset`); step 3, Today-first navigation (ADR-0097); step 4, the secondary views load on demand
> (ADR-0098, closed by a successful hosted CI run for `1dac6ed`); step 5, the public read-only showcase, a static build
> of synthetic snapshots with no sign-in and no API request (ADR-0099, `npm run build:showcase`; tested locally, not
> hosted). **Next task: step 6, the bounded WebKit/mobile gate.**
>
> Today the app runs locally and in GitHub Actions (latest checked run: success for `1dac6ed`). The single-host
> production profile is verified on a workstation but not deployed anywhere, sign-in has been tested against a test
> OpenID Connect provider only, and nothing has been checked on a physical phone. Local use signs in with fixed demo
> people; use synthetic data only. HealthKit is deferred until a Mac with Xcode is available.

## What it does

### Runs

- **Runner**: record a run from device GPS or a simulator; pause, resume, finish. Points are stored in the browser
  first and uploaded in order, so a run survives going offline, a reload or a lost answer. One tab writes at a time.
- **Coach**: a live board over Server-Sent Events showing the runs shared with you, with confirmed and stale positions
  and the selected tracks (on a Mapbox map when a public token is configured).
- **Archive**: finished runs as revision-bound vector tiles, **My runs** search by period, distance and sort, sharing
  and revoking a finished run, and owner deletion with tombstones and an off-host deletion journal.

### Daily records (owner-only: a coach never sees them)

- **Check-in**: weight, sleep, sleep quality, mood, soreness and a note, one record per local date.
- **Movement**: steps and active energy entered by hand, stored with `manual` provenance.
- **Activities**: manual entries (run, walk, ride, hike, swim, strength, other), or one GPX 1.1 track imported after a
  preview and an explicit type choice: start, elapsed time and distance only, labelled as a GPX import. The file and
  its route are not kept, and an import is not compared with GPS runs recorded here. A TCX v2 file with one activity can
  be imported the same way (ADR-0091): start, the duration its laps report (the exact sum of their total times, rounded
  once; neither elapsed nor moving time) and their distance, labelled as a TCX import; no GPS position is needed, and no
  lap, track, heart rate, calories, notes or device is kept. The Activity tab lists them with
  your own finished GPS runs in one history, each labelled with its source and its own measure, never added together.
- **Meal log**: meals and snacks with optional user-reported energy and macronutrients. Nothing is estimated or looked up.
  An optional, off-by-default **Draft from text** (ADR-0092) asks a local Ollama model to pick out what one meal
  description says; only values the server finds in the text next to their unit and nutrient are proposed, with the
  excerpt as evidence, and the person applies the proposal to the form, edits it and saves it as a manual entry.

### Views

The page opens on **Today**. The navigation leads with Today, Weekly review and Trends; the editors (Check-in, Meal
log, Activity) and the run views (Runner, Coach, Archive) follow in two groups. While a run records or still has data
to send, a compact status above every other view says so and leads back to Runner (ADR-0097).

- **Today**: one day across all of the above, with actions that open each editor on that date, the week's review and
  Trends, and the day's activities and runs in the activity history.
- **Trends**: the 28 dates ending on a chosen date (weight, sleep, steps, and recorded food energy, protein,
  carbohydrate and fat), each with its coverage; every nutrient has its own day and entry coverage (ADR-0096). Gaps
  stay gaps; a missing value never counts as zero. A nutrition date opens its Meal log, with a way back to the same range. Its Activity section shows one source and one activity type over the
  same dates (count, the source's own duration, distance, with coverage); sources are never added together.
- **Weekly review**: one week's coverage, values and limitations, worded by code on every read, including the week's
  recorded nutrition from the meal log with its entry and day coverage (ADR-0093); totals cover only what was logged.
  Its own view (also shown in the Check-in tab), with a way on to Trends ending on the week's Sunday, or today while the
  week is in progress.

### Optional AI, off by default

- Weekly insights from a **local** Ollama model that writes only about numbers the API computed, and must cite them
  exactly.
- "Describe the search in words" for My runs (OpenAI or local Ollama) proposes filters that you then apply.
- **Draft from text** in the Meal log (above). Its latest model measurement (2026-11-18) failed the quality bar (recall
  81.0 % below 85 %, no incorrect value accepted).
- **Ask my data** on Today (ADR-0094, ADR-0095): one read-only question answered by exactly one existing deterministic
  read. Predefined questions and the guided question builder **need no model**. Interpreting typed questions with a
  local model is optional: its last passing measurement predates a same-day correction of the question constraints, so
  there is no valid model evidence for the current code.
- None of these has met its quality target for the current code, and all stay off unless configured.

## Principles

- **Code computes every number.** SQL produces totals, coverage and trends; a model only words them, and a number in
  model output that is not in the facts is a defect.
- **A model only proposes; the person confirms.** Proposals go through a strict contract and change nothing until
  accepted.
- **Health data is owner-only.** Run sharing never grants access to check-ins, movement, activities or meals.
- **Deleted stays deleted.** Erasures go to a ledger that leaves the database host and is replayed after a restore.
  Limit: an erasure not yet exported when the host is lost can come back. The window is one export interval plus the
  time to drain any backlog ([recovery limits](docs/runbooks/deletion-journal-and-recovery.md#failure-modes-and-honest-limits)).
- **No derived health numbers without a definition.** No calories from steps, no "complete diary", no advice.

Details and the roadmap: [docs/product-direction.md](docs/product-direction.md).

## Architecture

```text
 Browser (React 19, Vite)  ── IndexedDB: offline point buffer, pending commands, writer lease
        │  HTTPS (nginx proxy in the deployment and pilot profiles; Vite proxy in development)
        ▼
 API (Node 24, Express 5)  ── sessions in PostgreSQL, CSRF + exact Origin checks, SSE live board,
        │                     maintenance jobs (summaries, auto-finish, retention, journal export)
        ▼
 PostgreSQL 17 + PostGIS 3.5  ── row-level security per person and organization, migration-owned schema,
                                 separate runtime / migration / maintenance roles
```

| Path | What it is |
|---|---|
| `apps/api` | Express 5 API, maintenance jobs, backup/restore and evaluation CLIs |
| `apps/web` | React 19 web app (Vite) |
| `packages/contracts` | Zod schemas shared by API and web; generates `openapi/openapi.json` |
| `packages/fixtures`, `tools/simulator` | deterministic test data and a GPS simulator |
| `db/migrations` | 43 SQL migrations (`0000`–`0042`), checksummed and applied in order |
| `infra/` | Compose files (development, loopback TLS, production, iPhone pilot), nginx proxy, API images |
| `scripts/` | setup, demo, profile verification, pilot tooling, and their tests |
| `tests/e2e` | Playwright browser suite (Chromium, an OpenID Connect project, a Firefox core gate, a WebKit gate) |
| `docs/` | release plan, design, 96 decision records, runbooks, reports and the progress log |

## Quick start

Requirements: Node.js 24 (`>=24.11.0 <25`), npm 11, and Docker with Compose v2. The ports used are API 3000, web 5173
and PostgreSQL 5433 (bound to `127.0.0.1`).

```powershell
npm ci
npm run demo:doctor   # read-only: is this machine ready?
npm run demo:up       # database, migrations, demo people, API and web app; Ctrl+C stops them
```

Open <http://127.0.0.1:5173> and press **Demo runner** or **Demo coach**. The walk-through, a 5–7 minute rehearsal and
troubleshooting are in [docs/runbooks/demo.md](docs/runbooks/demo.md).

### Development setup without the demo command

```powershell
Copy-Item .env.example .env      # POSIX: cp .env.example .env
npm ci
npm run db:up
npm run db:bootstrap
npm run db:bootstrap:test
npm run db:migrate
npm run db:migrate:test
npm run dev                      # API on :3000, web on :5173 (Vite proxies /api)
```

`.env.example` holds fixed, local-only credentials and keys. Local sign-in stays off until you enable it
(`LOCAL_AUTH_ENABLED`). Maps need a public `VITE_MAPBOX_ACCESS_TOKEN`; without one the app shows notices instead.

### Try it on an iPhone (synthetic data only)

The iPhone LAN pilot runs an isolated copy of the stack (its own database, the demo people only, AI off) and serves it
over HTTPS on your computer's private Wi-Fi address. The certificate comes from a local authority that is limited to
that address and that you trust on the phone. Its sign-in is the demo panel, so it is not for real data.

```powershell
npm run pilot:configure -- --address <your Wi-Fi IPv4>
npm run pilot:tls
npm run pilot:up
npm run pilot:verify
```

Phone setup, firewall, clean-up and the physical checklist:
[docs/runbooks/iphone-lan-pilot.md](docs/runbooks/iphone-lan-pilot.md).

### A populated, synthetic 56-day dataset

```sh
npm run portfolio:dataset    # own Compose project and PostgreSQL on 127.0.0.1:5442; seed, anchor and digest printed
```

It never touches the development or test database and never reads `.env`. It prints how to start the existing API
(port 3300) and web app (port 5373) against it, and which dates to open in Today, the weekly review and Trends:
[docs/runbooks/portfolio-dataset.md](docs/runbooks/portfolio-dataset.md).

### The public read-only showcase

```sh
npm run portfolio:showcase:export    # snapshots of that dataset through the app's read services (read-only)
npm run build:showcase               # static files in apps/web/dist-showcase/ (SHOWCASE_APP_URL = the app's link)
npm run preview:showcase             # http://127.0.0.1:4380, no API
```

A static page of the primary journey (Today → Weekly review → Trends → the day or its meals) from one committed file of
synthetic snapshots: no sign-in, no API request, no write, labelled "Read-only showcase · synthetic data" on every view:
[docs/runbooks/showcase.md](docs/runbooks/showcase.md).

## Tests and CI

| Command | What it runs |
|---|---|
| `npm run verify` | lint, typecheck, unit tests of every workspace and the scripts, build (3,168 tests on 2026-11-09) |
| `npm run test:integration` | API against a real PostgreSQL `_test` database: RLS, roles, HTTP, maintenance, backup and the restore drill (about 980 tests) |
| `npm run test:e2e` | Playwright, Chromium plus a real OpenID Connect provider process (146 tests); `npm run test:e2e:firefox` runs an 18-test Firefox core gate |
| `npm run test:e2e:webkit` | the bounded WebKit gate (47 tests): Playwright WebKit at a desktop and a phone-sized setting on the development servers, the production build and the showcase's static build (ADR-0100; WebKit automation, not Safari or a phone) |
| `npm run test:e2e:smoke` | a 24-test pre-demo smoke on its own ports |
| `npm run test:portfolio-dataset`, `npm run test:e2e:portfolio-dataset` | the synthetic dataset on throwaway databases inside its isolated server, and a Chromium walkthrough of the populated screens (after `npm run portfolio:dataset`; not in CI) |
| `npm run measure:web-bundle`, `npm run test:e2e:production-build` | the initial JavaScript and CSS of the production build, raw and gzip (`-- --ref <commit>` for a commit), and a Chromium/Firefox check of that build's chunk requests and of loading, failure and retry of the on-demand views (ADR-0098; not in CI) |
| `npm run test:e2e:showcase`, `npm run portfolio:showcase:export -- --check` | the showcase's static build in Chromium/Firefox with no API server (journey, labels, no `/api` request, no storage write, keyboard, 375 px, a broken data file), and whether the committed snapshot equals a fresh export (ADR-0099; not in CI; the check needs the dataset) |
| `npm run deploy:verify`, `npm run transport:verify`, `npm run pilot:verify` | Docker profile checks: deployment, loopback TLS/HTTP2, iPhone pilot |

The integration and browser suites need the test database first (`npm run db:up`, `npm run db:bootstrap:test`,
`npm run db:migrate:test`); run them one at a time, since they share it. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `verify`, then integration, three Chromium shards, the
Firefox gate and the WebKit gate, on pushes to `main`, on pull requests and on demand. It reads no secrets.

## Operating it

- **Sign-in**: OpenID Connect, invite-only. [docs/runbooks/identity-provider.md](docs/runbooks/identity-provider.md)
- **Deployment**: one host, Docker Compose, nginx with your certificate, secrets as files.
  [docs/runbooks/deployment.md](docs/runbooks/deployment.md)
- **Backups**: encrypted `pg_dump` and a restore drill that also replays deletions, access restrictions and erasures.
  [docs/runbooks/backup-and-restore.md](docs/runbooks/backup-and-restore.md),
  [docs/runbooks/deletion-journal-and-recovery.md](docs/runbooks/deletion-journal-and-recovery.md)
- **AI features**: [docs/runbooks/weekly-insights.md](docs/runbooks/weekly-insights.md),
  [docs/runbooks/run-search-ai.md](docs/runbooks/run-search-ai.md)
- **Real GPS traces** (privacy-preserving replay): [docs/runbooks/gps-traces.md](docs/runbooks/gps-traces.md)

## Documentation

| Document | Use it for |
|---|---|
| [docs/portfolio-v1-release-plan.md](docs/portfolio-v1-release-plan.md) | **current**: release scope, the ten steps, gates, evidence required per claim, deferrals |
| [docs/reference.md](docs/reference.md) | the detailed reference: API behaviour, data rules, configuration and verification for every feature |
| [docs/SDD.md](docs/SDD.md) | the system design |
| [docs/adr/](docs/adr/) | one decision record per slice (ADR-0001 to ADR-0100) |
| [docs/product-direction.md](docs/product-direction.md) | roadmap, principles and each slice's summary |
| [docs/progress.md](docs/progress.md) | what was built and how it was verified, entry by entry |
| [docs/runbooks/](docs/runbooks/) | how to run, demo, deploy, back up and pilot it |
| [docs/reports/](docs/reports/) | measurements, reviews and verification reports |
| [packages/contracts/openapi/openapi.json](packages/contracts/openapi/openapi.json) | the HTTP API (OpenAPI 3.1); SSE in [packages/contracts/sse.md](packages/contracts/sse.md) |

## What is not established

- Everything was verified on one Windows workstation and in GitHub Actions. Nothing is deployed, and no production
  recovery point or time is claimed.
- Sign-in was tested only against a test OpenID Connect provider, never a real one.
- The browser suite runs in Chromium, with bounded Firefox and WebKit gates (Playwright's WebKit build at a desktop and
  a phone-sized viewport). Nothing has run in Safari, on a phone or with real GPS yet; the iPhone pilot's physical checks
  are pending
  ([docs/reports/iphone-lan-pilot.md](docs/reports/iphone-lan-pilot.md)).
- No real Mapbox basemap was rendered in a test. The AI features (search in words, weekly insights, meal drafts, Ask my
  data interpretation) are off by default: none has valid passing model evidence for the current code (Ask my data's
  one passing run is stale after a later constraints correction), and OpenAI has never been called.
- The read-only showcase has been built and tested only on this workstation; it is not hosted, and its link to the
  invite-only application is configured at build time (no live address exists yet).
- Only steps 1 to 5 of the portfolio v1 release plan are done, so its release gates are not met; which claims need which
  evidence is listed in
  [the release plan](docs/portfolio-v1-release-plan.md#5-capability-claims-and-the-evidence-each-needs).
- No phone or watch import, no FIT import and no HealthKit. GPX and TCX import cover one documented subset each (one
  track or one activity, summary only); multi-activity files and overlap detection between sources do not exist.
