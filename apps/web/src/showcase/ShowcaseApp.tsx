import type { ShowcaseSnapshot } from '@running-tracker/contracts/showcase';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { initialShowcaseState, loadShowcaseSnapshot, showcaseReducer, type ShowcaseAction, type ShowcaseState, type SnapshotLoad } from './showcase-state.js';
import { ShowcaseFrame, ShowcaseLoadState, ShowcaseMeals, ShowcaseReview, ShowcaseToday, ShowcaseTrends } from './ShowcaseViews.js';

// The root of the public read-only showcase (ADR-0099). It loads ONE static file, the snapshot next to the page, and
// keeps the navigation in memory. It creates no session, reader, controller, mutation, IndexedDB database, capture or
// writer lease, and it writes no browser storage: a reload starts again on the sample date.

const HEADING_OF: Record<ShowcaseState['view'], string> = { meals: 'meals-title', review: 'review-title', today: 'today-title', trends: 'trends-title' };

function ShowcaseViews({ snapshot }: { snapshot: ShowcaseSnapshot }) {
  const [state, dispatch] = useReducer(
    (current: ShowcaseState, action: ShowcaseAction) => showcaseReducer(snapshot, current, action),
    snapshot,
    initialShowcaseState,
  );
  // A view change (not the first render) moves focus to the new view's heading, as the application's views do.
  useEffect(() => {
    if (state.focusKey > 0) document.getElementById(HEADING_OF[state.view])?.focus();
  }, [state.focusKey, state.view]);
  const props = { dispatch, snapshot, state };
  return (
    <ShowcaseFrame dispatch={dispatch} snapshot={snapshot} view={state.view}>
      {state.view === 'today' && <ShowcaseToday {...props} />}
      {state.view === 'review' && <ShowcaseReview {...props} />}
      {state.view === 'trends' && <ShowcaseTrends {...props} />}
      {state.view === 'meals' && <ShowcaseMeals {...props} />}
    </ShowcaseFrame>
  );
}

export interface ShowcaseAppProps {
  /** The snapshot file's URL, resolved against the page. */
  snapshotUrl: string;
  fetchFile?: typeof fetch;
}

export function ShowcaseApp({ fetchFile = fetch.bind(globalThis), snapshotUrl }: ShowcaseAppProps) {
  const [load, setLoad] = useState<SnapshotLoad>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const fetchRef = useRef(fetchFile);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: 'loading' });
    void loadShowcaseSnapshot(snapshotUrl, fetchRef.current, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLoad(result);
    });
    return () => controller.abort();
  }, [attempt, snapshotUrl]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (load.kind !== 'ready') {
    return (
      <ShowcaseFrame snapshot={null} view={null}>
        <ShowcaseLoadState load={load} onRetry={retry} />
      </ShowcaseFrame>
    );
  }
  return <ShowcaseViews snapshot={load.snapshot} />;
}
