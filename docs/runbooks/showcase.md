# Runbook: the public read-only showcase (release steps 5, 7 and 8)

Audience: whoever regenerates, builds, reviews or publishes the showcase. Related:
[ADR-0099](../adr/0099-public-read-only-showcase.md), [ADR-0101](../adr/0101-github-pages-showcase-publication.md)
(GitHub Pages, the source link), [release plan, steps 7 and 8](../portfolio-v1-release-plan.md#step-7-static-publication-preparation),
verification reports of [step 5](../reports/showcase-verification-2026-11-23.md),
[step 7](../reports/showcase-pages-preparation-2026-11-24.md) and [step 8](../reports/showcase-hosted-verification-2026-11-24.md)
(publication and hosted checks), [portfolio dataset runbook](portfolio-dataset.md).

The showcase is a static page that shows the primary journey (Today → Weekly review → Trends → the original day or its
meals) from one file of synthetic snapshots. It needs no API, no database and no sign-in at run time, and it sends no
request but for its own files. It is the only part of SomaLane meant to be published: the full application is not
hosted and runs locally ([README, Run it locally](../../README.md#run-it-locally)). The public address is
**`https://alextikhon.github.io/SomaLane/`**, confirmed by the deployment of 2026-11-24 (commit `3bbe2b2`, Pages run
45387434787; [section 3.5](#35-current-publication)).

## 1. Commands

```sh
npm run portfolio:showcase:export              # regenerate apps/web/showcase/public/showcase-snapshot.json
npm run portfolio:showcase:export -- --check   # export in memory and compare with that file (exit 1 if they differ)
npm run build:showcase                         # static output in apps/web/dist-showcase/ (what GitHub Pages publishes)
npm run preview:showcase                       # serve that output on http://127.0.0.1:4380 (no API proxy)
npm run test:e2e:showcase                      # build, then Chromium/Firefox checks under /SomaLane/ with no API server
```

`npm run build` and `npm run verify` build the showcase too. The export needs the dataset (`npm run portfolio:dataset`)
and Docker running; building, previewing, testing and publishing need only the committed snapshot. The WebKit projects
of the same check run in `npm run test:e2e:webkit` ([ADR-0100](../adr/0100-bounded-webkit-gate.md)).

## 2. Configuration

The page has none. Every state (loading, a broken data file, every view) shows the label "Read-only showcase ·
synthetic data", a fixed link **Source code on GitHub** to `https://github.com/AlexTikhon/SomaLane`, and one sentence
saying that the full application, with sign-in, recording and editing, is not hosted and runs locally from the source.

| Variable | Read by | Rule |
|---|---|---|
| `SHOWCASE_OUT_DIR` | `vite.showcase.config.ts`, at build time | another output directory; only the browser check sets it (`.local/showcase/e2e/dist`). Unset: `apps/web/dist-showcase/`. |

`SHOWCASE_APP_URL` (the former link to the invite-only application) was removed by ADR-0101; a variable with that name is
ignored. No `.env` file and no `VITE_*` variable is read by this build. The output uses relative references
(`base: './'`), so the same files work under `/SomaLane/` or any other path; there is no Pages-specific build.

## 3. Publishing on GitHub Pages

Prepared in release step 7; carried out in release step 8 on 2026-11-24. **Published**: the setup of 3.2 is in place
and the site serves `3bbe2b2` ([section 3.5](#35-current-publication)). Every later publication is one run of 3.3,
followed by the checks of 3.4.

### 3.1 What is published, and by what

The workflow [`.github/workflows/showcase-pages.yml`](../../.github/workflows/showcase-pages.yml) ("Showcase on GitHub
Pages") uploads the contents of `apps/web/dist-showcase/` and nothing else: `index.html`, one `assets/index-*.js`, one
`assets/index-*.css` and `showcase-snapshot.json`. Never the repository, the application's build, `.local/` or test
output. It runs only when dispatched by hand, and only from `main`:

| Job | Permissions | What it does |
|---|---|---|
| `build` ("validate and build the showcase") | `contents: read` | refuses any ref but `main`; `npm ci`; the showcase unit tests (the committed snapshot against the contract schemas, views, source link, module boundary); installs Chromium, Firefox and WebKit; builds the showcase for the browser check and runs it under `/SomaLane/` with no API server (Chromium 9 tests, Firefox 3, WebKit desktop 9, WebKit phone-sized 4); `npm run build:showcase`; `diff -r` of that output against the tested build; uploads `apps/web/dist-showcase` |
| `deploy` ("deploy to GitHub Pages") | `pages: write`, `id-token: write` | starts only after `build` succeeded and only for `main`; environment `github-pages`; `actions/configure-pages` (fails early if Pages is not set up), `actions/deploy-pages`; writes the reported page URL to the run summary and the environment |

No secret, Docker, database, dataset export or API server is involved. The workflow does not run `npm run verify`, the
integration suite or the application's browser suites: the CI workflow does that for every push to `main`.

### 3.2 One-time repository setup (the owner, in GitHub's web interface)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Do not choose a branch and do not add a
   suggested workflow; the workflow above is already in the repository. Leave **Custom domain** empty. HTTPS is
   enforced for `github.io` addresses.
2. **Settings → Environments → `github-pages`** (GitHub creates it when the source is set to GitHub Actions, or at the
   first deployment). Under **Deployment branches and tags**, allow `main` only (GitHub's default for this environment
   is the default branch, `main`; keep it, or choose "Selected branches and tags" with the rule `main`). Add no secrets
   and no variables; the workflow uses none.
3. **Settings → Actions → General**: Actions must be allowed for the repository. The default workflow permissions can
   stay read-only; each job of the workflow names its own.

**Done on 2026-11-24** (step 8), with the owner's authorization. It was done through the REST API, which is equivalent
to steps 1 and 2:

```sh
gh api repos/AlexTikhon/SomaLane/pages                                   # 404 before: no site
gh api -X POST repos/AlexTikhon/SomaLane/pages -f build_type=workflow    # source: GitHub Actions
gh api repos/AlexTikhon/SomaLane/environments/github-pages/deployment-branch-policies   # check: one policy, "main"
```

Enabling Pages made GitHub create the `github-pages` environment itself, with `custom_branch_policies: true` and a
single branch policy `main`. Step 2 therefore needed no change and none was made. Result: `build_type: workflow`, no
custom domain, HTTPS enforced. The environment has no secrets, variables or reviewers. `main` has no branch protection
or ruleset, and Actions settings were not changed.

### 3.3 Run it

Before running: the commit to publish is on `main`, and its CI run succeeded:

```sh
gh run list --workflow ci.yml --branch main --limit 1     # conclusion "success" for the commit to publish
```

Then, in the web interface: **Actions → Showcase on GitHub Pages → Run workflow → Branch: main → Run workflow**. Or:

```sh
gh workflow run showcase-pages.yml --ref main
gh run list --workflow showcase-pages.yml --limit 1       # the run's id
gh run watch <run id>
gh run view <run id>                                      # both jobs "success"; the deploy job shows the page URL
```

Record the run id, the commit, the conclusion of each job and the URL `deploy-pages` reported (run summary, or
**Settings → Environments → github-pages**). Only that URL is the published address.

| Failure | Meaning |
|---|---|
| `build`, first step: "The showcase is published from main only" | dispatched for another branch; nothing was built or deployed |
| `build`, a test, browser check or `diff -r` step | the showcase or its output is not what was tested; nothing was uploaded or deployed. Reproduce with `npm run test:e2e:showcase` |
| `deploy`, `configure-pages`: Pages site not found or not enabled | step 1 of 3.2 is missing |
| `deploy`, `deploy-pages`: the branch is not allowed to deploy to `github-pages` | the environment's branch rule (3.2, step 2) |

To take the site down: **Settings → Pages → Unpublish site** (the button appears once a site is published). To replace
it, fix `main` and run the workflow again; every run publishes `main` as it is then.

### 3.4 Hosted checks (release step 8)

Run against the URL the deployment reported (below written as the expected address) and record the results with the
run id, the commit, the date and the browser versions in a step-8 report. No personal data, no screenshots of anything
but the showcase.

| # | Check | Expected |
|---|---|---|
| H1 | Address | the run's page URL is `https://alextikhon.github.io/SomaLane/`, or the different URL is recorded and used below |
| H2 | `curl -sI https://alextikhon.github.io/SomaLane/` | `200`, `text/html` |
| H3 | `curl -sI https://alextikhon.github.io/SomaLane` (no slash) | a redirect to `/SomaLane/` (`vite preview` answers this with 404 locally; Pages is expected to redirect) |
| H4 | `curl -s https://alextikhon.github.io/SomaLane/showcase-snapshot.json \| sha256sum` and `sha256sum apps/web/showcase/public/showcase-snapshot.json` at the published commit | the same digest; `curl -sI` of it says `application/json` |
| H5 | `curl -sI https://alextikhon.github.io/SomaLane/no-such-page` | `404` (GitHub's page; the showcase has no routes) |
| H6 | Open the address in desktop Chromium and Firefox | Today on Sat, 21 Nov 2026 (sample date); "Read-only showcase · synthetic data" visible, also after scrolling to the end; **Source code on GitHub** opens `https://github.com/AlexTikhon/SomaLane`; the sentence about running the full application locally is shown |
| H7 | The journey | Today: choose Sun, 15 Nov 2026 → **Weekly review of …** (week 9–15 Nov) → **Open 28-day trends ending on Sun, 15 Nov 2026** → Food energy → a row's **Meals** and **Open** → **Back to Trends** returns to the same range and series |
| H8 | Reload on Trends, and open `…/SomaLane/index.html` | the page loads again on Today (the navigation is in memory only); no error |
| H9 | Developer tools → Network, from a fresh load through H7 | requests only to `alextikhon.github.io/SomaLane/…`: the page, one script, one stylesheet, `showcase-snapshot.json`; no `/api`, no other origin |
| H10 | Developer tools → Application/Storage | no cookie, local or session storage entry, IndexedDB database, Cache Storage or service worker created by the page |
| H11 | Block `showcase-snapshot.json` (developer tools request blocking) and reload | the alert "The showcase data file could not be downloaded. Check the connection and try again.", the label and the source link stay, **Try again** asks for the same file only |

A phone browser may be added as an observation, but Playwright WebKit is not Safari: no Safari or iPhone claim follows
from these checks unless a physical device is recorded ([release plan, section 5](../portfolio-v1-release-plan.md#5-capability-claims-and-the-evidence-each-needs)).

How step 8 ran them ([report, sections 4 and 6](../reports/showcase-hosted-verification-2026-11-24.md#4-hosted-checks-h1h11)):

- H1–H5 with `curl`.
- H4's second digest from the commit itself: `git show <sha>:apps/web/showcase/public/showcase-snapshot.json | sha256sum`.
- H6–H11 in Playwright's desktop Chromium and Firefox against the live URL, with the step-7 browser check's request
  guard and storage instrumentation.
- H11 by aborting the snapshot request in the test browser only; the hosted file is never removed.
- In addition, the live files were compared with the run's `github-pages` artifact (`gh run download <run id> -n github-pages`).

### 3.5 Current publication

| Item | Value (2026-11-24) |
|---|---|
| Address (reported by `actions/deploy-pages`) | <https://alextikhon.github.io/SomaLane/> |
| Published commit | `3bbe2b2f44ba57aba52ecbc8f5087f43b6cf5095` |
| Hosted CI for it | [45385170103](https://github.com/AlexTikhon/SomaLane/actions/runs/45385170103), `success` (WebKit and Firefox gates included) |
| Pages run | [45387434787](https://github.com/AlexTikhon/SomaLane/actions/runs/45387434787), `build` and `deploy` `success`; deployment 8026957134 |
| Hosted checks | H1–H11 all passed ([report](../reports/showcase-hosted-verification-2026-11-24.md)) |
| Snapshot SHA-256 | `8ccbbcd0406a11a0467bb2d915bb565c42b5147b9ace23692e154388b4fd7628` |

The site changes only when the workflow runs again. After that, update this table from the new run and record its
hosted checks.

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

A static picture of synthetic data at one instant: no live data, no editing, no sign-in, no AI output, no hosted
application behind it, and no claim about a phone or Safari.
