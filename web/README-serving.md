# Serving the web dashboard locally

No build step (§1: vanilla JS, no framework, no bundler) — `web/` is
served as static files directly. Two ways to run it locally, mirroring
`backend/scripts/README-serving.md`:

## Option A — a plain static file server (quick local testing)

```
cd web
php -S 127.0.0.1:5173
```

Then open `http://127.0.0.1:5173/` in a browser. `index.html` loads
`src/main.js` as an ES module directly — no build step needed.

## Option B — XAMPP's Apache (matches how this will actually run)

Point a second vhost's `DocumentRoot` at the `web/` folder (separate from
the API's `backend/public` vhost — see `backend/scripts/README-serving.md`),
e.g. `dashboard.baranguard.local`, and add that host entry too.

## Option C — XAMPP htdocs junction (open it directly at localhost)

Instead of a vhost, `C:\xampp\htdocs\baranguard` is a single Windows
directory junction pointing at this repo's ROOT (not just `web/`) — no
file copy, edits in the repo show up immediately. Recreate it if the repo
ever moves:

```
New-Item -ItemType Junction -Path "C:\xampp\htdocs\baranguard" -Target "<repo root>"
```

With Apache running, open `http://localhost/baranguard/web/`. The API is
NOT reached through this same junction — it needs its own Apache
DocumentRoot (`backend/public`) per Option B above, since its front
controller matches `REQUEST_URI` against exactly `/api/v1`, and a
subfolder mount under this junction would 404.

## Pointing the dashboard at the right API

`index.html` resolves `window.BARANGUARD_API_BASE_URL` before `main.js`
runs, in this order: a `?api_base=` query param (saved to `localStorage`,
then stripped from the URL bar) → a previously saved `localStorage`
value → `http://localhost:8081/api/v1` as the built-in default. See the
comment in `index.html` itself for the full reasoning — there's no build
step here to inject an env var, and the right API address is expected to
differ per machine, so nothing is hardcoded for everyone. If the API is
running somewhere else — the PHP built-in server on a different port, a
named vhost, or (temporary testing only) a Cloudflare Quick Tunnel — open
the dashboard once with `?api_base=<that address>/api/v1` instead of
editing this file.

The API's CORS is permissive by default (`CORS_ALLOWED_ORIGIN=*` in
`.env`, §7 Rule — locally hosted, no public internet exposure assumed), so
the dashboard and API can be served from different ports/origins without
extra configuration.

## Test accounts

There is no seed data for the web dashboard — sign in with a real Admin
or Punong Barangay account created via `backend/scripts/bootstrap-admin.js`
(Sprint 0) against whichever database `backend/.env` points at. There are
no demo/test credentials shipped in this repo (§8 production-realism
rule).
