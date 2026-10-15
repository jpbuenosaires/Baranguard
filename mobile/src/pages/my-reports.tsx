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
  closeCircleOutline,
  cloudUploadOutline,
  documentTextOutline,
  flameOutline,
  locationOutline,
  medkitOutline,
  searchOutline,
  shieldCheckmarkOutline,
  syncOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { Banner, Button, EmptyState, ErrorState, SyncLabel, type SyncState as UiSyncState } from '../components/ui';
import { deriveSyncState, listAllLocalIncidents, upsertServerIncidents, type SyncState } from '../services/db/incidentRepository';
import { getMyServerIncidents } from '../services/apiService';
import { getEvidenceCountsByIncident } from '../services/db/evidenceRepository';
import { runSyncPass } from '../services/syncService';
import type { IncidentLocalRow } from '../services/db/localSchema';
import tacticalFeedback from '../utils/tacticalFeedback';
import { formatIncidentCode, localReportRef } from '../utils/incidentCode';

// Wording comes from SyncLabel only. A duplicate means the server already has the report, so it is "Sent".
const SYNC_STATE_MAP: Record<SyncState, { state: UiSyncState; willRetry: boolean }> = {
  saved_locally: { state: 'saved_on_phone', willRetry: true },
  queued: { state: 'saved_on_phone', willRetry: true },
  synced: { state: 'sent', willRetry: true },
  duplicate_reconciled: { state: 'sent', willRetry: true },
  needs_attention: { state: 'failed', willRetry: false },
};

const FILTER_EMPTY_LABEL: Record<'all' | 'synced' | 'pending', string> = {
  all: '',
  synced: 'sent',
  pending: 'unsent',
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
      // Fresh install / new device: pull this Tanod's own history from the server (best effort).
      try {
        await upsertServerIncidents(await getMyServerIncidents());
      } catch {
        // offline or not allowed: show what is on the phone
      }
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
      <MobileHeader title="My Reports" showBack defaultBackHref="/tabs/profile" />

      <IonContent className="ion-padding content-bg">
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
                    {pendingCount} report{pendingCount > 1 ? 's' : ''} not sent yet
                  </div>
                  <div className="reports-sync-banner-sub">
                    Saved on your phone. Tap Sync to send to the Barangay Desk.
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
                  <span className="reports-sync-spinner">
                    <IonSpinner name="dots" />
                  </span>
                ) : (
                  <>
                    <IonIcon icon={syncOutline} className="icon-mr-4" />
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
                <span>Sent</span>
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
                <span>Not sent</span>
                <span className="reports-filter-count">{pendingCount}</span>
              </button>
            </div>
          )}

          {/* Content Body */}
          {loading ? (
            <LoadingBlock label="Loading reports…" />
          ) : loadError && rows.length === 0 ? (
            <ErrorState
              message="Could not read the reports saved on this phone."
              onRetry={() => {
                setLoading(true);
                void load().finally(() => {
                  if (mountedRef.current) setLoading(false);
                });
              }}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={documentTextOutline}
              title="No reports filed yet"
              body="Reports you file are saved on this phone and sent automatically when you are connected."
              action={
                <Button
                  onClick={() => {
                    tacticalFeedback.onTap();
                    navigate('/tabs/incidents/new');
                  }}
                >
                  File a report
                </Button>
              }
            />
          ) : filteredRows.length === 0 ? (
            <EmptyState
              title={searchQuery ? `No reports matching "${searchQuery}".` : `No ${FILTER_EMPTY_LABEL[filter]} reports found.`}
            />
          ) : (
            <div className="col-gap-md">
              {timelineGroups.map((group) => (
                <div key={group.title} className="col-gap-xs">
                  {/* Timeline Shift Header */}
                  <div className="reports-timeline-header">
                    <span>{group.title}</span>
                    <span className="reports-timeline-count">{group.items.length} {group.items.length === 1 ? 'report' : 'reports'}</span>
                  </div>

                  {/* Blotter Cards */}
                  {group.items.map((row) => {
                    const state = deriveSyncState(row);
                    const syncMeta = SYNC_STATE_MAP[state];
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
                          {row.from_server === 1 ? 'Details stay on the server' : excerpt(row.raw_narrative)}
                        </p>

                        {/* Row 3: Clean Inline Metadata & Right-Aligned Sync Badge */}
                        <div className="report-blotter-bottom">
                          <div className="report-blotter-meta-left">
                            <span className="report-blotter-case">
                              {formatIncidentCode({ displayId: row.display_id, serverIncidentId: row.server_incident_id }) ?? localReportRef(row.client_event_id)}
                            </span>

                            {row.from_server === 1 && row.location_text && (
                              <>
                                <span className="report-blotter-meta-bullet">•</span>
                                <span className="report-blotter-meta-item">
                                  <IonIcon icon={locationOutline} className="icon-primary" />
                                  <span>{row.location_text}</span>
                                </span>
                              </>
                            )}

                            {row.from_server !== 1 && row.latitude !== null && row.longitude !== null && (
                              <>
                                <span className="report-blotter-meta-bullet">•</span>
                                <span className="report-blotter-meta-item">
                                  <IonIcon icon={locationOutline} className="icon-primary" />
                                  <span>Location Saved</span>
                                </span>
                              </>
                            )}

                            {evidenceCount > 0 && (
                              <>
                                <span className="report-blotter-meta-bullet">•</span>
                                <span className="report-blotter-meta-item">
                                  <IonIcon icon={cameraOutline} className="icon-info" />
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

                            <SyncLabel state={syncMeta.state} willRetry={syncMeta.willRetry} />
                          </div>
                        </div>

                        {/* Error Alert Box for Attention Rows */}
                        {state === 'needs_attention' && row.last_sync_error && (
                          <Banner tone="error" role="status" className="ui-state-gap--none">
                            Not sent. Reason: {row.last_sync_error}
                          </Banner>
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
