/**
 * sosEnvelope.ts — loads this device's identity and key, then builds the
 * encrypted SOS envelope text (see `sosEnvelopeCore.ts` for the wire format
 * and why). Returns null when this device cannot produce an envelope the
 * server would accept (never registered, no key issued) — the caller then
 * simply skips the gateway SMS; the plain-text backup-contact SMS and the
 * offline queue are unaffected.
 */

import { getDeviceId } from './deviceIdentity';
import { getMessageEncryptionKey } from './messageEncryptionKey';
import { buildSosEnvelope } from './sosEnvelopeCore';

export async function buildSosEnvelopeText(options: {
  clientEventId: string;
  latitude?: number;
  longitude?: number;
}): Promise<string | null> {
  const keyBase64 = await getMessageEncryptionKey();
  if (!keyBase64) return null;
  const deviceId = await getDeviceId();
  const envelope = await buildSosEnvelope({ keyBase64, deviceId, ...options });
  return JSON.stringify(envelope);
}
