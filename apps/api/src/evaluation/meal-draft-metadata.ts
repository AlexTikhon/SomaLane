import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mealDraftPromptDigest, MEAL_DRAFT_PROMPT_VERSION } from '../meals/drafts/meal-draft-prompt.js';
import { MEAL_DRAFT_WIRE_SCHEMA_NAME } from '../meals/drafts/meal-draft-wire.js';

// Reproducibility metadata for the meal draft evaluation (ADR-0092). Bounded and content-free: digests, versions, names,
// settings and the paths of uncommitted files, never a text, an answer or a credential.

/** How Git is asked; replaced in tests. Returns stdout, or throws when Git or the repository is unavailable. */
export type GitRunner = (args: readonly string[]) => string;

export const runGit: GitRunner = (args) => execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });

/** At most this many uncommitted paths are listed (the count is always exact). */
const DIRTY_PATHS_LISTED = 40;

export interface GitState {
  /** True when the working tree differs from `sha` (tracked changes or untracked files); null when unknown. */
  dirty: boolean | null;
  dirtyPathCount: number | null;
  dirtyPaths: string[];
  sha: string | null;
}

export function readGitState(git: GitRunner = runGit): GitState {
  let sha: string | null;
  try {
    sha = git(['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{40}$/u.test(sha)) sha = null;
  } catch {
    sha = null;
  }
  try {
    const lines = git(['status', '--porcelain=v1', '--untracked-files=all'])
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '');
    return { dirty: lines.length > 0, dirtyPathCount: lines.length, dirtyPaths: lines.slice(0, DIRTY_PATHS_LISTED).map((line) => line.slice(3)), sha };
  } catch {
    return { dirty: null, dirtyPathCount: null, dirtyPaths: [], sha };
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** SHA-256 of a text with line endings normalised (a Windows checkout and a Linux one agree). */
export const normalizedDigest = (text: string): string => sha256(text.replaceAll('\r\n', '\n'));

// ---------------------------------------------------------------------------------------------------------------
// The verifier fingerprint.
//
// What decides whether a model's claim becomes a proposal, and how the model is called, is not two files: the grounding
// and the wire schema import the shared meal contracts (limits, precision, title and response schemas), and the model is
// reached through the Ollama adapter and its bounded fetch. The fingerprint covers the IMPORT CLOSURE of fixed API roots
// as the evaluation actually loads them (tsx runs the API from `src`, TypeScript), and the contract modules those
// sources really receive from `@running-tracker/contracts`:
//
// 1. The package is resolved as Node.js resolves an ESM `import` of it: its `package.json` `exports` entry for ".",
//    under the runtime's conditions (Node's defaults plus every `--conditions`). The result must be the module the
//    runtime itself reports (`import.meta.resolve`); a disagreement, or an `exports` shape this small resolver does not
//    model (no `exports`, fallback arrays, null targets, patterns, targets outside the package, CommonJS), is refused.
// 2. Every name the API closure imports by value from the package is followed from that entry through re-exports
//    (`export * from`, `export { … } from`; explicit before star, as ECMAScript links them) to the module that DEFINES
//    it. Modules on the way must be pure re-export barrels; a name defined by two star-exported modules is ambiguous and
//    refused. The defining modules and their import closures are hashed (the BUILT `dist` JavaScript, as loaded).
// 3. The resolution itself (manifest, condition path, entry, and which module and local binding supplies each name) is
//    part of the digest, so redirecting a re-export changes it even when every hashed file is unchanged.
//
// Star-exported modules that supply none of the names are read for their export statements only, never hashed, so other
// contracts, documentation and the evaluation's own reporting code do not change the fingerprint. External packages are
// recorded by their installed version. The reading is static (import and export statements at the start of a line;
// in a contract module an `export` anywhere else is refused); anything it cannot bind is refused rather than guessed.

export const MEAL_DRAFT_FINGERPRINT_VERSION = 2;

/** Roots in the API source tree, relative to the repository root. */
export const VERIFIER_API_ROOTS = [
  'apps/api/src/meals/drafts/meal-draft-grounding.ts',
  'apps/api/src/meals/drafts/meal-draft-wire.ts',
  'apps/api/src/meals/drafts/meal-draft-prompt.ts',
  'apps/api/src/insights/ollama-provider.ts',
] as const;

/** The workspace package whose exports the verifier uses; resolved and bound, never recorded by version. */
export const VERIFIER_CONTRACTS_PACKAGE = '@running-tracker/contracts';

/** The conditions Node.js matches for an ESM `import` before `--conditions` adds any (Node 24). */
export const NODE_ESM_IMPORT_CONDITIONS = ['node', 'import', 'module-sync', 'default'] as const;

export interface FingerprintSources {
  /** The conditions package `exports` are matched under: Node's ESM defaults plus the runtime's `--conditions`. */
  conditions: readonly string[];
  /** Absolute path of the directory of the installed `@running-tracker/contracts` package, as Node.js locates it. */
  contractsPackage: string;
  exists: (absolutePath: string) => boolean;
  /** The installed version of an external package, or null when it cannot be found. */
  packageVersion: (name: string) => string | null;
  read: (absolutePath: string) => string;
  /** Absolute repository root; recorded paths are relative to it. */
  root: string;
  /**
   * The absolute path of the module the runtime itself resolves `@running-tracker/contracts` to; the manifest
   * resolution must equal it. Null only for an isolated tree that no runtime loads (tests).
   */
  runtimeEntry: string | null;
}

/** How `@running-tracker/contracts` resolved, and which module supplies each value the verifier imports from it. */
export interface ContractResolution {
  /** One entry per imported name, sorted by name: the defining module and its local binding name. */
  bindings: Array<{ local: string; module: string; name: string }>;
  /** The keys followed in `exports` to the entry, e.g. [".", "default"]. */
  conditionPath: string[];
  entry: string;
  manifest: string;
  package: typeof VERIFIER_CONTRACTS_PACKAGE;
}

export interface VerifierFingerprint {
  contracts: ContractResolution;
  digest: string;
  files: Array<{ path: string; sha256: string }>;
  fingerprintVersion: typeof MEAL_DRAFT_FINGERPRINT_VERSION;
  packages: Array<{ name: string; version: string | null }>;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/** The directory of the grounding, whose `@running-tracker/contracts` import the fingerprint binds. */
const CONTRACTS_IMPORTER_DIRECTORY = resolve(REPOSITORY_ROOT, 'apps/api/src/meals/drafts');
const requireFromApi = createRequire(import.meta.url);

function installedPackageVersion(name: string): string | null {
  try {
    let directory = dirname(requireFromApi.resolve(name));
    for (let depth = 0; depth < 8; depth += 1) {
      const manifest = join(directory, 'package.json');
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
        if (parsed.name === name) return parsed.version ?? null;
      }
      directory = dirname(directory);
    }
  } catch {
    return null;
  }
  return null;
}

/** Node's package lookup: `node_modules/<name>` in the importer's directory and each ancestor, nearest first. */
function locatePackage(name: string, from: string): string {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(directory) === directory) throw new Error(`The verifier fingerprint cannot find ${name} from ${from}`);
  }
}

/** Node's ESM conditions plus every `--conditions` / `-C` given to this process (argv or NODE_OPTIONS). */
export function runtimeConditions(execArgv: readonly string[] = process.execArgv, nodeOptions: string = process.env['NODE_OPTIONS'] ?? ''): string[] {
  const args = [...execArgv, ...nodeOptions.split(/\s+/u).filter((arg) => arg !== '')];
  const extra: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = args[index + 1];
    if ((arg === '--conditions' || arg === '-C') && next !== undefined) {
      extra.push(next);
      index += 1;
    } else if (arg.startsWith('--conditions=')) {
      extra.push(arg.slice('--conditions='.length));
    }
  }
  return [...new Set<string>([...NODE_ESM_IMPORT_CONDITIONS, ...extra])];
}

