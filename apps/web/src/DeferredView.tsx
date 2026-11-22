import { useEffect, useState, type ReactNode } from 'react';

import { DeferredLoad, deferredModule, initialDeferredState, type DeferredModule, type DeferredState } from './deferred-module.js';
import type * as SecondaryViews from './secondary-views.js';

export type SecondaryViewsModule = typeof SecondaryViews;

const secondaryViewNames = [
  'ActivityScreen',
  'ArchiveScreen',
  'CoachScreen',
  'DailyCheckInScreen',
  'MealLogScreen',
  'RunDetailScreen',
] as const satisfies ReadonlyArray<keyof SecondaryViewsModule>;

export function isSecondaryViews(value: unknown): value is SecondaryViewsModule {
  return typeof value === 'object' && value !== null
    && secondaryViewNames.every((name) => typeof (value as Record<string, unknown>)[name] === 'function');
}

/** The secondary views' chunk (secondary-views.ts), imported the first time one of them opens. */
export const secondaryViews: DeferredModule<SecondaryViewsModule> = deferredModule({
  accept: isSecondaryViews,
  importer: () => import('./secondary-views.js'),
});

interface DeferredViewProps<T> {
  /** A way back offered while the view cannot be shown (Runner's result: "Back to Runner"). */
  readonly back?: { readonly label: string; readonly onBack: () => void };
  readonly children: (loaded: T) => ReactNode;
  readonly module: DeferredModule<T>;
  /** What is being opened, in a sentence: "the coach stream". */
  readonly what: string;
}

/**
 * Shows a view from a deferred module. Only the view's own area changes while its code loads or fails: navigation, the
 * Run status and everything App owns (session, run recovery, capture, uploads, writer lease) are outside it and never
 * wait for it. Nothing here navigates or reloads the page.
 */
export function DeferredView<T>({ back, children, module, what }: DeferredViewProps<T>) {
  // Ready at once when the module has already loaded, so a second opening shows no loading state.
  const [load, setLoad] = useState<{ load: DeferredLoad<T> | null; state: DeferredState<T> }>(() => ({
    load: null,
    state: initialDeferredState(module),
  }));
  useEffect(() => {
    const current = new DeferredLoad(module, (state) => setLoad({ load: current, state }));
    setLoad({ load: current, state: current.state() });
    current.start();
    return () => current.dispose();
  }, [module]);
  return (
    <DeferredViewContent back={back} onRetry={() => load.load?.retry()} state={load.state} what={what}>
      {children}
    </DeferredViewContent>
  );
}

interface DeferredViewContentProps<T> {
  readonly back?: DeferredViewProps<T>['back'];
  readonly children: (loaded: T) => ReactNode;
  readonly onRetry: () => void;
  readonly state: DeferredState<T>;
  readonly what: string;
}

export function DeferredViewContent<T>({ back, children, onRetry, state, what }: DeferredViewContentProps<T>) {
  if (state.status === 'ready') return <>{children(state.value)}</>;
  const backButton = back === undefined ? null : <button onClick={back.onBack} type="button">{back.label}</button>;
  if (state.status === 'loading') {
    return (
      <section aria-busy="true" className="deferred-view" data-deferred-view="loading">
        <p role="status">Opening {what}…</p>
        {backButton}
      </section>
    );
  }
  return (
    <section className="deferred-view deferred-view--failed" data-deferred-view="failed">
      <p role="alert">
        {what.charAt(0).toUpperCase() + what.slice(1)} could not be opened: its code did not load. Navigation, and any run
        in progress, are not affected. Check the connection, then try again.
      </p>
      <div className="deferred-view__actions">
        <button onClick={onRetry} type="button">Try again</button>
        {backButton}
      </div>
    </section>
  );
}
