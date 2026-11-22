import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bundleGraph, compareWithHtml, htmlAssets, measureGraph, sizeOf, staticClosure } from './web-bundle.mjs';

// A Vite manifest shaped like the web app's: an entry with a static import chain and its CSS, a dynamic entry that
// statically imports the entry chunk and has its own chunk and URL asset, and a dynamic third-party chunk.
const manifest = {
  'index.html': {
    css: ['assets/index-1.css'],
    dynamicImports: ['src/secondary-views.ts', 'node_modules/mapbox-gl/dist/mapbox-gl.js'],
    file: 'assets/index-1.js',
    imports: ['_vendor-1.js'],
    isEntry: true,
    name: 'index',
    src: 'index.html',
  },
  '_vendor-1.js': { file: 'assets/vendor-1.js', imports: ['_shared-1.js'], name: 'vendor' },
  '_shared-1.js': { css: ['assets/shared-1.css'], file: 'assets/shared-1.js', name: 'shared' },
  'src/secondary-views.ts': {
    assets: ['assets/mapbox-gl-1.css'],
    file: 'assets/secondary-views-1.js',
    imports: ['index.html', '_views-shared-1.js'],
    isDynamicEntry: true,
    name: 'secondary-views',
    src: 'src/secondary-views.ts',
  },
  '_views-shared-1.js': { css: ['assets/views-1.css'], file: 'assets/views-shared-1.js', name: 'views-shared' },
  'node_modules/mapbox-gl/dist/mapbox-gl.js': {
    file: 'assets/mapbox-gl-1.js',
    isDynamicEntry: true,
    name: 'mapbox-gl',
    src: 'node_modules/mapbox-gl/dist/mapbox-gl.js',
  },
};

const html = `<!doctype html><html><head>
  <script type="module" crossorigin src="/assets/index-1.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/vendor-1.js">
  <link rel="stylesheet" crossorigin href="/assets/index-1.css">
  <link rel="stylesheet" crossorigin href="/assets/shared-1.css">
</head><body><div id="root"></div></body></html>`;

describe('web bundle measurement (release step 4)', () => {
  it('counts the entry and its whole static closure as initial, with their CSS', () => {
    const graph = bundleGraph(manifest);
    assert.deepEqual(graph.initial, {
      css: ['assets/index-1.css', 'assets/shared-1.css'],
      entry: 'assets/index-1.js',
      js: ['assets/index-1.js', 'assets/vendor-1.js', 'assets/shared-1.js'],
    });
  });

  it('reports each dynamic entry with only what it adds beyond the initial files', () => {
    const { deferred } = bundleGraph(manifest);
    assert.deepEqual(deferred.map((group) => group.source), ['node_modules/mapbox-gl/dist/mapbox-gl.js', 'src/secondary-views.ts']);
    assert.deepEqual(deferred[1], {
      assets: ['assets/mapbox-gl-1.css'],
      css: ['assets/views-1.css'],
      entry: 'assets/secondary-views-1.js',
      js: ['assets/secondary-views-1.js', 'assets/views-shared-1.js'],
      name: 'secondary-views',
      source: 'src/secondary-views.ts',
    });
    assert.deepEqual(deferred[0].js, ['assets/mapbox-gl-1.js']);
  });

  it('reads the module script, modulepreload links and stylesheets of the built HTML', () => {
    assert.deepEqual(htmlAssets(html), {
      modulePreloads: ['assets/vendor-1.js'],
      scripts: ['assets/index-1.js'],
      stylesheets: ['assets/index-1.css', 'assets/shared-1.css'],
    });
  });

  it('agrees with an HTML that loads the initial set, and names a static import that has no preload link', () => {
    const graph = bundleGraph(manifest);
    assert.deepEqual(compareWithHtml(graph, htmlAssets(html)), { notPreloaded: ['assets/shared-1.js'], problems: [] });
  });

  it('refuses an HTML that loads a deferred file or misses initial CSS', () => {
    const graph = bundleGraph(manifest);
    const wrong = htmlAssets(html.replace('/assets/vendor-1.js', '/assets/secondary-views-1.js').replace('/assets/shared-1.css', '/assets/views-1.css'));
    assert.deepEqual(compareWithHtml(graph, wrong).problems, [
      'The HTML preloads assets/secondary-views-1.js, which is not in the initial static closure',
      'The HTML links assets/views-1.css, which is not initial CSS',
      'Initial CSS assets/shared-1.css is not linked from the HTML',
    ]);
  });

  it('sums raw and gzip bytes per set', () => {
    const graph = bundleGraph(manifest);
    const content = (file) => Buffer.from(file.endsWith('.css') ? 'body{color:red}'.repeat(10) : `export const x = ${JSON.stringify(file)};`);
    const measured = measureGraph(graph, content);
    const expected = (files) => files.map((file) => sizeOf(content(file))).reduce((a, b) => ({ gzip: a.gzip + b.gzip, raw: a.raw + b.raw }));
    assert.deepEqual(measured.initial.js.total, expected(graph.initial.js));
    assert.deepEqual(measured.initial.css.total, expected(graph.initial.css));
    assert.equal(measured.initial.js.files.length, 3);
    assert.deepEqual(measured.deferred[1].jsTotal, expected(['assets/secondary-views-1.js', 'assets/views-shared-1.js']));
    assert.ok(sizeOf(Buffer.from('a'.repeat(1000))).gzip < 1000);
  });

  it('refuses a manifest without exactly one entry, or with a missing chunk', () => {
    assert.throws(() => bundleGraph({ a: { file: 'a.js' } }), /exactly one entry chunk/u);
    assert.throws(() => staticClosure({ a: { file: 'a.js', imports: ['b'] } }, 'a'), /The manifest has no chunk b/u);
  });
});
