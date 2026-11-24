# SomaLane portfolio v1: closeout, freeze and restart

- Audience: whoever returns to this repository after portfolio v1, including the owner and any coding agent.
- Scope: release step 10 of the [release plan](portfolio-v1-release-plan.md#step-10-final-verification-release-tag-and-project-freeze),
  the freeze policy, and how to restart. The release plan stays the authority for scope, gates and evidence per claim.
- Written: 2026-11-24, with the final documentation of portfolio v1, **before** that documentation's own release
  checks ran.

This document is version-based on purpose. It defines what completes the release and where the results are recorded.
It does not contain the released commit, the run URLs or the hosted results, because a commit cannot name its own SHA
or the checks that run after it. Those are recorded in the annotated tag and the GitHub release (section 2).

## 1. When portfolio v1 is complete

Portfolio v1 is **released, and the freeze takes effect, when both of these are published**:

- the annotated tag **`portfolio-v1`** in `AlexTikhon/SomaLane`;
- the GitHub release **"SomaLane — Portfolio v1"** for that tag.

They are published only for a commit (the *release candidate*) that has passed every step-10 gate below. If neither
exists, portfolio v1 is **not released**, the freeze has not started, and step 10 is still open. In that case, resume
it from section 3. Nothing in the repository claims that a step-10 check succeeded.

Check the state:

```sh
git fetch origin --tags
git cat-file -t portfolio-v1                      # "tag": an annotated tag
git rev-parse portfolio-v1^{commit}               # the released commit
gh release view portfolio-v1 --repo AlexTikhon/SomaLane
```

## 2. Where the final results are

The tag annotation and the release notes, not this repository's files, hold:

- the full SHA of the released commit;
- the hosted CI run (`ci.yml`) for exactly that SHA, with its jobs;
- the Pages run (`showcase-pages.yml`) for the same SHA, its deployment and the URL it reported;
- the results of the hosted checks H1–H11 and of the Trends row-action check (section 3, gate 4);
- the licence, the desktop scope and the deferred capabilities.

The release also carries the final verification report and synthetic evidence as attached files. Earlier evidence
stays in the [reports](reports/) and [progress.md](progress.md) as recorded.

## 3. The step-10 gates (the release procedure)

Each gate applies to one release candidate. Any later commit on `main` creates a new candidate, and every gate must be
passed again for it. An older green run never counts for a newer commit.

1. **Candidate.** The reviewed work and the final documentation reach `main` by a normal push or merge: a fast-forward
   where possible, a pull request if protections require one. No force-push, no bypassed protection. The resulting
   remote `main` SHA is the candidate.
2. **Hosted CI.** A `ci.yml` run for exactly that SHA concludes `success`, with `verify`, `integration`,
   `e2e (chromium 1/3)`, `e2e (chromium 2/3)`, `e2e (chromium 3/3)`, `e2e (firefox-core)` and `e2e (webkit gate)`
   successful. A failure is inspected first:
   - a confirmed infrastructure-only failure may be rerun, without weakening any check;
   - a functional failure stops the release, and it is reported, not repaired inside step 10.
3. **Publication.** Only after that success, `showcase-pages.yml` is dispatched on `main`. Its `build` and `deploy`
   jobs succeed with the same head SHA as the CI run. The URL that `actions/deploy-pages` reports is recorded.
4. **Hosted checks**, against that URL, in desktop Chromium and Firefox:
   - H1–H11 of the [showcase runbook](runbooks/showcase.md#34-hosted-checks);
   - the Trends row-action check R1–R4 of the same section (the step-9 repair at 1280 and 375 px);
   - the live files compared byte for byte with the run's `github-pages` artifact;
   - the synthetic, read-only labels, no API request and no storage write.
5. **Tag and release, last.** First, confirm that `portfolio-v1` exists neither locally nor on the remote; an existing
   tag is never replaced. Then:
   - create the annotated tag at the candidate (the commit that passed gates 2–4);
   - push it;
   - publish the GitHub release with the evidence of section 2.

   If documentation or code changes after verification, that change is a new candidate. It goes through gates 1–4
   before it is tagged. The tag is never moved afterwards.
6. **Final state.** Remote `main`, the tag's target, the CI run's SHA and the deployed SHA agree.

## 4. The freeze

Portfolio v1 ends feature development on this project.

- **Reopening scope.** Any future feature, integration or roadmap item needs an **explicitly reopened scope**: an
  owner's decision that names the work, written down in a new plan or a progress entry before the work starts. The
  following are all outside the frozen scope:
  - new features;
  - identity-provider setup;
  - hosting the full application;
  - dependency upgrades;
  - licence changes;
  - the items deferred in [release plan section 6](portfolio-v1-release-plan.md#6-deferred-work).
- **Maintenance.** Fixing a recorded defect is a separate maintenance change, not a reopening of scope:
  - the defect is first recorded (report or progress entry) with how it was observed;
  - the fix is one bounded change with its own verification and its own hosted CI run;
  - if it changes the showcase, the publication is a new run of the Pages workflow followed by its own hosted checks.

  A maintenance change does not move `portfolio-v1`. If it is released, it gets a new, separately named tag.
- **Evidence boundaries stay as they are.** Hosted automation (Playwright Chromium, Firefox and WebKit, in CI or
  against the live site) is not physical-device evidence. No Safari, iPhone, phone, real-GPS or background-recording
  claim follows from it. The physical Safari checklist
  ([iphone-lan-pilot.md](reports/iphone-lan-pilot.md)) remains **NOT RUN**, and D10 remains PARTIAL.

## 5. What portfolio v1 contains

- **Published.** The public read-only showcase of synthetic data on GitHub Pages:
  <https://alextikhon.github.io/SomaLane/>. It is static, labelled on every view, sends no API request, writes no
  storage, and links to the source.
- **Local only.** The full application (sign-in, recording, editing, coach sharing, archive) runs from the source with
  synthetic data: `npm run demo:up`, the [portfolio dataset](runbooks/portfolio-dataset.md) or the iPhone LAN pilot
  tooling.
- **Licence.** [MIT](../LICENSE), "Copyright (c) 2026 Alex Tikhon".
- **Scope.** Desktop only. Evidence comes from desktop Chromium and Firefox, plus Playwright WebKit as automation.
- **Deferred, not done** ([release plan, 6 and 6.1](portfolio-v1-release-plan.md#6-deferred-work)):
  - real OpenID Connect provider verification;
  - hosting the full application, with a hosted smoke;
  - an isolated restore of a host's backup;
  - physical Safari and phone evidence, and real-device GPS traces (D10);
  - a real Mapbox basemap;
  - any AI quality claim, since every AI feature stays off by default;
  - multi-replica operation, FIT, HealthKit, RAG and a chat coach.

## 6. Restarting

### 6.1 Look at the frozen state

```sh
git fetch origin --tags
git status --short --branch
git log --oneline -5 origin/main
git log --oneline -1 portfolio-v1                 # absent: v1 is not released, see section 1
gh run list --workflow ci.yml --branch main --limit 3
gh run list --workflow showcase-pages.yml --limit 3
```

If `origin/main` is ahead of `portfolio-v1`, read those commits before assuming anything: each one is either
maintenance or reopened scope, and needs its own evidence.

### 6.2 Run it locally

Use Node 24 (`>=24.11.0 <25`), npm 11 and Docker with Compose v2:

```sh
npm ci
npm run demo:doctor
npm run demo:up                  # http://127.0.0.1:5173, Demo runner / Demo coach
npm run build:showcase && npm run preview:showcase
```

Synthetic data only. The populated screens need `npm run portfolio:dataset`, which uses its own database and never the
development one. When a branch adds or changes a migration, `npm run demo:up` (or `db:migrate`) applies it.

### 6.3 Verify before and after any change

| Change | Checks |
|---|---|
| Documentation only | relative links and anchors, `git diff --check` |
| Showcase, web styles or components | `npm run verify`; `npm run test:e2e:showcase`; `npm run test:e2e:webkit` where WebKit is affected; the affected application specs |
| API, SQL, authorization or persistence | also `npm run test:integration`, run alone against the validated test database |
| Anything pushed to `main` | its own hosted CI run; if the showcase changes, a Pages run and the runbook's hosted checks |

Integration and browser suites share the test database `running_tracker_test`, so run them one after another. They
refuse non-test targets. Never point them at development or dataset data. On Windows, run the commands from a
working directory whose drive letter is upper-case (`C:\…`).

### 6.4 Reopen scope or fix a defect

- **Reopen scope.** Record the owner's decision and the named scope, write a plan for it, and branch from `main`. Do
  not edit this closeout or the release plan to describe new work; they describe portfolio v1.
- **Fix a recorded defect.** Branch, fix, verify (6.3), push, and wait for hosted CI. Republish and recheck the showcase
  if it changed. Leave `portfolio-v1` where it is.

## 7. Related documents

- [Release plan](portfolio-v1-release-plan.md): scope, the ten steps, gates, evidence per claim, deferrals.
- [Showcase runbook](runbooks/showcase.md): publication and hosted checks.
- [Progress](progress.md): every verification, entry by entry.
- [Pause handoff](pause-handoff.md) and [implementation plan](implementation-plan.md): historical context; their current
  sections point here.
- [README](../README.md), [CHANGELOG](../CHANGELOG.md), [interview package](interview.md).
