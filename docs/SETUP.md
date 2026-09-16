# Setting up Baranguard on a new machine (backend + web)

This covers getting the **backend API** and **web dashboard** running
from a fresh `git clone`, for local-only development (everything reached
via `localhost`). It does not cover the mobile Android app (Ionic +
Capacitor + Android Studio + Gradle is a separate, heavier setup — see
`docs/HANDOFF.md`'s "Operational quick reference" for the mobile build
commands once you need them) or remote/production deployment.

Every step below was actually run against a disposable database as part
of writing this doc — not just described from memory.

## 1. Prerequisites

- **XAMPP** (Apache + MariaDB + PHP 8.2). Only MariaDB and the `mysql`
  CLI are strictly required by the steps below — the backend and web
  dashboard are both run via PHP's own built-in server (`php -S`), so no
  Apache vhost editing is required to get started. See
  `backend/scripts/README-serving.md` / `web/README-serving.md` if you
  want to serve through Apache instead (closer to how the real
  deployment runs), including the htdocs-junction / vhost options.
- **Node.js** (LTS) — the API itself is pure PHP, but `backend/`'s own
  CLI tooling (`bootstrap-admin.js`, the AI worker's Node-side pieces)
  needs it.
- **Git**.

Not needed for this backend+web setup, and safe to skip for now:
Android Studio/JDK/Gradle (mobile only), Ollama (AI features degrade to
`not_configured`, see step 5), an ORS API key, Firebase, Semaphore.

## 2. Clone and start MariaDB

```bash
git clone <this repo's URL>
cd Baranguard
```

Start XAMPP's MySQL/MariaDB service (XAMPP Control Panel, or
`cmd //c "C:\xampp\mysql_start.bat"` from Git Bash).

## 3. Bootstrap the database

```bash
bash backend/scripts/bootstrap-db.sh
```

This creates the `baranguard` database, applies every migration
`0001`..`0021` in order, and creates a least-privileged `baranguard_app`
DB user (SELECT/INSERT/UPDATE/DELETE only — no CREATE/ALTER, matching
`docs/REFERENCE.md` §8's stated policy; migrations themselves run as
XAMPP's root/no-password account, same convention every `verify-*.sh`
script already uses). It refuses to run if a `baranguard` database
already exists, rather than risk touching real data — see the script's
own header comment for overriding the database name/credentials.

It prints the exact `DB_*` values to put in `.env` next, including a
freshly generated password — copy them somewhere before closing the
terminal.

## 4. Configure `backend/.env`

```bash
cp backend/.env.example backend/.env
```

Fill in the `DB_*` values from step 3, then generate the three required
secrets (each has the exact command in `.env.example`'s own comments):

- `JWT_SECRET`
- `INTERNAL_SERVICE_TOKEN`
- `DEVICE_SECRET_MASTER_KEY`

Leave `OLLAMA_URL`/`ORS_API_KEY`/`FCM_SERVICE_ACCOUNT_PATH`/
`SEMAPHORE_API_KEY` blank unless you're specifically setting up AI,
routing, push, or SMS — each degrades to an honest `not_configured`
state rather than breaking anything (§2 Rule 6). `CORS_ALLOWED_ORIGIN`
can stay `*` for local-only dev.

## 5. Install backend Node dependencies and create your first login

```bash
cd backend
npm install
node scripts/bootstrap-admin.js
```

This is an interactive prompt (barangay, username, full name, password)
that creates the **one-time first Admin account** for whichever barangay
you pick. There is no seed data / demo login shipped in this repo (§8
production-realism rule) — this is the only way to get a working
account.

## 6. Run the API

```bash
cd backend/public
php -S 127.0.0.1:8081
```

Verify it's up: `curl -X POST http://127.0.0.1:8081/api/v1/auth/login -H "Content-Type: application/json" -d "{\"username\":\"<yours>\",\"password\":\"<yours>\"}"`
should return a token.

(To serve through Apache instead, matching how the real deployment runs:
`backend/scripts/README-serving.md` Option A.)

## 7. Run the web dashboard

```bash
cd web
php -S 127.0.0.1:5173
```

Open `http://127.0.0.1:5173/`. By default `web/index.html` points at
`http://localhost:8081/api/v1` (matches step 6). If you ran the API on a
different port/host, open the dashboard with an
`?api_base=http://host:port/api/v1` query param once — it saves to
`localStorage` and strips itself from the URL bar, so you don't need to
edit `index.html` (see that file's own comment for why this exists: the
API address is expected to change per machine and there's no build step
to inject an env var).

Log in with the account from step 5.

## 8. What's optional, and what it looks like when it's not configured

| Feature | Env var(s) | If left blank |
|---|---|---|
| AI redaction/drafting/tools (Ollama) | `OLLAMA_URL`, `OLLAMA_MODEL` | `GET /system/health` reports `ollama: not_configured`; redaction requests 503 instead of queueing |
| Turn-by-turn routing | `ORS_API_KEY` | `ors: not_configured`; a dispatch's route stays `route_status: unavailable`, external nav link still works |
| Push notifications (FCM) | `FCM_SERVICE_ACCOUNT_PATH` | `fcm: not_configured`; notifications fall straight to SMS |
| SMS gateway (Semaphore) | `SEMAPHORE_API_KEY` | `semaphore: not_configured`; SMS attempts recorded as `failed` (`SEMAPHORE_NOT_CONFIGURED`), not silently dropped |
| Remote access beyond your LAN | — | Not built by default (see below) — everything above assumes `localhost`/LAN reachability |

None of these block backend+web development. Every screen has a real
"not configured" state per §2 Rule 6 — there's nothing faked to make an
unconfigured integration look like it's working.

## 9. Remote access (temporary testing only)

The base architecture is LAN-only (`docs/REFERENCE.md` §1) — there is no
persistent remote-access mechanism configured by default. For temporary
testing from off-network, a Cloudflare Quick Tunnel can front the API:

```bash
cloudflared tunnel --url http://localhost:8081
```

This needs no Cloudflare account, but its hostname is **random and
changes every time you run it**, and it has **no authentication in front
of it** — anyone who obtains the URL can reach the API, relying solely on
the app's own login. Treat it as a disposable testing convenience, never
a production access path. Point the web dashboard at it with
`?api_base=https://<whatever-it-printed>/api/v1` (step 7), and add that
same origin to `backend/.env`'s `CORS_ALLOWED_ORIGIN` if you need the
dashboard itself loaded from somewhere other than `localhost` too.

## 10. Verify

- `GET http://127.0.0.1:8081/api/v1/barangays` — should list the 4
  barangays with no auth needed.
- Log into the web dashboard (step 7) and confirm the header shows a
  real `system/health` probe result, not a static badge.
