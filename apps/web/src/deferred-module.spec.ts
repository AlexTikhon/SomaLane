import { describe, expect, it, vi } from 'vitest';

import {
  DeferredLoad,
  deferredModule,
  failedModuleUrl,
  initialDeferredState,
  withRetryQuery,
  type DeferredState,
} from './deferred-module.js';

const ORIGIN = 'http://app.test';
const CHUNK = `${ORIGIN}/assets/secondary-views-Ab12.js`;
// What Chromium says for a failed dynamic import, and again (without a request) for every later import of the same URL.
const chromiumFailure = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`);

interface Views { readonly View: () => string }
const views: Views = { View: () => 'view' };
const isViews = (value: unknown): value is Views =>
  typeof value === 'object' && value !== null && typeof (value as Partial<Views>).View === 'function';

function deferred<T = Views>(
  importer: () => Promise<unknown>,
  importUrl: (url: string) => Promise<unknown> = vi.fn<(url: string) => Promise<unknown>>().mockRejectedValue(new Error('unexpected')),
  accept: (value: unknown) => value is T = isViews as unknown as (value: unknown) => value is T,
) {
  return deferredModule<T>({ accept, importer, importUrl, origin: () => ORIGIN });
}

function controlled() {
  let settle!: { reject: (error: unknown) => void; resolve: (value: unknown) => void };
  const promise = new Promise<unknown>((resolve, reject) => { settle = { reject, resolve }; });
  return { promise, ...settle };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a deferred module', () => {
  it('imports once, shares the attempt in flight, and keeps the loaded value', async () => {
    const pending = controlled();
    const importer = vi.fn(() => pending.promise);
    const module = deferred(importer);
    expect(module.current()).toBeUndefined();
    const first = module.load();
    const second = module.load();
    expect(importer).toHaveBeenCalledTimes(1);
    pending.resolve(views);
    expect(await first).toBe(views);
    expect(await second).toBe(views);
    expect(module.current()).toBe(views);
    expect(await module.load()).toBe(views);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('rejects a first failure as it is, without a second import', async () => {
    const importUrl = vi.fn<(url: string) => Promise<unknown>>();
    const module = deferred(vi.fn().mockRejectedValue(chromiumFailure()), importUrl);
    await expect(module.load()).rejects.toThrow('Failed to fetch dynamically imported module');
    expect(importUrl).not.toHaveBeenCalled();
    expect(module.current()).toBeUndefined();
  });

  it('retries by importing again, which is enough where the browser fetches a failed module again (Firefox)', async () => {
    const importer = vi.fn().mockRejectedValueOnce(new TypeError(`error loading dynamically imported module: ${CHUNK}`)).mockResolvedValueOnce(views);
    const importUrl = vi.fn<(url: string) => Promise<unknown>>();
    const module = deferred(importer, importUrl);
    await expect(module.load()).rejects.toThrow();
    expect(await module.load()).toBe(views);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(importUrl).not.toHaveBeenCalled();
  });

  it('retries a module the browser keeps failed (Chromium) through a new URL, one per attempt', async () => {
    const importer = vi.fn().mockRejectedValue(chromiumFailure());
    const importUrl = vi.fn<(url: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}?retry=1`))
      .mockResolvedValueOnce(views);
    const module = deferred(importer, importUrl);
    await expect(module.load()).rejects.toThrow();
    await expect(module.load()).rejects.toThrow(`${CHUNK}?retry=1`);
    expect(await module.load()).toBe(views);
    expect(importer).toHaveBeenCalledTimes(3);
    expect(importUrl.mock.calls).toEqual([[`${CHUNK}?retry=1`], [`${CHUNK}?retry=2`]]);
    expect(module.current()).toBe(views);
  });

  it('never imports a URL of another origin, an error without a URL, or a module without the expected exports', async () => {
    const importUrl = vi.fn<(url: string) => Promise<unknown>>().mockResolvedValue({ other: true });
    const foreign = deferred(vi.fn().mockRejectedValue(new TypeError('Failed to fetch dynamically imported module: https://cdn.example/x.js')), importUrl);
    await expect(foreign.load()).rejects.toThrow();
    await expect(foreign.load()).rejects.toThrow('https://cdn.example/x.js');
    const safari = deferred(vi.fn().mockRejectedValue(new TypeError('Importing a module script failed.')), importUrl);
    await expect(safari.load()).rejects.toThrow();
    await expect(safari.load()).rejects.toThrow('Importing a module script failed.');
    expect(importUrl).not.toHaveBeenCalled();
    // A URL that names a different module (Firefox names a failed dependency) is imported but not accepted.
    const wrong = deferred(vi.fn().mockRejectedValue(chromiumFailure()), importUrl);
    await expect(wrong.load()).rejects.toThrow();
    await expect(wrong.load()).rejects.toThrow('The loaded module does not have the expected exports');
    expect(wrong.current()).toBeUndefined();
    await expect(deferred(vi.fn().mockResolvedValue({ View: 'not a component' })).load()).rejects.toThrow('expected exports');
  });

  it('reads the failed module URL from the error message', () => {
    expect(failedModuleUrl(chromiumFailure(), ORIGIN)).toBe(CHUNK);
    expect(failedModuleUrl(new Error(`from ${ORIGIN}/a.js then ${CHUNK}`), ORIGIN)).toBe(CHUNK);
    expect(failedModuleUrl(new Error(`${CHUNK} then https://cdn.example/x.js`), ORIGIN)).toBe(CHUNK);
    expect(failedModuleUrl(chromiumFailure(), null)).toBeNull();
    expect(failedModuleUrl('not an error', ORIGIN)).toBeNull();
    expect(withRetryQuery(CHUNK, 3)).toBe(`${CHUNK}?retry=3`);
    expect(withRetryQuery(`${CHUNK}?retry=1&t=5`, 2)).toBe(`${CHUNK}?retry=2&t=5`);
  });
});

