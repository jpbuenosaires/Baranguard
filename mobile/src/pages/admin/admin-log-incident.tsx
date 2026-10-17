/**
 * admin-log-incident.tsx — Chief Tanod console: log an incident reported by phone call,
 * Facebook message, walk-in or SMS. The report is saved on the phone first and sent
 * when there is a connection, so it is never lost to a dead signal. The narrative
 * is typed here and never shown back (Rule 1).
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IonContent, IonPage } from '@ionic/react';
import MobileHeader from '../../components/MobileHeader';
import { Banner, Button } from '../../components/ui';
import { humanize } from '../../components/adminFormat';
import { INCIDENT_TYPES } from '../../services/db/incidentRepository';
import {
  countUnsentAdminIncidents,
  flushAdminIncidentOutbox,
  submitAdminIncident,
} from '../../services/adminIncidentOutbox';

const PRIORITIES = ['normal', 'high', 'critical'] as const;
const CHANNELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'phone_call', label: 'Phone call' },
  { value: 'facebook', label: 'Facebook message' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'sms', label: 'SMS' },
  { value: 'other', label: 'Other' },
];

const AdminLogIncidentPage: React.FC = () => {
  const navigate = useNavigate();
  const ids = useId();
  const [incidentType, setIncidentType] = useState<string>('disturbance');
  const [priority, setPriority] = useState<string>('normal');
  const [reportChannel, setReportChannel] = useState<string>('phone_call');
  const [location, setLocation] = useState('');
  const [complainant, setComplainant] = useState('');
  const [narrative, setNarrative] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [unsent, setUnsent] = useState(0);

  const refreshUnsent = useCallback(() => {
    void countUnsentAdminIncidents().then(setUnsent).catch(() => undefined);
  }, []);

  useEffect(() => {
    // Try anything left over from an earlier signal loss as soon as this screen opens.
    void flushAdminIncidentOutbox().finally(refreshUnsent);
  }, [refreshUnsent]);

  const valid = narrative.trim().length > 0;

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitAdminIncident({
        incidentType,
        priority,
        reportChannel,
        locationDescription: location,
        complainantName: complainant,
        narrative,
      });
      setNarrative('');
      setLocation('');
      setComplainant('');
      if (result.waiting > 0) {
        setNotice({ tone: 'warning', text: 'Saved on this phone. It will be sent when the connection returns.' });
      } else if (result.refused > 0) {
        setNotice({ tone: 'error', text: 'Saved on this phone, but the workstation refused it. Check the entries and try again from the web.' });
      } else {
        setNotice({ tone: 'success', text: 'Incident logged. It is now in the queue for dispatch.' });
      }
    } catch {
      setNotice({ tone: 'error', text: 'Could not save the report on this phone.' });
    } finally {
      setBusy(false);
      refreshUnsent();
    }
  }

  return (
    <IonPage>
      <MobileHeader title="Log an incident" subtitle="Chief Tanod Console" hideStatusIndicator />
      <IonContent>
        <div className="wf-page">
          {unsent > 0 && (
            <Banner tone="warning">
              {unsent} report{unsent === 1 ? '' : 's'} saved on this phone and not yet sent.
            </Banner>
          )}
          {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

          <div className="wf-field">
            <label className="wf-label" htmlFor={`${ids}-type`}>Incident type</label>
            <select id={`${ids}-type`} className="wf-select" value={incidentType} onChange={(e) => setIncidentType(e.target.value)}>
              {INCIDENT_TYPES.map((t) => (
                <option key={t} value={t}>{humanize(t)}</option>
              ))}
            </select>
          </div>
          <div className="wf-field">
            <label className="wf-label" htmlFor={`${ids}-priority`}>Priority</label>
            <select id={`${ids}-priority`} className="wf-select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{humanize(p)}</option>
              ))}
            </select>
          </div>
          <div className="wf-field">
            <label className="wf-label" htmlFor={`${ids}-channel`}>How it was reported</label>
            <select id={`${ids}-channel`} className="wf-select" value={reportChannel} onChange={(e) => setReportChannel(e.target.value)}>
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="wf-field">
            <label className="wf-label" htmlFor={`${ids}-loc`}>Place or landmark</label>
            <input id={`${ids}-loc`} className="wf-input" maxLength={255} placeholder="e.g. Purok 3, near the barangay hall" value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div className="wf-field">
            <label className="wf-label" htmlFor={`${ids}-who`}>Caller or reporter (optional)</label>
            <input id={`${ids}-who`} className="wf-input" maxLength={255} value={complainant} onChange={(e) => setComplainant(e.target.value)} />
          </div>
          <div className="wf-field">
            <label className="wf-label" htmlFor={`${ids}-text`}>What was reported</label>
            <textarea id={`${ids}-text`} className="wf-input" rows={5} value={narrative} onChange={(e) => setNarrative(e.target.value)} />
          </div>

          <Button onClick={() => void save()} disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Save incident'}
          </Button>
          <div className="admin-more">
            <Button variant="secondary" onClick={() => navigate('/tabs/incidents')}>
              Back to incidents
            </Button>
          </div>
        </div>
      </IonContent>
    </IonPage>
  );
};

export default AdminLogIncidentPage;
