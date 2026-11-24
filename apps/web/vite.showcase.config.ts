import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The public read-only showcase's own build target (ADR-0099, docs/runbooks/showcase.md), separate from the application:
//
//   npm run build:showcase      → apps/web/dist-showcase/ (static files only: index.html, assets, showcase-snapshot.json)
//   npm run preview:showcase    → serves that output on http://127.0.0.1:4380 with no API proxy
//
// Its entry is showcase/index.html → src/showcase/main.tsx; the snapshot is showcase/public/showcase-snapshot.json, the
// file `npm run portfolio:showcase:export` writes, copied next to the page. `base: './'` lets the output be hosted under
// any path: GitHub Pages serves it under /SomaLane/ (ADR-0101, .github/workflows/showcase-pages.yml). The page's only way
// on is a fixed link to the public source repository; nothing about it is configured. SHOWCASE_OUT_DIR (the browser
// test's output directory) is the only setting. No .env file is read (envDir is the showcase folder, which has none) and
// no VITE_* variable reaches the page, so the application's demo flag or Mapbox token can never change it. There is no
// server.proxy or preview.proxy: an /api request from this page could reach nothing.

const showcaseRoot = resolve(import.meta.dirname, 'showcase');

export default defineConfig({
  base: './',
  build: {
    emptyOutDir: true,
    outDir: process.env.SHOWCASE_OUT_DIR === undefined || process.env.SHOWCASE_OUT_DIR === '' ? resolve(import.meta.dirname, 'dist-showcase') : resolve(process.env.SHOWCASE_OUT_DIR),
  },
  envDir: showcaseRoot,
  envPrefix: 'SHOWCASE_PAGE_NONE_',
  plugins: [react()],
  preview: { host: '127.0.0.1', port: 4380, strictPort: true },
  publicDir: resolve(showcaseRoot, 'public'),
  root: showcaseRoot,
  server: { host: '127.0.0.1', port: 4380, strictPort: true },
});
