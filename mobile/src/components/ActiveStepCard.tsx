/**
 * ActiveStepCard.tsx — High-Contrast Tactical Navigation Banner (Google Maps / Waze style)
 * for live turn-by-turn guidance.
 *
 * Docks flush at the top of the tactical viewport with automotive-grade legibility,
 * crisp vector maneuver icons, distance metrics, and expandable upcoming turns.
 */

import React, { useState } from 'react';
import { IonIcon } from '@ionic/react';
import {
  arrowBack,
  arrowForward,
  arrowUp,
  checkmarkCircle,
  chevronDown,
  chevronUp,
  flag,
  navigate,
  refresh,
  returnDownBack,
  warning,
} from 'ionicons/icons';
import type { NavigationState } from '../utils/routeProgress';
import { formatNavDistance } from '../utils/routeProgress';
import type { RouteStep } from '../services/apiService';

interface Props {
  navState: NavigationState;
  steps: RouteStep[];
  mode: 'car' | 'foot';
  /** Called when user taps re-route when off-route. */
  onReroute: () => void;
}

/** Resolves an IonIcon for the maneuver instruction */
function getManeuverIonIcon(instruction?: string | null): string {
  const lower = (instruction || '').toLowerCase();
  if (lower.includes('turn left') || lower.includes('bear left') || lower.includes('sharp left')) return arrowBack;
  if (lower.includes('turn right') || lower.includes('bear right') || lower.includes('sharp right')) return arrowForward;
  if (lower.includes('u-turn')) return returnDownBack;
  if (lower.includes('roundabout')) return refresh;
  if (lower.includes('arrive') || lower.includes('destination')) return flag;
  if (lower.includes('head') || lower.includes('depart') || lower.includes('start')) return navigate;
  return arrowUp;
}

const ActiveStepCard: React.FC<Props> = ({ navState, steps, onReroute }) => {
  const [expanded, setExpanded] = useState(false);

  if (!navState || !navState.currentStep) {
    return null;
  }

  // --- Arrival state ---------------------------------------------------------
  if (navState.hasArrived) {
    return (
      <div className="nav-hud nav-hud--tactical nav-hud--arrived p4d-hud p4d-hud--ok" role="status">
        <div className="nav-hud__row">
          <div className="nav-hud__maneuver-icon p4d-hud__icon">
            <IonIcon icon={checkmarkCircle} aria-hidden="true" />
          </div>
          <div className="p4d-hud__text">
            <div className="nav-hud__instruction p4d-hud__title">Destination reached</div>
            <div className="nav-hud__stats p4d-hud__sub">Tap "Mark Arrived" to advance your status</div>
          </div>
        </div>
      </div>
    );
  }

  // --- Off-route state -------------------------------------------------------
  if (navState.isOffRoute) {
    return (
      <div className="nav-hud nav-hud--tactical nav-hud--off-route p4d-hud p4d-hud--warn" role="status">
        <div className="nav-hud__row">
          <div className="nav-hud__maneuver-icon p4d-hud__icon">
            <IonIcon icon={warning} aria-hidden="true" />
          </div>
          <div className="p4d-hud__text">
            <div className="nav-hud__instruction p4d-hud__title">Off route</div>
            <div className="nav-hud__stats p4d-hud__sub">{formatNavDistance(navState.remainingDistanceM)} remaining</div>
          </div>
          <button type="button" onClick={onReroute} className="p4d-hud__reroute">
            <IonIcon icon={refresh} aria-hidden="true" />
            <span>Re-route</span>
          </button>
        </div>
      </div>
    );
  }

  // --- Normal guidance state -------------------------------------------------
  const currentStep = navState.currentStep;
  const icon = getManeuverIonIcon(currentStep.instruction || currentStep.maneuver);
  const upcomingSteps = steps.slice(navState.currentStepIndex + 1, navState.currentStepIndex + 4);

  return (
    <div className="nav-hud nav-hud--tactical">
      <div className="nav-hud__row">
        <div className="nav-hud__maneuver-icon">
          <IonIcon icon={icon} />
        </div>
        <div className="p4d-hud__text">
          <div className="nav-hud__distance">
            {formatNavDistance(navState.distanceToNextTurnM)}
          </div>
          <div className="nav-hud__instruction" title={currentStep.instruction}>
            {currentStep.instruction || `Continue on ${currentStep.maneuver}`}
          </div>
        </div>

        {upcomingSteps.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label="Toggle upcoming steps"
            aria-expanded={expanded}
            className="nav-hud__expand-btn"
          >
            <IonIcon icon={expanded ? chevronUp : chevronDown} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Route Progress Bar */}
      <div className="nav-progress">
        <div
          className="nav-progress__fill"
          style={{ width: `${Math.min(100, Math.max(0, Math.round(navState.progressFraction * 100)))}%` }}
        />
      </div>

      {/* Expandable Upcoming Step Preview */}
      {expanded && upcomingSteps.length > 0 && (
        <div className="p4d-hud__upcoming">
          {upcomingSteps.map((step, idx) => (
            <div key={navState.currentStepIndex + 1 + idx} className="p4d-hud__step">
              <IonIcon icon={getManeuverIonIcon(step.instruction || step.maneuver)} aria-hidden="true" />
              <span className="p4d-hud__step-text">{step.instruction || `Continue on ${step.maneuver}`}</span>
              {step.distanceM > 0 && <span className="p4d-hud__step-dist">{formatNavDistance(step.distanceM)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ActiveStepCard;
