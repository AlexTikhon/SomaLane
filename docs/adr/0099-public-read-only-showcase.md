# ADR-0099: Public read-only showcase of synthetic snapshots

- Status: accepted; implemented (see the [verification report](../reports/showcase-verification-2026-11-23.md)). Local
  evidence only: no hosted CI run of this change, and the showcase is not hosted anywhere.
- Date: 2026-11-23
- Release step: 5 of the [portfolio v1 release plan](../portfolio-v1-release-plan.md#step-5-public-read-only-synthetic-showcase).
- Relates to: [ADR-0097](0097-navigation-and-first-use-flow.md) (the primary journey and its date policy),
  [ADR-0098](0098-initial-bundle-reduction.md) (what the application's first page loads), the step-2 dataset
  ([runbook](../runbooks/portfolio-dataset.md)), [ADR-0043](0043-single-host-deployment-profile.md) and
  [ADR-0046](0046-oidc-sign-in.md) (the invite-only application the showcase links to).
- Scope: a new build target in `apps/web` (`showcase/`, `src/showcase/`, `vite.showcase.config.ts`), small extractions of
  pure content blocks, a snapshot envelope in `packages/contracts` (subpath `./showcase`), an export command in
  `apps/api/src/portfolio-dataset/`, tests and docs. No API route, schema, migration, authentication, configuration guard
  or dependency change.

## Context

Portfolio v1 publishes two surfaces: a public read-only showcase of synthetic data, and the full application behind
invite-only OpenID Connect. The showcase must show the primary journey (Today → Weekly review → Trends → back to the
records) without sign-in, must not add an anonymous path into the API, must write nothing, and must be visibly synthetic
and read-only. The figures it shows must be the application's own (code computes every number; the showcase must not
recompute analytics), and they must come from the isolated step-2 dataset, never from real data.

The application's screens are stateful: `App` restores runs, owns capture, uploads and the writer lease, and each Screen
wrapper starts a controller that reads the API with the session. None of that may run on a public page.

## Decision

1. **A separate static build.** `npm run build:showcase` builds `apps/web/showcase/index.html` →
   `src/showcase/main.tsx` into `apps/web/dist-showcase/` (HTML, assets and one data file) with its own Vite config: no
   proxy, `base: './'` (hostable under any path), no `.env` and no `VITE_*` variable read. The application's entry
   (`src/main.tsx`) cannot reach any of it, and the snapshot is a file next to the page, not a module, so neither is in
   the application's bundle. `npm run build` (and so `npm run verify`) builds both.
2. **Snapshots from the read services, not from SQL.** `npm run portfolio:showcase:export` asks the application's own
   services (`DailyOverviewService`, `WeeklyReviewService`, `DailyTrendsService`, `ActivityTrendsService` with the
   previous-period comparison, and `listMeals`) as the synthetic runner, validates each answer with its existing contract
   schema, and writes one document. The showcase renders those responses as they are: coverage, sources, missing versus
   recorded zero and every total are the service's.
3. **The dataset's guards, read-only.** Before connecting: `APP_ENV=production` refused, the manifest and the recorded
   completion (`seed-state.json`) must agree, the URLs pass the dataset's isolation rules (only
   `somalane_portfolio_demo` on 127.0.0.1; `running_tracker` and `running_tracker_test` refused unconditionally), and the
   container is proven to be the dataset's (Compose labels, published port, system identifier). Every connection proves
   its database, role, system identifier and cluster name and is opened with `default_transaction_read_only=on` (checked
   on the connection), so even a plain `BEGIN` cannot write. The stored data must be complete with exactly the recorded
   digest before and after the reads. Nothing is bootstrapped, migrated, seeded or reset.
4. **A bounded catalog from the manifest.** Sample date = the anchor; Trends end dates = the anchor and the Sunday of the
   manifest's review week (the primary journey's completed week); offered days = every date those two ranges contain (a
   Trends row can open any of them); offered weeks = the weeks of those days; activity selections = the source/type pairs
   with entries. The envelope's cross-checks require the catalog to be closed and every response to match its entry, and
   the page offers exactly the catalog: an action whose target is not in it is replaced by a sentence saying so.
5. **Deterministic output.** Every read gets one injected clock, the first instant after the anchor in the dataset's
   zone, so every `computedAt` is that instant and the anchor is a completed date. A meal's database-generated id is
   replaced by a UUID derived from its date and position and its wall-clock times by that instant; a meal page must fit
   one page (no cursor is exported). The file is canonical JSON (sorted keys, LF) with a content digest. Two exports from
   the same baseline are byte-identical, and `--check` compares a fresh export with the committed file.
6. **An explicit allowlist.** The document holds dataset identity (version, seed, digest, anchor, zone, ranges), the
   snapshot instant, the contract versions, the catalog and the five response types; nothing else. The export refuses a
   document that would contain a credential-, session-, CSRF-, coordinate-, identity- or note-like field, an identifier of
   the dataset's people, organization or runs, or a note's text.
7. **The public boundary on the page.** Every state and view shows "Read-only showcase · synthetic data" (sticky), the
   dataset's dates and sample date, and a link to the invite-only application from `SHOWCASE_APP_URL` (https, or http on
   a loopback host only; validated at build time and again on the page; no default address). There is no editing,
   deletion, import, recording or generation control, no sign-in, no AI section, no request to `/api` and no write to
   browser storage. A missing or invalid snapshot is reported on the page, with only a retry of the same file.
8. **Reuse by small extractions.** The pure blocks move out of the files that import the API client:
   `TodayOverviewContent.tsx` (actions optional), `WeeklyReviewContent.tsx`, `TrendsContent.tsx` (the meal action's words
   are a prop), `MealEntryValues.tsx`; `ActivityTrendsContent` is exported. The original modules re-export them, and the
   application renders them as before. The date policy is `journey-navigation.ts` with "today" = the snapshot's last
   date.

## Consequences

- The application's initial JavaScript grows by 194 B raw (83 B gzip) for the optional-action branches; its CSS is
  unchanged; no showcase code, text or data is in its build (measured, see the report).
- The committed snapshot (`apps/web/showcase/public/showcase-snapshot.json`, about 470 KB) is a generated build input. A
  change of a response contract version makes the envelope refuse it until it is exported again.
- The showcase states its dates as the dataset's, not the visitor's: a visitor never sees "today".
- `LOCAL_AUTH_ENABLED=true` with `APP_ENV=production` is still refused (`apps/api/src/config/environment.ts` unchanged);
  no anonymous endpoint exists.

## Alternatives not taken

- **Mount `App` or the Screens with a fake API.** It would run run recovery, capture, IndexedDB and session code on a
  public page, and a fake would have to re-implement the server's answers.
- **An anonymous read-only API mode.** Contradicts the release guardrails (no anonymous path into private routes).
- **Export by SQL from the tables.** Would recreate the analytics outside the services that define them.
- **Bundle the snapshot into the showcase's JavaScript.** Simpler, but a missing or damaged data file could not be
  reported, and the data would change every chunk hash.

## Verification

[Report](../reports/showcase-verification-2026-11-23.md): unit tests of the envelope, catalog, normalisation, allowlist,
refusals, navigation and views; deterministic and `--check` exports against the dataset with the dataset unchanged;
`npm run test:e2e:showcase` against the static production build with no API server; the application's suites.
