/**
 * routeProgress.test.ts — unit tests for the route progress engine.
 *
 * Covers: snap-to-polyline, step index detection, off-route flag,
 * arrival detection, polyline splitting, and helper formatters.
 */

import { describe, it, expect } from 'vitest';
import {
  computeNavigationState,
  splitRouteAtSnap,
  maneuverIcon,
  formatRemainingTime,
  formatNavDistance,
} from './routeProgress';
import type { RouteData } from '../services/apiService';
import type { DevicePosition } from '../services/geolocation';

// --- Test fixtures -----------------------------------------------------------

/** A simple 3-segment L-shaped route:
 *  Start (0,0) → (0, 0.001) → (0.001, 0.001) → (0.002, 0.001)
 *  i.e. goes north, then turns east, then continues east.
 *  Each segment ≈ 111m, total ≈ 333m.
 */
function makeTestRoute(): RouteData {
  return {
    mode: 'foot',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0, 0.001],
        [0.001, 0.001],
        [0.002, 0.001],
      ],
    },
    distanceM: 333,
    durationS: 240,
    steps: [
      { instruction: 'Head north', maneuver: 'depart', distanceM: 111, durationS: 80 },
      { instruction: 'Turn right', maneuver: 'turn-right', distanceM: 111, durationS: 80 },
      { instruction: 'Continue east', maneuver: 'straight', distanceM: 111, durationS: 80 },
    ],
  };
}

function makePosition(lng: number, lat: number): DevicePosition {
  return {
    latitude: lat,
    longitude: lng,
    accuracyM: 5,
    recordedAt: new Date().toISOString(),
  };
}

// --- computeNavigationState --------------------------------------------------

describe('computeNavigationState', () => {
  it('returns null for empty route', () => {
    const route: RouteData = {
      mode: 'foot',
      geometry: { type: 'LineString', coordinates: [] },
      distanceM: 0,
      durationS: 0,
      steps: [],
    };
    const result = computeNavigationState(makePosition(0, 0), route);
    expect(result).toBeNull();
  });

  it('snaps user near the start of the route', () => {
    const route = makeTestRoute();
    // Position very close to the start (0, 0).
    const result = computeNavigationState(makePosition(0.00001, 0.00001), route);
    expect(result).not.toBeNull();
    expect(result!.currentStepIndex).toBe(0);
    expect(result!.progressFraction).toBeLessThan(0.1);
    expect(result!.isOffRoute).toBe(false);
    expect(result!.hasArrived).toBe(false);
  });

  it('detects user at the midpoint of the route', () => {
    const route = makeTestRoute();
    // Position near the turn point (0, 0.001).
    const result = computeNavigationState(makePosition(0, 0.001), route);
    expect(result).not.toBeNull();
    // Should be near the end of step 0 or the beginning of step 1.
    expect(result!.currentStepIndex).toBeLessThanOrEqual(1);
    expect(result!.progressFraction).toBeGreaterThan(0.2);
    expect(result!.progressFraction).toBeLessThan(0.5);
  });

  it('detects arrival near the destination', () => {
    const route = makeTestRoute();
    // Position very close to the end (0.002, 0.001).
    const result = computeNavigationState(makePosition(0.002, 0.001), route);
    expect(result).not.toBeNull();
    expect(result!.hasArrived).toBe(true);
    expect(result!.progressFraction).toBeGreaterThan(0.9);
  });

  it('flags off-route when user is far from the route', () => {
    const route = makeTestRoute();
    // Position far from any route segment (0.005, 0.005 ≈ 700m away).
    const result = computeNavigationState(makePosition(0.005, 0.005), route);
    expect(result).not.toBeNull();
    expect(result!.isOffRoute).toBe(true);
  });

  it('does not flag off-route when user is close to the route', () => {
    const route = makeTestRoute();
    // Position on the second segment (0.0005, 0.001) — on the route.
    const result = computeNavigationState(makePosition(0.0005, 0.001), route);
    expect(result).not.toBeNull();
    expect(result!.isOffRoute).toBe(false);
  });

  it('provides a valid bearing', () => {
    const route = makeTestRoute();
    const result = computeNavigationState(makePosition(0, 0.0005), route);
    expect(result).not.toBeNull();
    // On the first segment heading north, bearing should be near 0° (north).
    expect(result!.routeBearing).toBeGreaterThanOrEqual(0);
    expect(result!.routeBearing).toBeLessThan(360);
    // First segment is due north → bearing ≈ 0.
    expect(result!.routeBearing).toBeLessThan(5);
  });

  it('remaining distance decreases as user progresses', () => {
    const route = makeTestRoute();
    const startResult = computeNavigationState(makePosition(0, 0.0001), route);
    const midResult = computeNavigationState(makePosition(0.001, 0.001), route);
    expect(startResult).not.toBeNull();
    expect(midResult).not.toBeNull();
    expect(midResult!.remainingDistanceM).toBeLessThan(startResult!.remainingDistanceM);
  });
});

