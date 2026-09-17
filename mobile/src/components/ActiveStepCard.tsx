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
import { formatRemainingTime, formatNavDistance } from '../utils/routeProgress';
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
      <div className="nav-hud nav-hud--tactical nav-hud--arrived" style={{ borderColor: 'var(--color-success)' }}>
        <div className="nav-hud__row">
          <div
            className="nav-hud__maneuver-icon"
            style={{
              background: 'rgba(16, 185, 129, 0.25)',
              borderColor: 'rgba(16, 185, 129, 0.6)',
              color: '#34d399',
            }}
          >
            <IonIcon icon={checkmarkCircle} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nav-hud__instruction" style={{ color: '#34d399', fontSize: '1rem' }}>
              Destination Reached
            </div>
            <div className="nav-hud__stats" style={{ color: '#a7f3d0' }}>
              Tap "Mark Arrived" to advance your status
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Off-route state -------------------------------------------------------
  if (navState.isOffRoute) {
    return (
      <div className="nav-hud nav-hud--tactical nav-hud--off-route" style={{ borderColor: 'var(--color-warning)' }}>
        <div className="nav-hud__row">
          <div
            className="nav-hud__maneuver-icon"
            style={{
              background: 'rgba(245, 158, 11, 0.25)',
              borderColor: 'rgba(245, 158, 11, 0.6)',
              color: '#fbbf24',
            }}
          >
            <IonIcon icon={warning} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="nav-hud__instruction" style={{ color: '#fbbf24', fontSize: '0.95rem' }}>
              Off Route
            </div>
            <div className="nav-hud__stats" style={{ color: '#fde68a' }}>
              {formatNavDistance(navState.remainingDistanceM)} remaining
            </div>
          </div>
          <button
            type="button"
            onClick={onReroute}
            style={{
              background: '#f59e0b',
              color: '#000000',
              border: 'none',
              borderRadius: '999px',
              fontWeight: 800,
              fontSize: '0.75rem',
              padding: '6px 12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <IonIcon icon={refresh} />
            Re-route
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
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
              background: 'rgba(255, 255, 255, 0.12)',
              border: 'none',
              borderRadius: '50%',
              width: '32px',
              height: '32px',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <IonIcon icon={expanded ? chevronUp : chevronDown} style={{ fontSize: '1.2rem' }} />
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
        <div
          style={{
            marginTop: '10px',
            paddingTop: '8px',
            borderTop: '1px solid rgba(255, 255, 255, 0.12)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            maxHeight: '140px',
            overflowY: 'auto',
          }}
        >
          {upcomingSteps.map((step, idx) => (
            <div
              key={navState.currentStepIndex + 1 + idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.78rem',
                color: '#cbd5e1',
                padding: '3px 0',
              }}
            >
              <IonIcon
                icon={getManeuverIonIcon(step.instruction || step.maneuver)}
                style={{ opacity: 0.8, fontSize: '0.9rem', flexShrink: 0, color: '#60a5fa' }}
              />
              <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {step.instruction || `Continue on ${step.maneuver}`}
              </span>
              {step.distanceM > 0 && (
                <span style={{ color: '#94a3b8', fontSize: '0.72rem', flexShrink: 0 }}>
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
