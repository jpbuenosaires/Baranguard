/**
 * ActiveStepCard.tsx — Slim, top-anchored Navigation Banner (Google Maps style)
 * for live turn-by-turn guidance.
 *
 * Sits cleanly at the top of the map container without blocking the route
 * or user location. Compact (height ~56px), legible, and unobtrusive.
 */

import { useState } from 'react';
import { IonIcon } from '@ionic/react';
import { checkmarkCircleOutline, warningOutline, chevronDown, chevronUp } from 'ionicons/icons';
import type { NavigationState } from '../utils/routeProgress';
import { maneuverIcon, formatRemainingTime, formatNavDistance } from '../utils/routeProgress';
import type { RouteStep } from '../services/apiService';

interface Props {
  navState: NavigationState;
  steps: RouteStep[];
  mode: 'car' | 'foot';
  /** Called when user taps re-route when off-route. */
  onReroute: () => void;
}

const ActiveStepCard: React.FC<Props> = ({ navState, steps, mode, onReroute }) => {
  const [expanded, setExpanded] = useState(false);

  // --- Arrival state ---------------------------------------------------------
  if (navState.hasArrived) {
    return (
      <div className="nav-hud nav-hud--arrived">
        <div className="nav-hud__row">
          <div className="nav-hud__maneuver-icon" style={{ background: 'var(--tint-success-bg)', color: 'var(--color-success)' }}>
            <IonIcon icon={checkmarkCircleOutline} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nav-hud__instruction" style={{ color: 'var(--color-success)' }}>
              You have arrived
            </div>
            <div className="nav-hud__stats">Destination reached</div>
          </div>
        </div>
      </div>
    );
  }

  // --- Off-route state -------------------------------------------------------
  if (navState.isOffRoute) {
    return (
      <div className="nav-hud nav-hud--off-route">
        <div className="nav-hud__row">
          <div className="nav-hud__maneuver-icon" style={{ background: 'var(--tint-warning-bg)', color: 'var(--color-warning)' }}>
            <IonIcon icon={warningOutline} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nav-hud__instruction" style={{ color: 'var(--color-warning)' }}>
              Off route
            </div>
            <div className="nav-hud__stats">
              {formatNavDistance(navState.remainingDistanceM)} remaining
            </div>
          </div>
          <button
            type="button"
            onClick={onReroute}
            className="nav-toggle-btn nav-toggle-btn--start"
            style={{ fontSize: '0.75rem', padding: '4px 10px' }}
          >
            Re-route
          </button>
        </div>
      </div>
    );
  }

  // --- Normal guidance state -------------------------------------------------
  const currentStep = navState.currentStep;
  const icon = maneuverIcon(currentStep.instruction || currentStep.maneuver);
  const upcomingSteps = steps.slice(navState.currentStepIndex + 1, navState.currentStepIndex + 4);

  return (
    <div className="nav-hud">
      <div className="nav-hud__row">
        <div className="nav-hud__maneuver-icon">
          <span>{icon}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <span className="nav-hud__distance">
              {formatNavDistance(navState.distanceToNextTurnM)}
            </span>
            <span className="nav-hud__stats">
              · {formatRemainingTime(navState.remainingTimeS)} ({formatNavDistance(navState.remainingDistanceM)})
            </span>
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
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-primary)',
              fontSize: '1.1rem',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <IonIcon icon={expanded ? chevronUp : chevronDown} />
          </button>
        )}
      </div>

      {/* Thin progress bar */}
      <div className="nav-progress">
        <div className="nav-progress__fill" style={{ width: `${Math.round(navState.progressFraction * 100)}%` }} />
      </div>

      {/* Expandable upcoming step preview */}
      {expanded && upcomingSteps.length > 0 && (
        <div className="nav-upcoming">
          {upcomingSteps.map((step, idx) => (
            <div key={navState.currentStepIndex + 1 + idx} className="nav-upcoming__step">
              <span style={{ opacity: 0.7, width: '18px', textAlign: 'center', flexShrink: 0 }}>
                {maneuverIcon(step.instruction || step.maneuver)}
              </span>
              <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {step.instruction || `Continue on ${step.maneuver}`}
              </span>
              {step.distanceM > 0 && (
                <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, fontSize: '0.75rem' }}>
                  {formatNavDistance(step.distanceM)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ActiveStepCard;
