import { getCachedSosFallbackContact, getCachedSosGatewayNumber } from '../services/sosFallbackContact';
import SosSms from '../services/sosSms';
import { buildSosEnvelopeText } from '../services/sosEnvelope';
import { loadSession } from '../services/session';
import type { SmsFallbackInput } from '../services/smsFallbackState';
import { barangayLabel } from './homeDuty';

/** Accents to the base letter (José -> Jose), anything else outside GSM-7 dropped, so the text stays in few segments. ñ/Ñ are GSM-7 and kept. */
export function toGsm7(text: string): string {
  return text
    .replace(/[ñ]/g, '\u0001n')
    .replace(/[Ñ]/g, '\u0001N')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001n/g, 'ñ')
    .replace(/\u0001N/g, 'Ñ')
    .replace(/[^\x20-\x7E\nñÑ]/g, '');
}

/** Fixed Asia/Manila (+08:00) `YYYY-MM-DD HH:mm`, ASCII only: toLocaleString() depends on the phone's locale and can emit a non-GSM space. */
export function manilaStamp(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

type SendOutcome = { kind: 'sent' } | { kind: 'timeout' } | { kind: 'failed'; error?: string };

/** One SMS send, capped: Android may take a minute to report a result on a frozen radio. */
const SEND_TIMEOUT_MS = 20000;
async function sendOne(send: () => Promise<unknown>): Promise<SendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      send(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), SEND_TIMEOUT_MS);
      }),
    ]);
    return { kind: 'sent' };
  } catch (e) {
    if (e instanceof Error && e.message === 'timeout') return { kind: 'timeout' };
    return { kind: 'failed', error: e instanceof Error ? e.message : undefined };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

  const session = await loadSession();
  const bName = session ? barangayLabel(session.barangayId) : 'Unknown';
  const hasFix = payload.latitude !== undefined && payload.longitude !== undefined;
  const backupMessage = [
    'BARANGUARD EMERGENCY SOS',
    `Tanod: ${toGsm7(session?.fullName ?? 'Unknown')} (Brgy ${bName})`,
    hasFix
      ? `Location: ${payload.latitude!.toFixed(5)}, ${payload.longitude!.toFixed(5)}`
      : 'Location: unavailable (no GPS fix)',
    hasFix ? `Map: https://maps.google.com/?q=${payload.latitude},${payload.longitude}` : null,
    `Time: ${manilaStamp()}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  // Both texts go out AT ONCE: the human-monitored backup contact must never wait behind
  // the gateway text (a slow radio can take a minute to report), and each send is capped.
  // Tier A — encrypted envelope to the command-center gateway phone. If the
  // workstation is up but only the app's internet path is down, the gateway's
  // ingest daemon turns this into a real SOS on the dashboard. Uses the same
  // client_event_id as the queued SOS, so the later sync cannot double it.
  // Tier B — plain-text SMS to a human-monitored number. Independent of the
  // workstation entirely (survives the workstation itself being down).
  const [gateway, backup] = await Promise.all([
    gatewayNumber
      ? sendOne(async () => {
          const envelopeText = await buildSosEnvelopeText({ clientEventId, ...payload });
          if (!envelopeText) throw new Error('No message key on this device.');
          return SosSms.sendDirect({ number: gatewayNumber, message: envelopeText });
        })
      : Promise.resolve<SendOutcome | null>(null),
    backupNumber ? sendOne(() => SosSms.sendDirect({ number: backupNumber, message: backupMessage })) : Promise.resolve<SendOutcome | null>(null),
  ]);

  const attempted = [gateway, backup].filter((r): r is SendOutcome => r !== null);
  const anySent = attempted.some((r) => r.kind === 'sent');
  const anyUnconfirmed = attempted.some((r) => r.kind === 'timeout');
  const smsStatus: 'sent' | 'pending' | 'failed' = anySent ? 'sent' : anyUnconfirmed ? 'pending' : 'failed';
  const outcome = { reachedWorkstation: false, smsAttempted: true, smsStatus };

  const ok = (r: SendOutcome | null) => r?.kind === 'sent';
  if (ok(gateway) && ok(backup)) {
    return { outcome, toast: 'Internet unreachable — SOS texted to the command center gateway and the backup contact.' };
  }
  if (ok(backup)) {
    return { outcome, toast: 'Workstation unreachable — emergency SMS sent directly to backup contact.' };
  }
  if (ok(gateway)) {
    return { outcome, toast: backupNumber ? 'SOS texted to the command center gateway. Backup contact SMS failed.' : 'Internet unreachable — SOS texted to the command center gateway.' };
  }
  if (anyUnconfirmed) {
    return { outcome, toast: 'SOS saved locally. The SMS was handed to the phone but not confirmed; it may still go out.' };
  }
  const reason = attempted.flatMap((r) => (r.kind === 'failed' && r.error ? [r.error] : []))[0];
  return { outcome, toast: reason ? `SOS saved locally. SMS could not be sent: ${reason}` : 'SOS saved locally. SMS could not be sent.' };
}
