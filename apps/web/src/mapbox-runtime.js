// The Mapbox GL runtime and its stylesheet, both loaded the first time a map is created (release step 4, ADR-0098):
// neither is part of the first page. `?url` emits the stylesheet as a file and gives only its URL here.
import mapboxStylesheetUrl from 'mapbox-gl/dist/mapbox-gl.css?url';

export const MAPBOX_BASE_STYLE = 'mapbox://styles/mapbox/dark-v11';

let stylesheet = null;

// One <link> for the page, appended once and resolved when it has loaded, so a map is never constructed without its
// controls' styles. A link that fails is removed and forgotten, so the next map creation fetches it again.
export function loadMapboxStylesheet(document = globalThis.document, href = mapboxStylesheetUrl) {
  if (stylesheet !== null) return stylesheet;
  const loading = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.mapboxStylesheet = '';
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => {
      link.remove();
      if (stylesheet === loading) stylesheet = null;
      reject(new Error('The map stylesheet could not be loaded'));
    }, { once: true });
    document.head.append(link);
  });
  stylesheet = loading;
  return loading;
}

/** Test seam: forget the page's stylesheet promise. */
export function resetMapboxStylesheet() {
  stylesheet = null;
}

export async function loadMapbox() {
  const [runtime] = await Promise.all([import('mapbox-gl'), loadMapboxStylesheet()]);
  return runtime;
}