// --- splitRouteAtSnap --------------------------------------------------------

describe('splitRouteAtSnap', () => {
  it('splits the route at the first segment', () => {
    const coords: [number, number][] = [[0, 0], [1, 0], [2, 0]];
    const snap = { lng: 0.5, lat: 0 };
    const { traveled, remaining } = splitRouteAtSnap(coords, 0, snap);
    expect(traveled).toEqual([[0, 0], [0.5, 0]]);
    expect(remaining).toEqual([[0.5, 0], [1, 0], [2, 0]]);
  });

  it('splits the route at the second segment', () => {
    const coords: [number, number][] = [[0, 0], [1, 0], [2, 0]];
    const snap = { lng: 1.5, lat: 0 };
    const { traveled, remaining } = splitRouteAtSnap(coords, 1, snap);
    expect(traveled).toEqual([[0, 0], [1, 0], [1.5, 0]]);
    expect(remaining).toEqual([[1.5, 0], [2, 0]]);
  });

  it('handles snap at the start of the route', () => {
    const coords: [number, number][] = [[0, 0], [1, 0]];
    const snap = { lng: 0, lat: 0 };
    const { traveled, remaining } = splitRouteAtSnap(coords, 0, snap);
    expect(traveled).toEqual([[0, 0], [0, 0]]);
    expect(remaining).toEqual([[0, 0], [1, 0]]);
  });
});

// --- maneuverIcon ------------------------------------------------------------

describe('maneuverIcon', () => {
  it('maps turn left instructions', () => {
    expect(maneuverIcon('Turn left onto Main Street')).toBe('↰');
  });

  it('maps turn right instructions', () => {
    expect(maneuverIcon('Turn right at the intersection')).toBe('↱');
  });

  it('maps straight/continue as upward arrow', () => {
    expect(maneuverIcon('Continue straight')).toBe('↑');
  });

  it('maps departure', () => {
    expect(maneuverIcon('Head north on Road')).toBe('▶');
  });

  it('maps arrival', () => {
    expect(maneuverIcon('Arrive at destination')).toBe('⚑');
  });

  it('defaults to straight for unknown', () => {
    expect(maneuverIcon('Some unknown maneuver')).toBe('↑');
  });
});

// --- formatRemainingTime -----------------------------------------------------

describe('formatRemainingTime', () => {
  it('formats seconds under 1 minute as "1 min"', () => {
    expect(formatRemainingTime(30)).toBe('1 min');
  });

  it('formats 5 minutes', () => {
    expect(formatRemainingTime(300)).toBe('5 min');
  });

  it('formats 90 minutes as "1 hr 30 min"', () => {
    expect(formatRemainingTime(5400)).toBe('1 hr 30 min');
  });

  it('formats exactly 1 hour', () => {
    expect(formatRemainingTime(3600)).toBe('1 hr');
  });
});

// --- formatNavDistance --------------------------------------------------------

describe('formatNavDistance', () => {
  it('formats meters under 1km', () => {
    expect(formatNavDistance(350)).toBe('350m');
  });

  it('formats kilometers', () => {
    expect(formatNavDistance(1500)).toBe('1.5 km');
  });

  it('formats exactly 1km', () => {
    expect(formatNavDistance(1000)).toBe('1.0 km');
  });
});
