// Code loaded on demand (release step 4, ADR-0098): a dynamic import that is started at most once at a time, whose
// value is kept once it has loaded, and whose failure can really be retried.
//
// Why a retry needs more than calling import() again: Chromium keeps a failed module fetch in the document's module map,
// so a second import() of the same URL rejects at once without any request (Firefox fetches again). A retry therefore
// first calls the importer again and, when that rejects too and the error names a same-origin module URL, imports that
// URL with a `retry` query: a new URL is a new fetch. That only helps when the module's own static imports have already
// loaded, which is why every deferred view lives in ONE chunk whose static imports are initial chunks (secondary-views.ts).
// The value is accepted only when it has the expected exports, so a URL naming another module is never used.

export type DeferredState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly message: string };

export interface DeferredModule<T> {
  /** The loaded value, or undefined while it has not loaded. */
  current(): T | undefined;
  /** Loads the module; one attempt at a time, and a later call after a failure is a retry. */
  load(): Promise<T>;
}

export interface DeferredModuleOptions<T> {
  readonly accept: (value: unknown) => value is T;
  readonly importer: () => Promise<unknown>;
  /** Imports a URL; injected by tests. The default is the browser's dynamic import, outside the bundler's graph. */
  readonly importUrl?: (url: string) => Promise<unknown>;
  /** The page origin a retried URL must belong to; injected by tests. */
  readonly origin?: () => string | null;
}

const browserImport = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);
const pageOrigin = (): string | null => (typeof location === 'undefined' ? null : location.origin);

/** The last same-origin http(s) URL in an import error's message, or null (Safari's message names none). */
export function failedModuleUrl(error: unknown, origin: string | null): string | null {
  if (origin === null || !(error instanceof Error)) return null;
  const candidates = error.message.match(/https?:\/\/[^\s'"<>]+/gu) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const url = new URL(candidate);
      if (url.origin === origin) return url.href;
    } catch {
      // Not a URL; try the next candidate.
    }
  }
  return null;
}

export function withRetryQuery(url: string, attempt: number): string {
  const next = new URL(url);
  next.searchParams.set('retry', String(attempt));
  return next.href;
}

export function deferredModule<T>(options: DeferredModuleOptions<T>): DeferredModule<T> {
  const importUrl = options.importUrl ?? browserImport;
  const origin = options.origin ?? pageOrigin;
  let value: T | undefined;
  let pending: Promise<T> | null = null;
  let attempts = 0;

  const checked = (loaded: unknown): T => {
    if (!options.accept(loaded)) throw new Error('The loaded module does not have the expected exports');
    return loaded;
  };

  const attempt = async (number: number): Promise<T> => {
    try {
      return checked(await options.importer());
    } catch (error) {
      if (number === 0) throw error;
      const url = failedModuleUrl(error, origin());
      if (url === null) throw error;
      return checked(await importUrl(withRetryQuery(url, number)));
    }
  };

  return {
    current: () => value,
    load: () => {
      if (value !== undefined) return Promise.resolve(value);
      if (pending !== null) return pending;
      const number = attempts;
      attempts += 1;
      pending = attempt(number).then(
        (loaded) => {
          value = loaded;
          pending = null;
          return loaded;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
  };
}

export function initialDeferredState<T>(module: DeferredModule<T>): DeferredState<T> {
  const value = module.current();
  return value === undefined ? { status: 'loading' } : { status: 'ready', value };
}

/**
 * One view's use of a deferred module: reports loading, ready or failed, and after `dispose` (the view closed, another
 * scope replaced it) reports nothing more. The import itself is not cancelled: a later opening finds it loaded.
 */
export class DeferredLoad<T> {
  #disposed = false;
  #state: DeferredState<T>;
  readonly #module: DeferredModule<T>;
  readonly #onState: (state: DeferredState<T>) => void;

  constructor(module: DeferredModule<T>, onState: (state: DeferredState<T>) => void) {
    this.#module = module;
    this.#onState = onState;
    this.#state = initialDeferredState(module);
  }

  state(): DeferredState<T> {
    return this.#state;
  }

  start(): void {
    if (this.#state.status === 'loading') this.#load();
  }

  retry(): void {
    if (this.#disposed || this.#state.status !== 'failed') return;
    this.#set({ status: 'loading' });
    this.#load();
  }

  dispose(): void {
    this.#disposed = true;
  }

  #load(): void {
    this.#module.load().then(
      (value) => this.#set({ status: 'ready', value }),
      (error: unknown) => this.#set({ message: error instanceof Error ? error.message : String(error), status: 'failed' }),
    );
  }

  #set(state: DeferredState<T>): void {
    if (this.#disposed) return;
    this.#state = state;
    this.#onState(state);
  }
}
