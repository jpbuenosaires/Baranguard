import { window, cleanup, settle, text } from '../harness/render.mjs';
import { maps } from '../harness/env.mjs';
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LiveMap, formatAge } from '../../src/components/LiveMap.js';
import { HeatmapMap } from '../../src/components/HeatmapMap.js';

afterEach(() => cleanup());
function container() {
  const el = window.document.createElement('div');
  window.document.getElementById('app').appendChild(el);
  return el;
}
const markerEls = () => maps.flatMap((m) => m.markers).map((m) => m.getElement());

describe('LiveMap', () => {
  test('starts centred on Pilar with navigation + OSM attribution controls', async () => {
    LiveMap(container());
    await settle();
    const [map] = maps;
    assert.deepEqual(map.options.center, [123.6667, 12.9186]);
    assert.equal(map.controls.length, 2, 'OSM tile policy requires the attribution control');
  });

  test('Tanods far apart render individually; close together they cluster', async () => {
    const live = LiveMap(container());
    await settle();
    live.setMarkers([
      { userId: 4, fullName: 'Jose Reyes', latitude: 12.95, longitude: 123.70, ageSeconds: 20, isStale: false },
      { userId: 5, fullName: 'Maria Dela Cruz', latitude: 12.88, longitude: 123.60, ageSeconds: 20, isStale: false },
    ]);
    await settle();
    assert.equal(markerEls().filter((el) => !el.className.includes('cluster')).length, 2);

    live.setMarkers([
      { userId: 4, fullName: 'Jose Reyes', latitude: 12.9180, longitude: 123.6670, ageSeconds: 20, isStale: false },
      { userId: 5, fullName: 'Maria Dela Cruz', latitude: 12.9181, longitude: 123.6671, ageSeconds: 20, isStale: false },
    ]);
    await settle();
    const clusters = markerEls().filter((el) => el.className.includes('cluster'));
    assert.equal(clusters.length, 1);
    assert.equal(text(clusters[0]), '2');
  });

  test('SOS markers are never clustered, even on top of a Tanod', async () => {
    const live = LiveMap(container());
    await settle();
    live.setMarkers([{ userId: 4, fullName: 'Jose', latitude: 12.918, longitude: 123.667, ageSeconds: 5, isStale: false }]);
    live.setSosMarkers([{ sosId: 91, latitude: 12.918, longitude: 123.667, status: 'active' }]);
    await settle();
    assert.equal(markerEls().filter((el) => el.className.includes('--sos')).length, 1);
  });

  test('a boundary set before the style loads is applied once it does', async () => {
    const live = LiveMap(container());
    live.setBoundary({ type: 'FeatureCollection', features: [] });
    await settle();
    assert.ok(maps[0].getSource('barangay-boundary'), 'boundary source never added after load');
  });

  test('destroy() removes the map', async () => {
    const live = LiveMap(container());
    await settle();
    live.destroy();
    assert.equal(maps[0].removed, true);
  });

  test('formatAge buckets seconds, minutes and hours', () => {
    assert.equal(formatAge(42), '42s ago');
    assert.equal(formatAge(60), '1m ago');
    assert.equal(formatAge(3599), '59m ago');
    assert.equal(formatAge(7200), '2h ago');
  });
});

describe('HeatmapMap', () => {
  test('points set before load become the heat source; later updates replace them', async () => {
    const heat = HeatmapMap(container());
    heat.setPoints([{ latitude: 12.92, longitude: 123.67, weight: 2 }]);
    await settle();
    const source = maps[0].getSource('incident-heat');
    assert.ok(source, 'heat source was never added');
    assert.deepEqual(source.data.features[0].geometry.coordinates, [123.67, 12.92], 'GeoJSON is [lng, lat], not [lat, lng]');
    heat.setPoints([]);
    assert.equal(maps[0].getSource('incident-heat').data.features.length, 0);
  });
});
