/**
 * sosEnvelopeCore.ts — pure (no Capacitor, no storage) construction of the
 * §6 SMS envelope for an SOS, so it can be unit-verified in plain Node.
 *
 * WHY THIS EXISTS: when the workstation API is unreachable but cellular SMS
 * still works (partial outage), the Tanod app texts this envelope to the GSM
 * gateway phone's SIM. `gsm-ingest-daemon.php` reads it off that phone and
 * forwards it to `POST /internal/sms/sos`, where `SmsGatewayService` decrypts
 * it and creates the SOS through `TanodSosController::createItem()` with
 * `fallback_channel = 'sms'`. The server half was built and verified long
 * before the app could send it (see `smsFallbackState.ts` history); this is
 * the missing mobile half.
 *
 * WIRE FORMAT = `backend/services/sms/EnvelopeCrypto.php` +
 * `backend/scripts/sms-envelope-build.php`, byte for byte:
 *  - version '1'; message_id and client_event_id are UUIDs;
 *  - created_at / expiry are `YYYY-MM-DDTHH:MM:SSZ` strings, used verbatim in
 *    the AAD (the server rebuilds the AAD from the same raw strings);
 *  - AAD = version|message_id|device_id|client_event_id|created_at|expiry|type;
 *  - AES-256-GCM, 12-byte nonce, 16-byte tag, key = the 32 raw bytes from
 *    `POST /devices/register` (stored base64 by `messageEncryptionKey.ts`);
 *  - nonce / ciphertext / tag are separate base64 fields. WebCrypto returns
 *    ciphertext||tag in one buffer, so the last 16 bytes are split off.
 *
 * The server enforces: expiry - created_at <= 1800 s, created_at not more
 * than 300 s in the future, not expired, message_id never seen before.
 * A phone with a badly wrong clock will therefore be rejected (by design).
 */

const TAG_BYTES = 16;
const NONCE_BYTES = 12;
/** Server cap is 1800 s; stay under it so a rounding edge can never trip it. */
export const SOS_ENVELOPE_TTL_SECONDS = 1500;

export interface SosEnvelopeInput {
  /** Base64 of the 32 raw key bytes, exactly as stored by messageEncryptionKey.ts. */
  keyBase64: string;
  deviceId: string;
  /** Must equal the SOS's client_event_id so the later queued sync dedupes against it. */
  clientEventId: string;
  latitude?: number;
  longitude?: number;
  dispatchId?: number;
  /** Injectable for tests. */
  now?: Date;
  messageId?: string;
}

export interface SosEnvelope {
  version: string;
  message_id: string;
  device_id: string;
  client_event_id: string;
  created_at: string;
  expiry: string;
  message_type: 'sos';
  nonce: string;
  ciphertext: string;
  tag: string;
}

export function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** `2026-10-10T08:00:00Z` — no milliseconds, matching PHP's gmdate('Y-m-d\TH:i:s\Z'). */
export function formatEnvelopeTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildAad(
  version: string,
  messageId: string,
  deviceId: string,
  clientEventId: string,
  createdAt: string,
  expiry: string,
  messageType: string
): string {
  return [version, messageId, deviceId, clientEventId, createdAt, expiry, messageType].join('|');
}

export async function buildSosEnvelope(input: SosEnvelopeInput): Promise<SosEnvelope> {
  const rawKey = base64ToBytes(input.keyBase64);
  if (rawKey.length !== 32) {
    throw new Error('Message encryption key is not 32 bytes.');
  }

  const version = '1';
  const messageType = 'sos';
  const messageId = input.messageId ?? crypto.randomUUID();
  const now = input.now ?? new Date();
  const createdAt = formatEnvelopeTime(now);
  const expiry = formatEnvelopeTime(new Date(now.getTime() + SOS_ENVELOPE_TTL_SECONDS * 1000));

  // Only what the server reads (SmsGatewayService::receiveSos): coordinates
  // when there is a fix, and an optional dispatch_id. Kept minimal on purpose:
  // every extra byte is another SMS segment that must arrive intact.
  const payload: Record<string, number> = {};
  if (input.latitude !== undefined && input.longitude !== undefined) {
    payload.latitude = Number(input.latitude.toFixed(6));
    payload.longitude = Number(input.longitude.toFixed(6));
  }
  if (input.dispatchId !== undefined) payload.dispatch_id = input.dispatchId;

  const aad = buildAad(version, messageId, input.deviceId, input.clientEventId, createdAt, expiry, messageType);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad), tagLength: TAG_BYTES * 8 },
      key,
      new TextEncoder().encode(JSON.stringify(payload))
    )
  );

  return {
    version,
    message_id: messageId,
    device_id: input.deviceId,
    client_event_id: input.clientEventId,
    created_at: createdAt,
    expiry,
    message_type: 'sos',
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(sealed.slice(0, sealed.length - TAG_BYTES)),
    tag: bytesToBase64(sealed.slice(sealed.length - TAG_BYTES)),
  };
}
