import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { SNAPSHOT_FILE } from './showcase-state.js';
import { ShowcaseApp } from './ShowcaseApp.js';
// The application's own styles, so the reused content blocks look as they do in the app, plus the showcase frame.
import '../styles.css';
import './showcase.css';

// The entry of the public read-only showcase (ADR-0099), built by `npm run build:showcase` into its own output. It is not
// reachable from the application's entry (src/main.tsx), so none of this code or data is in the application's bundle.

const root = document.querySelector<HTMLDivElement>('#root');
if (!root) throw new Error('Root element was not found');

createRoot(root).render(
  <StrictMode>
    <ShowcaseApp snapshotUrl={new URL(SNAPSHOT_FILE, document.baseURI).href} />
  </StrictMode>,
);
