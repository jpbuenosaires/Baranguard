/**
 * incident-submitted.tsx — M4 Incident Submitted Confirmation (§9 Mobile).
 *
 * §9 M4, in full: "Displays 'Saved locally,' 'Queued,' 'Synced,'
 * 'Duplicate reconciled,' or 'Needs attention.' It never claims server
 * submission when only local persistence has occurred."
 *
 * That last sentence is the whole point of this screen, so the state is
 * DERIVED from the stored row (`deriveSyncState`), never passed in as a
 * hopeful assumption from the previous screen. In Sprint 2 the only
 * reachable state is "Saved locally" — there is no sync worker yet — and
 * the copy says exactly that rather than implying delivery.
 *
 * kebab-case filename per §4.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonPage,
  IonSpinner,
} from '@ionic/react';
import {
  checkmarkOutline,
  copyOutline,
  documentTextOutline,
  homeOutline,
  listOutline,
  shieldCheckmarkOutline,
} from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { deriveSyncState, getLocalIncident, type SyncState } from '../services/db/incidentRepository';
import type { IncidentLocalRow } from '../services/db/localSchema';
import SmsFallbackBadge from '../components/SmsFallbackBadge';

const STATE_LABELS: Record<SyncState, string> = {
  saved_locally: 'Saved locally',
  queued: 'Queued for sync',
  synced: 'Synced with HQ',
  duplicate_reconciled: 'Duplicate reconciled',
  needs_attention: 'Needs attention',
};

const STATE_PILL: Record<SyncState, string> = {
  saved_locally: 'status-pill--pending',
  queued: 'status-pill--info',
  synced: 'status-pill--success',
  duplicate_reconciled: 'status-pill--success',
  needs_attention: 'status-pill--critical',
};

const STATE_DETAIL: Record<SyncState, string> = {
  saved_locally:
    'This report is safely encrypted on your device. It will upload automatically when in range of the Barangay HQ network.',
  queued: 'Report is queued and ready for transmission.',
  synced: 'The barangay workstation has verified and confirmed this incident.',
  duplicate_reconciled:
    'The workstation already received this report; your local record was synchronized.',
  needs_attention: 'This report could not be sent. It is safely preserved on this device.',
};

const IncidentSubmittedPage: React.FC = () => {
  const navigate = useNavigate();
  const { localId } = useParams<{ localId: string }>();
  const [row, setRow] = useState<IncidentLocalRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    getLocalIncident(localId ?? '')
      .then((found) => {
        if (active) {
          setRow(found);
          setLoading(false);
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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const state: SyncState | null = row ? deriveSyncState(row) : null;

  return (
    <IonPage>
      <MobileHeader title="REPORT CONFIRMED" subtitle="Local Capture Verification" />

      <IonContent className="ion-padding" style={{ '--background': 'var(--color-bg)' }}>
        <div className="app-column">
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 64 }}>
              <IonSpinner name="dots" />
            </div>
          ) : !row ? (
            <div
              className="card--elevated"
              style={{
                textAlign: 'center',
                padding: '32px 16px',
                marginTop: '32px',
                borderTop: '4px solid var(--color-critical)',
              }}
            >
              <h3 style={{ color: 'var(--color-critical)', margin: '0 0 8px' }}>Report Not Found</h3>
              <p style={{ color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
                That incident report could not be located in local storage.
              </p>
              <IonButton expand="block" onClick={() => navigate('/home', { replace: true })}>
                Return to Home
              </IonButton>
            </div>
          ) : state ? (
            <>
              {/* Success Hero */}
              <div
                className="card--elevated"
                style={{
                  textAlign: 'center',
                  padding: '32px 16px',
                  marginBottom: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    width: '68px',
                    height: '68px',
                    borderRadius: '50%',
                    background: 'var(--tint-success-bg)',
                    border: '2px solid var(--color-success)',
                    color: 'var(--color-success)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '2.4rem',
                    marginBottom: '14px',
                    boxShadow: '0 0 20px rgba(22, 163, 74, 0.2)',
                  }}
                >
                  <IonIcon icon={shieldCheckmarkOutline} />
                </div>

                <h2 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 800, margin: '0 0 6px', color: 'var(--color-text-primary)' }}>
                  Incident Stored Locally
                </h2>
                <p style={{ margin: '0 0 14px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                  Committed atomically to encrypted SQLite
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className={`status-pill ${STATE_PILL[state]}`}>{STATE_LABELS[state]}</span>
                  <SmsFallbackBadge
                    input={{
                      reachedWorkstation: state === 'synced' || state === 'duplicate_reconciled',
                      smsAttempted: false,
                      smsStatus: null,
                    }}
                  />
                </div>
              </div>

              {/* Status Explanation Card */}
              <div className="card--elevated" style={{ marginBottom: '16px' }}>
                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
                  PERSISTENCE STATUS
                </div>
                <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)', lineHeight: '1.5' }}>
                  {STATE_DETAIL[state]}
                </p>
              </div>

              {/* Reference ID Card */}
              <div className="card--elevated" style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                    CLIENT EVENT REFERENCE
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      background: 'var(--color-surface-blue)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px',
                      color: 'var(--color-primary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <IonIcon icon={copied ? checkmarkOutline : copyOutline} />
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                  </button>
                </div>

                <div
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '8px 10px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8rem',
                    color: 'var(--color-text-primary)',
                    wordBreak: 'break-all',
                    marginBottom: '8px',
                  }}
                >
                  {row.client_event_id}
                </div>

                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                  Captured: {new Date(row.created_offline_at).toLocaleString()}
                </div>
              </div>

              {/* Dual Actions */}
              <IonButton
                expand="block"
                onClick={() => navigate('/home', { replace: true })}
                style={{
                  '--background': 'linear-gradient(135deg, var(--color-navy) 0%, var(--color-primary) 100%)',
                  fontWeight: 700,
                  height: '48px',
                  marginBottom: '10px',
                  boxShadow: 'var(--shadow-fab)',
                }}
              >
                <IonIcon icon={homeOutline} slot="start" />
                Return to Patrol Console
              </IonButton>

              <IonButton
                expand="block"
                fill="outline"
                onClick={() => navigate('/incidents/new', { replace: true })}
                style={{ fontWeight: 700, height: '48px', marginBottom: '10px' }}
              >
                <IonIcon icon={documentTextOutline} slot="start" />
                Log Another Incident
              </IonButton>

              <IonButton
                expand="block"
                fill="clear"
                onClick={() => navigate('/reports')}
                style={{ fontWeight: 600, height: '44px' }}
              >
                <IonIcon icon={listOutline} slot="start" />
                View My Reports
              </IonButton>
            </>
          ) : null}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default IncidentSubmittedPage;
