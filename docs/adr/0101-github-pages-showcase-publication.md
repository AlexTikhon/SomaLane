# ADR-0101: Publish only the static showcase, on GitHub Pages

- Status: accepted; prepared (see the [verification report](../reports/showcase-pages-preparation-2026-11-24.md)). Local
  evidence only: the workflow has never run on GitHub, Pages is not enabled for the repository, and nothing is
  published. Release step 8 runs it.
- Date: 2026-11-24
- Release step: 7 of the [portfolio v1 release plan](../portfolio-v1-release-plan.md#step-7-static-publication-preparation).
- Amends: [ADR-0099](0099-public-read-only-showcase.md), decision 7 (the link to the invite-only application and its
  `SHOWCASE_APP_URL` setting). Everything else in ADR-0099 stands.
- Relates to: [ADR-0100](0100-bounded-webkit-gate.md) (the showcase's WebKit projects), [ADR-0043](0043-single-host-deployment-profile.md)
  and [ADR-0046](0046-oidc-sign-in.md) (the full application's production profile and sign-in, unchanged and not hosted).
- Scope: the showcase's link and its tests, the showcase browser check's base path, a new manual workflow
  (`.github/workflows/showcase-pages.yml`) with a structural test, and documentation. No change to the full
  application, the API, authentication, the production configuration guard, the CI workflow or any dependency.

## Context

The release plan published two surfaces: the static showcase and the full application on one host behind invite-only
OpenID Connect. The owner changed that scope on 2026-11-24: publish **only** the public read-only synthetic showcase,
keep the full application for local demonstrations, and defer real-provider verification, full-application hosting and
hosted backup/restore verification, while keeping the full application's authentication and production safeguards as
they are.

That leaves the showcase with nothing to link to. Its build read `SHOWCASE_APP_URL`; with no hosted application, every
public build would show "The address of the invite-only application is not configured in this build.", an unfinished
page for a visitor. The showcase also needs a host. Its output is four static files with relative references, and the
repository is public on GitHub.

## Decision

1. **A fixed source link instead of a configurable application link.** Every state of the page (loading, the data-file
   error and every view) shows, under the persistent "Read-only showcase · synthetic data" label, a link
   "Source code on GitHub" to `https://github.com/AlexTikhon/SomaLane` and one sentence saying that the full application,
   with sign-in, recording and editing, is not hosted and runs locally from the source, as the README describes. The
   address is a constant in `ShowcaseViews.tsx` (`SOURCE_REPOSITORY_URL`).
2. **`SHOWCASE_APP_URL` is removed**, with its validation module (`showcase-config.ts`), its tests and the compiled
   constant. The showcase build has one setting left, `SHOWCASE_OUT_DIR`, used by the browser check. A variable with the
   old name is ignored. If a hosted application exists one day, its link is a new decision, not a dormant setting.
3. **GitHub Pages, project site.** The expected address is `https://alextikhon.github.io/SomaLane/` (GitHub shows the
   account name in lower case; the path is case-sensitive). It stays "expected" until a deployment reports it. The build
   keeps `base: './'`, so the same files work under `/SomaLane/` or any other path, and no Pages-specific build exists.
4. **A separate, manual workflow.** `.github/workflows/showcase-pages.yml`, following GitHub's custom-workflow
   documentation (`actions/configure-pages@v6`, `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`, the
   versions current on 2026-11-24, checked against their release tags) and the repository's Node/npm conventions
   (`actions/checkout@v5`, `actions/setup-node@v5` with `.nvmrc` and the npm cache, `npm ci`):
   - `workflow_dispatch` only; a run for any ref other than `refs/heads/main` fails its first step, and the deploy job
     also requires `main`. The `github-pages` environment's branch rule is the third fence (runbook).
   - Top-level `permissions: {}`. The **build** job has `contents: read` only: showcase unit tests, Chromium, Firefox
     and WebKit browsers, one test build, the showcase browser check (all four projects), `npm run build:showcase`,
     `diff -r` of that output against the tested build, and `upload-pages-artifact` of `apps/web/dist-showcase` only.
   - The **deploy** job `needs: build`, is the only job with `pages: write` and `id-token: write`, runs in the
     `github-pages` environment whose URL is `steps.deployment.outputs.page_url`, checks out nothing and builds nothing,
     and writes the address `deploy-pages` reported (and `configure-pages`' base URL) to the run summary.
   - `concurrency: pages`, `cancel-in-progress: false`, as in GitHub's starter workflow.
   - No secret, Docker, database, dataset regeneration or API server: the input is the committed snapshot.
5. **The browser check serves the build the way Pages does.** `vite preview --base /SomaLane/` serves the output under
   `/SomaLane/`; tests open `./`. The request guard now also fails any request outside `/SomaLane/`. A new test reloads
   the page directly and opens `./index.html`, and checks that every file came from under `/SomaLane/` with status 200.
   The file-listing test asserts that the output is exactly `index.html`, `showcase-snapshot.json`, one script and one
   stylesheet, with relative references only, the source address in the script and no "not configured" or
   "invite-only" text.
6. **The existing CI workflow is untouched** and keeps `contents: read`; a structural test
   (`scripts/showcase-pages-workflow.test.mjs`) pins both workflows' boundaries.

## Consequences

- A visitor gets a finished page with a working way on (the source), and nobody has to configure anything to build it.
- The full application's link is gone from the showcase. The full application itself, its OIDC sign-in, the refusal of
  `LOCAL_AUTH_ENABLED=true` with `APP_ENV=production` and the deployment profile are unchanged and simply not hosted.
- Publishing is one manual dispatch on `main` after the owner enables Pages with "GitHub Actions" as its source. Nothing
  publishes on push, so a broken commit cannot reach the public page without a person starting a run, and that run
  validates first.
- `vite preview` is not GitHub Pages: it answers `/SomaLane` (no slash) with 404 where Pages redirects, and serves the
  page for an unknown path where Pages answers 404. The hosted checks of step 8 cover the real behaviour.
- Historical documents (ADR-0099's decision 7, the step-5 and step-6 reports and progress entries) still describe the
  application link; they are not rewritten. This ADR and the current runbook supersede them on this point.

## Not decided here

A custom domain, a hosted full application, a real identity provider, hosted backups, analytics (none) and a licence
(release step 9).
