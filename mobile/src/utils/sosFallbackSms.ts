import { getCachedSosFallbackContact, getCachedSosGatewayNumber } from '../services/sosFallbackContact';
import SosSms from '../services/sosSms';
import { buildSosEnvelopeText } from '../services/sosEnvelope';
import { loadSession } from '../services/session';
import type { SmsFallbackInput } from '../services/smsFallbackState';
import { barangayLabel } from './homeDuty';

export interface SosFallbackResult {
  outcome: SmsFallbackInput;
  toast: string;
}

/** Offline SOS: text the gateway (encrypted envelope) and/or the backup contact. */
export async function runSosSmsFallback(
  payload: { latitude?: number; longitude?: number },
  clientEventId: string
): Promise<SosFallbackResult> {
  const backupNumber = await getCachedSosFallbackContact();
  const gatewayNumber = await getCachedSosGatewayNumber();
  if (!backupNumber && !gatewayNumber) {
    return {
      outcome: { reachedWorkstation: false, smsAttempted: false, smsStatus: null },
      toast: 'SOS saved locally — will dispatch automatically upon reconnect. (No backup contact configured.)',
    };
  }

  // Tier A — encrypted envelope to the command-center gateway phone. If the
  // workstation is up but only the app's internet path is down, the gateway's
  // ingest daemon turns this into a real SOS on the dashboard. Uses the same
  // client_event_id as the queued SOS, so the later sync cannot double it.
  let gatewaySent = false;
  if (gatewayNumber) {
    try {
      const envelopeText = await buildSosEnvelopeText({ clientEventId, ...payload });
      if (envelopeText) {
        await SosSms.sendDirect({ number: gatewayNumber, message: envelopeText });
        gatewaySent = true;
      }
    } catch {
      // Falls through to the plain-text contact below; never blocks it.
    }
  }

  // Tier B — plain-text SMS to a human-monitored number. Independent of the
  // workstation entirely (survives the workstation itself being down).
  if (!backupNumber) {
    return {
      outcome: { reachedWorkstation: false, smsAttempted: true, smsStatus: gatewaySent ? 'sent' : 'failed' },
      toast: gatewaySent
        ? 'Internet unreachable — SOS texted to the command center gateway.'
        : 'SOS saved locally. Gateway SMS could not be sent.',
    };
  }
  try {
    const session = await loadSession();
    const bName = session ? barangayLabel(session.barangayId) : 'Unknown';
    const hasFix = payload.latitude !== undefined && payload.longitude !== undefined;
    const message = [
      'BARANGUARD EMERGENCY SOS',
      `Tanod: ${session?.fullName ?? 'Unknown'} (Brgy ${bName})`,
      hasFix
        ? `Location: ${payload.latitude!.toFixed(5)}, ${payload.longitude!.toFixed(5)}`
        : 'Location: unavailable (no GPS fix)',
      hasFix ? `Map: https://maps.google.com/?q=${payload.latitude},${payload.longitude}` : null,
      `Time: ${new Date().toLocaleString()}`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    await SosSms.sendDirect({ number: backupNumber, message });
    return {
      outcome: { reachedWorkstation: false, smsAttempted: true, smsStatus: 'sent' },
      toast: gatewaySent
        ? 'Internet unreachable — SOS texted to the command center gateway and the backup contact.'
        : 'Workstation unreachable — emergency SMS sent directly to backup contact.',
    };
  } catch (smsError) {
    // Honest status: "sent" if the gateway text went out even though the
    // backup-contact text failed; "failed" only when nothing was sent.
    return {
      outcome: { reachedWorkstation: false, smsAttempted: true, smsStatus: gatewaySent ? 'sent' : 'failed' },
      toast: gatewaySent
        ? 'SOS texted to the command center gateway. Backup contact SMS failed.'
        : smsError instanceof Error
          ? `SOS saved locally. Backup SMS also failed: ${smsError.message}`
          : 'SOS saved locally. Backup SMS also failed.',
    };
  }
}
