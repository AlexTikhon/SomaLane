import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The production build the bounded browser check serves (release step 4, ADR-0098): built by
// `scripts/measure-web-bundle.mjs --out` before any server starts (the npm script does both), with the same settings
// as every measurement, then served by `vite preview` with the API proxied. Its own ports, so it never meets the
// development servers of the other configs.
export const productionBuild = {
  apiOrigin: 'http://127.0.0.1:3103',
  outDir: resolve(import.meta.dirname, '..', '..', '..', '.local', 'web-bundle', 'e2e-production', 'dist'),
  webOrigin: 'http://127.0.0.1:5278',
} as const;

interface ManifestChunk {
  readonly assets?: readonly string[];
  readonly css?: readonly string[];
  readonly file: string;
  readonly imports?: readonly string[];
  readonly isDynamicEntry?: boolean;
  readonly isEntry?: boolean;
  readonly src?: string;
}

export interface BuiltFiles {
  /** Every JS and CSS file a cold load fetches: the entry, its static imports and their CSS. */
  readonly initial: readonly string[];
  /** The one chunk of the secondary views, and the Mapbox runtime and stylesheet, which are only loaded on demand. */
  readonly mapboxRuntime: string;
  readonly mapboxStylesheet: string;
  readonly secondaryViews: string;
}

/** The served build's file names, read from its manifest. */
export function builtFiles(): BuiltFiles {
  const path = resolve(productionBuild.outDir, '.vite', 'manifest.json');
  if (!existsSync(path)) throw new Error(`No production build at ${productionBuild.outDir}: run npm run test:e2e:production-build`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ManifestChunk>;
  const chunks = Object.entries(manifest);
  const entry = chunks.find(([, chunk]) => chunk.isEntry === true);
  const views = chunks.find(([key]) => key.endsWith('src/secondary-views.ts'));
  const mapbox = chunks.find(([key]) => key.endsWith('mapbox-gl/dist/mapbox-gl.js'));
  const stylesheet = views?.[1].assets?.find((asset) => /mapbox-gl.*\.css$/u.test(asset));
  if (entry === undefined || views === undefined || mapbox === undefined || stylesheet === undefined) {
    throw new Error('The production build does not have the expected entry, secondary views chunk and Mapbox files');
  }
  const initial = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key]!;
    if (initial.has(chunk.file)) return;
    initial.add(chunk.file);
    for (const css of chunk.css ?? []) initial.add(css);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(entry[0]);
  return { initial: [...initial], mapboxRuntime: mapbox[1].file, mapboxStylesheet: stylesheet, secondaryViews: views[1].file };
}
