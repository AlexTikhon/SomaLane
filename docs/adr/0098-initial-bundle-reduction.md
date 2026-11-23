# ADR-0098: Measured initial-bundle reduction — the secondary views on demand

- Status: accepted; **implemented and verified** (2026-11-23). Candidate commit `dff831a`. The release step's full
  Chromium/OIDC gate, which no local full run passed without failures (see the
  [verification report](../reports/initial-bundle-verification-2026-11-22.md), including its independent review), was
  closed by hosted CI run [45055752618](https://github.com/AlexTikhon/SomaLane/actions/runs/45055752618): `success` for
  `1dac6ed` (the candidate plus documentation), with `verify`, `integration`, the three Chromium/OIDC shards and the
  Firefox core gate successful.
- Date: 2026-11-22
- Release step: 4 of the [portfolio v1 release plan](../portfolio-v1-release-plan.md#step-4-measured-initial-bundle-reduction).
- Relates to: [ADR-0097](0097-navigation-and-first-use-flow.md) (which views are primary; App owns run recovery, capture,
  uploads and the writer lease whatever view is shown), [ADR-0031](0031-archive-react-source-lifecycle.md) and
  [ADR-0065](0065-coach-live-map.md) (Mapbox GL JS loaded dynamically; the map lifecycle, unchanged).
- Scope: `apps/web` loading boundaries, a measurement script, tests and docs. No API, contract, schema, dependency,
  routing library, chunking plugin or Vite configuration change.

## Context

At `a3bf4e2` the production build had one JavaScript chunk and one stylesheet for the first page: **799,724 B raw /
220,581 B gzip** of JavaScript and **91,478 B / 13,681 B** of CSS. Every view was in that chunk, although a first visit
shows Today and the step-3 navigation makes Today, the Weekly review and Trends the primary journey. The Mapbox GL
runtime was already a separate chunk loaded by `mapbox-runtime.js`, but `main.tsx` imported its 48.8 KB stylesheet into
the first page's CSS.

## Decision 1: one reproducible measurement

`npm run measure:web-bundle` (`scripts/measure-web-bundle.mjs`, analysis in `scripts/web-bundle.mjs`) runs Vite's
production build of `apps/web` through its own `vite.config.ts` with a manifest, mode `production` and an **empty env
directory** (every `VITE_*` variable removed), so a developer's `.env` cannot change the output. It reports:

- **initial** JS and CSS, raw and gzip (zlib level 6): the HTML entry chunk, the transitive closure of its **static**
  imports (each fetched by the browser whether or not a `modulepreload` link exists) and their CSS, cross-checked
  against the built `index.html` (module script, `modulepreload` links, stylesheets; a disagreement fails the command);
- **deferred** chunks per dynamic entry, with the URL assets they import, never counted as initial.

`--ref <commit>` measures that commit's `apps/web` (extracted with `git archive`, built with this checkout's
dependencies) and refuses when `packages/`, `package-lock.json` or `tsconfig.base.json` differ from the working tree. An
uncommitted candidate is identified by git tree ids computed through a temporary index (the real index is untouched):
the same files committed later have the same `apps/web` tree id.

## Decision 2: the secondary views are one deferred chunk

Coach, Archive, Activity (with its GPX/TCX importers and history), Check-in (with movement and the optional AI insight
panel), Meal log (with the optional draft panel) and Runner's result (`RunDetailScreen`) are re-exported by
`secondary-views.ts` and imported only through `secondaryViews` in `DeferredView.tsx`, a dynamic import. App no longer
imports them. Kept in the first page: Today (with Ask my data, which Today renders at once), the Weekly review, Trends,
Runner with its share panel, the Run status, navigation, and everything App owns (session, IndexedDB restoration,
authority reads, capture, the upload worker, pending requests, the writer lease). A reload therefore never waits for the
deferred chunk to restore or resume a run.

**One chunk, not one per view.** These views share code the first page does not need: the run details (Archive,
Activity, Runner's result), the map helpers and `mapbox-runtime.js` (Coach, Archive, run details), and the check-in
controller (Check-in, Activity, Meal log). With one chunk per view the bundler puts that code in shared deferred chunks.
A probe in Playwright's Chromium and Firefox (reported in the verification report) showed that **Chromium keeps a failed
module fetch failed for the life of the document**: a second `import()` of the same URL rejects with no request, and so
does a new URL whose static imports include a module that failed (directly, as a dependency, or as a
`modulepreload`). Firefox fetches again in every case. With shared deferred chunks a retry in Chromium could therefore
never succeed without reloading the page. With one chunk whose static imports are all initial (already loaded), it can.
The cost: opening any secondary view downloads all six views at once (179,628 B raw / 46,896 B gzip).

## Decision 3: loading and failure stay in the view's area

`DeferredView` renders a view from the deferred module through a render function, without React.lazy, Suspense or an
error boundary, so nothing above the view's own area can suspend, fail or reset:

- **Loading**: a section with `aria-busy` and a polite status, "Opening the meal log…". Runner's result also offers
  **Back to Runner**.
- **Failure**: an alert ("… could not be opened: its code did not load. Navigation, and any run in progress, are not
  affected. Check the connection, then try again.") and **Try again**. Nothing navigates or reloads the page.
- **Ready**: the view, rendered with the props of the render in which its code is available. The views keep their scope
  keys, so a change of session, person or organization while the code loads opens the view for the new scope only.
  Editor and history intents, Back to Trends and the kept selections stay in App state and are applied when the view
  mounts.
- **Leaving while loading**: the view's `DeferredLoad` is disposed and reports nothing more; the import continues and
  its result is kept, so the next opening is immediate. Nothing navigates when it arrives.

`deferred-module.ts` loads the module one attempt at a time and keeps the value. **Try again** imports again, which is
a real retry where the browser fetches a failed module again (Firefox); when that rejects too and the error names a
same-origin module URL (Chromium's and Firefox's messages do), it imports that URL with a `retry=<attempt>` query, a new
fetch. A loaded value is accepted only when it has the six expected view exports, so a URL naming another module (for
example a failed dependency) is never used.

## Decision 4: the Mapbox stylesheet loads with the runtime

`main.tsx` no longer imports `mapbox-gl.css`. `mapbox-runtime.js` imports its URL (`?url`, an emitted file, not CSS in a
chunk) and `loadMapbox()` resolves only when both the runtime and a single `<link rel="stylesheet">` have loaded, so a
map is never constructed without its styles. A link that fails is removed and forgotten, so the next map creation
fetches it again; Vite's own CSS preloading would not, because its helper never retries a dependency it has seen. The
map lifecycle (`createMapboxMap`, its abort checks and the map hosts) is unchanged.

The stylesheet now arrives after `styles.css`, so equal-specificity rules of Mapbox win. The only conflict was
`.archive-map__canvas { position: absolute }` against Mapbox's `.mapboxgl-map { position: relative }` on the same
element; it became `.archive-map > .archive-map__canvas`, as the coach map's rule already was. The run-details map
sets no property with a different value from Mapbox's.

## Decision 5: what proves it

- A unit test walks the first page's static import graph from `main.tsx` and fails when it reaches a secondary view,
  `secondary-views.ts` or the map code (a mutation adding one static import made it fail).
- `npm run test:e2e:production-build` builds with the measurement script's settings **before** any server starts, serves
  that build with `vite preview` and asserts the requests a browser actually makes: a cold Today load and the primary
  journey fetch exactly the initial files; the first secondary view fetches the one chunk; loading, failure and Try again
  (Chromium and Firefox); leaving during the import; a change of organization during the import; recording, upload and
  a reload on Today with the chunk unavailable. A mutation making Try again only call `import()` again failed the
  Chromium test (no new request) and passed in Firefox.

## Rejected

- **React.lazy per view.** A lazy component caches its rejected promise; resetting an error boundary around it retries
  nothing, and in Chromium even a new `import()` of a failed chunk sends no request.
- **Prefetching the deferred chunk at idle.** The browser would request it right after the first page, so it would not
  be an initial saving.
- **A "Reload page" recovery.** It works for a deploy that replaced the chunk names, but it drops the kept selections and
  intents (App memory by design) and would be the only way out in Chromium. Not offered; see the limits.
- **`manualChunks`/`codeSplitting` groups or a plugin**: one dynamic entry gives the needed graph without configuration.
- **Splitting `styles.css` per view**: a CSS dependency of the chunk would go through Vite's preload helper, which never
  retries a failed stylesheet; the 43 KB global stylesheet stays whole.
- **Deferring Ask my data, the Weekly review or Trends**: Ask my data renders on Today (an immediate request, no saving);
  the other two are the primary journey.

## Consequences and limits

- Measured on the same settings: initial JavaScript **625,755 B raw / 175,156 B gzip** (−173,969 B / −45,425 B), initial
  CSS **43,020 B / 8,276 B** (−48,458 B / −5,405 B). No target was set.
- The first opening of any secondary view waits for the 46.9 KB (gzip) chunk; later openings do not.
- Vite still warns that the initial chunk exceeds 500 kB (611 KiB). The warning is not suppressed or raised.
- Safari's import error names no URL, so there Try again relies on the browser fetching the module again; not verified
  (no WebKit run in this step). A deploy that replaces the chunk names makes Try again fail until a reload, which the
  person can do; App restores a run after a reload (ADR-0097).
- The production check's build has no Mapbox token (it reads no `.env`), so no map is created there; the Mapbox
  stylesheet path is covered by unit tests and the development-server map specs (fake and real runtime).
- The production check is local and is not part of `npm run test:e2e` or CI.
