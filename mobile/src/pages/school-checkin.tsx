/**
 * school-checkin.tsx — School check-in / check-out (Safer School Zones,
 * contract §7, §9).
 *
 * A Tanod posted at a school taps Check In (and later Check Out); the desk
 * counts deployment days from these. Everything is OFFLINE-SAFE: the school
 * picker reads the cached `school_local` list (filled on login/resume/sync),
 * and each tap persists to encrypted SQLite before the screen reacts (Rule 7).
 * The chip on every row says only what that row can prove — "Saved on phone"
 * until the server has confirmed it, including a check-out that is still
 * waiting to be sent (contract §7's close-by-reference item).
 *
 * No coordinates are captured or stored for a check-in (the server stores
 * none), and nothing about students is ever recorded.
 */

import { useCallback, useEffect, useState } from 'react';
import { IonContent, IonIcon, IonPage, IonSpinner } from '@ionic/react';
import { logInOutline, logOutOutline, schoolOutline } from 'ionicons/icons';
import MobileHeader from '../components/MobileHeader';
import { LoadingBlock } from '../components/LoadingBlock';
import { Banner, SyncChip } from '../components/WorkflowBits';
import {
  endSchoolCheckin,
  getOpenSchoolCheckin,
  isCheckinFullySynced,
  listCachedSchools,
  listRecentSchoolCheckins,
  startSchoolCheckin,
} from '../services/db/schoolRepository';
import type { SchoolCheckinLocalRow, SchoolLocalRow } from '../services/db/localSchema';
import { forceSyncNow, subscribeSyncSummary } from '../services/syncScheduler';
import { refreshSchoolCache } from '../services/workflowRefresh';
import { formatManilaDateTime, formatManilaTime, formatMinutes } from '../utils/manilaTime';
import tacticalFeedback from '../utils/tacticalFeedback';

/** The sync chip must not say "Synced" while a check-out is still waiting to be sent. */
const chipRow = (row: SchoolCheckinLocalRow) => ({
  synced: isCheckinFullySynced(row) ? 1 : 0,
  permanent_failure: row.permanent_failure,
});

