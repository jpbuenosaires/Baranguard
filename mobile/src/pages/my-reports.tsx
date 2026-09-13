/**
 * my-reports.tsx — M14 My Incident Reports (Mobile Improvement Plan
 * Phase 2.2, previously unbuilt).
 *
 * The gap this closes: after M4's one-shot confirmation screen, a Tanod
 * had no way to check what happened to a report they filed — did it sync,
 * did the workstation reject it, what's its server incident id. This
 * screen lists EVERY incident this device has ever captured
 * (`listAllLocalIncidents()`, not the sync worker's unsynced-only query),
 * newest first, with each card's sync state derived from the same
 * `deriveSyncState()` M4 already uses — so "pending"/"synced"/"needs
 * attention" mean exactly the same thing on both screens rather than a
 * second, subtly different classification.
 *
 * Reads ONLY the local encrypted store — no network call, so this screen
 * works identically online or offline, same as M5's cached-first design.
 * Deliberately NOT built: live server-side case-status refresh (pending/
 * dispatched/resolved as currently tracked by the workstation) — that
 * needs a new `GET /incidents/:id`-style mobile-facing call this cut
 * doesn't add; what's shown here is exactly what this device itself
 * knows, honestly labeled, not a guess at server state.
 */

import { useCallback, useEffect, useState } from 'react';
import { IonContent, IonIcon, IonPage, IonRefresher, IonRefresherContent, IonSpinner } from '@ionic/react';
import {
  alertCircleOutline,
  checkmarkDoneOutline,
  cloudUploadOutline,
  documentTextOutline,
  locationOutline,
  timeOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { deriveSyncState, listAllLocalIncidents, type SyncState } from '../services/db/incidentRepository';
import type { IncidentLocalRow } from '../services/db/localSchema';

const SYNC_STATE_META: Record<SyncState, { label: string; pillClass: string; icon: typeof cloudUploadOutline }> = {
  saved_locally: { label: 'STAGED IN CACHE', pillClass: 'status-pill--pending', icon: cloudUploadOutline },
  // Not currently reachable — deriveSyncState() never returns it yet (see
  // that function's own comment in incidentRepository.ts) — kept here so
  // this Record stays total rather than needing a fallback/cast, and so
  // this screen doesn't silently break the day that function's TODO lands.
  queued: { label: 'QUEUED FOR SYNC', pillClass: 'status-pill--info', icon: cloudUploadOutline },
  synced: { label: 'SYNCED', pillClass: 'status-pill--success', icon: checkmarkDoneOutline },
  duplicate_reconciled: { label: 'RECONCILED', pillClass: 'status-pill--info', icon: checkmarkDoneOutline },
  needs_attention: { label: 'SYNC FAILED', pillClass: 'status-pill--critical is-urgent', icon: alertCircleOutline },
};

const PRIORITY_PILL_CLASS: Record<string, string> = {
  normal: 'status-pill--info',
  high: 'status-pill--pending',
  critical: 'status-pill--critical is-urgent',
};

function excerpt(text: string, maxLength = 140): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

const MyReportsPage: React.FC = () => {
  const [rows, setRows] = useState<IncidentLocalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const all = await listAllLocalIncidents();
    setRows(all);
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleRefresh(event: CustomEvent) {
    await load();
    (event.target as HTMLIonRefresherElement).complete();
  }

  return (
    <IonPage>
      <MobileHeader title="MY REPORTS" subtitle="Field Incident History" showBack defaultBackHref="/home" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <IonRefresher slot="fixed" onIonRefresh={handleRefresh}>
          <IonRefresherContent />
        </IonRefresher>

        <div className="app-column">
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 64, gap: 12 }}>
              <IonSpinner name="dots" />
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                Loading your reports…
              </span>
            </div>
          ) : rows.length === 0 ? (
            <div
              className="card--elevated"
              style={{ textAlign: 'center', padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '16px' }}
            >
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: 'var(--tint-neutral-bg)',
                  color: 'var(--color-text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '2rem',
                  marginBottom: '16px',
                }}
              >
                <IonIcon icon={documentTextOutline} />
              </div>
              <h3 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-lg)', fontWeight: 700 }}>No Reports Yet</h3>
              <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', maxWidth: '280px' }}>
                Incidents you log from this device will show up here, whether or not they've synced yet.
              </p>
            </div>
          ) : (
            <div className="card-list">
              {rows.map((row) => {
                const state = deriveSyncState(row);
                const meta = SYNC_STATE_META[state];
                const priorityClass = PRIORITY_PILL_CLASS[row.priority] ?? 'status-pill--info';

                return (
                  <div key={row.local_id} className="card" style={{ padding: '14px' }}>
                    <div className="card__header" style={{ marginBottom: '6px', flexWrap: 'wrap', rowGap: '6px' }}>
                      <span className={`status-pill ${priorityClass}`}>{row.priority}</span>
                      <span className={`status-pill ${meta.pillClass}`}>
                        <IonIcon icon={meta.icon} style={{ fontSize: '0.85rem' }} />
                        {meta.label}
                      </span>
                      {row.server_incident_id !== null && (
                        <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-text-tertiary)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
                          Case #{row.server_incident_id}
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: '4px' }}>
                      {row.incident_type.replace(/_/g, ' ').toUpperCase()}
                    </div>

                    <p style={{ margin: '0 0 8px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
                      {excerpt(row.raw_narrative)}
                    </p>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '0.72rem', color: 'var(--color-text-tertiary)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <IonIcon icon={timeOutline} />
                        <span>{new Date(row.created_offline_at).toLocaleString()}</span>
                      </div>
                      {row.latitude !== null && row.longitude !== null && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <IonIcon icon={locationOutline} />
                          <span>
                            {row.latitude.toFixed(4)}, {row.longitude.toFixed(4)}
                          </span>
                        </div>
                      )}
                    </div>

                    {state === 'needs_attention' && row.last_sync_error && (
                      <div
                        style={{
                          marginTop: '8px',
                          background: 'var(--tint-critical-bg)',
                          border: '1px solid var(--color-critical)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '8px 10px',
                          color: 'var(--pill-critical-text)',
                          fontSize: '0.75rem',
                        }}
                      >
                        {row.last_sync_error}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default MyReportsPage;
