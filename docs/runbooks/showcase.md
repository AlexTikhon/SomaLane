# Runbook: the public read-only showcase (release step 5)

Audience: whoever regenerates, builds, reviews or (later) hosts the showcase. Related:
[ADR-0099](../adr/0099-public-read-only-showcase.md), [release plan, step 5](../portfolio-v1-release-plan.md#step-5-public-read-only-synthetic-showcase),
[verification report](../reports/showcase-verification-2026-11-23.md), [portfolio dataset runbook](portfolio-dataset.md).

The showcase is a static page that shows the primary journey (Today → Weekly review → Trends → the original day or its
meals) from one file of synthetic snapshots. It needs no API, no database and no sign-in at run time, and it sends no
request but for its own files.

## 1. Commands

```sh
npm run portfolio:showcase:export              # regenerate apps/web/showcase/public/showcase-snapshot.json
npm run portfolio:showcase:export -- --check   # export in memory and compare with that file (exit 1 if they differ)
npm run build:showcase                         # static output in apps/web/dist-showcase/
npm run preview:showcase                       # serve that output on http://127.0.0.1:4380 (no API proxy)
npm run test:e2e:showcase                      # build with a test link, then Chromium/Firefox checks with no API server
```

`npm run build` and `npm run verify` build the showcase too (with no link configured). The export needs the dataset
(`npm run portfolio:dataset`) and Docker running; building, previewing and testing need only the committed snapshot.

## 2. Configuration: the application link

| Variable | Read by | Rule |
|---|---|---|
| `SHOWCASE_APP_URL` | `vite.showcase.config.ts`, at build time | the invite-only application's address. An absolute `https:` URL, or `http:` for `127.0.0.1`, `localhost` or `[::1]` only; no user name, password or fragment. Anything else fails the build. Unset or empty: every view says that the address is not configured. |

There is no default and no address is invented. For the hosted build (release step 8), set it to the application's
real origin, for example on Linux `SHOWCASE_APP_URL=https://<application host>/ npm run build:showcase`, or in PowerShell
`$env:SHOWCASE_APP_URL='https://<application host>/'; npm run build:showcase`. The browser test builds with
`http://127.0.0.1:5999/` (nothing listens there; the test only checks the link). `SHOWCASE_OUT_DIR` changes the output
directory (the browser test uses `.local/showcase/e2e/dist`). No `.env` file and no `VITE_*` variable is read by this
build.

## 3. Hosting notes for release step 8 (nothing is hosted yet)

- Serve the contents of `apps/web/dist-showcase/` as static files: `index.html`, `assets/*.js`, `assets/*.css` and
  `showcase-snapshot.json` (`application/json`). Paths are relative, so any path prefix works.
- The page needs no proxy and makes no request to `/api`; the host should not forward anything for it. It sets no
  cookie and writes no browser storage, so it needs no consent banner of its own.
- Check after deploying: every view shows "Read-only showcase · synthetic data" and the link to the application, and the
  browser's network panel lists only the page's own files (release step 9 records this).

## 4. What the export reads, and its guards

Reused from the dataset tooling ([runbook, section 4](portfolio-dataset.md#4-isolation)) and applied before the first
query:

1. `APP_ENV=production` is refused.
2. `.local/portfolio-dataset/manifest.json` must be the dataset's (version, digest normalisation, database
   `somalane_portfolio_demo` of project `somalane-portfolio-dataset`), and `seed-state.json` must record a completed seed
   with the same parameters and digest. Neither is written.
3. The URLs come from the dataset's own settings and secrets and must pass its isolation rules (127.0.0.1 only, never
   `running_tracker` or `running_tracker_test`; only `somalane_portfolio_demo` for an export).
4. The running container is proven to be the dataset's (Compose labels, compose file, published port, system identifier).
5. Every connection (owner and runtime roles) proves its database, role, system identifier and cluster name, and must
   report `default_transaction_read_only = on` (the export opens it with that option): no transaction can write.
6. The stored dataset, read by the owner role in one REPEATABLE READ READ ONLY snapshot, must be complete with exactly
   the recorded digest, before the export and again after it.

Then, as the synthetic runner (no session is created), at one fixed instant: Today's overview and the meal list of every
offered day, the weekly review of every offered week, the daily trends of every offered end date, and the activity trends
(with the previous-period comparison) of every source and type for those end dates. Each answer is parsed by its
contract schema. 119 reads for the default dataset.

## 5. What the snapshot contains (an allowlist)

| Part | Content |
|---|---|
| `dataset` | version, seed, canonical digest and its normalisation, anchor, zone, current and previous ranges, `synthetic: true` |
| `snapshot` | `asOfDate` (the anchor) and `readAt` (the one instant every read was given) |
| `contracts` | the response contract versions it was read with (`daily-overview-4`, `weekly-review-5`, `daily-trends-2`, `activity-trends-1`); another version is refused by the page and the tests |
| `selections` | the bounded catalog: sample date, offered days, weeks, Trends end dates, activity selections and the defaults |
| `responses` | the five response types, as the services answered them, keyed by date, week, end date or `endDate\|source\|type` |
| `contentDigest` | SHA-256 over `showcase-snapshot-normalization-v1` and the canonical JSON of everything else |

Never in it: credentials, sessions, CSRF tokens, cursors, command payloads, raw GPS points or geometry, identifiers of the
dataset's people, organization or runs, note text, or any other database state. The export refuses a document with such
a field or value, and `npm test` checks the committed file again.

**Catalog** (default dataset, anchor 2026-11-21): sample date Sat 21 Nov 2026; Trends ending Sun 15 Nov (the primary
journey's completed week) and Sat 21 Nov 2026; 34 offered days (19 Oct to 21 Nov 2026, every date those two ranges
open); 5 weeks (19 Oct to 16 Nov); activity: manual run, walk and strength, GPX ride and hike, TCX swim, recorded run.
Representative states: 29 Oct no meal logged (unknown, not zero), 11 Nov nothing recorded at all, 14 Nov carbohydrate on
1 of 2 entries (partial), 20 Nov a title-only dinner, 21 Nov a coffee recorded as 0.

**Date policy.** The application's (`journey-navigation.ts`) with "today" = the snapshot's last date: Today → the week
of its date; a completed week's Trends end on its Sunday, the anchor's unfinished week ends on the anchor. An action
whose target is not in the catalog (an October week's range, Trends ending on a date that is not an end date) is
replaced by a sentence saying which ranges the showcase includes.

## 6. Determinism: volatile values

| Value | Handling |
|---|---|
| `provenance.computedAt` of every response | the injected clock: the first instant after the anchor in the dataset's zone (`2026-11-21T23:00:00.000Z` by default) |
| a meal entry's `mealId` (database-generated) | a UUID v8 derived from `showcase-meal-v1\|<date>\|<position>` |
| a meal entry's `createdAt`, `updatedAt` (wall clock of the seed) | `readAt` |
| a meal page's `nextCursor` (opaque, signed) | must be null; a date that needs a second page stops the export |
| key order, whitespace, line endings | canonical JSON: keys sorted, two-space indentation, LF, one final newline (`.gitattributes` keeps LF) |

Nothing else is changed. Two exports from the same baseline are byte-identical; `--check` proves the committed file is
what the dataset produces now.

## 7. When to regenerate

After `npm run portfolio:dataset` with other parameters, after a change of a read service or a response contract, or when
`--check` fails. Regenerate, run `npm test` (the committed file is validated there) and `npm run test:e2e:showcase`, and
commit the new file with the change that caused it.

## 8. Failure messages

| Message | Meaning |
|---|---|
| `No dataset manifest …` / `seed-state.json does not record a completed dataset …` / `… record different digests` | prepare the dataset first; nothing was exported |
| `The dataset's PostgreSQL container … is not running` and other isolation messages | the dataset's own checks; nothing connected |
| `… the stored dataset is not the complete planned dataset` / `… digest … is not the recorded …` | the dataset drifted; the export reads only the recorded baseline |
| `the snapshot would publish more than the allowlist` | a response would carry an identifier, note or forbidden field; nothing was written |
| On the page: `The showcase data file is not available (HTTP 404)…`, `… is damaged: it is not valid JSON.`, `… does not match the format this page expects (…)` | the build lacks the file, or it is damaged or of another version; the page asks for nothing else |

## What this is not

A static picture of synthetic data at one instant: no live data, no editing, no sign-in, no AI output, and no claim about
the hosted application, a phone or Safari.
