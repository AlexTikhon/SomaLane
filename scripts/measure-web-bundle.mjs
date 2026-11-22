#!/usr/bin/env node
// Measures what a cold load of the production web app fetches (release step 4, ADR-0098):
//
//   npm run measure:web-bundle                      the working tree (a committed or an uncommitted candidate)
//   npm run measure:web-bundle -- --ref a3bf4e2     apps/web as it is in that commit, with today's dependencies
//   ... -- --json <file>                            also write the result as JSON
//   ... -- --out <dir>                              build into <dir> (default .local/web-bundle/<label>/dist)
//
// Every measurement uses the same build: Vite's production build of apps/web through its own vite.config.ts, mode
// "production", a manifest, and an EMPTY env directory with every VITE_* variable removed from the environment, so a
// developer's .env (a Mapbox token, the demo flag) cannot change the output. The npm script builds the contracts and
// fixtures packages first, as the web app's own prebuild does.
//
// --ref extracts apps/web from the commit (git archive) into .local/web-bundle/<commit>/ and builds it there, resolving
// dependencies from this checkout. It refuses when anything else the web build reads (packages/,
// package-lock.json, tsconfig.base.json) differs between that commit and the working tree, because the result would
// then not describe the commit.
//
// The candidate is identified by git tree ids: the working tree is written to a TEMPORARY index (the real index is not
// touched; git stores the blobs as unreferenced objects), and the ids of the whole tree and of apps/web are printed.
// A later commit of the same files has the same apps/web tree id (`git rev-parse <commit>:apps/web`).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleGraph, compareWithHtml, formatBytes, GZIP_LEVEL, htmlAssets, measureGraph, sizeOf } from './web-bundle.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// What the web build reads besides apps/web (dependency versions are pinned by package-lock.json). --ref requires
// these to be unchanged.
const sharedInputs = ['packages', 'package-lock.json', 'tsconfig.base.json'];

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function parseArguments(argv) {
  const options = { json: null, out: null, quiet: false, ref: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === '--ref') options.ref = value();
    else if (argument === '--json') options.json = value();
    else if (argument === '--out') options.out = value();
    else if (argument === '--quiet') options.quiet = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

function workingTreeIdentity() {
  const head = git(['rev-parse', 'HEAD']);
  const temporary = mkdtempSync(join(tmpdir(), 'web-bundle-index-'));
  try {
    const index = join(temporary, 'index');
    copyFileSync(resolve(repositoryRoot, git(['rev-parse', '--git-path', 'index'])), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(['add', '--all'], { env });
    const tree = git(['write-tree'], { env });
    const dirty = tree !== git(['rev-parse', 'HEAD^{tree}']);
    return {
      appsWebTree: git(['rev-parse', `${tree}:apps/web`]),
      baseCommit: head,
      kind: dirty ? 'uncommitted candidate' : 'clean working tree',
      label: dirty ? `worktree-${tree.slice(0, 12)}` : head.slice(0, 12),
      tree,
    };
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

function extractRef(ref) {
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  // Object ids, compared after git's own line-ending normalization: a build that only rewrote a generated file's line
  // endings (the contracts' openapi.json on Windows) is not a difference, any content change is.
  const { tree } = workingTreeIdentity();
  const changed = sharedInputs.filter((path) => git(['rev-parse', `${commit}:${path}`]) !== git(['rev-parse', `${tree}:${path}`]));
  if (changed.length > 0) {
    throw new Error(`--ref ${ref}: the web build's other inputs differ from the working tree (${changed.join(', ')}), so the result would not describe that commit`);
  }
  const target = resolve(repositoryRoot, '.local', 'web-bundle', commit.slice(0, 12), 'source');
  rmSync(target, { force: true, recursive: true });
  mkdirSync(target, { recursive: true });
  const archive = join(target, 'apps-web.tar');
  // tsconfig.base.json too: apps/web/tsconfig.json extends it, and Vite's transform reads it.
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit, 'apps/web', 'tsconfig.base.json'], { cwd: repositoryRoot });
  execFileSync('tar', ['-xf', 'apps-web.tar'], { cwd: target });
  rmSync(archive);
  return {
    identity: {
      appsWebTree: git(['rev-parse', `${commit}:apps/web`]),
      baseCommit: commit,
      kind: 'commit',
      label: commit.slice(0, 12),
      tree: git(['rev-parse', `${commit}^{tree}`]),
    },
    // Inside the checkout, so its node_modules resolve the same dependency versions.
    webRoot: join(target, 'apps', 'web'),
  };
}

async function buildWeb(webRoot, outDir) {
  // Nothing from the developer's environment reaches import.meta.env.
  for (const name of Object.keys(process.env)) if (name.startsWith('VITE_')) delete process.env[name];
  const envDir = mkdtempSync(join(tmpdir(), 'web-bundle-env-'));
  const { build, version } = await import('vite');
  try {
    await build({
      build: { emptyOutDir: true, manifest: true, outDir },
      configFile: join(webRoot, 'vite.config.ts'),
      envDir,
      logLevel: 'warn',
      mode: 'production',
      root: webRoot,
    });
  } finally {
    rmSync(envDir, { force: true, recursive: true });
  }
  return version;
}

function printReport(result) {
  const { initial, deferred, deferredUnion } = result.measurement;
  const line = (label, total) => `${label.padEnd(34)} ${String(total.raw).padStart(9)} B raw  ${String(total.gzip).padStart(8)} B gzip  (${formatBytes(total.raw)} / ${formatBytes(total.gzip)})`;
  console.log(`\nWeb bundle measurement (${result.identity.kind})`);
  console.log(`  base commit       ${result.identity.baseCommit}`);
  console.log(`  tree              ${result.identity.tree}`);
  console.log(`  apps/web tree     ${result.identity.appsWebTree}`);
  console.log(`  build             vite ${result.build.vite}, mode ${result.build.mode}, empty env dir, gzip level ${result.build.gzipLevel}`);
  console.log(`  output            ${result.build.outDir}\n`);
  console.log(line('Initial JS', initial.js.total));
  for (const file of initial.js.files) console.log(`    ${file.file.padEnd(40)} ${String(file.raw).padStart(9)}  ${String(file.gzip).padStart(8)}`);
  console.log(line('Initial CSS', initial.css.total));
  for (const file of initial.css.files) console.log(`    ${file.file.padEnd(40)} ${String(file.raw).padStart(9)}  ${String(file.gzip).padStart(8)}`);
  console.log(line('Initial JS + CSS', { gzip: initial.js.total.gzip + initial.css.total.gzip, raw: initial.js.total.raw + initial.css.total.raw }));
  console.log(`  HTML: entry ${result.html.scripts.join(', ')}; modulepreload ${result.html.modulePreloads.length ? result.html.modulePreloads.join(', ') : 'none'}; stylesheets ${result.html.stylesheets.join(', ') || 'none'}`);
  if (result.notPreloaded.length > 0) console.log(`  Initial static imports without a preload link (still fetched): ${result.notPreloaded.join(', ')}`);
  console.log('\nDeferred (fetched only when a dynamic import runs; a chunk shared by several entries is listed under each):');
  for (const group of deferred) {
    const assets = group.assets.length > 0 ? `  assets: ${group.assets.map((asset) => `${asset} (${asset in result.assetSizes ? `${result.assetSizes[asset].raw} B raw, ${result.assetSizes[asset].gzip} B gzip` : '?'})`).join(', ')}` : '';
    console.log(`  ${group.source.replace(/^(?:\.\.\/)+/u, '')}`);
    console.log(`    JS  ${String(group.jsTotal.raw).padStart(9)} B raw ${String(group.jsTotal.gzip).padStart(8)} B gzip  ${group.js.join(', ')}${group.css.length ? `\n    CSS ${String(group.cssTotal.raw).padStart(9)} B raw ${String(group.cssTotal.gzip).padStart(8)} B gzip  ${group.css.join(', ')}` : ''}${assets ? `\n  ${assets}` : ''}`);
  }
  console.log(line('\nAll deferred files (each once)', deferredUnion));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { identity, webRoot } = options.ref === null
    ? { identity: workingTreeIdentity(), webRoot: join(repositoryRoot, 'apps', 'web') }
    : extractRef(options.ref);
  const outDir = options.out === null
    ? resolve(repositoryRoot, '.local', 'web-bundle', identity.label, 'dist')
    : isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
  const vite = await buildWeb(webRoot, outDir);

  const manifestPath = join(outDir, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`The build wrote no manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const graph = bundleGraph(manifest);
  const html = htmlAssets(readFileSync(join(outDir, 'index.html'), 'utf8'));
  const { notPreloaded, problems } = compareWithHtml(graph, html);
  if (problems.length > 0) throw new Error(`The HTML and the manifest disagree:\n${problems.join('\n')}`);
  const read = (file) => readFileSync(join(outDir, file));
  const measurement = measureGraph(graph, read);
  const initialFiles = new Set([...graph.initial.js, ...graph.initial.css]);
  const deferredFiles = [...new Set(graph.deferred.flatMap((group) => [...group.js, ...group.css, ...group.assets]))]
    .filter((file) => !initialFiles.has(file) && /\.(?:js|css)$/u.test(file));
  measurement.deferredUnion = deferredFiles
    .map((file) => sizeOf(read(file)))
    .reduce((total, size) => ({ gzip: total.gzip + size.gzip, raw: total.raw + size.raw }), { gzip: 0, raw: 0 });
  const assetSizes = Object.fromEntries(
    [...new Set(graph.deferred.flatMap((group) => group.assets))].map((asset) => [asset, sizeOf(read(asset))]),
  );
  const result = {
    assetSizes,
    build: { configFile: 'apps/web/vite.config.ts', envDir: 'empty temporary directory', gzipLevel: GZIP_LEVEL, mode: 'production', outDir, vite },
    html,
    identity,
    measurement,
    notPreloaded,
  };
  if (!options.quiet) printReport(result);
  if (options.json !== null) writeFileSync(options.json, `${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
