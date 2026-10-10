// verify-sos-envelope.mjs — proves the Tanod app's SOS envelope (sosEnvelopeCore.ts)
// is accepted by the server's rules (SmsGatewayService::resolveAndDecrypt +
// EnvelopeCrypto). Run: node scripts/verify-sos-envelope.mjs   (Node >= 22.18, no install)
//
// 1. Always: re-implements the server's checks with node:crypto and decrypts.
// 2. If `php` is on PATH: ALSO decrypts with the REAL backend/services/sms/EnvelopeCrypto.php.
//    (Skipped, loudly, when php is missing — it is not required for the JS-side checks.)

import { webcrypto, createDecipheriv } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const here = dirname(fileURLToPath(import.meta.url));
const { buildSosEnvelope, buildAad, SOS_ENVELOPE_TTL_SECONDS } = await import('../src/services/sosEnvelopeCore.ts');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyBytes = webcrypto.getRandomValues(new Uint8Array(32));
const keyB64 = Buffer.from(keyBytes).toString('base64');
const clientEventId = webcrypto.randomUUID();
const deviceId = 'and-' + webcrypto.randomUUID();

/** Server-side decrypt, same order of checks as SmsGatewayService::resolveAndDecrypt. */
function serverDecrypt(env, key, nowMs = Date.now()) {
  for (const f of ['version','message_id','device_id','client_event_id','created_at','expiry','message_type','nonce','ciphertext','tag'])
    if (typeof env[f] !== 'string' || env[f] === '') throw new Error('missing ' + f);
  if (!UUID.test(env.message_id) || !UUID.test(env.client_event_id)) throw new Error('uuid');
  if (env.message_type !== 'sos') throw new Error('type');
  const created = Date.parse(env.created_at), expiry = Date.parse(env.expiry);
  if (Number.isNaN(created) || Number.isNaN(expiry)) throw new Error('timestamps');
  if ((expiry - created) / 1000 > 1800) throw new Error('lifetime');
  if (created > nowMs + 300_000) throw new Error('future');
  if (nowMs > expiry) throw new Error('expired');
  const nonce = Buffer.from(env.nonce, 'base64'), tag = Buffer.from(env.tag, 'base64'), ct = Buffer.from(env.ciphertext, 'base64');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('lengths');
  const aad = buildAad(env.version, env.message_id, env.device_id, env.client_event_id, env.created_at, env.expiry, env.message_type);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad)); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString());
}

// --- with a GPS fix
const withFix = await buildSosEnvelope({ keyBase64: keyB64, deviceId, clientEventId, latitude: 12.9167041, longitude: 123.6805, dispatchId: 7 });
const p1 = serverDecrypt(withFix, Buffer.from(keyBytes));
check('envelope decrypts with server rules', p1.latitude === 12.916704 && p1.longitude === 123.6805 && p1.dispatch_id === 7, JSON.stringify(p1));
check('client_event_id carried through (sync will dedupe)', withFix.client_event_id === clientEventId);
check('created_at/expiry are second-precision Z strings', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(withFix.created_at) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(withFix.expiry));
check('lifetime within the 1800 s server cap', (Date.parse(withFix.expiry) - Date.parse(withFix.created_at)) / 1000 === SOS_ENVELOPE_TTL_SECONDS && SOS_ENVELOPE_TTL_SECONDS <= 1800);

// --- no fix
const noFix = await buildSosEnvelope({ keyBase64: keyB64, deviceId, clientEventId: webcrypto.randomUUID() });
const p2 = serverDecrypt(noFix, Buffer.from(keyBytes));
check('no-GPS SOS still builds and decrypts (empty payload)', Object.keys(p2).length === 0);

// --- tampering and wrong key must fail
const swapType = { ...withFix, device_id: 'and-someone-else' };
let threw = false; try { serverDecrypt(swapType, Buffer.from(keyBytes)); } catch { threw = true; }
check('tampered header (device_id) fails authentication', threw);
threw = false; try { serverDecrypt(withFix, Buffer.from(webcrypto.getRandomValues(new Uint8Array(32)))); } catch { threw = true; }
check('wrong key fails authentication', threw);
threw = false; try { serverDecrypt(withFix, Buffer.from(keyBytes), Date.now() + 3_600_000); } catch { threw = true; }
check('expired envelope is rejected by the server rule', threw);
threw = false; try { await buildSosEnvelope({ keyBase64: Buffer.from('short').toString('base64'), deviceId, clientEventId }); } catch { threw = true; }
check('non-32-byte key refuses to build', threw);

// --- SMS size: report segments (GSM-7 160 / 153 per concatenated part)
const text = JSON.stringify(withFix);
const segments = text.length <= 160 ? 1 : Math.ceil(text.length / 153);
check(`envelope text is ASCII and ${text.length} chars (~${segments} SMS segments)`, /^[\x20-\x7e]+$/.test(text) && segments <= 4);

// --- optional: decrypt with the REAL PHP EnvelopeCrypto
const crypto_php = resolve(here, '../../backend/services/sms/EnvelopeCrypto.php');
const php = spawnSync('php', ['-v']);
if (php.status === 0 && existsSync(crypto_php)) {
  const dir = mkdtempSync(join(tmpdir(), 'sosenv-'));
  const script = join(dir, 'check.php');
  writeFileSync(script, `<?php
require ${JSON.stringify(crypto_php.replace(/EnvelopeCrypto\.php$/, 'EnvelopeException.php'))};
require ${JSON.stringify(crypto_php)};
use Baranguard\\Services\\Sms\\EnvelopeCrypto;
$e = json_decode($argv[1], true); $secret = base64_decode($argv[2], true);
$aad = EnvelopeCrypto::buildAad($e['version'], $e['message_id'], $e['device_id'], $e['client_event_id'], $e['created_at'], $e['expiry'], $e['message_type']);
echo json_encode((new EnvelopeCrypto())->decryptPayload($secret, $e['nonce'], $e['ciphertext'], $e['tag'], $aad));`);
  const out = execFileSync('php', [script, JSON.stringify(withFix), keyB64]).toString();
  const got = JSON.parse(out);
  check('REAL PHP EnvelopeCrypto decrypts the JS envelope', got.latitude === 12.916704 && got.dispatch_id === 7, out);
  const out2 = execFileSync('php', [script, JSON.stringify(noFix), keyB64]).toString();
  check('REAL PHP EnvelopeCrypto decrypts the no-fix envelope', out2 === '[]' || out2 === '{}', out2);
} else {
  console.log('SKIP  php not available (or backend not beside mobile/) — PHP interop step not run');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
