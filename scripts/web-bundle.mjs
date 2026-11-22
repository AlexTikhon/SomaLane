import { gzipSync } from 'node:zlib';

// Pure analysis of a production build of apps/web (release step 4, ADR-0098), used by measure-web-bundle.mjs.
//
// "Initial" is what a cold load of the page fetches before any dynamic import: the HTML entry chunk and the transitive
// closure of its STATIC imports (each of which the browser requests whether or not Vite also emitted a modulepreload
// link for it), plus the CSS those chunks carry. Everything reachable only through a dynamic import is "deferred" and
// is reported per dynamic entry, never counted as part of the initial bytes.

/** zlib's default level (6), stated so a later measurement uses the same one. */
export const GZIP_LEVEL = 6;

export function sizeOf(buffer) {
  return { gzip: gzipSync(buffer, { level: GZIP_LEVEL }).length, raw: buffer.length };
}

function sum(sizes) {
  return sizes.reduce((total, size) => ({ gzip: total.gzip + size.gzip, raw: total.raw + size.raw }), { gzip: 0, raw: 0 });
}

function entryKeyOf(manifest) {
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry === true);
  if (entries.length !== 1) throw new Error(`Expected exactly one entry chunk in the manifest, found ${entries.length}`);
  return entries[0][0];
}

/** The manifest keys reachable from `start` through static imports only, `start` included, in a stable order. */
export function staticClosure(manifest, start) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    const chunk = manifest[key];
    if (chunk === undefined) throw new Error(`The manifest has no chunk ${key}`);
    seen.add(key);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  visit(start);
  return [...seen];
}

function cssOf(manifest, keys) {
  return [...new Set(keys.flatMap((key) => manifest[key].css ?? []))];
}

/**
 * The initial and deferred file sets of a build, from its manifest (`build.manifest`). Deferred groups are keyed by
 * dynamic entry and list only the files that entry adds beyond the initial set.
 */
export function bundleGraph(manifest) {
  const entry = entryKeyOf(manifest);
  const initialKeys = staticClosure(manifest, entry);
  const initialSet = new Set(initialKeys);
  const initial = {
    css: cssOf(manifest, initialKeys),
    entry: manifest[entry].file,
    js: initialKeys.map((key) => manifest[key].file),
  };
  const initialFiles = new Set([...initial.js, ...initial.css]);
  const deferred = Object.entries(manifest)
    .filter(([key, chunk]) => chunk.isDynamicEntry === true && !initialSet.has(key))
    .map(([key, chunk]) => {
      const keys = staticClosure(manifest, key).filter((reached) => !initialSet.has(reached));
      return {
        css: cssOf(manifest, keys).filter((file) => !initialFiles.has(file)),
        // Assets a deferred chunk imports as URLs (the Mapbox stylesheet through `?url`), fetched only when used.
        assets: [...new Set(keys.flatMap((reached) => manifest[reached].assets ?? []))],
        entry: chunk.file,
        js: keys.map((reached) => manifest[reached].file),
        name: chunk.name ?? key,
        source: chunk.src ?? key,
      };
    })
    .sort((left, right) => left.source.localeCompare(right.source));
  return { deferred, initial };
}

/** What the built index.html makes a browser fetch at once: module scripts, modulepreload links and stylesheets. */
export function htmlAssets(html) {
  const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag)?.[1] ?? null;
  const scripts = [];
  const modulePreloads = [];
  const stylesheets = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gu)) {
    const src = attribute(tag, 'src');
    if (src !== null && attribute(tag, 'type') === 'module') scripts.push(src);
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gu)) {
    const rel = attribute(tag, 'rel');
    const href = attribute(tag, 'href');
    if (href === null) continue;
    if (rel === 'modulepreload') modulePreloads.push(href);
    if (rel === 'stylesheet') stylesheets.push(href);
  }
  const strip = (path) => path.replace(/^\//u, '');
  return { modulePreloads: modulePreloads.map(strip), scripts: scripts.map(strip), stylesheets: stylesheets.map(strip) };
}

/**
 * Problems between what the HTML references and the manifest's initial closure. Every script, preload and stylesheet
 * in the HTML must belong to the initial set, and every initial CSS file must be linked; an initial JS file that is
 * neither the entry nor preloaded is still fetched (as a static import), so it is not a problem, only reported.
 */
export function compareWithHtml(graph, html) {
  const problems = [];
  const initialJs = new Set(graph.initial.js);
  const initialCss = new Set(graph.initial.css);
  if (html.scripts.length !== 1 || html.scripts[0] !== graph.initial.entry) {
    problems.push(`The HTML's module scripts ${JSON.stringify(html.scripts)} are not exactly the entry ${graph.initial.entry}`);
  }
  for (const file of html.modulePreloads) {
    if (!initialJs.has(file)) problems.push(`The HTML preloads ${file}, which is not in the initial static closure`);
  }
  for (const file of html.stylesheets) {
    if (!initialCss.has(file)) problems.push(`The HTML links ${file}, which is not initial CSS`);
  }
  for (const file of graph.initial.css) {
    if (!html.stylesheets.includes(file)) problems.push(`Initial CSS ${file} is not linked from the HTML`);
  }
  const preloaded = new Set([graph.initial.entry, ...html.modulePreloads]);
  const notPreloaded = graph.initial.js.filter((file) => !preloaded.has(file));
  return { notPreloaded, problems };
}

/** Sizes for a graph, reading each file through `read(file) -> Buffer`. */
export function measureGraph(graph, read) {
  const files = (list) => list.map((file) => ({ file, ...sizeOf(read(file)) }));
  const initialJs = files(graph.initial.js);
  const initialCss = files(graph.initial.css);
  const deferred = graph.deferred.map((group) => {
    const js = files(group.js);
    const css = files(group.css);
    return { ...group, cssFiles: css, cssTotal: sum(css), jsFiles: js, jsTotal: sum(js) };
  });
  return {
    deferred,
    initial: {
      css: { files: initialCss, total: sum(initialCss) },
      js: { files: initialJs, total: sum(initialJs) },
    },
  };
}

export function formatBytes(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
}