export function defaultFingerprintSources(): FingerprintSources {
  if (typeof import.meta.resolve !== 'function') throw new Error('The verifier fingerprint cannot ask this runtime how it resolves @running-tracker/contracts (no import.meta.resolve).');
  return {
    conditions: runtimeConditions(),
    contractsPackage: locatePackage(VERIFIER_CONTRACTS_PACKAGE, CONTRACTS_IMPORTER_DIRECTORY),
    exists: existsSync,
    packageVersion: installedPackageVersion,
    read: (path) => readFileSync(path, 'utf8'),
    root: REPOSITORY_ROOT,
    runtimeEntry: realpathSync(fileURLToPath(import.meta.resolve(VERIFIER_CONTRACTS_PACKAGE))),
  };
}

// Only import and export statements are read (a specifier on such a line), never comments or strings elsewhere.
const STATEMENT_SPECIFIERS = [/^\s*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1/u, /^\s*import\s*(['"])([^'"]+)\1/u, /^\s*\}\s*from\s*(['"])([^'"]+)\1/u];
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*/u;
const WORKSPACE_SCOPE = '@running-tracker/';

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split(/\r?\n/u)) {
    for (const pattern of STATEMENT_SPECIFIERS) {
      const match = pattern.exec(line);
      if (match?.[2] !== undefined) {
        found.push(match[2]);
        break;
      }
    }
  }
  return found;
}

const relativeId = (root: string, path: string) => relative(root, path).split(sep).join('/');
const isInside = (directory: string, path: string) => {
  const between = relative(directory, path);
  return between !== '' && !between.startsWith('..') && !isAbsolute(between);
};
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ');

class UnsupportedResolution extends Error {
  constructor(detail: string) {
    super(`The verifier fingerprint cannot bind ${VERIFIER_CONTRACTS_PACKAGE}: ${detail}`);
    this.name = 'UnsupportedResolution';
  }
}

/** Parses `a, b as c, type T` into [imported, exported] pairs; type-only members are dropped when `dropTypes`. */
function clauseMembers(clause: string, where: string, dropTypes: boolean): Array<[string, string]> {
  const members: Array<[string, string]> = [];
  for (const raw of withoutComments(clause).split(',')) {
    const member = raw.trim();
    if (member === '') continue;
    if (dropTypes && /^type\s/u.test(member)) continue;
    const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/u.exec(member);
    if (match === null) throw new UnsupportedResolution(`"${member}" in ${where} is not a plain export name`);
    members.push([match[1]!, match[2] ?? match[1]!]);
  }
  return members;
}

// --- The names the API closure imports from the package -------------------------------------------------------

const CONTRACTS_NAMED_IMPORT = /^[ \t]*(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])@running-tracker\/contracts\3/gmu;

