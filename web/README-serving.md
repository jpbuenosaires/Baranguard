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

Instead of a vhost, `C:\xampp\htdocs\baranguard` and
`C:\xampp\htdocs\baranguard-api` are Windows directory junctions pointing
at this repo's `web/` and `backend/public/` respectively — no file copy,
edits in the repo show up immediately. Recreate them if the repo ever
moves:

```
New-Item -ItemType Junction -Path "C:\xampp\htdocs\baranguard" -Target "<repo>\web"
New-Item -ItemType Junction -Path "C:\xampp\htdocs\baranguard-api" -Target "<repo>\backend\public"
```

With Apache running, open `http://localhost/baranguard/`.
`index.html`'s asset paths (`src/...`, `vendor/...`) are relative, not
root-absolute, specifically so this works from the `/baranguard/`
subfolder instead of only from a vhost root — don't change them back to
`/src/...` without re-checking this.

## Pointing the dashboard at the right API

`index.html` sets `window.BARANGUARD_API_BASE_URL` before `main.js` runs.
It defaults to `http://localhost/baranguard-api/api/v1` (Option C above).
If you're running the API a different way — the PHP built-in server
(`http://127.0.0.1:8080/api/v1`) or a named vhost
(`http://baranguard.local/api/v1`) — edit that one line in `index.html`
to match.

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
