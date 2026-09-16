/**
 * routeProgress.ts — client-side route progress engine for live
 * turn-by-turn navigation (M6 Assignment Detail).
 *
 * Given the Tanod's current GPS position, the route geometry (GeoJSON
 * LineString coordinates), and the route steps from ORS, computes the
 * full navigation state: which step is active, distance to the next
 * maneuver, remaining distance/time, whether the user is off-route or
 * has arrived, and the bearing for heading-up map rotation.
 *
 * All math is pure haversine (reusing the same approach as geo.ts) —
 * runs entirely offline, no API calls, no external dependencies.
 */

import type { RouteData, RouteStep } from '../services/apiService';
import type { DevicePosition } from '../services/geolocation';

// --- Constants ---------------------------------------------------------------

/** If the user's GPS is further than this from the route, flag off-route. */
const OFF_ROUTE_THRESHOLD_M = 50;
/** If the user is within this distance of the final destination, flag arrived. */
const ARRIVAL_THRESHOLD_M = 30;

const EARTH_RADIUS_M = 6_371_000;

// --- Types -------------------------------------------------------------------

export interface NavigationState {
  /** Index of the current step the user is on (0-based into RouteData.steps). */
  currentStepIndex: number;
  /** The current step object itself, for convenience. */
  currentStep: RouteStep;
  /** Distance in meters from user to the next maneuver point (end of current step). */
  distanceToNextTurnM: number;
  /** Total remaining distance in meters along the route from the snapped point. */
  remainingDistanceM: number;
  /** Estimated remaining time in seconds. */
  remainingTimeS: number;
  /** User's position projected (snapped) onto the nearest point on the route polyline. */
  snappedPoint: { lng: number; lat: number };
  /** Forward bearing along the route at the snapped point (degrees, 0=north, clockwise). */
  routeBearing: number;
  /** True if user is > OFF_ROUTE_THRESHOLD_M from the route polyline. */
  isOffRoute: boolean;
  /** Fraction 0..1 of the route already traveled. */
  progressFraction: number;
  /** True if user is within ARRIVAL_THRESHOLD_M of the final destination. */
  hasArrived: boolean;
  /** The index of the coordinate on the route polyline closest to the snapped point. */
  snappedSegmentIndex: number;
}

// --- Haversine helpers (self-contained, mirrors geo.ts) ----------------------

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Haversine distance between two [lng, lat] points, in meters. */
function haversineM(
  lng1: number, lat1: number,
  lng2: number, lat2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing from (lng1,lat1) to (lng2,lat2) in degrees [0, 360). */
function bearingDeg(
  lng1: number, lat1: number,
  lng2: number, lat2: number,
): number {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// --- Snap to polyline --------------------------------------------------------

interface SnapResult {
  /** The nearest point on the polyline. */
  point: { lng: number; lat: number };
  /** Index of the segment start (coords[segmentIndex] → coords[segmentIndex+1]). */
  segmentIndex: number;
  /** Fractional position within the segment [0, 1]. */
  segmentFraction: number;
  /** Distance from the user's raw GPS to the snapped point, in meters. */
  perpendicularDistM: number;
}

/**
 * Projects `userLng, userLat` onto the nearest point on the polyline
 * defined by `coords` (array of [lng, lat]).
 *
 * Uses a flat-earth approximation for the perpendicular projection
 * (accurate enough at barangay scale — sub-meter error for segments
 * under ~5 km, which ORS routing steps always are).
 */
function snapToPolyline(
  userLng: number,
  userLat: number,
  coords: [number, number][],
): SnapResult {
  let bestDist = Infinity;
  let bestSnap: SnapResult = {
    point: { lng: coords[0][0], lat: coords[0][1] },
    segmentIndex: 0,
    segmentFraction: 0,
    perpendicularDistM: haversineM(userLng, userLat, coords[0][0], coords[0][1]),
  };

  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i];     // segment start [lng, lat]
    const [bx, by] = coords[i + 1]; // segment end

    // Flat-earth projection: scale longitude by cos(latitude).
    const cosLat = Math.cos(toRad((ay + by) / 2));
    const uX = (userLng - ax) * cosLat;
    const uY = userLat - ay;
    const sX = (bx - ax) * cosLat;
    const sY = by - ay;

    const segLenSq = sX * sX + sY * sY;
    let t: number;
    if (segLenSq < 1e-14) {
      // Degenerate segment (zero length).
      t = 0;
    } else {
      t = Math.max(0, Math.min(1, (uX * sX + uY * sY) / segLenSq));
    }

    const snapLng = ax + t * (bx - ax);
    const snapLat = ay + t * (by - ay);
    const dist = haversineM(userLng, userLat, snapLng, snapLat);

    if (dist < bestDist) {
      bestDist = dist;
      bestSnap = {
        point: { lng: snapLng, lat: snapLat },
        segmentIndex: i,
        segmentFraction: t,
        perpendicularDistM: dist,
      };
    }
  }

  return bestSnap;
}

