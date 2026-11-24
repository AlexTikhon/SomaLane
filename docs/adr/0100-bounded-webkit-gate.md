# ADR-0100: Bounded WebKit gate at desktop and phone-sized settings

- Status: accepted; implemented (see the [verification report](../reports/webkit-gate-verification-2026-11-23.md)).
  Local evidence only: no hosted CI run of this change yet. No physical iPhone or Safari observation exists.
- Date: 2026-11-23
- Release step: 6 of the [portfolio v1 release plan](../portfolio-v1-release-plan.md#step-6-bounded-webkitmobile-coverage-and-physical-safari-observations).
- Relates to: the Firefox core gate ([reference](../reference.md#browser-end-to-end-tests)), [ADR-0097](0097-navigation-and-first-use-flow.md)
  (the primary journey), [ADR-0098](0098-initial-bundle-reduction.md) (deferred views and `deferred-module.ts`),
  [ADR-0099](0099-public-read-only-showcase.md) (the showcase), [ADR-0054](0054-session-revalidation-unknown-is-not-invalid.md)
  (session revalidation), [ADR-0085](0085-iphone-lan-pilot.md) (the iPhone LAN pilot, whose physical checks stay NOT RUN).
- Scope: Playwright projects and npm commands in `tests/e2e`, one shared settings module, a CI job and its structural
  test, test-only adjustments for observed WebKit behaviour, one unit test. No application source, API, schema,
  configuration guard or dependency change. The WebKit browser build is the one `@playwright/test` 1.63.0 pins.

## Context

Step 6 asks for a bounded WebKit gate "in the spirit of the 18-test Firefox core gate", at a desktop and a phone-sized
viewport, run and recorded, with Playwright WebKit recorded as WebKit automation and not as Safari. Until now nothing ran
in WebKit: the full suite (192 tests) is Chromium and OpenID Connect, Firefox runs 18 core tests, and the production-build
and showcase checks run in Chromium and Firefox.

Running all 192 tests again in another engine, twice (two settings), would triple the slowest gate for little extra
signal: most specs exercise server behaviour already proven in Chromium. What differs between engines is the browser
side: IndexedDB, timers and focus events behind recording and recovery, `BroadcastChannel`/storage events behind tab
ownership, offline emulation, the module loader behind the deferred views, keyboard focus, date formatting and layout.

`deferred-module.ts` (ADR-0098) is the one place where application code depends on engine-specific error text: on a
failed retry it reads a module URL from the error message and imports it again with a `retry` query, because Chromium
keeps a failed module failed for the page. Its comment already said Safari's message names no URL; nobody had observed
what WebKit then does.

## Decision

1. **One gate, three parts, one command.** `npm run test:e2e:webkit` builds the contracts and fixtures and runs, one
   after the other (`npm run e2e:webkit` in `tests/e2e`):
   - `e2e:webkit:dev-server`: projects `webkit-desktop` and `webkit-phone` of `playwright.config.ts`, against the same
     development servers, test database guard, fixtures and settings as the Chromium and Firefox projects;
   - `e2e:webkit:production-build`: project `production-webkit` of `playwright.production-build.config.ts`, after the
     same measured production build (`scripts/measure-web-bundle.mjs --out`) the existing check makes;
   - `e2e:webkit:showcase`: projects `showcase-webkit` and `showcase-webkit-phone` of `playwright.showcase.config.ts`,
     after the same showcase build (`support/showcase-build.ts`), with no API server.

   Every build finishes before its servers start; no part builds while another part's servers run.

2. **Settings** (`tests/e2e/support/webkit-gate.ts`, shared by the three configurations).

   | Setting | Viewport (CSS px) | Device scale | `isMobile` | `hasTouch` | User agent |
   |---|---|---|---|---|---|
   | Desktop | 1280 × 720 | 1 | no | no | Playwright WebKit's default |
   | Phone-sized | 390 × 844 | 3 | yes | yes | Playwright WebKit's default; **no iPhone user agent is set** |

   Playwright WebKit's default user agent reads as desktop Safari on macOS
   (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15`)
   even when it runs on Windows or Linux; that string is not evidence of Safari. Observed inside the page at the
   phone-sized setting: 390 × 844, `devicePixelRatio` 3, `(pointer: coarse)` matches, `navigator.maxTouchPoints` 0.
   Locale and time zone come from each spec or configuration as for the other engines (`en-GB`, Europe/Warsaw for the
   application specs; Pacific/Auckland for the showcase). Tests that set their own viewport (the 375 px checks) keep it.
   The phone-sized setting emulates a viewport, meta-viewport handling and touch support; it is not iOS, Safari, a phone
   keyboard, a phone network, sleep, background behaviour or GPS.

3. **The scenario list** (47 tests).

   | Project | Spec (tests) | Covers |
   |---|---|---|
   | `webkit-desktop` (28) | `record` (1), `reload-offline` (3), `second-tab` (2), `gps-recovery` (3), `run-sharing` (2), `archive-sharing` (4), `coach-map` (3, fake runtime) | the 18 Firefox core tests unchanged: recording, upload, pause/finish, reload recovery, offline buffering and exactly-once delivery, upload failure, competing-tab ownership, foreground GPS recovery with an injected geolocation, live sharing, archive sharing, the Coach map lifecycle with a fake Mapbox runtime |
   | | `session-revalidation` (6) | session loss and revalidation: 503, network failure and 429 on focus keep the session and the recording; coming back online re-checks once; a reload while the session cannot be checked; a real 401 signs out and keeps unsent points |
   | | `primary-journey` (4) | records → Today → Weekly review → Trends → records with the date policy; scope and late answers; capture and upload continuing for the same run while Today and the Weekly review are shown, reload away from Runner restoring it, pause and finish; 375 px and keyboard |
   | `webkit-phone` (4) | `primary-journey` (4) | the same four at the phone-sized setting |
   | `production-webkit` (4) | `production-build/deferred-views` (4) | initial files only on a cold load, the secondary views as one chunk; loading, network failure, Try again while still failing, recovery when the network returns, on the date Today chose; leaving a view while its code loads and an organization change during the load; recording, upload and reload while the chunk cannot load |
   | `showcase-webkit` (8) | `showcase/showcase` (8) | the journey and its kept selections, missing/zero/partial states, labels and no mutation control on every view, keyboard and 375 px, three broken snapshot files, the request guard, the built files |
   | `showcase-webkit-phone` (3) | the three tagged `@phone` | the journey, the read-only boundary with its missing and zero states, keyboard and 375 px |

   Selection reuses the existing mechanisms: a spec allowlist for the development-server projects (like
   `firefox-core`), the existing `@real-map-runtime` exclusion, and a `@phone` tag (Playwright's `tag` option, so no test
   title changes) for the showcase's phone project.

4. **Excluded on purpose.**
   - `coach-map smoke: the installed Mapbox runtime starts with a local empty style…` (`@real-map-runtime`): the real
     Mapbox GL runtime with WebGL. Excluded as in Firefox. The three `coach-map` tests that run use a fake runtime served
     in place of `mapbox-gl`; **they are not evidence that a real basemap, WebGL or Mapbox renders in WebKit or Safari**.
     No test anywhere renders a real Mapbox basemap.
   - The OpenID Connect project (`oidc/`): sign-in against the provider process stays Chromium-only. Every WebKit
     scenario signs in with the development session (or needs none, for the showcase).
   - The rest of the Chromium suite (imports, Trends details, Ask my data, meal drafts, run search, insights, run
     details, deletion, organizations, demo flows): server-side behaviour already covered in Chromium; not repeated.
   - The LAN pilot (`lan-pilot/`) and the dataset walkthrough (`portfolio-dataset/`) keep their own Chromium configs.

5. **Opt-in, and existing commands unchanged.** The WebKit projects run only when selected by name. `npm run test:e2e`
   and `npm run test:e2e:firefox` already select their projects; `e2e:production-build` and `e2e:showcase` now name
   theirs (`production-chromium`/`production-firefox`, `showcase-chromium`/`showcase-firefox`), so their selection is
   exactly what it was and they never launch WebKit. Every existing project's `--list` output is unchanged (verified).
   WebKit failure output goes to `tests/e2e/webkit-results/<project>/`, never to `test-results/`.

6. **Observed WebKit behaviour, handled narrowly in tests.**
   - **Keyboard: Tab skips links in Playwright WebKit on Windows.** In Playwright WebKit 26.6 on Windows neither Tab
     nor Alt+Tab focuses a link (desktop and phone settings alike); buttons and inputs are tabbable. This is not an
     application defect. The showcase's keyboard test asserts, in Windows WebKit only, that the first Tab lands on the
     first view (the link is skipped), then focuses the link directly and checks the same Tab order from it. Chromium
     and Firefox assertions are unchanged.
     *Corrected 2026-11-24:* this decision first applied the Windows observation to every WebKit platform and likened
     it to Safari's default setting. Hosted CI (runs 45342998163 and 45354574755) showed that Playwright WebKit 26.6 on
     Linux focuses the link with Tab, as Chromium and Firefox do, so the test failed there. The test now takes the
     link-skipping path only for WebKit on Windows (`process.platform === 'win32'`); every other assertion is the same
     on all platforms. Safari and macOS WebKit were not observed. Evidence:
     [report, section 10](../reports/webkit-gate-verification-2026-11-23.md#10-hosted-ci-correction-linux-webkit-tab-order-2026-11-24).
   - **Deferred module retry.** WebKit rejects a failed dynamic import with `TypeError: Importing a module script
     failed.` (for a network failure and for an HTTP 503 alike), which names no URL, so `failedModuleUrl` returns null
     and the `?retry=` fallback is never taken. WebKit does fetch the same URL again on a repeated `import()`, so the
     importer's own second call recovers. The production-build retry test now asserts this for WebKit (every chunk
     request is the plain file, at least three: the first failure, the failed Try again, the recovery), and a unit test
     pins the same path with WebKit's exact message. `deferred-module.ts` is unchanged.

7. **CI.** A new job `e2e (webkit gate)` (`e2e-webkit`): after `verify`, its own PostGIS service with the pinned image,
   the compose init script, bootstrap and migrations, the WebKit build cached under `playwright-<os>-<version>-webkit`
   (installed with `--with-deps`, or `install-deps` on a cache hit, as the Chromium job does), then the three parts as
   three steps (the later two also run after the first fails), and on failure an artifact `playwright-webkit-gate` with
   `webkit-results/` and the blob reports. `scripts/ci-workflow.test.mjs` pins the job and that no existing job or
   command selects WebKit. No existing job changed.

## Consequences

- WebKit runs the browser-side paths that most often differ between engines, at two settings, in about the time of the
  Firefox gate plus the two build checks, instead of 192 × 2 more tests.
- The deferred views' recovery in WebKit is a measured fact, not an assumption from Chromium or Firefox; the URL fallback
  remains a Chromium-only path.
- A pass is a statement about Playwright's WebKit build on Windows (and, once it runs, on Ubuntu in CI). It says nothing
  about Safari on iOS: its WebKit version, process model, keyboard, permission prompts, background throttling, storage
  eviction, GPS and the LAN pilot's certificate trust. The physical checklist in
  [iphone-lan-pilot.md](../reports/iphone-lan-pilot.md) stays NOT RUN, and the release stays desktop-scoped.
- Keyboard reachability of links under Safari's default setting is not shown by any test (WebKit's model skips them);
  the showcase's application link is reachable by pointer and by direct focus.

## Alternatives not taken

- **The full suite in WebKit.** Rejected: 192 tests × 2 settings, mostly repeating server behaviour.
- **A separate WebKit configuration file with its own servers.** Rejected: it would clone the web-server list, test
  database guard and settings; projects in the existing configurations reuse them.
- **An iPhone device descriptor (`devices['iPhone 13']`).** Rejected: it sets an iPhone Safari user agent, which would
  make automation look like an iPhone. The phone-sized setting keeps Playwright WebKit's default user agent.
- **Changing `deferred-module.ts` for WebKit.** Not needed: the observed behaviour already recovers.
- **Retries or skips for WebKit.** Not used: retries stay 0 and nothing is skipped for WebKit.

## Verification

See the [verification report](../reports/webkit-gate-verification-2026-11-23.md).
