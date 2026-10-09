/**
 * my-reports.tsx — M14 My Incident Reports (Field Incident History).
 *
 * COMPLETE GROUND-UP REDESIGN:
 * Tactical blotter ledger built from scratch for field responders.
 *
 * UX & ACCESSIBILITY ENHANCEMENTS:
 * 1. Sticky Sync Action Banner:
 *    - Immediately notifies Tanods if offline/unsynced reports exist with a 1-tap manual sync trigger.
 * 2. Instant Search & Quick Status Filters:
 *    - Search input for incident type, keyword narrative, or case # combined with All/Synced/Pending pills.
 * 3. Chronological Shift & Date Grouping:
 *    - Buckets reports into "Today's Shift", "Yesterday", and dated section ledgers.
 * 4. Tactical Blotter Card Architecture:
 *    - Severity color indicators (Red = Critical, Amber = High, Blue = Normal).
 *    - Integrated monospace Case #, category icon, and right-aligned Sync badge.
 *    - Clean narrative excerpt with high-contrast text conforming to WCAG 2.2 AA.
 * 5. Human-Readable Telemetry Chips:
 *    - Dropped noisy decimal coordinates in favor of clean [📍 GPS Fixed] and [📷 X photos] chips.
 *    - Tapping opens the report receipt and verification screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IonContent,
  IonIcon,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
} from '@ionic/react';
import {
  alertCircleOutline,
  cameraOutline,
  carOutline,
  checkmarkDoneOutline,
  chevronForwardOutline,
  closeCircleOutline,
  cloudUploadOutline,
  documentTextOutline,
  flameOutline,
  locationOutline,
  medkitOutline,
  searchOutline,
  shieldCheckmarkOutline,
  syncOutline,
  timeOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { deriveSyncState, listAllLocalIncidents, type SyncState } from '../services/db/incidentRepository';
import { getEvidenceCountsByIncident } from '../services/db/evidenceRepository';
import { runSyncPass } from '../services/syncService';
import type { IncidentLocalRow } from '../services/db/localSchema';
import tacticalFeedback from '../utils/tacticalFeedback';

const SYNC_STATE_META: Record<SyncState, { label: string; pillClass: string; icon: typeof cloudUploadOutline }> = {
  saved_locally: { label: 'Saved Offline', pillClass: 'status-pill--pending', icon: cloudUploadOutline },
  queued: { label: 'Queued', pillClass: 'status-pill--info', icon: cloudUploadOutline },
  synced: { label: 'Synced', pillClass: 'status-pill--success', icon: checkmarkDoneOutline },
  duplicate_reconciled: { label: 'Synced', pillClass: 'status-pill--info', icon: checkmarkDoneOutline },
  needs_attention: { label: 'Needs Attention', pillClass: 'status-pill--critical is-urgent', icon: alertCircleOutline },
};

const PRIORITY_PILL_CLASS: Record<string, string> = {
  high: 'status-pill--pending',
  critical: 'status-pill--critical is-urgent',
};

function getCategoryIcon(type?: string | null) {
  const normalized = (type ?? '').toLowerCase();
  if (normalized.includes('injury') || normalized.includes('medical') || normalized.includes('health')) {
    return medkitOutline;
  }
  if (normalized.includes('theft') || normalized.includes('vandalism') || normalized.includes('robbery') || normalized.includes('security')) {
    return shieldCheckmarkOutline;
  }
  if (normalized.includes('fire') || normalized.includes('smoke')) {
    return flameOutline;
  }
  if (normalized.includes('fight') || normalized.includes('disturbance') || normalized.includes('noise')) {
    return alertCircleOutline;
  }
  if (normalized.includes('traffic') || normalized.includes('vehicular') || normalized.includes('accident')) {
    return carOutline;
  }
  return documentTextOutline;
}

function formatIncidentType(rawType: string): string {
  return rawType
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTimeOnly(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getDateGroup(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Other';
  const now = new Date();

  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  if (isToday) return "Today's Shift";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear();

  if (isYesterday) return 'Yesterday';

  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function excerpt(text: string, maxLength = 120): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

const MyReportsPage: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<IncidentLocalRow[]>([]);
  const [evidenceCounts, setEvidenceCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const mountedRef = useRef(true);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'synced' | 'pending'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const load = useCallback(async () => {
    try {
      const [all, counts] = await Promise.all([
        listAllLocalIncidents(),
        getEvidenceCountsByIncident().catch(() => ({})),
      ]);
      if (!mountedRef.current) return;
      setRows(all);
      setEvidenceCounts(counts);
      setLoadError(false);
    } catch {
      if (mountedRef.current) setLoadError(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    void load().finally(() => {
      if (mountedRef.current) setLoading(false);
    });
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  async function handleRefresh(event: CustomEvent) {
    try {
      await load();
    } finally {
      (event.target as HTMLIonRefresherElement).complete();
    }
  }

  const handleManualSync = async () => {
    if (syncing) return;
    setSyncing(true);
    tacticalFeedback.vibrate(20);
    try {
      await runSyncPass();
      await load();
      tacticalFeedback.onSuccess();
    } catch {
      tacticalFeedback.onWarning();
    } finally {
      if (mountedRef.current) setSyncing(false);
    }
  };

  const { filteredRows, syncedCount, pendingCount, timelineGroups } = useMemo(() => {
    let synced = 0;
    let pending = 0;
    for (const r of rows) {
      if (deriveSyncState(r) === 'synced') {
        synced++;
      } else {
        pending++;
      }
    }

    const query = searchQuery.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      const state = deriveSyncState(r);
      if (filter === 'synced' && state !== 'synced') return false;
      if (filter === 'pending' && state === 'synced') return false;

      if (query) {
        const matchesType = r.incident_type.toLowerCase().includes(query);
        const matchesNarrative = r.raw_narrative.toLowerCase().includes(query);
        const matchesCase = r.server_incident_id !== null && String(r.server_incident_id).includes(query);
        const matchesLocalId = r.client_event_id.toLowerCase().includes(query);
        if (!matchesType && !matchesNarrative && !matchesCase && !matchesLocalId) {
          return false;
        }
      }

      return true;
    });

    // Group filtered rows by chronological shift / date
    const groupMap = new Map<string, IncidentLocalRow[]>();
    for (const r of filtered) {
      const grp = getDateGroup(r.created_offline_at);
      if (!groupMap.has(grp)) {
        groupMap.set(grp, []);
      }
      groupMap.get(grp)!.push(r);
    }

    const groups: Array<{ title: string; items: IncidentLocalRow[] }> = [];
    for (const [title, items] of groupMap.entries()) {
      groups.push({ title, items });
    }

    return {
      filteredRows: filtered,
      syncedCount: synced,
      pendingCount: pending,
      timelineGroups: groups,
    };
  }, [rows, filter, searchQuery]);

  return (
    <IonPage>
      <MobileHeader title="My Reports" showBack defaultBackHref="/tabs/home" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        <div className="reports-screen-container">
          {/* Sticky Sync Action Banner (Only visible when unsynced items exist) */}
          {!loading && pendingCount > 0 && (
            <div className="reports-sync-banner" role="status" aria-live="polite">
              <div className="reports-sync-banner-text">
                <IonIcon icon={cloudUploadOutline} className="reports-sync-banner-icon" />
                <div>
                  <div className="reports-sync-banner-title">
                    {pendingCount} report{pendingCount > 1 ? 's' : ''} waiting to sync
                  </div>
                  <div className="reports-sync-banner-sub">
                    Saved on your device. Tap to sync with the Barangay Desk.
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="reports-sync-btn"
                disabled={syncing}
                onClick={handleManualSync}
                aria-label="Synchronize pending reports now"
              >
                {syncing ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <IonSpinner name="dots" style={{ width: '20px', height: '16px' }} />
                  </span>
                ) : (
                  <>
                    <IonIcon icon={syncOutline} style={{ marginRight: '4px' }} />
                    Sync
                  </>
                )}
              </button>
            </div>
          )}

          {/* Quick Search Box */}
          {!loading && rows.length > 0 && (
            <div className="reports-search-box">
              <IonIcon icon={searchOutline} className="reports-search-icon" aria-hidden="true" />
              <input
                type="text"
                className="reports-search-input"
                placeholder="Search by incident type, keyword, or ID…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search reports"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="reports-search-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search"
                >
                  <IonIcon icon={closeCircleOutline} />
                </button>
              )}
            </div>
          )}

          {/* Status Filter Pills */}
          {!loading && rows.length > 0 && (
            <div className="reports-filter-bar" role="tablist" aria-label="Filter reports">
              <button
                type="button"
                role="tab"
                aria-selected={filter === 'all'}
                className={`reports-filter-pill ${filter === 'all' ? 'reports-filter-pill--active' : ''}`}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setFilter('all');
                }}
              >
                <span>All</span>
                <span className="reports-filter-count">{rows.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === 'synced'}
                className={`reports-filter-pill ${filter === 'synced' ? 'reports-filter-pill--active' : ''}`}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setFilter('synced');
                }}
              >
                <span>Synced</span>
                <span className="reports-filter-count">{syncedCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === 'pending'}
                className={`reports-filter-pill ${filter === 'pending' ? 'reports-filter-pill--active' : ''}`}
                onClick={() => {
                  tacticalFeedback.onTap();
                  setFilter('pending');
                }}
              >
                <span>Pending</span>
                <span className="reports-filter-count">{pendingCount}</span>
              </button>
            </div>
          )}

          {/* Content Body */}
          {loading ? (
            <LoadingBlock label="Loading reports…" />
          ) : loadError && rows.length === 0 ? (
            <div role="alert" style={{ textAlign: 'center', padding: 'var(--spacing-xl) var(--spacing-md)' }}>
              <p style={{ margin: '0 0 var(--spacing-md)', color: 'var(--pill-critical-text)', fontSize: 'var(--font-size-sm)' }}>
                Could not read the reports saved on this phone.
              </p>
              <button
                type="button"
                className="dispatch-primary-cta dispatch-primary-cta--blue"
                style={{ maxWidth: '240px', height: '44px' }}
                onClick={() => {
                  setLoading(true);
                  void load().finally(() => {
                    if (mountedRef.current) setLoading(false);
                  });
                }}
              >
                Try again
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div
              className="card--elevated"
              style={{
                textAlign: 'center',
                padding: 'var(--spacing-2xl) var(--spacing-lg)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                marginTop: 'var(--spacing-md)',
              }}
            >
              <div
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  background: 'var(--tint-neutral-bg)',
                  color: 'var(--color-text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '1.5rem',
                  marginBottom: 'var(--spacing-md)',
                }}
              >
                <IonIcon icon={documentTextOutline} />
              </div>
              <h3 style={{ margin: '0 0 var(--spacing-xs)', fontSize: 'var(--font-size-lg)', fontWeight: 700 }}>
                No Reports Filed Yet
              </h3>
              <p style={{ margin: '0 0 var(--spacing-md)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', maxWidth: '280px' }}>
                Reports saved on this phone will sync automatically when connected to the internet.
              </p>
              <button
                type="button"
                className="dispatch-primary-cta dispatch-primary-cta--blue"
                style={{ maxWidth: '240px', height: '44px' }}
                onClick={() => {
                  tacticalFeedback.onTap();
                  navigate('/tabs/incidents/new');
                }}
              >
                File a Report
              </button>
            </div>
          ) : filteredRows.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 'var(--spacing-xl) var(--spacing-md)', color: 'var(--color-text-secondary)' }}>
              <p style={{ fontSize: 'var(--font-size-sm)', margin: 0 }}>
                {searchQuery ? `No reports matching "${searchQuery}".` : `No ${filter} reports found.`}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
              {timelineGroups.map((group) => (
                <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
                  {/* Timeline Shift Header */}
                  <div className="reports-timeline-header">
                    <span>{group.title}</span>
                    <span className="reports-timeline-count">{group.items.length} {group.items.length === 1 ? 'report' : 'reports'}</span>
                  </div>

                  {/* Blotter Cards */}
                  {group.items.map((row) => {
                    const state = deriveSyncState(row);
                    const meta = SYNC_STATE_META[state];
                    const isElevatedPriority = row.priority === 'high' || row.priority === 'critical';
                    const evidenceCount = evidenceCounts[row.local_id] ?? 0;

                    return (
                      <div
                        key={row.local_id}
                        className="report-blotter-card"
                        onClick={() => {
                          tacticalFeedback.onTap();
                          navigate(`/incidents/${row.local_id}/submitted`);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            tacticalFeedback.onTap();
                            navigate(`/incidents/${row.local_id}/submitted`);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`View report for ${formatIncidentType(row.incident_type)}`}
                      >
                        {/* Row 1: Header (Type & Category Icon on Left, Time on Right) */}
                        <div className="report-blotter-top">
                          <div className="report-blotter-heading">
                            <IonIcon icon={getCategoryIcon(row.incident_type)} className="report-blotter-icon" />
                            <span className="report-blotter-title">
                              {formatIncidentType(row.incident_type)}
                            </span>
                          </div>

                          <span className="report-blotter-time">
                            {formatTimeOnly(row.created_offline_at)}
                          </span>
                        </div>

                        {/* Row 2: Narrative Excerpt (Unquoted, clean typography) */}
                        <p className="report-blotter-narrative">
                          {excerpt(row.raw_narrative)}
                        </p>

                        {/* Row 3: Clean Inline Metadata & Right-Aligned Sync Badge */}
                        <div className="report-blotter-bottom">
                          <div className="report-blotter-meta-left">
                            <span className="report-blotter-case">
                              {row.server_incident_id !== null ? `#${row.server_incident_id}` : `#${row.client_event_id.slice(0, 6)}`}
                            </span>

                            {row.latitude !== null && row.longitude !== null && (
                              <>
                                <span className="report-blotter-meta-bullet">•</span>
                                <span className="report-blotter-meta-item">
                                  <IonIcon icon={locationOutline} style={{ color: 'var(--color-primary)' }} />
                                  <span>Location Saved</span>
                                </span>
                              </>
                            )}

                            {evidenceCount > 0 && (
                              <>
                                <span className="report-blotter-meta-bullet">•</span>
                                <span className="report-blotter-meta-item">
                                  <IonIcon icon={cameraOutline} style={{ color: 'var(--color-info)' }} />
                                  <span>{evidenceCount} attachment{evidenceCount > 1 ? 's' : ''}</span>
                                </span>
                              </>
                            )}
                          </div>

                          <div className="report-blotter-status-group">
                            {isElevatedPriority && (
                              <span className={`status-pill ${PRIORITY_PILL_CLASS[row.priority]}`}>
                                {row.priority}
                              </span>
                            )}

                            <span className={`status-pill ${meta.pillClass}`}>
                              <IonIcon icon={meta.icon} style={{ fontSize: '0.85rem' }} />
                              {meta.label}
                            </span>
                          </div>
                        </div>

                        {/* Error Alert Box for Attention Rows */}
                        {state === 'needs_attention' && row.last_sync_error && (
                          <div
                            style={{
                              marginTop: 'var(--spacing-xs)',
                              background: 'var(--tint-critical-bg)',
                              border: '1px solid var(--color-critical)',
                              borderRadius: 'var(--radius-sm)',
                              padding: 'var(--spacing-xs) var(--spacing-sm)',
                              color: 'var(--pill-critical-text)',
                              fontSize: 'var(--font-size-label)',
                              fontWeight: 600,
                            }}
                          >
                            Sync Error: {row.last_sync_error}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default MyReportsPage;
