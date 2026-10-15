import React from 'react';
import { IonIcon } from '@ionic/react';
import { alertCircleOutline, closeOutline, refreshOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import tacticalFeedback from '../../utils/tacticalFeedback';
import { DEFAULT_ADVANCED_FILTERS, type AdvancedFilterState } from '../../utils/mapFilters';

interface Props {
  filters: AdvancedFilterState;
  setFilters: React.Dispatch<React.SetStateAction<AdvancedFilterState>>;
  tanodCount: number;
  incidentCount: number;
  criticalOrHighCount: number;
  availableIncidentTypes: string[];
  onClose: () => void;
  onApply: () => void;
}

interface SegmentOption {
  label: React.ReactNode;
  active: boolean;
  onSelect: () => void;
}

const SegmentGroup: React.FC<{ ariaLabel: string; options: SegmentOption[] }> = ({ ariaLabel, options }) => (
  <div className="live-map-filter-segment" role="group" aria-label={ariaLabel}>
    {options.map((o, i) => (
      <button
        key={i}
        type="button"
        className={`live-map-filter-segment-btn ${o.active ? 'live-map-filter-segment-btn--active' : ''}`}
        onClick={o.onSelect}
      >
        {o.label}
      </button>
    ))}
  </div>
);

/** Detailed filter sheet (modal) for the live map. Edits a temp copy; Apply commits it. */
const MapFilterSheet: React.FC<Props> = ({
  filters,
  setFilters,
  tanodCount,
  incidentCount,
  criticalOrHighCount,
  availableIncidentTypes,
  onClose,
  onApply,
}) => {
  const patch = (p: Partial<AdvancedFilterState>) => setFilters((prev) => ({ ...prev, ...p }));

  return (
    <>
      <div
        className="live-map-modal-backdrop"
        onClick={() => {
          tacticalFeedback.onTap();
          onClose();
        }}
        aria-hidden="true"
      />
      <div className="live-map-filter-sheet" role="dialog" aria-modal="true" aria-labelledby="filter-sheet-title">
        <div className="live-map-filter-sheet__header">
          <span id="filter-sheet-title" className="live-map-filter-sheet__title">
            Filter Live Patrol Map
          </span>
          <div className="lm-sheet-actions">
            <button
              type="button"
              className="live-map-reset-btn"
              onClick={() => {
                tacticalFeedback.onTap();
                setFilters(DEFAULT_ADVANCED_FILTERS);
              }}
            >
              <IonIcon icon={refreshOutline} />
              <span>Reset</span>
            </button>
            <button
              type="button"
              className="topbar-btn lm-sheet-close"
              onClick={() => {
                tacticalFeedback.onTap();
                onClose();
              }}
              aria-label="Close filters"
            >
              <IonIcon icon={closeOutline} />
            </button>
          </div>
        </div>

        <div className="live-map-filter-sheet__body">
          {/* Section 1: Entities to show */}
          <div>
            <div className="live-map-filter-section-title">Show On Map</div>
            <div className="lm-sheet-col">
              <label className="live-map-filter-toggle-row">
                <span className="lm-toggle-label">
                  <IonIcon icon={shieldCheckmarkOutline} className="lm-icon-primary" />
                  On-Duty Tanod Patrols ({tanodCount})
                </span>
                <input
                  type="checkbox"
                  className="lm-check hit-48"
                  checked={filters.showTanods}
                  onChange={(e) => patch({ showTanods: e.target.checked })}
                />
              </label>

              {filters.showTanods && (
                <label className="live-map-filter-toggle-row live-map-filter-toggle-row--sub">
                  <span className="lm-toggle-label--sub">Hide stale patrols (GPS older than 2m)</span>
                  <input
                    type="checkbox"
                    className="lm-check lm-check--sm hit-48"
                    checked={filters.hideStaleTanods}
                    onChange={(e) => patch({ hideStaleTanods: e.target.checked })}
                  />
                </label>
              )}

              <label className="live-map-filter-toggle-row">
                <span className="lm-toggle-label">
                  <IonIcon icon={alertCircleOutline} className="lm-icon-warning" />
                  Reported Incidents ({incidentCount})
                </span>
                <input
                  type="checkbox"
                  className="lm-check hit-48"
                  checked={filters.showIncidents}
                  onChange={(e) => patch({ showIncidents: e.target.checked })}
                />
              </label>
            </div>
          </div>

          {/* Section 2: Priority */}
          {filters.showIncidents && (
            <div>
              <div className="live-map-filter-section-title">Incident Priority</div>
              <SegmentGroup
                ariaLabel="Filter by priority"
                options={[
                  { label: `All (${incidentCount})`, active: filters.priority === 'all', onSelect: () => patch({ priority: 'all' }) },
                  {
                    label: <>Critical &amp; High ({criticalOrHighCount})</>,
                    active: filters.priority === 'critical_high',
                    onSelect: () => patch({ priority: 'critical_high' }),
                  },
                  { label: 'Critical Only', active: filters.priority === 'critical_only', onSelect: () => patch({ priority: 'critical_only' }) },
                ]}
              />
            </div>
          )}

          {/* Section 3: Incident Types */}
          {filters.showIncidents && availableIncidentTypes.length > 0 && (
            <div>
              <div className="live-map-filter-section-title">Incident Types</div>
              <div className="live-map-filter-types-grid">
                <button
                  type="button"
                  className={`live-map-filter-type-pill ${filters.selectedTypes.length === 0 ? 'live-map-filter-type-pill--active' : ''}`}
                  onClick={() => patch({ selectedTypes: [] })}
                >
                  All Types
                </button>
                {availableIncidentTypes.map((type) => {
                  const isSelected = filters.selectedTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      className={`live-map-filter-type-pill ${isSelected ? 'live-map-filter-type-pill--active' : ''}`}
                      onClick={() => {
                        setFilters((prev) => {
                          const exists = prev.selectedTypes.includes(type);
                          return {
                            ...prev,
                            selectedTypes: exists
                              ? prev.selectedTypes.filter((t) => t !== type)
                              : [...prev.selectedTypes, type],
                          };
                        });
                      }}
                    >
                      {type.replace(/_/g, ' ')}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 4: Incident Freshness */}
          {filters.showIncidents && (
            <div>
              <div className="live-map-filter-section-title">Reported Time</div>
              <SegmentGroup
                ariaLabel="Filter by time"
                options={[
                  { label: 'All Active', active: filters.maxAgeHours === 0, onSelect: () => patch({ maxAgeHours: 0 }) },
                  { label: <>&lt; 1 Hour</>, active: filters.maxAgeHours === 1, onSelect: () => patch({ maxAgeHours: 1 }) },
                  { label: <>&lt; 6 Hours</>, active: filters.maxAgeHours === 6, onSelect: () => patch({ maxAgeHours: 6 }) },
                ]}
              />
            </div>
          )}
        </div>

        <div className="live-map-filter-sheet__footer">
          <button
            type="button"
            className="live-map-btn-primary lm-apply-btn"
            onClick={() => {
              tacticalFeedback.onTap();
              onApply();
            }}
          >
            <span>Apply Filters</span>
          </button>
        </div>
      </div>
    </>
  );
};

export default MapFilterSheet;
