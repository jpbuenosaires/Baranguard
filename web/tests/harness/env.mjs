/**
 * env.mjs — one jsdom document per test FILE, installed onto globalThis
 * before any app module is imported.
 *
 * Why one per file and not one per test: several app modules bind
 * listeners to `document` at import time (DateRangePicker.js registers its
 * click/Escape handlers at module scope; AppShell.js keeps a module-scope
 * search host). A fresh document per test would leave those listeners
 * attached to a dead document. `node --test` already runs every file in
 * its own process, so files are isolated from each other; within a file,
 * `resetDom()` clears state between tests instead.
 *
 * Every browser API the app touches that jsdom lacks is stubbed here, so
 * a failure means the APP broke, not the harness.
 */

import { JSDOM, VirtualConsole } from 'jsdom';

export const API_BASE = 'http://api.test/api/v1';

/** Errors jsdom itself reports (e.g. "Not implemented: ..."), collected per test. */
export const jsdomErrors = [];

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => jsdomErrors.push(err));

const dom = new JSDOM(
  '<!doctype html><html lang="en" data-theme="light"><head><title>Baranguard</title></head><body><div id="app"></div></body></html>',
  { url: 'http://localhost/baranguard/web/', pretendToBeVisual: true, virtualConsole },
);

export const window = dom.window;
window.BARANGUARD_API_BASE_URL = API_BASE;

// --- Globals the app reads as bare identifiers ------------------------------

const WINDOW_GLOBALS = [
  'window', 'document', 'location', 'history', 'localStorage', 'sessionStorage',
  'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
  'HTMLAnchorElement', 'HTMLFormElement', 'HTMLImageElement', 'HTMLCanvasElement', 'SVGElement',
  'Element', 'Node', 'NodeList', 'Text', 'DocumentFragment', 'DOMParser', 'XMLSerializer',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent', 'SubmitEvent', 'UIEvent',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
  'FormData', 'File', 'FileReader', 'CSS',
];

for (const key of WINDOW_GLOBALS) {
  const value = key === 'window' ? window : window[key];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// Node 21+ ships its own global `navigator`; the app must see jsdom's.
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });

// --- Stubs for APIs jsdom does not implement ---------------------------------

/** Controls what `matchMedia(query).matches` returns, per test. */
export const mediaState = { 'prefers-color-scheme: dark': false, 'prefers-reduced-motion: reduce': false };
window.matchMedia = (query) => {
  const key = Object.keys(mediaState).find((k) => query.includes(k));
  return {
    matches: key ? mediaState[key] : false,
    media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  };
};

window.Element.prototype.scrollIntoView = function scrollIntoView() {};
window.Element.prototype.scrollTo = function scrollTo() {};
window.scrollTo = () => {};
window.print = () => { browserCalls.print += 1; };
window.open = (...args) => { browserCalls.open.push(args); return null; };

// Charts and map clustering read real layout sizes; jsdom reports 0x0,
// which turns every scale into a 0/0 NaN. Report a plausible box instead.
window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400, toJSON() { return this; } };
};

// A synthetic <a download> click would make jsdom attempt a navigation.
window.HTMLAnchorElement.prototype.click = function click() {
  browserCalls.downloads.push({ href: this.href, download: this.download });
};

/** Side effects the app asked the browser for, recorded instead of performed. */
export const browserCalls = { print: 0, open: [], downloads: [], clipboard: [], objectUrls: 0 };

Object.defineProperty(window.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text) => { browserCalls.clipboard.push(text); } },
});

/** `geolocation.mode`: 'deny' (default) or 'allow' with `coords`. */
export const geolocation = { mode: 'deny', coords: { latitude: 12.9186, longitude: 123.6667, accuracy: 12 } };
Object.defineProperty(window.navigator, 'geolocation', {
  configurable: true,
  value: {
    getCurrentPosition(success, error) {
      setTimeout(() => {
        if (geolocation.mode === 'allow') success({ coords: { ...geolocation.coords }, timestamp: Date.now() });
        else error?.({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1 });
      }, 0);
    },
    watchPosition() { return 1; },
    clearWatch() {},
  },
});

URL.createObjectURL = () => { browserCalls.objectUrls += 1; return 'blob:http://localhost/fake'; };
URL.revokeObjectURL = () => {};

// --- MapLibre GL (vendored as a global in index.html) -----------------------

/** Every map instance created, so tests can inspect sources/markers. */
export const maps = [];

class FakeLngLatBounds {
  constructor() { this.points = []; }
  extend(ll) { this.points.push(Array.isArray(ll) ? ll : [ll.lng, ll.lat]); return this; }
  isEmpty() { return this.points.length === 0; }
  getCenter() { const [lng, lat] = this.points[0] ?? [0, 0]; return { lng, lat }; }
}

class FakePopup {
  constructor(options = {}) { this.options = options; this.content = null; }
  setDOMContent(node) { this.content = node; return this; }
  setHTML(html) { this.content = html; return this; }
  setText(text) { this.content = text; return this; }
  setLngLat(ll) { this.lngLat = ll; return this; }
  addTo() { return this; }
  remove() { return this; }
  isOpen() { return false; }
}

