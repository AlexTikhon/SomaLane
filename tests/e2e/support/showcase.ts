import { resolve } from 'node:path';

// The public read-only showcase's browser check (release step 5, ADR-0099): `npm run test:e2e:showcase` builds the
// showcase's production output (support/showcase-build.ts) BEFORE Playwright starts, then `vite preview` serves those
// static files and nothing else: no API server exists in this configuration, and the preview has no proxy. Its own port,
// so it never meets the other configurations' servers.
export const showcaseBuild = {
  /**
   * The explicit local address compiled in as the invite-only application's link. Nothing listens there and no test
   * navigates to it; the tests only check that every view links to exactly this address.
   */
  appUrl: 'http://127.0.0.1:5999/',
  outDir: resolve(import.meta.dirname, '..', '..', '..', '.local', 'showcase', 'e2e', 'dist'),
  webOrigin: 'http://127.0.0.1:4381',
} as const;
