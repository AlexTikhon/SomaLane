import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { DeferredModule, DeferredState } from './deferred-module.js';
import { DeferredView, DeferredViewContent, isSecondaryViews, secondaryViews } from './DeferredView.js';

const noop = () => undefined;

function content(state: DeferredState<string>, back?: { label: string; onBack: () => void }, onRetry = noop) {
  return DeferredViewContent<string>({ back, children: (value) => <p>View: {value}</p>, onRetry, state, what: 'the coach stream' });
}

/** Presses every button in a rendered element tree whose text is `label`. */
function press(node: unknown, label: string): void {
  if (Array.isArray(node)) return node.forEach((child) => press(child, label));
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const { props, type } = node as { props: { children?: unknown; onClick?: () => void }; type: unknown };
  if (type === 'button' && props.children === label) props.onClick?.();
  press(props.children, label);
}

describe('a deferred view', () => {
  it('says what is opening while its code loads, in a polite status, and nothing else of the view', () => {
    const markup = renderToStaticMarkup(content({ status: 'loading' }));
    expect(markup).toBe('<section aria-busy="true" class="deferred-view" data-deferred-view="loading"><p role="status">Opening the coach stream…</p></section>');
  });

  it('says that its code did not load, that navigation and a run are not affected, and offers Try again', () => {
    const markup = renderToStaticMarkup(content({ message: 'Failed to fetch dynamically imported module', status: 'failed' }));
    expect(markup).toContain('<p role="alert">The coach stream could not be opened: its code did not load. Navigation, and any run in progress, are not affected. Check the connection, then try again.</p>');
    expect(markup).toContain('<button type="button">Try again</button>');
    // The technical message is not shown to the person.
    expect(markup).not.toContain('Failed to fetch');
    const onRetry = vi.fn();
    press(content({ message: 'x', status: 'failed' }, undefined, onRetry), 'Try again');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers the way back while loading and after a failure, when the view has one', () => {
    const onBack = vi.fn();
    const back = { label: 'Back to Runner', onBack };
    expect(renderToStaticMarkup(content({ status: 'loading' }, back))).toContain('<button type="button">Back to Runner</button>');
    press(content({ message: 'x', status: 'failed' }, back), 'Back to Runner');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows the view itself once loaded', () => {
    expect(renderToStaticMarkup(content({ status: 'ready', value: 'loaded' }))).toBe('<p>View: loaded</p>');
  });

  it('renders a module that has already loaded at once, and does not import while rendering', () => {
    const load = vi.fn<() => Promise<string>>();
    const loaded: DeferredModule<string> = { current: () => 'loaded', load };
    const unloaded: DeferredModule<string> = { current: () => undefined, load };
    const render = (module: DeferredModule<string>) =>
      renderToStaticMarkup(<DeferredView module={module} what="the archive">{(value) => <p>{value}</p>}</DeferredView>);
    expect(render(loaded)).toBe('<p>loaded</p>');
    expect(render(unloaded)).toContain('Opening the archive…');
    expect(load).not.toHaveBeenCalled();
  });
});

describe('the secondary views chunk', () => {
  it('exports exactly the views App opens on demand', async () => {
    const module = await secondaryViews.load();
    expect(isSecondaryViews(module)).toBe(true);
    expect(Object.keys(module).sort()).toEqual(['ActivityScreen', 'ArchiveScreen', 'CoachScreen', 'DailyCheckInScreen', 'MealLogScreen', 'RunDetailScreen']);
    expect(isSecondaryViews({ ...module, CoachScreen: undefined })).toBe(false);
    expect(isSecondaryViews(null)).toBe(false);
  });
});