describe('a view loading a deferred module', () => {
  it('reports loading, then ready, and a later opening is ready at once with no new import', async () => {
    const pending = controlled();
    const importer = vi.fn(() => pending.promise);
    const module = deferred(importer);
    const states: DeferredState<Views>[] = [];
    const load = new DeferredLoad(module, (state) => states.push(state));
    expect(load.state()).toEqual({ status: 'loading' });
    load.start();
    pending.resolve(views);
    await flush();
    expect(states).toEqual([{ status: 'ready', value: views }]);
    expect(initialDeferredState(module)).toEqual({ status: 'ready', value: views });
    const again = new DeferredLoad(module, () => undefined);
    again.start();
    expect(again.state()).toEqual({ status: 'ready', value: views });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('reports a failure, and Try again imports again and shows the view', async () => {
    const importer = vi.fn().mockRejectedValueOnce(chromiumFailure()).mockResolvedValueOnce(views);
    const module = deferred(importer);
    const states: DeferredState<Views>[] = [];
    const load = new DeferredLoad(module, (state) => states.push(state));
    load.start();
    await flush();
    expect(states).toEqual([{ message: `Failed to fetch dynamically imported module: ${CHUNK}`, status: 'failed' }]);
    load.retry();
    expect(load.state()).toEqual({ status: 'loading' });
    await flush();
    expect(states.slice(1)).toEqual([{ status: 'loading' }, { status: 'ready', value: views }]);
    expect(importer).toHaveBeenCalledTimes(2);
    // Try again does nothing once the view is shown.
    load.retry();
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('says nothing after the view closed while the import was pending, and the code is kept for the next opening', async () => {
    const pending = controlled();
    const module = deferred(() => pending.promise);
    const onState = vi.fn();
    const load = new DeferredLoad(module, onState);
    load.start();
    load.dispose();
    pending.resolve(views);
    await flush();
    expect(onState).not.toHaveBeenCalled();
    expect(module.current()).toBe(views);
  });

  it('serves a new scope that replaced the view during the import with the same single import', async () => {
    const pending = controlled();
    const importer = vi.fn(() => pending.promise);
    const module = deferred(importer);
    const previousScope = vi.fn();
    const nextScope = vi.fn();
    const previous = new DeferredLoad(module, previousScope);
    previous.start();
    previous.dispose();
    const next = new DeferredLoad(module, nextScope);
    next.start();
    pending.resolve(views);
    await flush();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(previousScope).not.toHaveBeenCalled();
    expect(nextScope).toHaveBeenCalledExactlyOnceWith({ status: 'ready', value: views });
  });

  it('ignores Try again after the view closed', async () => {
    const importer = vi.fn().mockRejectedValue(new Error('offline'));
    const load = new DeferredLoad(deferred(importer), () => undefined);
    load.start();
    await flush();
    load.dispose();
    load.retry();
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