/** The value names one API source imports from the package; any other way of loading it is refused. */
function contractNamesOf(source: string, id: string): string[] {
  if (/\b(?:import|require)\s*\(\s*['"]@running-tracker\/contracts/u.test(source)) throw new UnsupportedResolution(`${id} loads it dynamically`);
  const statements = specifiersOf(source).filter((specifier) => specifier === VERIFIER_CONTRACTS_PACKAGE || specifier.startsWith(`${VERIFIER_CONTRACTS_PACKAGE}/`)).length;
  const names: string[] = [];
  let named = 0;
  for (const match of source.matchAll(CONTRACTS_NAMED_IMPORT)) {
    named += 1;
    if (match[1] !== undefined) continue; // `import type { … }` is erased.
    for (const [imported] of clauseMembers(match[2]!, id, true)) {
      if (imported === 'default') throw new UnsupportedResolution(`${id} imports its default export`);
      names.push(imported);
    }
  }
  if (named !== statements) {
    throw new UnsupportedResolution(`${id} loads it other than by named imports from the package root (a namespace, default, side-effect, re-export-all or subpath import); only \`import { … } from '${VERIFIER_CONTRACTS_PACKAGE}'\` can be bound`);
  }
  return names;
}

// --- `exports` resolution ---------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function selectTarget(value: unknown, conditions: ReadonlySet<string>, path: string[], manifest: string): { path: string[]; target: string } | null {
  const at = path.length === 0 ? '"exports"' : `"exports" → ${path.map((key) => `"${key}"`).join(' → ')}`;
  if (typeof value === 'string') return { path, target: value };
  if (value === null) throw new UnsupportedResolution(`${at} in ${manifest} is null (not exported)`);
  if (Array.isArray(value)) throw new UnsupportedResolution(`${at} in ${manifest} is a fallback array, which this resolver does not model`);
  if (!isRecord(value)) throw new UnsupportedResolution(`${at} in ${manifest} is neither a path nor a condition object`);
  for (const key of Object.keys(value)) {
    if (key.startsWith('.') || /^\d+$/u.test(key)) throw new UnsupportedResolution(`${at} in ${manifest} has the key "${key}" where only conditions may appear`);
    if (!conditions.has(key)) continue;
    const selected = selectTarget(value[key], conditions, [...path, key], manifest);
    if (selected !== null) return selected;
  }
  return null;
}

/** The entry module of the package for an ESM `import` of its root under `conditions`. */
function resolveEntry(sources: FingerprintSources): { conditionPath: string[]; entry: string; manifest: string } {
  const manifestPath = join(sources.contractsPackage, 'package.json');
  const manifest = relativeId(sources.root, manifestPath);
  if (!sources.exists(manifestPath)) throw new UnsupportedResolution(`${manifest} does not exist`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(sources.read(manifestPath));
  } catch {
    throw new UnsupportedResolution(`${manifest} is not valid JSON`);
  }
  if (!isRecord(parsed) || parsed['name'] !== VERIFIER_CONTRACTS_PACKAGE) throw new UnsupportedResolution(`${manifest} is not the manifest of ${VERIFIER_CONTRACTS_PACKAGE}`);
  const exportsField = parsed['exports'];
  if (exportsField === undefined) throw new UnsupportedResolution(`${manifest} has no "exports"; resolution through "main" or an index file is not supported`);
  let root: unknown = exportsField;
  const path: string[] = [];
  if (isRecord(exportsField)) {
    const keys = Object.keys(exportsField);
    const subpaths = keys.filter((key) => key.startsWith('.'));
    if (subpaths.length > 0 && subpaths.length !== keys.length) throw new UnsupportedResolution(`"exports" in ${manifest} mixes subpaths and conditions`);
    if (subpaths.length > 0) {
      if (!Object.hasOwn(exportsField, '.')) throw new UnsupportedResolution(`"exports" in ${manifest} has no "." entry`);
      root = exportsField['.'];
      path.push('.');
    }
  }
  const conditions = new Set(sources.conditions);
  const selected = selectTarget(root, conditions, path, manifest);
  if (selected === null) throw new UnsupportedResolution(`no condition of "exports" → "." in ${manifest} matches the runtime conditions (${[...conditions].join(', ')})`);
  const { target } = selected;
  const where = `"exports" → ${selected.path.map((key) => `"${key}"`).join(' → ')} = "${target}" in ${manifest}`;
  const segments = target.split('/').slice(1);
  if (!target.startsWith('./') || target.includes('*') || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === 'node_modules')) {
    throw new UnsupportedResolution(`${where} is not a plain relative file inside the package`);
  }
  const extension = extname(target);
  if (extension !== '.mjs' && !(extension === '.js' && parsed['type'] === 'module')) throw new UnsupportedResolution(`${where} is not an ES module (.mjs, or .js with "type": "module")`);
  const entry = resolve(sources.contractsPackage, target);
  if (!sources.exists(entry)) throw new UnsupportedResolution(`${where} does not exist`);
  if (sources.runtimeEntry !== null && relative(sources.runtimeEntry, entry) !== '') {
    throw new UnsupportedResolution(`${where} resolves to ${relativeId(sources.root, entry)}, but the runtime loads ${relativeId(sources.root, sources.runtimeEntry)}`);
  }
  return { conditionPath: selected.path, entry, manifest };
}

// --- Export statements of a contract module ----------------------------------------------------------------------

interface ModuleExports {
  /** `export { a as b } from './x.js'`: exported name → the name imported from the specifier. */
  explicit: Map<string, { imported: string; specifier: string }>;
  /** Names defined (or re-exported from an import) by the module itself: exported name → local binding. */
  local: Map<string, string>;
  /** `export * as ns from './x.js'`. */
  namespaces: Map<string, string>;
  /**
   * True when every statement of the module is an `export * from` / `export { … } from` this parse read (comments and
   * semicolons aside). Derived from the parsed statements themselves, so nothing counts as barrel content unread.
   */
  pureBarrel: boolean;
  stars: string[];
}

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const defines = (match: RegExpExecArray, found: ModuleExports) => {
  found.local.set(match[1]!, match[1]!);
};
// Tried in order at each `export` that starts a line; a statement none of them names is refused. The flag marks the
// re-export forms a pure barrel may consist of.
const EXPORT_FORMS: Array<[RegExp, (match: RegExpExecArray, found: ModuleExports, where: string) => void, boolean]> = [
  [
    /export\s*\*\s*from\s*(['"])([^'"]+)\1/uy,
    (match, found) => {
      found.stars.push(match[2]!);
    },
    true,
  ],
  [
    new RegExp(`export\\s*\\*\\s*as\\s+(${IDENTIFIER})\\s+from\\s*(['"])([^'"]+)\\2`, 'uy'),
    (match, found) => {
      found.namespaces.set(match[1]!, match[3]!);
    },
    false,
  ],
  [
    /export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/uy,
    (match, found, where) => {
      for (const [imported, exported] of clauseMembers(match[1]!, where, false)) found.explicit.set(exported, { imported, specifier: match[3]! });
    },
    true,
  ],
  [
    /export\s*\{([^}]*)\}/uy,
    (match, found, where) => {
      for (const [local, exported] of clauseMembers(match[1]!, where, false)) found.local.set(exported, local);
    },
    false,
  ],
  [/export\s+default\b/uy, () => {}, false], // never re-exported by `export *`, never imported by name here
  [new RegExp(`export\\s+(?:async\\s+)?function\\s*\\*?\\s*(${IDENTIFIER})`, 'uy'), defines, false],
  [new RegExp(`export\\s+class\\s+(${IDENTIFIER})`, 'uy'), defines, false],
  // One declarator per statement, as tsc emits; a destructuring export is refused.
  [new RegExp(`export\\s+(?:const|let|var)\\s+(${IDENTIFIER})(?![\\w$])`, 'uy'), defines, false],
];

function parseModuleExports(source: string, id: string): ModuleExports {
  const text = withoutComments(source);
  // Statements are read where they start a line. An `export` anywhere else (a second statement on the line, after a
  // comment or code) would go unread while a binding succeeds, so it is refused instead. Export-like text inside a
  // string is refused too: failing closed is the safe direction.
  for (const keyword of text.matchAll(/\bexport\b/gu)) {
    const lineStart = text.lastIndexOf('\n', keyword.index) + 1;
    if (text.slice(lineStart, keyword.index).trim() !== '') {
      const line = text.slice(lineStart, text.indexOf('\n', keyword.index) === -1 ? undefined : text.indexOf('\n', keyword.index)).trim();
      throw new UnsupportedResolution(`${id} has an \`export\` that does not start a line ("${line.slice(0, 100)}"); this reader binds one export statement per line, so put each export statement on its own line`);
    }
  }
  const found: ModuleExports = { explicit: new Map(), local: new Map(), namespaces: new Map(), pureBarrel: false, stars: [] };
  let unread = '';
  let cursor = 0;
  let reexportsOnly = true;
  for (const start of text.matchAll(/^[ \t]*(export\b)/gmu)) {
    const index = start.index + start[0].length - start[1]!.length;
    if (index < cursor) throw new UnsupportedResolution(`${id} has an export statement inside another one ("${text.slice(index, index + 60).split('\n')[0]!.trim()}")`);
    const form = EXPORT_FORMS.find(([pattern]) => {
      pattern.lastIndex = index;
      return pattern.test(text);
    });
    if (form === undefined) throw new UnsupportedResolution(`${id} has an export statement this reader cannot name ("${text.slice(index, index + 60).split('\n')[0]!.trim()}")`);
    const [pattern, apply, reexport] = form;
    pattern.lastIndex = index;
    const match = pattern.exec(text)!;
    apply(match, found, id);
    reexportsOnly &&= reexport;
    unread += text.slice(cursor, index);
    cursor = index + match[0].length;
    const semicolon = /\s*;/uy;
    semicolon.lastIndex = cursor;
    if (semicolon.test(text)) cursor = semicolon.lastIndex;
  }
  unread += text.slice(cursor);
  // A barrel is pure only when nothing but the re-exports just read remains.
  found.pureBarrel = reexportsOnly && unread.trim() === '';
  return found;
}

// --- Binding the imported names ---------------------------------------------------------------------------------

interface Binding {
  local: string;
  module: string;
  /** The modules the name passed through before its defining module (entry first). */
  via: string[];
}

class ContractBinder {
  private readonly parsed = new Map<string, ModuleExports>();

  constructor(private readonly sources: FingerprintSources) {}

  private id(path: string): string {
    return relativeId(this.sources.root, path);
  }

  private exportsOf(path: string): ModuleExports {
    let statements = this.parsed.get(path);
    if (statements === undefined) {
      statements = parseModuleExports(this.sources.read(path), this.id(path));
      this.parsed.set(path, statements);
    }
    return statements;
  }

  /** A re-export target: relative, inside the package, an existing ES module file. */
  private target(from: string, specifier: string): string {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new UnsupportedResolution(`${this.id(from)} re-exports from "${specifier}"; only relative modules inside the package are supported`);
    const target = resolve(dirname(from), specifier);
    if (!isInside(this.sources.contractsPackage, target)) throw new UnsupportedResolution(`${this.id(from)} re-exports "${specifier}", outside the package`);
    if (!this.sources.exists(target)) throw new Error(`The verifier fingerprint cannot resolve ${specifier} from ${this.id(from)}`);
    if (extname(target) !== '.js' && extname(target) !== '.mjs') throw new UnsupportedResolution(`${this.id(from)} re-exports "${specifier}", which is not a JavaScript module`);
    return target;
  }

  /** Where `name`, exported by `path`, is defined; null when `path` does not export it. */
  lookup(path: string, name: string, visiting: ReadonlySet<string> = new Set()): Binding | null {
    if (visiting.has(path)) return null; // a star-export cycle contributes nothing new
    const inner = new Set(visiting).add(path);
    const statements = this.exportsOf(path);
    const local = statements.local.get(name);
    if (local !== undefined) return { local, module: path, via: [] };
    if (statements.namespaces.has(name)) throw new UnsupportedResolution(`${this.id(path)} exports ${name} as a module namespace`);
    // An explicit `export { … } from` wins over `export *`, as ECMAScript links them.
    const explicit = statements.explicit.get(name);
    if (explicit !== undefined) {
      const reexported = this.lookup(this.target(path, explicit.specifier), explicit.imported, inner);
      if (reexported === null) throw new UnsupportedResolution(`${this.id(path)} re-exports ${explicit.imported} from "${explicit.specifier}", which does not export it`);
      return { ...reexported, via: [path, ...reexported.via] };
    }
    if (name === 'default') return null;
    const found = new Map<string, Binding>();
    for (const specifier of statements.stars) {
      const binding = this.lookup(this.target(path, specifier), name, inner);
      if (binding !== null) found.set(`${binding.module}\0${binding.local}`, binding);
    }
    if (found.size > 1) {
      const suppliers = [...found.values()].map((binding) => this.id(binding.module)).sort(compareText);
      throw new UnsupportedResolution(`${name} is ambiguous in ${this.id(path)}: ${suppliers.join(' and ')} both supply it through \`export *\``);
    }
    const [binding] = found.values();
    return binding === undefined ? null : { ...binding, via: [path, ...binding.via] };
  }

  bind(entry: string, name: string, importers: readonly string[]): Binding {
    const binding = this.lookup(entry, name);
    if (binding === null) throw new UnsupportedResolution(`${this.id(entry)} does not export ${name} (imported by ${importers.join(', ')}; a type-only import needs \`type\`)`);
    for (const barrel of binding.via) {
      if (!this.exportsOf(barrel).pureBarrel) {
        throw new UnsupportedResolution(`${this.id(barrel)} passes ${name} on but also contains statements other than re-exports, which this resolver does not bind`);
      }
    }
    return binding;
  }
}

// --- The fingerprint --------------------------------------------------------------------------------------------

export function verifierFingerprint(sources: FingerprintSources = defaultFingerprintSources()): VerifierFingerprint {
  const files = new Map<string, string>();
  const packages = new Set<string>();
  /** Value name → the API sources importing it from the package. */
  const contractNames = new Map<string, Set<string>>();

  const traverse = (queue: string[]) => {
    while (queue.length > 0) {
      const path = queue.shift()!;
      const id = relativeId(sources.root, path);
      if (files.has(id)) continue;
      if (!sources.exists(path)) throw new Error(`The verifier fingerprint cannot read ${id}`);
      const source = sources.read(path);
      files.set(id, normalizedDigest(source));
      const typescript = extname(path) === '.ts';
      if (typescript) {
        for (const name of contractNamesOf(source, id)) contractNames.set(name, (contractNames.get(name) ?? new Set()).add(id));
      }
      for (const specifier of specifiersOf(source)) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          const target = resolve(dirname(path), specifier);
          // API source imports './x.js' for './x.ts'; built JavaScript imports the file itself.
          const candidates = typescript && target.endsWith('.js') ? [`${target.slice(0, -3)}.ts`, target] : [target];
          const found = candidates.find((candidate) => sources.exists(candidate));
          if (found === undefined) throw new Error(`The verifier fingerprint cannot resolve ${specifier} from ${id}`);
          queue.push(found);
        } else if (specifier === VERIFIER_CONTRACTS_PACKAGE || specifier.startsWith(`${VERIFIER_CONTRACTS_PACKAGE}/`)) {
          if (!typescript) throw new UnsupportedResolution(`${id} imports the package itself`); // API imports were bound above
        } else if (specifier.startsWith(WORKSPACE_SCOPE)) {
          throw new Error(`The verifier fingerprint does not cover the workspace package ${specifier} imported by ${id}`);
        } else if (!specifier.startsWith('node:')) {
          const name = PACKAGE_NAME.exec(specifier)?.[0];
          if (name !== undefined) packages.add(name);
        }
      }
    }
  };

  traverse(VERIFIER_API_ROOTS.map((path) => resolve(sources.root, path)));
  const { conditionPath, entry, manifest } = resolveEntry(sources);
  const binder = new ContractBinder(sources);
  const bindings = [...contractNames]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, importers]) => ({ binding: binder.bind(entry, name, [...importers].sort(compareText)), name }));
  traverse([...new Set(bindings.map(({ binding }) => binding.module))]);

  const contracts: ContractResolution = {
    bindings: bindings.map(({ binding, name }) => ({ local: binding.local, module: relativeId(sources.root, binding.module), name })),
    conditionPath,
    entry: relativeId(sources.root, entry),
    manifest,
    package: VERIFIER_CONTRACTS_PACKAGE,
  };
  const sortedFiles = [...files].sort(([left], [right]) => compareText(left, right)).map(([path, digest]) => ({ path, sha256: digest }));
  const sortedPackages = [...packages].sort(compareText).map((name) => ({ name, version: sources.packageVersion(name) }));
  const digest = sha256(
    JSON.stringify({
      contracts: [contracts.package, contracts.manifest, contracts.conditionPath, contracts.entry, contracts.bindings.map((binding) => [binding.name, binding.module, binding.local])],
      files: sortedFiles.map((file) => [file.path, file.sha256]),
      fingerprintVersion: MEAL_DRAFT_FINGERPRINT_VERSION,
      packages: sortedPackages.map((entry) => [entry.name, entry.version]),
    }),
  );
  return { contracts, digest, files: sortedFiles, fingerprintVersion: MEAL_DRAFT_FINGERPRINT_VERSION, packages: sortedPackages };
}

