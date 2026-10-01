/**
 * incident-submitted.tsx — M4 Incident Submitted Confirmation (§9 Mobile).
 *
 * COMPLETE GROUND-UP REDESIGN:
 * Unified Tactical Blotter Receipt built entirely from scratch for field responders.
 *
 * UX & ACCESSIBILITY ENHANCEMENTS:
 * 1. Unified Tactical Receipt Canvas:
 *    - Replaces fragmented hero and detail boxes with a single, authoritative field receipt.
 * 2. Dynamic Synchronous State Engine:
 *    - Real-time headline, subtitle, and badge that accurately reflect the sync state
 *      without confusing contradictions ("Report Verified & Synced" vs "Report Secured Offline").
 * 3. Ergonomic 2-Row Action Dock:
 *    - Full-width primary CTA ("Return to Patrol Console") + side-by-side secondary CTAs
 *      ("Log Another" and "View Blotter") placed directly in the mobile thumb zone.
 * 4. Interactive Telemetry & Semantic Identifiers:
 *    - Interactive [Map] button to view pinned GPS coordinates on the Live Radar map.
 *    - Explicit semantic differentiation between HQ Case Number and Local Blotter Reference.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonPage,
} from '@ionic/react';
import {
  addOutline,
  alertCircleOutline,
  cameraOutline,
  carOutline,
  checkmarkCircleOutline,
  checkmarkDoneOutline,
  checkmarkOutline,
  cloudUploadOutline,
  copyOutline,
  documentTextOutline,
  flameOutline,
  homeOutline,
  listOutline,
  locationOutline,
  mapOutline,
  medkitOutline,
  shieldCheckmarkOutline,
  timeOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import ReferralPanel from '../components/ReferralPanel';
import { LoadingBlock } from '../components/LoadingBlock';
import { deriveSyncState, getLocalIncident, type SyncState } from '../services/db/incidentRepository';
import { getEvidenceForIncident } from '../services/db/evidenceRepository';
import type { IncidentLocalRow, EvidenceAttachmentLocalRow } from '../services/db/localSchema';
import tacticalFeedback from '../utils/tacticalFeedback';

interface SyncEngineMeta {
  headline: string;
  subtitle: string;
  badgeLabel: string;
  badgeClass: string;
  badgeIcon: typeof checkmarkDoneOutline;
  emblemClass: string;
  emblemIcon: typeof shieldCheckmarkOutline;
}

const SYNC_ENGINE_CONFIG: Record<SyncState, SyncEngineMeta> = {
  synced: {
    headline: 'Report Submitted & Synced',
    subtitle: 'Sent directly to the Barangay Desk',
    badgeLabel: 'Synced',
    badgeClass: 'status-pill--success',
    badgeIcon: checkmarkDoneOutline,
    emblemClass: 'tactical-receipt-emblem--success',
    emblemIcon: shieldCheckmarkOutline,
  },
  saved_locally: {
    headline: 'Report Saved Offline',
    subtitle: 'Saved on this device. Will sync once connected.',
    badgeLabel: 'Saved Offline',
    badgeClass: 'status-pill--pending',
    badgeIcon: cloudUploadOutline,
    emblemClass: 'tactical-receipt-emblem--warning',
    emblemIcon: cloudUploadOutline,
  },
  queued: {
    headline: 'Waiting to Sync',
    subtitle: 'Connecting to the Barangay Desk…',
    badgeLabel: 'Sync Queued',
    badgeClass: 'status-pill--info',
    badgeIcon: cloudUploadOutline,
    emblemClass: 'tactical-receipt-emblem--warning',
    emblemIcon: cloudUploadOutline,
  },
  duplicate_reconciled: {
    headline: 'Report Synced',
    subtitle: 'Verified and linked with the incident at the Barangay Desk.',
    badgeLabel: 'Synced',
    badgeClass: 'status-pill--info',
    badgeIcon: checkmarkDoneOutline,
    emblemClass: 'tactical-receipt-emblem--success',
    emblemIcon: checkmarkCircleOutline,
  },
  needs_attention: {
    headline: 'Saved • Sync Pending',
    subtitle: 'Saved on your phone. Will retry syncing automatically.',
    badgeLabel: 'Sync Pending',
    badgeClass: 'status-pill--critical is-urgent',
    badgeIcon: alertCircleOutline,
    emblemClass: 'tactical-receipt-emblem--critical',
    emblemIcon: alertCircleOutline,
  },
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

const IncidentSubmittedPage: React.FC = () => {
  const navigate = useNavigate();
  const { localId = '' } = useParams<{ localId: string }>();
  const [row, setRow] = useState<IncidentLocalRow | null>(null);
  const [evidenceList, setEvidenceList] = useState<EvidenceAttachmentLocalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      getLocalIncident(localId),
      getEvidenceForIncident(localId).catch(() => []),
    ])
      .then(([foundRow, foundEvidence]) => {
        if (active) {
          setRow(foundRow);
          setEvidenceList(foundEvidence);
          setLoading(false);
          tacticalFeedback.onSuccess();
        }
      })
      .catch(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [localId]);

  const handleCopyId = () => {
    if (!row?.client_event_id) return;
    navigator.clipboard.writeText(row.client_event_id);
    tacticalFeedback.vibrate(25);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const state: SyncState | null = row ? deriveSyncState(row) : null;
  const engineMeta = state ? SYNC_ENGINE_CONFIG[state] : null;

  return (
    <IonPage>
      <MobileHeader
        title="Report Confirmed"
        showBack
        defaultBackHref="/tabs/home"
      />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="tactical-receipt-container">
          {loading ? (
            <LoadingBlock label="Loading report…" />
          ) : !row || !engineMeta ? (
            <div
              className="card--elevated"
              style={{
                textAlign: 'center',
                padding: 'var(--spacing-xl) var(--spacing-md)',
                marginTop: 'var(--spacing-xl)',
                borderTop: '4px solid var(--color-critical)',
              }}
            >
              <h3 style={{ color: 'var(--color-critical)', margin: '0 0 var(--spacing-xs)' }}>Report Not Found</h3>
              <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-md)' }}>
                That incident report could not be located in local device storage.
              </p>
              <IonButton expand="block" onClick={() => navigate('/tabs/home', { replace: true })}>
                Return to Home
              </IonButton>
            </div>
          ) : (
            <>
              {/* Single Unified Tactical Field Receipt */}
              <div className="tactical-receipt-card" role="region" aria-label="Incident Confirmation Receipt">
                {/* Top Verification Stamp */}
                <div className="tactical-receipt-stamp">
                  <div className={`tactical-receipt-emblem ${engineMeta.emblemClass}`} aria-hidden="true">
                    <IonIcon icon={engineMeta.emblemIcon} />
                  </div>
                  <h1 className="tactical-receipt-title">{engineMeta.headline}</h1>
                  <p className="tactical-receipt-subtitle">{engineMeta.subtitle}</p>
                  <span className={`status-pill ${engineMeta.badgeClass}`} style={{ marginTop: '2px' }}>
                    <IonIcon icon={engineMeta.badgeIcon} style={{ fontSize: '0.85rem' }} />
                    {engineMeta.badgeLabel}
                  </span>
                </div>

                {/* Perforated Receipt Divider */}
                <div className="tactical-receipt-perforated" aria-hidden="true" />

                {/* Incident Type Header & Case Number */}
                <div className="tactical-receipt-incident-header">
                  <div className="tactical-receipt-type">
                    <IonIcon icon={getCategoryIcon(row.incident_type)} className="tactical-receipt-type-icon" />
                    <span>{row.incident_type.replace(/_/g, ' ')}</span>
                  </div>
                  {row.server_incident_id !== null ? (
                    <span className="tactical-receipt-case-tag">Case #{row.server_incident_id}</span>
                  ) : (
                    <span className="tactical-receipt-case-tag">Saved on Phone</span>
                  )}
                </div>

                {/* Narrative Excerpt */}
                {row.raw_narrative && (
                  <p className="tactical-receipt-narrative">
                    "{row.raw_narrative}"
                  </p>
                )}

                {/* Telemetry Grid */}
                <div className="tactical-receipt-grid">
                  {/* Location with Interactive Map Affordance */}
                  <div className="tactical-receipt-row">
                    <span className="tactical-receipt-label">
                      <IonIcon icon={locationOutline} />
                      Location
                    </span>
                    <div className="tactical-receipt-value">
                      {row.latitude !== null && row.longitude !== null ? (
                        <>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-label)' }}>
                            {row.latitude.toFixed(4)}, {row.longitude.toFixed(4)}
                          </span>
                          <button
                            type="button"
                            className="tactical-receipt-map-btn"
                            onClick={() => {
                              tacticalFeedback.onTap();
                              navigate('/tabs/map');
                            }}
                            aria-label="View location on map"
                          >
                            <IonIcon icon={mapOutline} />
                            Map
                          </button>
                        </>
                      ) : (
                        <span style={{ color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-label)' }}>
                          No GPS Location
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Evidence Attachments */}
                  <div className="tactical-receipt-row">
                    <span className="tactical-receipt-label">
                      <IonIcon icon={cameraOutline} />
                      Evidence
                    </span>
                    <span className="tactical-receipt-value">
                      {evidenceList.length > 0
                        ? `${evidenceList.length} photo${evidenceList.length > 1 ? 's' : ''} attached`
                        : 'None attached'}
                    </span>
                  </div>

                  {/* Logged Timestamp */}
                  <div className="tactical-receipt-row">
                    <span className="tactical-receipt-label">
                      <IonIcon icon={timeOutline} />
                      Logged At
                    </span>
                    <span className="tactical-receipt-value">
                      {new Date(row.created_offline_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  {/* Semantic Local Reference */}
                  <div className="tactical-receipt-row">
                    <span className="tactical-receipt-label">
                      <IonIcon icon={documentTextOutline} />
                      Report ID
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyId}
                      className="tactical-receipt-ref-btn"
                      title="Tap to copy report ID"
                      aria-label="Copy report ID"
                    >
                      <span>#{row.client_event_id ? row.client_event_id.slice(0, 8) : '--------'}</span>
                      <IonIcon icon={copied ? checkmarkOutline : copyOutline} style={{ color: copied ? 'var(--color-success)' : 'inherit' }} />
                      {copied && <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>Copied</span>}
                    </button>
                  </div>
                </div>
              </div>

              {/* Referral / handoff — works offline; a phone-only incident is linked by its local id. */}
              <ReferralPanel
                link={{ incidentLocalId: row.local_id, serverIncidentId: row.server_incident_id }}
                incidentLabel={row.server_incident_id !== null ? `Case #${row.server_incident_id}` : 'this report'}
              />

              {/* Ergonomic 2-Row Action Dock */}
              <div className="tactical-receipt-dock">
                {/* Row 1: Full-Width Primary CTA */}
                <button
                  type="button"
                  className="dispatch-primary-cta dispatch-primary-cta--blue"
                  onClick={() => {
                    tacticalFeedback.onTap();
                    navigate('/tabs/home', { replace: true });
                  }}
                >
                  <IonIcon icon={homeOutline} style={{ fontSize: '1.2rem' }} />
                  <span>Back to Home</span>
                </button>

                {/* Row 2: Ergonomic 2-Column Split */}
                <div className="tactical-receipt-row-secondary">
                  <button
                    type="button"
                    className="dispatch-secondary-cta"
                    onClick={() => {
                      tacticalFeedback.onTap();
                      navigate('/tabs/incidents/new', { replace: true });
                    }}
                  >
                    <IonIcon icon={addOutline} style={{ color: 'var(--color-primary)' }} />
                    <span>Report Another</span>
                  </button>

                  <button
                    type="button"
                    className="dispatch-secondary-cta"
                    onClick={() => {
                      tacticalFeedback.onTap();
                      navigate('/tabs/reports');
                    }}
                  >
                    <IonIcon icon={listOutline} style={{ color: 'var(--color-primary)' }} />
                    <span>View Reports</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default IncidentSubmittedPage;
