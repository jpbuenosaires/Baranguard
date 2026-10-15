import type { NearbyIncident, NearbyTanod } from '../services/apiService';

export type DrawerMode = 'peek' | 'selected' | 'expanded';
export type QuickFilterTab = 'all' | 'tanods' | 'incidents' | 'critical' | 'custom';

export interface AdvancedFilterState {
  showTanods: boolean;
  hideStaleTanods: boolean;
  showIncidents: boolean;
  priority: 'all' | 'critical_high' | 'critical_only';
  selectedTypes: string[];
  maxAgeHours: number;
}

export const DEFAULT_ADVANCED_FILTERS: AdvancedFilterState = {
  showTanods: true,
  hideStaleTanods: false,
  showIncidents: true,
  priority: 'all',
  selectedTypes: [],
  maxAgeHours: 0,
};

export type SelectedItem =
  | { type: 'incident'; item: NearbyIncident }
  | { type: 'tanod'; item: NearbyTanod };

export interface MapFilterResult {
  filteredIncidents: NearbyIncident[];
  filteredTanods: NearbyTanod[];
  criticalCount: number;
  criticalOrHighCount: number;
  isFilterActive: boolean;
}

/** Applies the quick-filter rail and the advanced filter sheet to the nearby lists. */
export function applyMapFilters(
  nearby: NearbyIncident[],
  nearbyTanods: NearbyTanod[],
  quickFilter: QuickFilterTab,
  advancedFilters: AdvancedFilterState
): MapFilterResult {
  let incList = nearby;
  let tanodList = nearbyTanods;

  // Two DIFFERENT counts, not one blurred together: the quick-filter
  // rail's flame button is labeled "Critical only" (aria-label), so its
  // badge and its actual filter must both mean literally
  // priority==='critical' — not critical-or-high. The broader
  // combined tier still exists, but only inside the advanced filter
  // sheet's own explicit "Critical & High" option, which names itself
  // correctly and won't be confused with the rail's "Critical only".
  const critCount = nearby.filter((i) => i.priority === 'critical').length;
  const critOrHighCount = nearby.filter((i) => i.priority === 'critical' || i.priority === 'high').length;

  if (quickFilter === 'tanods') {
    incList = [];
    if (advancedFilters.hideStaleTanods) {
      tanodList = tanodList.filter((t) => !t.isStale);
    }
  } else if (quickFilter === 'incidents') {
    tanodList = [];
  } else if (quickFilter === 'critical') {
    tanodList = [];
    incList = incList.filter((i) => i.priority === 'critical');
  } else if (quickFilter === 'all') {
    if (advancedFilters.hideStaleTanods) {
      tanodList = tanodList.filter((t) => !t.isStale);
    }
  } else {
    // Custom filters applied via modal
    if (!advancedFilters.showTanods) {
      tanodList = [];
    } else if (advancedFilters.hideStaleTanods) {
      tanodList = tanodList.filter((t) => !t.isStale);
    }

    if (!advancedFilters.showIncidents) {
      incList = [];
    } else {
      if (advancedFilters.priority === 'critical_only') {
        incList = incList.filter((i) => i.priority === 'critical');
      } else if (advancedFilters.priority === 'critical_high') {
        incList = incList.filter((i) => i.priority === 'critical' || i.priority === 'high');
      }

      if (advancedFilters.selectedTypes.length > 0) {
        incList = incList.filter((i) => advancedFilters.selectedTypes.includes(i.incidentType));
      }

      if (advancedFilters.maxAgeHours > 0) {
        const maxSec = advancedFilters.maxAgeHours * 3600;
        incList = incList.filter((i) => i.ageSeconds <= maxSec);
      }
    }
  }

  const active =
    quickFilter !== 'all' ||
    advancedFilters.hideStaleTanods ||
    !advancedFilters.showTanods ||
    !advancedFilters.showIncidents ||
    advancedFilters.priority !== 'all' ||
    advancedFilters.selectedTypes.length > 0 ||
    advancedFilters.maxAgeHours > 0;

  return {
    filteredIncidents: incList,
    filteredTanods: tanodList,
    criticalCount: critCount,
    criticalOrHighCount: critOrHighCount,
    isFilterActive: active,
  };
}