/** The parts of a recorded fingerprint that can be compared; `contracts` and the version exist from version 2. */
export type ComparableFingerprint = Pick<VerifierFingerprint, 'files' | 'packages'> & { contracts?: ContractResolution | undefined; fingerprintVersion?: number | undefined };

function resolutionChanges(before: ContractResolution | undefined, after: ContractResolution | undefined): string[] {
  if (after === undefined) return [];
  if (before === undefined) return ['contract resolution not recorded'];
  const changes: string[] = [];
  if (before.manifest !== after.manifest) changes.push(`contracts manifest ${before.manifest} → ${after.manifest}`);
  const route = (resolution: ContractResolution) => `${resolution.entry} (${resolution.conditionPath.join(' → ')})`;
  if (route(before) !== route(after)) changes.push(`contracts entry ${route(before)} → ${route(after)}`);
  const supplier = (binding: ContractResolution['bindings'][number] | undefined) =>
    binding === undefined ? null : binding.local === binding.name ? binding.module : `${binding.module} as ${binding.local}`;
  const was = new Map(before.bindings.map((binding) => [binding.name, binding]));
  const is = new Map(after.bindings.map((binding) => [binding.name, binding]));
  // Grouped by move, so a redirected module reads as one change, not one per name.
  const moves = new Map<string, { from: string | null; names: string[]; to: string | null }>();
  for (const name of [...new Set([...was.keys(), ...is.keys()])].sort(compareText)) {
    const from = supplier(was.get(name));
    const to = supplier(is.get(name));
    if (from === to) continue;
    const key = `${from}\0${to}`;
    moves.set(key, { from, names: [...(moves.get(key)?.names ?? []), name], to });
  }
  for (const { from, names, to } of moves.values()) {
    const list = `${names[0]!}${names.length > 1 ? ` (+${names.length - 1})` : ''}`;
    changes.push(from === null ? `${list} newly bound to ${to}` : to === null ? `${list} no longer bound (was ${from})` : `${list} bound to ${to} (was ${from})`);
  }
  return changes;
}

