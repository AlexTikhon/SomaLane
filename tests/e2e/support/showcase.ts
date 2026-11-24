import { resolve } from 'node:path';

// The public read-only showcase's browser check (release steps 5 and 7, ADR-0099, ADR-0101): `npm run test:e2e:showcase`
// builds the showcase's production output (support/showcase-build.ts) BEFORE Playwright starts, then `vite preview`
// serves those static files and nothing else, under the same path GitHub Pages gives the project site
// (https://alextikhon.github.io/SomaLane/): no API server exists in this configuration, and the preview has no proxy.
// Its own port, so it never meets the other configurations' servers.
const webOrigin = 'http://127.0.0.1:4381';
const basePath = '/SomaLane/';

export const showcaseBuild = {
  /** The project site's path on GitHub Pages; every file the page loads must be under it. */
  basePath,
  outDir: resolve(import.meta.dirname, '..', '..', '..', '.local', 'showcase', 'e2e', 'dist'),
  /** The page itself, as a visitor opens it. */
  pageUrl: `${webOrigin}${basePath}`,
  /** The fixed link every state shows; no test follows it (the request guard would abort it). */
  sourceUrl: 'https://github.com/AlexTikhon/SomaLane',
  webOrigin,
} as const;
