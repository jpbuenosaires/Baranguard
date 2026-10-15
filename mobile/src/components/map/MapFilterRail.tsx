import React from 'react';
import { IonIcon } from '@ionic/react';
import {
  alertCircleOutline,
  flameOutline,
  layersOutline,
  optionsOutline,
  shieldCheckmarkOutline,
} from 'ionicons/icons';
import tacticalFeedback from '../../utils/tacticalFeedback';
import type { QuickFilterTab } from '../../utils/mapFilters';

interface Props {
  quickFilter: QuickFilterTab;
  incidentCount: number;
  tanodCount: number;
  criticalCount: number;
  isFilterActive: boolean;
  onSelectAll: () => void;
  onSelectTab: (tab: QuickFilterTab) => void;
  onOpenAdvanced: () => void;
}

/**
 * Filter rail: each toggle shows icon, count and a short text label so the
 * meaning never depends on the icon alone.
 */
const MapFilterRail: React.FC<Props> = ({
  quickFilter,
  incidentCount,
  tanodCount,
  criticalCount,
  isFilterActive,
  onSelectAll,
  onSelectTab,
  onOpenAdvanced,
}) => (
  <div className="lm-rail" role="tablist" aria-label="Filter live map markers">
    <button
      type="button"
      role="tab"
      aria-selected={quickFilter === 'all'}
      aria-label={`All markers — ${incidentCount + tanodCount} total`}
      className={`lm-rail-btn ${quickFilter === 'all' ? 'lm-rail-btn--active' : ''}`}
      onClick={() => {
        tacticalFeedback.onSelection();
        onSelectAll();
      }}
    >
      <span className="lm-rail-top">
        <IonIcon icon={layersOutline} />
        <span className="lm-rail-count">{incidentCount + tanodCount}</span>
      </span>
      <span className="lm-rail-label">All</span>
    </button>

    <button
      type="button"
      role="tab"
      aria-selected={quickFilter === 'tanods'}
      aria-label={`Tanods — ${tanodCount} nearby`}
      className={`lm-rail-btn ${quickFilter === 'tanods' ? 'lm-rail-btn--active' : ''}`}
      onClick={() => {
        tacticalFeedback.onSelection();
        onSelectTab('tanods');
      }}
    >
      <span className="lm-rail-top">
        <IonIcon icon={shieldCheckmarkOutline} />
        <span className="lm-rail-count">{tanodCount}</span>
      </span>
      <span className="lm-rail-label">Tanods</span>
    </button>

    <button
      type="button"
      role="tab"
      aria-selected={quickFilter === 'incidents'}
      aria-label={`Incidents — ${incidentCount} active`}
      className={`lm-rail-btn ${quickFilter === 'incidents' ? 'lm-rail-btn--active' : ''}`}
      onClick={() => {
        tacticalFeedback.onSelection();
        onSelectTab('incidents');
      }}
    >
      <span className="lm-rail-top">
        <IonIcon icon={alertCircleOutline} />
        <span className="lm-rail-count">{incidentCount}</span>
      </span>
      <span className="lm-rail-label">Incidents</span>
    </button>

    <button
      type="button"
      role="tab"
      aria-selected={quickFilter === 'critical'}
      aria-label={`Critical only — ${criticalCount} critical`}
      className={`lm-rail-btn lm-rail-btn--critical ${quickFilter === 'critical' ? 'lm-rail-btn--active lm-rail-btn--critical-active' : ''}`}
      onClick={() => {
        tacticalFeedback.onSelection();
        onSelectTab('critical');
      }}
    >
      <span className="lm-rail-top">
        <IonIcon icon={flameOutline} />
        <span className="lm-rail-count">{criticalCount}</span>
      </span>
      <span className="lm-rail-label">Critical</span>
    </button>

    {/* Vertical divider separates filter tier from settings tier */}
    <span className="lm-rail-divider" aria-hidden="true" />

    <button
      type="button"
      aria-label="Advanced filter options"
      aria-pressed={isFilterActive && quickFilter === 'custom'}
      className={`lm-rail-btn lm-rail-btn--settings ${isFilterActive && quickFilter === 'custom' ? 'lm-rail-btn--active' : ''}`}
      onClick={() => {
        tacticalFeedback.onTap();
        onOpenAdvanced();
      }}
    >
      <IonIcon icon={optionsOutline} />
      {isFilterActive && <span className="lm-rail-dot" aria-hidden="true" />}
    </button>
  </div>
);

export default MapFilterRail;