/** Which resolution, files or packages differ between two fingerprints: the actionable part of a stale-evidence verdict. */
export function fingerprintChanges(recorded: ComparableFingerprint, current: ComparableFingerprint): string[] {
  const changes: string[] = [];
  if (recorded.fingerprintVersion !== undefined && current.fingerprintVersion !== undefined && recorded.fingerprintVersion !== current.fingerprintVersion) {
    changes.push(`fingerprint version ${recorded.fingerprintVersion} → ${current.fingerprintVersion}`);
  }
  changes.push(...resolutionChanges(recorded.contracts, current.contracts));
  const before = new Map(recorded.files.map((file) => [file.path, file.sha256]));
  const after = new Map(current.files.map((file) => [file.path, file.sha256]));
  for (const [path, digest] of after) {
    if (!before.has(path)) changes.push(`${path} (added)`);
    else if (before.get(path) !== digest) changes.push(`${path} (changed)`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`${path} (removed)`);
  const versions = new Map(recorded.packages.map((entry) => [entry.name, entry.version]));
  for (const entry of current.packages) {
    if (versions.get(entry.name) !== entry.version) changes.push(`package ${entry.name} ${versions.get(entry.name) ?? 'absent'} → ${entry.version ?? 'unknown'}`);
  }
  return changes;
}

export interface VerifierDigests {
  fingerprint: VerifierFingerprint;
  promptDigest: string;
  promptVersion: string;
  schemaName: string;
}

export function currentVerifierDigests(sources?: FingerprintSources): VerifierDigests {
  return {
    fingerprint: verifierFingerprint(sources),
    promptDigest: mealDraftPromptDigest(),
    promptVersion: MEAL_DRAFT_PROMPT_VERSION,
    schemaName: MEAL_DRAFT_WIRE_SCHEMA_NAME,
  };
}

export interface ReproducibilityMetadata extends VerifierDigests {
  datasetDigest: string | null;
  git: GitState;
  /** The generation settings sent with every call (null for a run that makes no call). */
  generation: Record<string, unknown> | null;
  model: string | null;
  /** The digest the local runtime reports for the model, as installed (null when there is no model). */
  modelDigest: string | null;
  nodeVersion: string;
  ollamaVersion: string | null;
  recordedAt: string;
  timeoutMs: number | null;
}

export function collectReproducibilityMetadata(input: {
  datasetDigest: string | null;
  generation: Record<string, unknown> | null;
  git?: GitRunner;
  model: string | null;
  modelDigest: string | null;
  now: Date;
  ollamaVersion: string | null;
  sources?: FingerprintSources;
  timeoutMs: number | null;
}): ReproducibilityMetadata {
  return {
    ...currentVerifierDigests(input.sources),
    datasetDigest: input.datasetDigest,
    generation: input.generation,
    git: readGitState(input.git),
    model: input.model,
    modelDigest: input.modelDigest,
    nodeVersion: process.version,
    ollamaVersion: input.ollamaVersion,
    recordedAt: input.now.toISOString(),
    timeoutMs: input.timeoutMs,
  };
}
