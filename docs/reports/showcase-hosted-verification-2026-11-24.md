# Verification report: GitHub Pages publication and hosted showcase checks (release step 8)

- Date: 2026-11-24
- Change: none to code. The reviewed keyboard correction (`a3783ae`, `3bbe2b2`) was pushed, GitHub Pages was enabled
  and the step-7 workflow was dispatched. [Release plan, step 8](../portfolio-v1-release-plan.md#step-8-github-pages-publication-and-hosted-showcase-smoke);
  [runbook, section 3](../runbooks/showcase.md#3-publishing-on-github-pages); [ADR-0101](../adr/0101-github-pages-showcase-publication.md).
- **Published commit: `3bbe2b2f44ba57aba52ecbc8f5087f43b6cf5095`** (`main`).
- **Published address, as reported by `actions/deploy-pages`: <https://alextikhon.github.io/SomaLane/>**. This is the
  expected address, so it is now confirmed.
- Kinds of evidence: **hosted CI**, **hosted publication** (both read with `gh run view`, `gh api` and the job logs),
  and **agent-run hosted checks** from the Windows 11 workstation against the live site. The workstation used Node
  24.11.1, npm 11.6.2, curl 8.17.0, and the browsers pinned by `@playwright/test` 1.63.0: Chromium 153.0.8010.12 and
  Firefox 155.0, headless, desktop viewport 1280 × 900. No physical device, no Safari and no phone were used.

## 1. The commit and its hosted CI run

The keyboard correction had already been committed locally as two commits and was pushed unchanged. Before the push,
`git show` confirmed that they contain only the five reviewed files:

- `tests/e2e/showcase/showcase.spec.ts`: the link-skipping path only for `browserName === 'webkit' && process.platform === 'win32'`;
- `docs/adr/0100-bounded-webkit-gate.md`;
- `docs/portfolio-v1-release-plan.md`;
- `docs/progress.md`;
- `docs/reports/webkit-gate-verification-2026-11-23.md`.

The historical counts quoted in those documents match the job logs of runs 45342998163 and 45354574755. Showcase 9
passed, 2 failed (of 11), and 11 passed, 2 failed (of 13). The second run's `e2e (firefox-core)` was cancelled.

| Item | Value |
|---|---|
| Push | `git push origin main`: `6ceb34e..3bbe2b2`. A normal push: no force, and no protection rule on `main` (none existed) |
| CI run | [45385170103](https://github.com/AlexTikhon/SomaLane/actions/runs/45385170103), `push`, `main`, head `3bbe2b2`, attempt **1** (no rerun), 11:32:51–11:46:03 UTC |
| Conclusion | **`success`** |
| Jobs | `verify` success; `integration` success; `e2e (chromium 1/3)` 70 passed, `2/3` 60 passed, `3/3` 62 passed (192); `e2e (firefox-core)` **18 passed**; `e2e (webkit gate)` **success**: development servers 32 passed, production build 4 passed, showcase 13 passed (`showcase-webkit` 9, `showcase-webkit-phone` 4); `e2e-report` skipped (it runs only after a Chromium failure) |

This is the first hosted run in which the WebKit gate passed. It closes the step-8 prerequisite recorded in the
[step-6 report, section 10](webkit-gate-verification-2026-11-23.md#10-hosted-ci-correction-linux-webkit-tab-order-2026-11-24).

## 2. Repository setup

These settings were read before anything changed: `gh api repos/AlexTikhon/SomaLane{,/pages,/environments,/branches/main/protection,/rulesets,/actions/permissions,/actions/permissions/workflow}`.

| Setting | Before | Action | After |
|---|---|---|---|
| Pages site | `404` (none) | `POST /repos/AlexTikhon/SomaLane/pages` with `build_type=workflow` (GitHub REST docs, "Create a GitHub Pages site") | `build_type: workflow`, `cname: null` (no custom domain), `https_enforced: true`, `public: true`, `html_url: https://alextikhon.github.io/SomaLane/` |
| Environment `github-pages` | none (0 environments) | created by GitHub when Pages was enabled | `deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}`, one branch policy `main` (type `branch`): **main only**. Already as required, so it was left unchanged. No secrets, variables, reviewers or wait timer. `can_admins_bypass: true` (GitHub's default, not changed) |
| Branch protection / rulesets on `main` | none / none | none | unchanged |
| Actions | enabled, all actions allowed; default workflow permissions `read` | none | unchanged |

No credential, token, secret, paid resource or custom domain was created.

## 3. The Pages workflow run

| Item | Value |
|---|---|
| Dispatch | `gh workflow run showcase-pages.yml --ref main`, after `gh api repos/AlexTikhon/SomaLane/commits/main` returned `3bbe2b2…` |
| Run | [45387434787](https://github.com/AlexTikhon/SomaLane/actions/runs/45387434787), `workflow_dispatch`, `main`, head **`3bbe2b2`**, the same commit as the CI run, attempt 1, 11:47:41–11:51:11 UTC |
| Conclusion | **`success`** |
| `validate and build the showcase` | [success](https://github.com/AlexTikhon/SomaLane/actions/runs/45387434787/job/138421948608). "Refuse any ref but main" skipped (ref was `main`); showcase unit tests 4 files, **55 passed**; browser checks under `/SomaLane/` **25 passed** (Chromium 9, Firefox 3, WebKit desktop 9, WebKit phone-sized 4); "The files to publish are the tested build" (`diff -r`) success; upload of artifact `github-pages` (ID 14916458047, 167,318 B) |
| `deploy to GitHub Pages` | [success](https://github.com/AlexTikhon/SomaLane/actions/runs/45387434787/job/138423582941). `configure-pages`, `deploy-pages` ("Created deployment for 3bbe2b2…", "Reported success!"), log line `Published at https://alextikhon.github.io/SomaLane/` |
| Deployment | ID 8026957134, environment `github-pages`, ref `main`, sha `3bbe2b2…`, status `success`, `environment_url: https://alextikhon.github.io/SomaLane/` |

## 4. Hosted checks H1–H11

All checks ran against the deployment-reported URL, 11:52–11:53 UTC, a minute after the deployment.

| # | Check | Result |
|---|---|---|
| H1 | Address | **PASS**: `deploy-pages` reported `https://alextikhon.github.io/SomaLane/`, equal to the expected address. The deployment status and the Pages API's `html_url` say the same |
| H2 | `curl -sI https://alextikhon.github.io/SomaLane/` | **PASS**: `HTTP/1.1 200 OK`, `Content-Type: text/html; charset=utf-8`, 612 B, `Server: GitHub.com` |
| H3 | `curl -sI https://alextikhon.github.io/SomaLane` (no slash) | **PASS**: `301 Moved Permanently`, `Location: https://alextikhon.github.io/SomaLane/`. Followed, it ends at 200 after 1 redirect. Also observed: `http://…/SomaLane/` → 301 to the `https://` address |
| H4 | Snapshot digest and type | **PASS**: hosted `showcase-snapshot.json` SHA-256 `8ccbbcd0406a11a0467bb2d915bb565c42b5147b9ace23692e154388b4fd7628`; `git show 3bbe2b2:apps/web/showcase/public/showcase-snapshot.json \| sha256sum` gives the same. `Content-Type: application/json; charset=utf-8`, 471,413 B |
| H5 | `curl -sI https://alextikhon.github.io/SomaLane/no-such-page` | **PASS**: `404 Not Found`, `text/html` (GitHub's page) |
| H6 | Open the address in desktop Chromium and Firefox | **PASS** in both: Today, "Showing Sat, 21 Nov 2026 (sample date) in the time zone Europe/Warsaw."; "Read-only showcase · synthetic data" visible, and still in the viewport after scrolling to the end (on Today and on Trends); one link, "Source code on GitHub", `href="https://github.com/AlexTikhon/SomaLane"`; clicking it navigated to that address, answered 200; the sentence "The full application, with sign-in, recording and editing, is not hosted: it runs locally from the source" shown |
| H7 | The journey | **PASS** in both: Date Sun 15 Nov 2026 → **Weekly review of …** (heading focused, week 2026-11-09) → **Open 28-day trends ending on Sun, 15 Nov 2026** (heading focused, "Range: 28 days, Mon, 19 Oct 2026 to Sun, 15 Nov 2026") → Food energy (29 Oct "Not recorded") → row **Open the logged meals of Sat, 14 Nov 2026** (2 entries) → **Back to Trends ending Sun, 15 Nov 2026, Food energy** (end date and series kept) → row **Open Today on Thu, 29 Oct 2026** ("No meal or snack logged for this day.") → **Back to Trends** (end date 15 Nov and Food energy kept). The label and source link were checked on every view |
| H8 | Reload on Trends; open `…/SomaLane/index.html` | **PASS** in both: the address stayed `/SomaLane/` on Trends; the reload and `index.html` each loaded Today on the sample date with the label and source link; no alert; no page error or console error; every response 200 |
| H9 | Network, from a fresh load through H7 | **PASS** in both: exactly 4 requests, all `GET`, all `200`, all at `https://alextikhon.github.io/SomaLane/`: the page (`text/html`), `assets/index-CSFkCBR5.js` (`application/javascript`), `assets/index-DeAHiD62.css` (`text/css`), `showcase-snapshot.json` (`application/json`). No `/api`, no other origin, no path outside `/SomaLane/`. The guard's blocked-request list was empty in all 8 browser tests |
| H10 | Browser storage | **PASS** in both, after H7, H8 and H11: `document.cookie` empty and 0 cookies in the browser context; `localStorage` and `sessionStorage` length 0; `indexedDB.databases()` empty; `caches.keys()` empty; 0 service-worker registrations; 0 calls recorded to `Storage.setItem/removeItem/clear`, `indexedDB.open`, `caches.open`, `serviceWorker.register` or the `document.cookie` setter |
| H11 | Snapshot request blocked, then reload | **PASS** in both: the snapshot request was blocked in the test browser only (Playwright `route.abort('blockedbyclient')`, the equivalent of developer-tools request blocking). The hosted file was untouched: H4's digest was taken from it. The alert said "The showcase data file could not be downloaded. Check the connection and try again."; the label, the source link and the local-application sentence stayed; the view navigation was absent. **Try again** made exactly one more request, `/SomaLane/showcase-snapshot.json`, and showed the same alert; no storage |

**Totals.** curl checks H1–H5: 5 of 5 pass. Browser checks: **8 passed, 0 failed, 0 flaky, 0 retries** (Chromium 4,
Firefox 4; 44.1 s; started 2026-11-24T11:52:55Z).

## 5. Published files

The live site serves exactly the files of the uploaded artifact. Artifact 14916458047 was downloaded with
`gh run download 45387434787 -n github-pages`, and each of its files was fetched from the live site. `diff -r` found
them **byte-identical**. They are also byte-identical to a local `showcase-build.ts` build of `3bbe2b2`:

| File | Bytes | SHA-256 | `Content-Type` served |
|---|---|---|---|
| `index.html` | 612 | `770c8b51…5067392` | `text/html; charset=utf-8` |
| `showcase-snapshot.json` | 471,413 | `8ccbbcd0…4fd7628` | `application/json; charset=utf-8` |
| `assets/index-CSFkCBR5.js` | 464,346 | `819a1063…6a54f2ebf` | `application/javascript; charset=utf-8` |
| `assets/index-DeAHiD62.css` | 44,593 | `d10b1ee9…93a6dc` | `text/css; charset=utf-8` |

The site sent no `Set-Cookie` header. GitHub Pages answers with `Cache-Control: max-age=600` and
`Access-Control-Allow-Origin: *`.

## 6. How the browser checks were run

An agent-run Playwright script, kept outside the repository's suites in the git-ignored
`tests/e2e/.local/hosted/` and not committed. It was run with
`HOSTED_URL=https://alextikhon.github.io/SomaLane/ npx playwright test --config=.local/hosted/playwright.hosted.config.ts`
in `tests/e2e`, with projects `hosted-chromium` and `hosted-firefox`, 1 worker, no retries. It reuses the step-7
browser check (`tests/e2e/showcase/showcase.spec.ts`) almost as is: the request guard, the storage instrumentation,
`expectSourceLink`, the journey's selectors and its expected texts. The only differences:

- the origin is the live site;
- the guard records each request with its method;
- storage also counts browser-context cookies and Cache Storage keys;
- the source link is followed to GitHub, after which the guard lets GitHub's own page through;
- H11 blocks the request instead of fulfilling it with an error.

Before the live run, the script was dry-run against `vite preview` of the same build: 8 passed. That run only shows
the script works and is not counted here.

## 7. Limits

- **Automation, not people's browsers.** H6–H11 used Playwright's headless Chromium 153 and Firefox 155 at a desktop
  viewport, not branded Chrome or Firefox with developer tools open. "Developer tools → Network / Application" in the
  runbook was done with Playwright's request events and in-page storage reads. Browser-initiated requests that page
  request events do not report (for example a favicon probe) are outside H9. The page declares an empty icon (`<link rel="icon" href="data:,">`), so it gives the browser no
  icon address to fetch.
- **No Safari, iPhone or phone claim.** WebKit ran only inside the two workflows (CI's WebKit gate and the Pages build's
  browser check, on Linux runners); it was not run against the hosted site. The physical Safari checklist stays NOT
  RUN, and the release stays desktop-scoped.
- **One point in time.** A later push to `main` does not change the site: only another dispatch of the workflow does.
  The checks describe `3bbe2b2` as deployed at 11:51 UTC on 2026-11-24.
- Not run for this step: the full application in any hosted form (deferred, release plan section 6.1). Neither was
  integration beyond CI, nor anything of step 9.

## 8. Outcome

Step 8's acceptance holds:

- two successful runs for the published commit, checked at their source: CI 45385170103, then Pages 45387434787;
- the reported URL is recorded and equals the expected one;
- H1–H11 are recorded, all pass;
- no Safari or phone claim.

**Step 8 is complete.** The documentation changes recording it (this report, the release plan, the README, the runbook
and progress) are left uncommitted for review.