// --- Cumulative segment distances --------------------------------------------

/**
 * Precomputes cumulative distances along the polyline: result[i] is the
 * distance from coords[0] to coords[i].
 */
function cumulativeDistances(coords: [number, number][]): number[] {
  const dists = new Array<number>(coords.length);
  dists[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    dists[i] = dists[i - 1] + haversineM(
      coords[i - 1][0], coords[i - 1][1],
      coords[i][0], coords[i][1],
    );
  }
  return dists;
}

// --- Step ↔ coordinate mapping -----------------------------------------------

/**
 * Maps each RouteStep to a cumulative-distance range on the polyline so
 * we can determine which step a snapped point falls into.
 *
 * ORS returns per-step `distance_m` values. We build running-sum
 * boundaries: step i covers [boundaries[i], boundaries[i+1]) of the
 * total route distance.
 */
function stepBoundaries(steps: RouteStep[]): number[] {
  const boundaries: number[] = [0];
  let cum = 0;
  for (const step of steps) {
    cum += step.distanceM;
    boundaries.push(cum);
  }
  return boundaries;
}

// --- Main computation --------------------------------------------------------

/**
 * Computes the full navigation state from the user's current GPS and the
 * cached route. Pure function, no side effects, safe to call on every
 * position update (≈ every 1-3s).
 *
 * Returns `null` if the route has no geometry or no steps (shouldn't
 * happen with a valid ORS response, but defensive).
 */
export function computeNavigationState(
  position: DevicePosition,
  route: RouteData,
): NavigationState | null {
  const coords = route.geometry?.coordinates;
  if (!coords || coords.length < 2 || route.steps.length === 0) return null;

  // 1. Snap user position to the polyline.
  const snap = snapToPolyline(position.longitude, position.latitude, coords);

  // 2. Cumulative distances along the polyline.
  const cumDist = cumulativeDistances(coords);
  const totalPolylineLength = cumDist[cumDist.length - 1];

  // Distance traveled along the polyline up to the snap point.
  const segStart = cumDist[snap.segmentIndex];
  const segEnd = cumDist[snap.segmentIndex + 1];
  const segLength = segEnd - segStart;
  const distanceTraveled = segStart + snap.segmentFraction * segLength;

  // 3. Remaining distance = total polyline length − distance traveled.
  const remainingDistanceM = Math.max(0, totalPolylineLength - distanceTraveled);

  // 4. Progress fraction.
  const progressFraction = totalPolylineLength > 0
    ? Math.min(1, distanceTraveled / totalPolylineLength)
    : 0;

  // 5. Remaining time — proportional to remaining distance.
  //    Uses the route's total duration scaled by the fraction remaining.
  const remainingTimeS = route.durationS > 0 && totalPolylineLength > 0
    ? route.durationS * (remainingDistanceM / totalPolylineLength)
    : 0;

  // 6. Determine which step the snapped point falls into.
  //    Step boundaries are cumulative sums of step.distanceM values.
  const boundaries = stepBoundaries(route.steps);
  // ORS's total step distances may not perfectly match the polyline
  // length — normalize distanceTraveled into "step space".
  const totalStepDist = boundaries[boundaries.length - 1];
  const stepSpaceTraveled = totalStepDist > 0
    ? (distanceTraveled / totalPolylineLength) * totalStepDist
    : 0;

  let currentStepIndex = 0;
  for (let i = 0; i < route.steps.length; i++) {
    if (stepSpaceTraveled < boundaries[i + 1]) {
      currentStepIndex = i;
      break;
    }
    // If past all boundaries, clamp to last step.
    currentStepIndex = route.steps.length - 1;
  }

  // 7. Distance to the next maneuver = distance to the end of the current step.
  const distanceToNextTurnM = Math.max(0, boundaries[currentStepIndex + 1] - stepSpaceTraveled);

  // 8. Forward bearing along the route at the snap point.
  //    Use the segment the snap is on (or the next segment if at a vertex).
  const bearingIdx = Math.min(snap.segmentIndex, coords.length - 2);
  const routeBearing = bearingDeg(
    coords[bearingIdx][0], coords[bearingIdx][1],
    coords[bearingIdx + 1][0], coords[bearingIdx + 1][1],
  );

  // 9. Off-route check.
  const isOffRoute = snap.perpendicularDistM > OFF_ROUTE_THRESHOLD_M;

  // 10. Arrival check — haversine from user to the final coordinate.
  const dest = coords[coords.length - 1];
  const distToDest = haversineM(position.longitude, position.latitude, dest[0], dest[1]);
  const hasArrived = distToDest < ARRIVAL_THRESHOLD_M;

  return {
    currentStepIndex,
    currentStep: route.steps[currentStepIndex],
    distanceToNextTurnM,
    remainingDistanceM,
    remainingTimeS,
    snappedPoint: snap.point,
    routeBearing,
    isOffRoute,
    progressFraction,
    hasArrived,
    snappedSegmentIndex: snap.segmentIndex,
  };
}

