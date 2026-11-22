import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
// The Mapbox stylesheet is not imported here: mapbox-runtime.js loads it with the map runtime (ADR-0098).
import './styles.css';

const root = document.querySelector<HTMLDivElement>('#root');

if (!root) {
  throw new Error('Root element was not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