class FakeMarker {
  constructor(options = {}) {
    this.element = options.element ?? window.document.createElement('div');
    this.popup = null;
  }
  setLngLat(ll) { this.lngLat = ll; return this; }
  setPopup(popup) { this.popup = popup; return this; }
  getPopup() { return this.popup; }
  togglePopup() { return this; }
  addTo(map) { this.map = map; map.container.appendChild(this.element); map.markers.push(this); return this; }
  getElement() { return this.element; }
  remove() { this.element.remove(); if (this.map) this.map.markers = this.map.markers.filter((m) => m !== this); return this; }
}

class FakeMap {
  constructor(options) {
    this.options = options;
    this.container = typeof options.container === 'string' ? window.document.getElementById(options.container) : options.container;
    this.handlers = {};
    this.sources = new Map();
    this.layers = new Map();
    this.controls = [];
    this.markers = [];
    this.removed = false;
    this.zoom = options.zoom ?? 13;
    this.center = options.center ?? [0, 0];
    maps.push(this);
    // Real MapLibre fires 'load' asynchronously once the style is ready.
    setTimeout(() => this.fire('load'), 0);
  }
  on(event, layerOrFn, maybeFn) {
    const fn = typeof layerOrFn === 'function' ? layerOrFn : maybeFn;
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  once(event, fn) { return this.on(event, fn); }
  off() { return this; }
  fire(event, data = {}) { for (const fn of this.handlers[event] ?? []) fn({ type: event, target: this, ...data }); }
  addControl(control, position) { this.controls.push({ control, position }); return this; }
  addSource(id, spec) {
    const source = { spec, data: spec.data, setData(data) { this.data = data; } };
    this.sources.set(id, source);
    return this;
  }
  getSource(id) { return this.sources.get(id); }
  removeSource(id) { this.sources.delete(id); return this; }
  addLayer(layer) { this.layers.set(layer.id, layer); return this; }
  getLayer(id) { return this.layers.get(id); }
  removeLayer(id) { this.layers.delete(id); return this; }
  setLayoutProperty() { return this; }
  setPaintProperty() { return this; }
  setFilter() { return this; }
  fitBounds(bounds) { this.lastFit = bounds; this.fire('moveend'); return this; }
  flyTo(options) { this.lastFly = options; return this; }
  easeTo(options) { this.lastFly = options; return this; }
  jumpTo(options) { this.lastFly = options; return this; }
  setCenter(center) { this.center = center; return this; }
  getCenter() { const [lng, lat] = this.center; return { lng, lat }; }
  setZoom(zoom) { this.zoom = zoom; return this; }
  getZoom() { return this.zoom; }
  zoomIn() { this.zoom += 1; return this; }
  zoomOut() { this.zoom -= 1; return this; }
  resize() { return this; }
  // Deterministic pseudo-projection so clustering maths gets real numbers.
  project(ll) {
    const [lng, lat] = Array.isArray(ll) ? ll : [ll.lng, ll.lat];
    return { x: (lng - 123) * 10000, y: (13 - lat) * 10000 };
  }
  getCanvas() { return window.document.createElement('canvas'); }
  getContainer() { return this.container; }
  loaded() { return true; }
  isStyleLoaded() { return true; }
  remove() { this.removed = true; }
}

window.maplibregl = {
  Map: FakeMap,
  Marker: FakeMarker,
  Popup: FakePopup,
  LngLatBounds: FakeLngLatBounds,
  NavigationControl: class NavigationControl { constructor(o) { this.options = o; } },
  AttributionControl: class AttributionControl { constructor(o) { this.options = o; } },
};
Object.defineProperty(globalThis, 'maplibregl', { value: window.maplibregl, configurable: true, writable: true });

/** Clears DOM + storage + recorded side effects between tests in one file. */
export function resetDom() {
  const { document } = window;
  document.documentElement.setAttribute('data-theme', 'light');
  document.head.querySelectorAll('meta,link,style').forEach((n) => n.remove());
  document.title = 'Baranguard';
  // Empty #app and the toast container rather than rebuilding <body>:
  // Toast.js holds its container as a module-level singleton for the page's
  // lifetime (the real app never wipes <body>), so detaching it would make
  // every later toast in this file invisible. Anything else parked on
  // <body> (dialog backdrops, stray download links) is transient — removed.
  for (const child of [...document.body.children]) {
    if (child.id === 'app' || child.classList.contains('toast-container')) child.replaceChildren();
    else child.remove();
  }
  if (!document.getElementById('app')) {
    const app = document.createElement('div');
    app.id = 'app';
    document.body.prepend(app);
  }
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
  try { window.localStorage.clear(); } catch { /* ignore */ }
  window.location.hash = '';
  mediaState['prefers-color-scheme: dark'] = false;
  mediaState['prefers-reduced-motion: reduce'] = false;
  geolocation.mode = 'deny';
  browserCalls.print = 0;
  browserCalls.open.length = 0;
  browserCalls.downloads.length = 0;
  browserCalls.clipboard.length = 0;
  browserCalls.objectUrls = 0;
  maps.length = 0;
  jsdomErrors.length = 0;
}
