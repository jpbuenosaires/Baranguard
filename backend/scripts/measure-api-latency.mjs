// measure-api-latency.mjs — times key READ endpoints for the thesis (ISO/IEC 25010
// Performance Efficiency, "time behaviour"). Node >= 18, no install.
//
//   BG_USER=admin.dao BG_PASS=... node backend/scripts/measure-api-latency.mjs \
//        --base=http://localhost:8081/api/v1 [--n=30] [--warmup=3] [--json]
//
// - Logs in ONCE (repeated logins trip the lockout), then does only GET requests
//   one after another, so it adds no data and no concurrency.
// - Credentials come from the environment so they do not land in shell history.
// - Reports median / p95 / max in milliseconds per endpoint, plus failures.
//   What it measures: round trip as seen from the machine running this script
//   (network + server). Run it ON the workstation for server-side time, and
//   from a second device over the LAN or the tunnel for what users experience.
// - It does not measure the dashboard's 15 s poll, rendering, or load from many
//   users; say so in the thesis and state N and the machine used.

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
  })
);
const base = String(args.base || 'http://localhost:8081/api/v1').replace(/\/$/, '');
const n = Math.max(5, parseInt(args.n || '30', 10));
const warmup = Math.max(0, parseInt(args.warmup || '3', 10));
const user = process.env.BG_USER;
const pass = process.env.BG_PASS;
if (!user || !pass) {
  console.error('Set BG_USER and BG_PASS in the environment (an Admin account; not stored anywhere).');
  process.exit(1);
}
if (/baranguardph\.win/.test(base) && n > 50) {
  console.error('Refusing n > 50 against the public host.');
  process.exit(1);
}

const ENDPOINTS = [
  ['GET /gps/live', '/gps/live?barangay_id=1'],
  ['GET /incidents', '/incidents'],
  ['GET /dispatch', '/dispatch'],
  ['GET /reports/summary', '/reports/summary'],
  ['GET /reports/heatmap', '/reports/heatmap'],
];

const pct = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))] : null);
const round = (x) => (x === null ? null : Math.round(x * 10) / 10);

const t0 = performance.now();
const loginRes = await fetch(base + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const loginMs = performance.now() - t0;
if (!loginRes.ok) {
  console.error(`Login failed (HTTP ${loginRes.status}). Not retrying, to avoid locking the account.`);
  process.exit(1);
}
const { token, user: me } = await loginRes.json();
const headers = { Authorization: `Bearer ${token}` };

const results = [];
for (const [label, path] of ENDPOINTS) {
  const times = [];
  let failures = 0;
  const statuses = new Set();
  for (let i = 0; i < warmup + n; i++) {
    const s = performance.now();
    let ok = false;
    try {
      const r = await fetch(base + path, { headers });
      await r.arrayBuffer(); // include body transfer
      statuses.add(r.status);
      ok = r.ok;
    } catch {
      statuses.add('network');
    }
    const ms = performance.now() - s;
    if (i >= warmup) {
      if (ok) times.push(ms);
      else failures++;
    }
  }
  times.sort((a, b) => a - b);
  results.push({ endpoint: label, n: times.length, failures, statuses: [...statuses], median_ms: round(pct(times, 50)), p95_ms: round(pct(times, 95)), max_ms: round(times[times.length - 1] ?? null) });
}

const out = { base, role: me?.role, n, warmup, login_ms: round(loginMs), generated_utc: new Date().toISOString(), results };
if (args.json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`API latency — ${base} — role ${out.role} — ${n} requests per endpoint after ${warmup} warm-up (login ${out.login_ms} ms, single sample)`);
  for (const r of results) {
    const f = (x) => String(x ?? 'n/a').padStart(7);
    console.log(`  ${r.endpoint.padEnd(24)} median ${f(r.median_ms)} ms   p95 ${f(r.p95_ms)} ms   max ${f(r.max_ms)} ms   failures ${r.failures}   HTTP ${r.statuses.join(',')}`);
  }
  console.log('  Note: round trip from this machine; state N and where it was run when citing.');
}
