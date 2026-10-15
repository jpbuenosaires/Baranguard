/** Segmented filter bar and on-demand search of the Dispatches list (Phase 6 split; markup unchanged). */
import { IonIcon } from '@ionic/react';
import { closeCircleOutline, searchOutline } from 'ionicons/icons';

export type FilterTab = 'all' | 'critical' | 'en_route' | 'assigned';

export interface FilterCounts {
  all: number;
  critical: number;
  en_route: number;
  assigned: number;
}

export default function DispatchFilterBar({
  activeFilter,
  counts,
  showSearch,
  searchQuery,
  onFilterChange,
  onToggleSearch,
  onSearchChange,
}: {
  activeFilter: FilterTab;
  counts: FilterCounts;
  showSearch: boolean;
  searchQuery: string;
  onFilterChange: (filter: FilterTab) => void;
  onToggleSearch: () => void;
  onSearchChange: (query: string) => void;
}) {
  return (
    <>
    <div className="dispatch-control-bar">
      <div className="dispatch-segmented-control" role="tablist" aria-label="Filter dispatches">
        <button
          type="button"
          role="tab"
          aria-selected={activeFilter === 'all'}
          className={`dispatch-segment-btn ${activeFilter === 'all' ? 'dispatch-segment-btn--active' : ''}`}
          onClick={() => onFilterChange('all')}
        >
          <span>All</span>
          <span className="dispatch-segment-badge">{counts.all}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeFilter === 'critical'}
          className={`dispatch-segment-btn dispatch-segment-btn--critical ${activeFilter === 'critical' ? 'dispatch-segment-btn--active' : ''}`}
          onClick={() => onFilterChange('critical')}
        >
          <span>Critical</span>
          {counts.critical > 0 && (
            <span className="dispatch-segment-badge dispatch-segment-badge--urgent">
              {counts.critical}
            </span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeFilter === 'en_route'}
          className={`dispatch-segment-btn ${activeFilter === 'en_route' ? 'dispatch-segment-btn--active' : ''}`}
          onClick={() => onFilterChange('en_route')}
        >
          <span>En Route</span>
          {counts.en_route > 0 && (
            <span className="dispatch-segment-badge">{counts.en_route}</span>
          )}
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeFilter === 'assigned'}
          className={`dispatch-segment-btn ${activeFilter === 'assigned' ? 'dispatch-segment-btn--active' : ''}`}
          onClick={() => onFilterChange('assigned')}
        >
          <span>Assigned</span>
          {counts.assigned > 0 && (
            <span className="dispatch-segment-badge">{counts.assigned}</span>
          )}
        </button>
      </div>

      {/* On-demand Search Toggle */}
      <button
        type="button"
        className={`dispatch-search-toggle ${showSearch ? 'dispatch-search-toggle--active' : ''}`}
        onClick={onToggleSearch}
        aria-label={showSearch ? 'Close search' : 'Open search'}
        title={showSearch ? 'Close search' : 'Search dispatches'}
      >
        <IonIcon icon={showSearch ? closeCircleOutline : searchOutline} />
      </button>
    </div>

      {/* Expandable Search Input */}
      {showSearch && (
        <div className="dispatch-search-bar" role="search">
      <IonIcon icon={searchOutline} className="dispatch-search-icon" aria-hidden="true" />
      <input
        type="text"
        autoFocus
        className="dispatch-search-field"
        placeholder="Search by incident type, summary, or ID…"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label="Search dispatches"
      />
      {searchQuery && (
        <button
          type="button"
          className="dispatch-search-clear-btn"
          onClick={() => onSearchChange('')}
          aria-label="Clear search input"
        >
          <IonIcon icon={closeCircleOutline} />
        </button>
      )}
    </div>
      )}
    </>
  );
}
