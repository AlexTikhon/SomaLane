# Runbook: the portfolio v1 synthetic dataset (release step 2)

Audience: whoever prepares, reviews or demonstrates portfolio v1 on one Windows, macOS or Linux workstation with
Docker. Related: [release plan, step 2](../portfolio-v1-release-plan.md#step-2-reproducible-isolated-synthetic-dataset-over-56-calendar-dates),
[verification report](../reports/portfolio-dataset-verification-2026-11-22.md), [demo runbook](demo.md). The public
read-only showcase (release step 5) is exported from this dataset, read-only, by `npm run portfolio:showcase:export`:
[showcase runbook](showcase.md).

One command creates an isolated PostgreSQL server and fills it with a reproducible, **synthetic** dataset over 56 local
calendar dates, so that Today, the weekly review, nutrition Trends and the 28-date activity comparison of the existing
app are populated. Nothing in it is real personal data: the identities are the existing demo runner and demo coach, and
every text, number and coordinate is generated.

## 1. Prepare and seed

```sh
npm run portfolio:dataset                                    # default seed, anchor = yesterday in Europe/Warsaw
npm run portfolio:dataset -- --seed somalane-portfolio-v1 --anchor 2026-11-21   # exactly reproducible
```

| Parameter | Default | Rule |
|---|---|---|
| `--seed` | `somalane-portfolio-v1` | 1–64 characters of `A-Z a-z 0-9 . _ -` |
| `--anchor` | yesterday in Europe/Warsaw | the last of the 56 dates; must be a **completed** date (before today in the zone), so a comparison is not "in progress" |
| zone | `Europe/Warsaw` | fixed for this dataset version |
| `--port` | `5442` | loopback port of the dataset PostgreSQL; first run only (then stored) |

The default anchor depends on the day you run it. The command prints the resolved parameters and the exact command that
reproduces them, and writes them to the manifest. It never reads `.env`, `DATABASE_URL` or any `TEST_*` variable.

What it does, in order, each step refusing to go on if the previous one failed:

1. Creates `.local/portfolio-dataset/` once (ignored by git): `settings.json` (the port), `secrets/` (random 256-bit
   passwords for the image's administrator and the three application roles, and an API cursor key), `compose.env`.
2. Starts the Compose project **`somalane-portfolio-dataset`** ([compose file](../../infra/compose/docker-compose.portfolio-dataset.yml)):
   its own PostgreSQL server (the pinned `postgis/postgis:17-3.5` image of the development stack), database
   `somalane_portfolio_demo`, network and volume, published on `127.0.0.1:<port>` only. A port held by anything else is
   reported; nothing is stopped to free it.
3. Proves isolation before the first change (section 4), then runs the existing `scripts/bootstrap-database.mjs` and
   `scripts/migrate.mjs` against that database only. The bootstrap changes cluster-wide roles, which is why the dataset
   has its own server rather than a database on the development server.
4. Seeds through the application's own services (section 3) and, only once the core writer has accepted the dataset,
   writes `.local/portfolio-dataset/manifest.json` and `seed-state.json` (section 6). No env file is written for the app:
   it is started by its own launcher (section 5). `api.env`/`web.env` files left by an earlier version of this tooling
   are no longer used by anything and can be deleted.

A complete rerun with the same parameters writes nothing and prints the same digest.

## 2. What the dataset contains

Calendar: dates `anchor-55 .. anchor`. **Current range** `anchor-27 .. anchor` (what Trends ending on the anchor shows);
**previous range** `anchor-55 .. anchor-28` (the activity comparison's previous period). `k` below is the number of dates
before the anchor (`k = 0` is the anchor). Every instant is a local wall time in Europe/Warsaw, so a range crossing a
daylight-saving change is exact; the numbers vary with the seed, the patterns do not.

| Records (default parameters) | Count | Pattern |
|---|---|---|
| Identities | runner `…0001`, coach `…0002`, organization `…0000` | the demo identities of `scripts/demo-plan.mjs`; provisioned by the owner role |
| Check-ins | 48 | none when `k % 7 = 3`; weight missing when `k % 5 = 2`, sleep duration missing when `k % 11 = 6`; mood, soreness, sleep quality and a synthetic note on some dates |
| Manual movement | 46 | none when `k % 6 = 4`; steps only when `k % 8 = 5`; active energy only when `k % 13 = 7`; `k = 20` records 0 steps and 0 kcal (a value, not a gap) |
| Manual activities | 27 | runs with a distance when `k % 7` is 1 or 4, plus `k = 13` (9 current, 8 previous); strength without a distance when `k % 7 = 6`; walks only in the current range (`k = 0` with, `k = 16` without a distance) |
| GPX imports | 2 | current range only: a hike (`k = 19`) and a ride (`k = 5`), points every 5 s on a generated loop |
| TCX imports | 2 | a swim in each range (`k = 33`, `k = 12`), two laps whose reported totals round half up |
| Recorded runs | 6 (2,178 points) | finished, three per range (`k` = 44, 37, 30 and 23, 9, 0), one point every 5 s, current published summaries; the anchor's run is shared with the coach (history only) |
| Meals | 121 | none when `k % 5 = 3`; a full breakfast (all four values); a lunch, full when `k` is even, energy and protein only when odd; a title-only dinner when `k % 4 = 1`; an energy-only snack when `k % 3 = 2`; "Black coffee" with all four values recorded as 0 when `k % 6 = 0` |
| Unlogged dates | 2 | `k = 10` and `k = 38`: nothing at all is recorded (unknown, not inactivity) |

Comparisons: manual runs have a distance on every entry in both ranges, so count, duration and distance changes are all
defined (default: 9 vs 8 entries, +12.5 %; 73.20 km vs 61.60 km). Recorded runs are 3 vs 3 with current summaries.
Elsewhere coverage is deliberately partial and never merged across sources: GPX has no previous-range entries, strength
never records a distance, the walk comparison has no previous period entries.

## 3. How it is written

- Owner role (`running_tracker_owner`): only the two users, the organization and the two memberships, insert-only. The
  application has no route for these.
- Runtime role (`running_tracker_runtime`): every record, through the existing service functions (`putDailyMetrics`,
  `putDailyMovement`, `createActivity`, `confirmGpxImport`/`confirmTcxImport` after the real `readGpxActivity`/
  `readTcxActivity`, `createMeal`, `createRun`, `ingestRunPoints`, `applyRunCommand`, `upsertRunShare`) inside
  `withAuthenticatedTenantTransaction`, with each request parsed by its contract schema first. Row-level security,
  triggers, constraints and privileges are all in force.
- Maintenance role (`running_tracker_maintenance`): run summaries are calculated and published by
  `runSummaryPublicationOnce`, the function the API's summary worker runs (`calculate_run_summary`, the display-geometry
  simplifier, `publish_run_summary`). No summary or geometry is inserted by the tooling.
- Historical instants come from the injected `Clock` each service already accepts (tooling only). IDs, `created_at`,
  `updated_at` and server-owned provenance (`source`, import fingerprints, meal creation digests) are the database's or
  the service's own.
- No AI provider is constructed and no network call is made except to the dataset database.

Code: [`apps/api/src/portfolio-dataset/`](../../apps/api/src/portfolio-dataset/) (`dataset-plan.ts` the pure planner,
`isolation.ts`, `dataset-writer.ts` the core writer, `dataset-snapshot.ts` the digest, `prepare-cli.ts` the command).

## 4. Isolation

Refused unconditionally, in the CLI **and** in the core writer (there is no flag, variable or option to override it):
the databases `running_tracker` and `running_tracker_test`, any database other than `somalane_portfolio_demo` or a
throwaway `somalane_portfolio_t_<12 hex>`, any host but `127.0.0.1`, any query parameter in a URL (identity overrides
are refused by the API's own URL parser), a URL for another role than its use, and `APP_ENV=production`.

Before any change, the tooling proves the connection reaches the owned container:

1. exactly one running container carries the labels `com.docker.compose.project=somalane-portfolio-dataset` and
   `com.docker.compose.service=postgres`, was started from the dataset compose file, and publishes only `5432/tcp`, only
   on `127.0.0.1`, on the port the URL names;
2. inside that container (`docker exec … psql`, its own socket) the server reports its **system identifier**, a random
   64-bit value chosen when the cluster was initialised;
3. over each TCP connection actually used (administrator, owner, runtime, maintenance, every new pooled connection), the
   server must report the expected database, `current_user = session_user =` the expected role, the same system
   identifier, and `cluster_name = somalane-portfolio-dataset`.

Docker NAT makes the server's own address and port those of the container, not the published loopback endpoint, so they
are not compared; the system identifier ties the TCP connection to the container proven to be ours. If any check fails
the command stops and says which one; nothing was changed.

## 5. Review the populated app

The existing API and web app, unchanged, on their own ports (the normal `demo:up`, `npm run dev` and `.env` are not
touched). Two terminals, from the repository root:

```sh
npm run portfolio:dataset:api     # http://127.0.0.1:3300
npm run portfolio:dataset:web     # http://127.0.0.1:5373
```

Open <http://127.0.0.1:5373> (that host name, not `localhost`) and press **Demo runner** (or **Demo coach**). Ctrl+C in
each terminal stops them. Use only these commands for the populated app; the browser walkthrough
(`npm run test:e2e:portfolio-dataset`) starts the same launcher
([`serve-cli.ts`](../../apps/api/src/portfolio-dataset/serve-cli.ts)).

**Why a launcher, not `node --env-file`** (fixed after the step-2 review, 2026-11-22). The first version documented
`node --env-file=…/api.env` and `…/web.env`. Variables already set in the shell win over an `--env-file`, and the API's
loader then also falls back to `.env`, so an inherited `DATABASE_URL`/`MAINTENANCE_DATABASE_URL` (for example to
`127.0.0.1:5433/running_tracker`) or `API_PROXY_TARGET=http://127.0.0.1:3000` silently moved the "isolated" app to the
normal stack. The launcher now decides everything itself:

- **API.** Its configuration source is exactly the dataset's own settings and secrets (`settings.json` and `secrets/`
  under `.local/portfolio-dataset/`): runtime and maintenance URLs of `somalane_portfolio_demo`, `127.0.0.1:3300`, the
  one origin `http://127.0.0.1:5373`, local sign-in for the demo runner and coach only, a cursor key, every AI provider
  off. It is passed to the application's own `loadEnvironment` as its *only* source, with no `.env` file, so nothing
  else (an inherited or `.env` value of a database URL or its `*_FILE` form, a listening address or port, origins,
  identities, an AI provider, OIDC, a metrics listener, a deletion-journal directory) can take part; anything not named
  takes the application's default (OIDC, metrics and journal export off). The result is checked
  (`assertIsolatedApiConfiguration`); the launcher's own environment is reduced to operating-system variables (so the
  PostgreSQL driver sees no `PG*` default); the configured runtime and maintenance URLs are then proven, connection by
  connection, to reach the owned container as `running_tracker_runtime` and `running_tracker_maintenance` (the checks
  of section 4); only then does the existing `main()` start, through its `loadConfig` injection point. It prints the
  verified targets as `role@127.0.0.1:5442/somalane_portfolio_demo`, never a password or key.
- **Web.** Vite runs with operating-system variables only, plus `API_PROXY_TARGET=http://127.0.0.1:3300`,
  `VITE_LOCAL_DEMO_ENABLED=true` and an empty `VITE_MAPBOX_ACCESS_TOKEN` (no external map request from this stack;
  the maps show their tokenless notice), on `--host 127.0.0.1 --port 5373 --strictPort`. Vite never lets a `.env` file
  override a variable that is set.

Operating-system variables kept: paths, temporary directories, the user profile, locale and terminal (`PATH`,
`SystemRoot`, `TEMP`, `HOME`, `LANG`, …); `NODE_OPTIONS`, `npm_*` and every application variable are dropped. If the
settings point anywhere but the owned container, the API stops before connecting or starting.

Named selections for the default parameters (`--anchor 2026-11-21`; the command prints them for any anchor):

| Screen | Selection | What it shows |
|---|---|---|
| Today | Date **2026-11-21** | check-in (sleep 6 h 56 min, weight 70.73 kg, a note), 8,424 steps / 492.6 kcal, 3 meals including a recorded-zero coffee, a walk, one finished GPS run of 6.72 km |
| Weekly review (its own view; also in the Check-in tab) | Week **2026-11-09 – 2026-11-15** | 6 movement days (54,613 steps over 5), 14 meals on 5 days with partial nutrient coverage, a TCX swim, a GPS run, the unlogged date 2026-11-11 |
| Trends, nutrition | End date **2026-11-21** | 61 entries on 22 of 28 days; 2026-10-29 no entry logged; 2026-11-14 partial (1 of 2 entries with fat); 2026-11-21 recorded zeros; 2026-11-20 a title-only dinner |
| Trends, activity | Source **Manual**, type **Run**, end date 2026-11-21 | compared with 2026-09-27 – 2026-10-24: +1 (+12.5 %), +1:05:01 (+19.5 %), +11.60 km (+18.8 %) |
| Archive → My runs → View details | the run of 2026-11-21 | finished, current summary: 6.72 km, 34:00 |
| Coach | sign in as **Demo coach** | the coach's Today is empty: check-ins, movement, meals and activities are owner-only; only the shared run is visible |

**The primary journey** (release step 3, [ADR-0097](../adr/0097-navigation-and-first-use-flow.md)). After **Demo
runner** the page is on **Today**. Set the date to **2026-11-15** (the review week's Sunday) → **Weekly review** (Today's
button) opens the week 9–15 Nov → **28-day trends ending Sun 15 Nov 2026** (a completed week ends on its Sunday) → a
nutrition series, then a row's **Meal log** (and **Back to Trends**) or **Open** (Today on that date). The navigation's
**Weekly review** button reopens the week you chose. The walkthrough's second test follows exactly this, with the
selections read from the manifest.

When the API runs, its maintenance jobs run too: the raw points of runs finished more than seven days ago are purged
(retention, migrations 0014–0015), while their summaries stay. That is expected and does not change the digest.

## 6. Reruns, interruptions, conflicts

- **Complete rerun**: writes nothing; the digest must equal the one recorded when these parameters last completed
  (`seed-state.json`, else `manifest.json`); the command prints `recorded digest: matched`.
- **Interrupted first seed** (a crash, a failed statement, before these parameters ever completed): every write is
  keyed by a stable operation key derived from the seed (activity ids and idempotency keys, meal keys, run ids, point
  sequences, the finish command id), so the dataset is incomplete but consistent, and its committed writes stay.
  `seed-state.json` records `interrupted` and the error; running the **same** command again resumes and ends with the
  same digest as an uninterrupted run. A run killed outright records nothing; the next run still classifies the stored
  data as partial and resumes it.
- **A recorded completion that lost data**: once these parameters completed on this computer (`seed-state.json`, else
  `manifest.json`), that completion is the only state accepted: complete with the recorded digest. An empty or partial
  dataset (for example a deleted meal, or a removed volume with `.local/portfolio-dataset/` kept) is refused before any
  write, as is a complete one with another digest; it is never re-seeded as if it were an interrupted first seed. To
  seed again from nothing, start over (below).
- **Different seed, anchor or version, unexpected data, or drift**: refused before any write, listing the reasons; no
  state file or manifest is replaced. Refused are: another user, organization or membership; a record of someone else;
  a deleted run; an edited or unplanned record; and any run state the plan's lifecycle cannot produce (see below).
- **What a refusal says**: a refusal before the first write says `this attempt wrote nothing`. The final check of a
  finished seed (only reachable without a recorded completion, since with one nothing is written) instead says how many
  write operations the attempt performed and that what they committed stays (nothing is rolled back). Neither replaces
  `seed-state.json` or `manifest.json`.
- **Two seeds at once**: serialized by a PostgreSQL advisory lock on the dataset database; the second stops at once.

**What a stored run must be** (the core writer, `validateRun` in
[`dataset-writer.ts`](../../apps/api/src/portfolio-dataset/dataset-writer.ts), fixed after the step-2 review). The first
version checked only the requested start, the finish time and whether a summary was current, so a changed summary
distance, a removed display geometry, another effective start or a replaced finish-command payload were accepted as
"complete", and the CLI then recorded the drifted digest as the new manifest. Now each run must be a state the writer's
lifecycle, then the summary job, then retention can produce:

| Stage | Required |
|---|---|
| Created | requested and effective start = the planned start; control revision 0 |
| Uploading (partial) | `recording`; the points are exactly the first *k* planned batches, each point equal to the planned point; data revision *k*; no command, no summary |
| Finished | `finished` at the planned instant; control revision 1, data revision = batches + 1; exactly the planned finish command with its canonical payload (`expectedControlRevision` 0, `finish`) and response |
| Summarised | current for the data revision; the server's current algorithm; valid quality statistics; a display geometry; the planned duration; a distance within 2 % of the planned polyline |
| Retention | raw history `available` with every planned point, or `purging` with a subset of them, or `purged` with none, the last two only with a current summary; this is the raw purge the API runs and it keeps the dataset complete with the same digest |

When a completion digest is recorded, it is checked before anything is written or replaced (`baselineRefusal` in the
core writer): a complete dataset must have exactly that digest, so a change too small for the checks above (for example
a summary distance moved by half a metre) is still refused, and an empty or partial dataset is refused outright. The
first version of this check ran only for a complete dataset: a half-metre summary change plus one deleted meal was
classified partial, resumed (254 write operations, the meal recreated) and only then refused by the final digest
check, with a message claiming nothing was written. When no digest is recorded on this computer (for example after
deleting `.local/portfolio-dataset/`), only the checks above apply and the command says `none recorded`.

### Starting over

There is no reset command. To discard the dataset and its credentials, by hand:

```sh
docker compose --project-name somalane-portfolio-dataset --file infra/compose/docker-compose.portfolio-dataset.yml --env-file .local/portfolio-dataset/compose.env down --volumes
```

then delete `.local/portfolio-dataset/`. This removes only the dataset project's container, network and volume.

## 7. Manifest and digest

`manifest.json` holds the dataset version, seed, zone, anchor and both ranges, logical counts, the deliberate gaps, the
expected analytics of the named selections (computed from the plan, independently of the read models), the selections
and the digest. Default parameters (`somalane-portfolio-v1`, `2026-11-21`, `Europe/Warsaw`) give
`sha256:b6222c858f464e8d4fe465b3f9c29a95f5c8f0f3e0cf3403b0021d49012e857d` on PostgreSQL 17.5 / PostGIS 3.5 of the pinned
image.

**Digest normalisation** (`portfolio-dataset-digest-v1`): SHA-256 over the normalisation version and the canonical JSON
(keys sorted, rows in a fixed SQL order) of the runner's and coach's rows read by the owner role in one read-only
snapshot. **Kept:** users and memberships; check-in, movement and meal values with their dates, zones and sources;
activities with type, start, duration, distance, effort, notes, source, client-chosen id and idempotency key and the
import fingerprint; meal idempotency keys and creation digests; runs with id, status, requested and effective start,
finish, data and control revisions; the finish commands' canonical payloads and responses; summaries with source
revision, algorithm version, whether current, distance (mm) and observed duration (ms), quality statistics, and the
display geometry as point count plus the MD5 of its WKT snapped to 1e-7°; run shares. Numerics are PostgreSQL's
`trim_scale` text. **Left out, and only these:** database-generated meal ids; `created_at`/`updated_at`/`received_at`;
the summary's `computed_at` (the publication clock); the organization's `archive_revision` (a cache-invalidation
counter); sessions; and the retention-owned `run_points` and `runs.raw_state`, which the API's raw purge changes
without changing the dataset. Floating-point results are stable on one PostgreSQL/PostGIS build; another build could
change the summary digits without changing their meaning.

## 8. Tests

| Command | What it proves |
|---|---|
| `npm test` (part of `npm run verify`) | planner determinism, the 56-date calendar and DST crossings, request validity, gaps, refusals of targets/roles/hosts/URL overrides, the Docker ownership proof, connection identity checks, core-writer refusals before Docker or a connection is touched; the launcher's configuration under poisoned inherited variables and poisoned `.env` files, and its refusal before connecting when the settings point elsewhere; every run-drift and malformed-partial case of the table above; the recorded completion baseline (only its own completion accepted; empty, partial or another digest refused); refusal messages that claim "wrote nothing" only before the first write; completion artifacts left unchanged on a refusal |
| `npm run test:portfolio-dataset` | real PostgreSQL, **throwaway databases inside the dataset server only** (created and dropped by name): seeding, idempotent rerun with the recorded digest, digest agreement across databases, interrupted and resumed seeds, conflicting parameters, a concurrent second seed, existing reads matching the plan, current summaries, import provenance, coach and outsider isolation, stored drift refused (by the run checks and by the recorded digest) with nothing written, a real raw purge staying complete with the same digest, malformed partial uploads refused before further writes; with a recorded completion (through the core writer and through `seedAndRecord`), a half-metre summary change plus a deleted meal, a deleted meal alone and an empty target refused before any write (no write hook reached; every row, row version and timestamp unchanged; `seed-state.json` and `manifest.json` byte-identical with their modification times), an unchanged completion accepted with 0 writes and no row rewritten, and a genuine interrupted first seed still resumed. Plus `startup.dataset.test.ts`: the real launcher started from a poisoned parent (inherited variables and both `.env` files pointing at test-owned decoys), which must serve the demo dataset on its own endpoints and never contact a decoy (it reads the demo dataset; signing in writes a session row) |
| `npm run test:e2e:portfolio-dataset` | a bounded Chromium walkthrough of the populated screens, started through the same launcher; read-only; screenshots in `.local/portfolio-dataset/screenshots/` |

The last two need `npm run portfolio:dataset` first and Docker running. Neither is part of CI.

## What this is not

Synthetic GPS loops, synthetic files and a desktop browser say nothing about real GPS accuracy, real exports from
devices, Safari or a phone, and no AI quality is involved (every provider is off).
