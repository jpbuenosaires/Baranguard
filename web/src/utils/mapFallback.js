/**
 * mapFallback.js - graceful, honest degradation when the basemap tiles
 * cannot be fetched (internet down; this dashboard is served from a local
 * workstation and must stay usable offline).
 *
 * The basemap is a third-party OpenStreetMap raster source. Everything the
 * operator actually needs (markers, responder positions, heatmap, routes)
 * is drawn locally on top of a plain background layer, so a missing
 * basemap only costs the street picture. This helper watches the map for
 * failed raster tile requests (MapLibre 'error' events carrying the raster
 * source id) and for navigator.onLine going false, and shows ONE small
 * notice on the map until a tile loads again. It never touches the data
 * layers and never retries on its own: panning/zooming re-requests tiles
 * and the first success clears the notice.
 */

export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const BASEMAP_OFFLINE_MESSAGE = 'Basemap unavailable (offline) - positions and markers are still live';

/**
 * @param {object} map MapLibre map instance
 * @param {string} rasterSourceId id of the raster basemap source in the style
 * @param {HTMLElement} [container] element to host the notice (defaults to map.getContainer())
 * @returns {() => void} detach function (removes listeners and the notice)
 */
export function attachBasemapFallback(map, rasterSourceId, container) {
  const host = container ?? (typeof map.getContainer === 'function' ? map.getContainer() : null);
  if (!host) return () => {};
  const doc = host.ownerDocument;
  const win = doc.defaultView;

  let notice = null;
  let detached = false;

  function show() {
    if (detached || notice) return;
    notice = doc.createElement('div');
    notice.className = 'map-basemap-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = BASEMAP_OFFLINE_MESSAGE;
    host.appendChild(notice);
  }
  function hide() {
    if (!notice) return;
    notice.remove();
    notice = null;
  }

  const onError = (e) => {
    // Only the basemap raster source. Errors from data sources, style
    // parsing etc. are not "tiles unavailable" and must not claim so.
    if (e && e.sourceId === rasterSourceId) show();
  };
  const onSourceData = (e) => {
    // A raster tile arrived: the basemap is reachable again.
    if (e && e.sourceId === rasterSourceId && e.tile) hide();
  };
  const onOffline = () => show();

  map.on('error', onError);
  map.on('sourcedata', onSourceData);
  win?.addEventListener('offline', onOffline);
  if (win && win.navigator && win.navigator.onLine === false) show();

  return function detach() {
    detached = true;
    hide();
    if (typeof map.off === 'function') {
      map.off('error', onError);
      map.off('sourcedata', onSourceData);
    }
    win?.removeEventListener('offline', onOffline);
  };
}