// --- Polyline splitting (for traveled/remaining map layers) -------------------

/**
 * Splits the route polyline at the snapped point into two coordinate
 * arrays: "traveled" (behind the user) and "remaining" (ahead). Used by
 * LiveMapCanvas to render the traveled portion in gray and the remaining
 * in blue.
 */
export function splitRouteAtSnap(
  coords: [number, number][],
  segmentIndex: number,
  snappedPoint: { lng: number; lat: number },
): { traveled: [number, number][]; remaining: [number, number][] } {
  const snapCoord: [number, number] = [snappedPoint.lng, snappedPoint.lat];

  // Traveled: coords[0..segmentIndex] + snapped point.
  const traveled: [number, number][] = [];
  for (let i = 0; i <= segmentIndex; i++) {
    traveled.push(coords[i]);
  }
  traveled.push(snapCoord);

  // Remaining: snapped point + coords[segmentIndex+1..end].
  const remaining: [number, number][] = [snapCoord];
  for (let i = segmentIndex + 1; i < coords.length; i++) {
    remaining.push(coords[i]);
  }

  return { traveled, remaining };
}

// --- Maneuver icon mapping ---------------------------------------------------

/** Maps ORS instruction text patterns to Unicode arrow characters for the HUD. */
export function maneuverIcon(instruction: string): string {
  const lower = instruction.toLowerCase();
  if (lower.includes('turn left') || lower.includes('bear left')) return '↰';
  if (lower.includes('turn right') || lower.includes('bear right')) return '↱';
  if (lower.includes('sharp left')) return '↰';
  if (lower.includes('sharp right')) return '↱';
  if (lower.includes('slight left')) return '↖';
  if (lower.includes('slight right')) return '↗';
  if (lower.includes('u-turn')) return '↩';
  if (lower.includes('roundabout')) return '↻';
  if (lower.includes('arrive') || lower.includes('destination')) return '⚑';
  if (lower.includes('depart') || lower.includes('start') || lower.includes('head')) return '▶';
  // Default: straight ahead.
  return '↑';
}

/** Formats remaining time as "X min" or "X hr Y min". */
export function formatRemainingTime(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${Math.max(1, totalMin)} min`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr} hr ${min} min` : `${hr} hr`;
}

/** Formats distance: "350m" under 1km, "1.4 km" at or above. */
export function formatNavDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
