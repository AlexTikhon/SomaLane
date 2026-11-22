import { afterEach, describe, expect, it } from 'vitest';

import { loadMapboxStylesheet, resetMapboxStylesheet } from './mapbox-runtime.js';

// The Mapbox stylesheet is loaded with the runtime the first time a map is created (ADR-0098). A small stand-in for the
// document: links appended to head, each firing its own load or error event.
type Listener = () => void;
class FakeLink {
  readonly dataset: Record<string, string> = {};
  href = '';
  readonly listeners = new Map<string, Listener>();
  rel = '';
  removed = false;
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, listener); }
  fire(type: 'error' | 'load') { this.listeners.get(type)?.(); }
  remove() { this.removed = true; }
}

function fakeDocument() {
  const links: FakeLink[] = [];
  const document = {
    createElement: () => new FakeLink(),
    head: { append: (link: FakeLink) => { links.push(link); } },
  } as unknown as Pick<Document, 'createElement' | 'head'>;
  return { document, links };
}

const HREF = '/assets/mapbox-gl-Ab12.css';

describe('the Mapbox stylesheet', () => {
  afterEach(() => resetMapboxStylesheet());

  it('is one stylesheet link for the page, resolved once it has loaded', async () => {
    const { document, links } = fakeDocument();
    const first = loadMapboxStylesheet(document, HREF);
    const second = loadMapboxStylesheet(document, HREF);
    expect(second).toBe(first);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ dataset: { mapboxStylesheet: '' }, href: HREF, rel: 'stylesheet' });
    let loaded = false;
    void first.then(() => { loaded = true; });
    await Promise.resolve();
    expect(loaded).toBe(false);
    links[0]!.fire('load');
    await expect(first).resolves.toBeUndefined();
    expect(loadMapboxStylesheet(document, HREF)).toBe(first);
    expect(links).toHaveLength(1);
  });

  it('removes a link that failed, so the next map creation fetches the stylesheet again', async () => {
    const { document, links } = fakeDocument();
    const failed = loadMapboxStylesheet(document, HREF);
    links[0]!.fire('error');
    await expect(failed).rejects.toThrow('The map stylesheet could not be loaded');
    expect(links[0]!.removed).toBe(true);
    const retried = loadMapboxStylesheet(document, HREF);
    expect(retried).not.toBe(failed);
    expect(links).toHaveLength(2);
    links[1]!.fire('load');
    await expect(retried).resolves.toBeUndefined();
  });
});