const SchoolCheckinPage: React.FC = () => {
  const [schools, setSchools] = useState<SchoolLocalRow[]>([]);
  const [open, setOpen] = useState<SchoolCheckinLocalRow | null>(null);
  const [history, setHistory] = useState<SchoolCheckinLocalRow[]>([]);
  const [schoolId, setSchoolId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'info' | 'warning' | 'critical'; text: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [cached, current, recent] = await Promise.all([
        listCachedSchools(),
        getOpenSchoolCheckin(),
        listRecentSchoolCheckins(),
      ]);
      setSchools(cached);
      setOpen(current);
      setHistory(recent);
      setLoadError(null);
    } catch {
      setLoadError('Could not read check-ins from this phone.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await reload();
      if (!cancelled) setLoading(false);
    })();
    const unsubscribe = subscribeSyncSummary(() => void reload());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [reload]);

  async function handleCheckIn() {
    const school = schools.find((s) => String(s.school_id) === schoolId);
    if (!school) {
      setNote({ tone: 'warning', text: 'Choose a school first.' });
      return;
    }
    setBusy(true);
    setNote(null);
    tacticalFeedback.onTap();
    try {
      await startSchoolCheckin({ schoolId: school.school_id, name: school.name });
      tacticalFeedback.onSuccess();
      setSchoolId('');
      setNote({ tone: 'success', text: `Checked in at ${school.name}. Saved on this phone; it will sync when connected.` });
      await reload();
      void forceSyncNow();
    } catch (err) {
      tacticalFeedback.onWarning();
      setNote({ tone: 'critical', text: err instanceof Error ? err.message : 'Could not save the check-in.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckOut() {
    if (!open) return;
    setBusy(true);
    setNote(null);
    tacticalFeedback.onTap();
    try {
      await endSchoolCheckin(open.local_id);
      tacticalFeedback.onSuccess();
      setNote({ tone: 'success', text: 'Checked out. Saved on this phone; it will sync when connected.' });
      await reload();
      void forceSyncNow();
    } catch (err) {
      tacticalFeedback.onWarning();
      setNote({ tone: 'critical', text: err instanceof Error ? err.message : 'Could not save the check-out.' });
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshSchools() {
    setRefreshing(true);
    setNote(null);
    const ok = await refreshSchoolCache({ force: true });
    await reload();
    setNote(
      ok
        ? { tone: 'success', text: 'School list updated.' }
        : { tone: 'warning', text: 'Could not download the school list. Connect to the workstation and try again.' }
    );
    setRefreshing(false);
  }

  const duration = (row: SchoolCheckinLocalRow): string | null => {
    if (!row.checked_out_at) return null;
    const mins = Math.round((new Date(row.checked_out_at).getTime() - new Date(row.checked_in_at).getTime()) / 60000);
    return mins > 0 ? formatMinutes(mins) : null;
  };

  return (
    <IonPage>
      <MobileHeader title="School Check-in" showBack defaultBackHref="/tabs/profile" />
      <IonContent style={{ '--background': 'var(--color-bg)' }}>
        <div className="wf-page" style={{ paddingBottom: 28 }}>
          {note && <Banner tone={note.tone}>{note.text}</Banner>}
          {loadError && <Banner tone="critical">{loadError}</Banner>}

          {loading ? (
            <LoadingBlock label="Loading…" />
          ) : open ? (
            <div className="wf-card">
              <div className="wf-card__head">
                <div>
                  <h3 className="wf-card__title">Checked in at {open.school_name}</h3>
                  <p className="wf-card__sub">Since {formatManilaTime(open.checked_in_at)}</p>
                </div>
                <SyncChip row={chipRow(open)} />
              </div>
              <button type="button" className="dispatch-primary-cta dispatch-primary-cta--green" onClick={handleCheckOut} disabled={busy}>
                {busy ? <IonSpinner name="dots" /> : (
                  <>
                    <IonIcon icon={logOutOutline} style={{ fontSize: '1.2rem' }} />
                    <span>Check Out</span>
                  </>
                )}
              </button>
            </div>
          ) : schools.length === 0 ? (
            <div className="wf-card" style={{ alignItems: 'center', textAlign: 'center' }}>
              <h3 className="wf-card__title">No schools saved on this phone</h3>
              <p className="wf-card__sub">
                The school list downloads automatically when you are connected. If your barangay has schools registered
                and none appear, ask the desk to add them.
              </p>
              <button type="button" className="wf-btn" onClick={handleRefreshSchools} disabled={refreshing}>
                {refreshing ? <IonSpinner name="dots" /> : <span>Download school list</span>}
              </button>
            </div>
          ) : (
            <div className="wf-card">
              <div className="wf-card__head">
                <div>
                  <h3 className="wf-card__title">Check in at a school</h3>
                  <p className="wf-card__sub">Works without a signal. Your location is not recorded.</p>
                </div>
                <IonIcon icon={schoolOutline} style={{ fontSize: '1.4rem', color: 'var(--color-primary)' }} />
              </div>
              <div className="wf-field">
                <label className="wf-label" htmlFor="checkin-school">
                  School
                </label>
                <select
                  id="checkin-school"
                  className="wf-select"
                  value={schoolId}
                  onChange={(e) => setSchoolId(e.target.value)}
                  disabled={busy}
                >
                  <option value="">Select a school…</option>
                  {schools.map((s) => (
                    <option key={s.school_id} value={String(s.school_id)}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="dispatch-primary-cta dispatch-primary-cta--blue"
                onClick={handleCheckIn}
                disabled={busy || !schoolId}
              >
                {busy ? <IonSpinner name="dots" /> : (
                  <>
                    <IonIcon icon={logInOutline} style={{ fontSize: '1.2rem' }} />
                    <span>Check In</span>
                  </>
                )}
              </button>
              <button type="button" className="wf-btn wf-btn--small" onClick={handleRefreshSchools} disabled={refreshing}>
                {refreshing ? <IonSpinner name="dots" /> : <span>Refresh school list</span>}
              </button>
            </div>
          )}

          {!loading && history.length > 0 && (
            <div className="wf-stack">
              <span className="intake-block-title">Recent check-ins</span>
              {history.map((row) => (
                <div key={row.local_id} className="wf-entry">
                  <div className="wf-row wf-row--between">
                    <strong style={{ fontSize: '0.88rem' }}>{row.school_name}</strong>
                    <SyncChip row={chipRow(row)} />
                  </div>
                  <span className="wf-muted">
                    In {formatManilaDateTime(row.checked_in_at)}
                    {row.checked_out_at ? ` · Out ${formatManilaTime(row.checked_out_at)}` : ' · still checked in'}
                    {duration(row) ? ` · ${duration(row)}` : ''}
                  </span>
                  {row.last_sync_error && !isCheckinFullySynced(row) && (
                    <span className="wf-muted">The desk could not save this yet: {row.last_sync_error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </IonContent>
    </IonPage>
  );
};

export default SchoolCheckinPage;
