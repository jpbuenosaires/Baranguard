# Setting up Baranguard on a new machine

Every step below was actually run against a disposable database (and, for
the mobile/remote-access stages, this real workstation) as part of
writing this doc — not just described from memory.

**Stages, in order:**

1. [Backend + web](#1-backend--web-required) — required, gets you a
   working local dev environment reachable via `localhost`.
2. [Mobile Android app](#2-mobile-android-app-optional) — optional,
   needed only if you're building/testing the Tanod app.
3. [SMS gateway phone](#3-sms-gateway-phone-optional) — optional, needed
   only for real SMS send/receive via the local GSM gateway.
4. [Remote access beyond your LAN](#4-remote-access-beyond-your-lan-optional)
   — optional, needed only if Tanod/Secretary/PB need to reach the
   system from outside the barangay hall's own network.
5. [Keep services running across reboots](#5-keep-services-running-across-reboots-optional)
   — optional, makes stages 1 and 4's services survive a restart without
   manual intervention.

---

## 1. Backend + web (required)

### 1.1 Prerequisites

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

Not needed for this stage, and safe to skip until you reach the stage
that needs them: Android Studio/JDK/Gradle (stage 2), Ollama (AI
features degrade to `not_configured`, see step 1.8), an ORS API key
(stage 1.4's script asks about this), a Cloudflare account (stage 4), the
GSM SMS gateway phone (stage 3).

### 1.2 Clone and start MariaDB

```bash
git clone <this repo's URL>
cd Baranguard
```

Start XAMPP's MySQL/MariaDB service (XAMPP Control Panel, or
`cmd //c "C:\xampp\mysql_start.bat"` from Git Bash).

### 1.3 Bootstrap the database

```bash
bash backend/scripts/bootstrap-db.sh
```

This creates the `baranguard` database, applies every migration in
`backend/migrations/` in order, and creates a least-privileged
`baranguard_app` DB user (SELECT/INSERT/UPDATE/DELETE only — no
CREATE/ALTER, matching `docs/REFERENCE.md` §8's stated policy;
migrations themselves run as XAMPP's root/no-password account, same
convention every `verify-*.sh` script already uses). It refuses to run
if a `baranguard` database already exists, rather than risk touching
real data — see the script's own header comment for overriding the
database name/credentials.

It prints the exact `DB_*` values to put in `.env` next, including a
freshly generated password — keep this terminal open for step 1.4, or
copy the values somewhere before closing it.

### 1.4 Configure `backend/.env`

```bash
bash backend/scripts/setup-env.sh
```

An interactive script that replaces the old manual "copy `.env.example`,
hand-generate three secrets, paste the DB values" sequence:

- Refuses to run if `backend/.env` already exists (won't overwrite a
  real config).
- Asks for the `DB_NAME`/`DB_USER`/`DB_PASSWORD` step 1.3 printed —
  or skip the prompts entirely by piping them straight in:
  `DB_NAME=baranguard DB_USER=baranguard_app DB_PASSWORD='...' bash backend/scripts/setup-env.sh`
- Auto-generates real values for `JWT_SECRET`, `INTERNAL_SERVICE_TOKEN`,
  and `DEVICE_SECRET_MASTER_KEY` — no command to run by hand for these.
- Asks, one at a time, whether you have an ORS API key, an FCM
  service-account file, or a GSM gateway phone already set up — answer
  no/skip to any of them and that integration is left in its honest
  `not_configured` state (§2 Rule 6), not a fake value. Run it again
  later isn't needed for these specifically — `backend/.env` isn't
  git-tracked, so you can just edit it directly once you do have a key.
- `bash backend/scripts/setup-env.sh --non-interactive` skips every
  prompt (secrets still get generated; every optional integration stays
  blank) — for scripting/CI use.

### 1.5 Install backend Node dependencies and create your first login

```bash
cd backend
npm install
node scripts/bootstrap-admin.js
```

This is an interactive prompt (barangay, username, full name, password)
that creates the **one-time first Admin account** for whichever barangay
you pick. There is no seed data / demo login shipped in this repo (§8
production-realism rule) — this is the only way to get a working
account. (Deliberately NOT automated — it's the one account this repo
has no safe default for.)

### 1.6 Run the API

```bash
cd backend/public
php -S 127.0.0.1:8081
```

Verify it's up: `curl -X POST http://127.0.0.1:8081/api/v1/auth/login -H "Content-Type: application/json" -d "{\"username\":\"<yours>\",\"password\":\"<yours>\"}"`
should return a token.

(To serve through Apache instead, matching how the real deployment runs:
`backend/scripts/README-serving.md` Option A.)

### 1.7 Run the web dashboard

```bash
cd web
php -S 127.0.0.1:5173
```

Open `http://127.0.0.1:5173/`. By default `web/index.html` points at
`http://localhost:8081/api/v1` (matches step 1.6) when opened from
`localhost`, and auto-derives `api.<hostname>` when opened from anywhere
else (see stage 4). If you ran the API on a different local port/host,
open the dashboard with an `?api_base=http://host:port/api/v1` query
param once — it saves to `localStorage` and strips itself from the URL
bar (see that file's own comment for why this exists: the API address is
expected to change per machine and there's no build step to inject an
env var).

Log in with the account from step 1.5.

**The dispatch PC must never sleep.** The dashboard's session is a
15-minute sliding token that an *open* dashboard renews on its own (it
polls `/notifications` every 15s), so SOS/new-incident alerts keep
arriving with nobody touching the keyboard — but only while the machine
is awake and the tab is open. Set Windows power options to "Never" for
sleep/display-off on the barangay-hall workstation; a PC that sleeps
overnight misses every alert until someone signs back in. (Rule 9,
amended 2026-09-19: the Tanod app gets a 24-hour device session for the
opposite reason — it must survive being out of range.)

### 1.8 What's optional, and what it looks like when it's not configured

| Feature | Env var(s) | If left blank |
|---|---|---|
| AI redaction/drafting/tools (Ollama) | `OLLAMA_URL`, `OLLAMA_MODEL` | `GET /system/health` reports `ollama: not_configured`; redaction requests 503 instead of queueing |
| Turn-by-turn routing | `ORS_API_KEY` | `ors: not_configured`; a dispatch's route stays `route_status: unavailable`, external nav link still works |
| Push notifications (FCM) | `FCM_SERVICE_ACCOUNT_PATH` | `fcm: not_configured`; notifications fall straight to SMS |
| SMS gateway (local GSM, tethered phone) | `GSM_GATEWAY_ENABLED` | `sms_gsm_gateway: not_configured`; SMS attempts recorded as `failed` (`GSM_GATEWAY_NOT_CONFIGURED`), not silently dropped |
| Remote access beyond your LAN | — | Not built by default — see stage 4 |

None of these block backend+web development. Every screen has a real
"not configured" state per §2 Rule 6 — there's nothing faked to make an
unconfigured integration look like it's working.

---

## 2. Mobile Android app (optional)

Full detail: `mobile/README.md`. Short version:

```bash
bash mobile/scripts/setup-android-platform.sh
```

Checks for an installed Android SDK (install Android Studio first if
you don't have one — https://developer.android.com/studio, a large GUI
installer this script deliberately doesn't try to automate), then runs
`npm install` + `npx cap add android` (skipped if already added) +
`npx cap sync android`. Prints the next step (building/installing a
debug APK) when it finishes.

`docs/REFERENCE.md` §8 has the Gradle/`JAVA_HOME` gotcha this script's
own output reminds you of (a space in the Windows username breaks
Gradle's `.bat` tools unless you use the short path form).

---

## 3. SMS gateway phone (optional)

Full detail: `sms-gateway/README.md` (outbound) and
`backend/scripts/gsm-ingest-daemon.php --status` (inbound — see
`docs/HANDOFF.md`'s "Operational quick reference" for the daemon
commands). This is a separate, standalone Android project (not the
Tanod app from stage 2) that turns a dedicated tethered phone into the
outbound/inbound SMS transport — no cloud SMS aggregator, no per-message
fee. Only needed if you're testing real SMS delivery; everything else in
this repo works with `GSM_GATEWAY_ENABLED=false` (stage 1.8's table).

---

## 4. Remote access beyond your LAN (optional)

The base architecture is LAN-only (`docs/REFERENCE.md` §1) — nothing here
is required for local development. Two options, depending on what you
need:

### 4.1 Temporary testing (no account needed)

```bash
cloudflared tunnel --url http://localhost:8081
```

No Cloudflare account needed, but its hostname is **random and changes
every time you run it**, and it has **no authentication in front of
it** — anyone who obtains the URL can reach the API, relying solely on
the app's own login. Treat it as a disposable testing convenience, never
a production access path. Point the web dashboard at it with
`?api_base=https://<whatever-it-printed>/api/v1` (step 1.7), and add
that same origin to `backend/.env`'s `CORS_ALLOWED_ORIGIN`.

### 4.2 Persistent access (a real domain, a real login gate)

For actual ongoing use by Tanod/Secretary/PB off-network:

1. Create a free Cloudflare account, and get a domain into it (Cloudflare
   Registrar sells at cost if you don't have one; or point an existing
   domain's nameservers at Cloudflare). Both of these are account/
   purchase actions only you can do.
2. `cloudflared tunnel login` — opens a browser to authorize `cloudflared`
   against your account. Also only you can do this (it's your login).
3. ```bash
   bash backend/scripts/setup-cloudflare-tunnel.sh yourdomain.win
   ```
   Creates the tunnel, writes `~/.cloudflared/config.yml` routing
   `yourdomain.win` → the web dashboard and `api.yourdomain.win` → the
   API, and adds both DNS records. Safe to re-run (idempotent — reuses
   an existing tunnel/config/route rather than erroring or duplicating).
4. Add `https://yourdomain.win` to `backend/.env`'s `CORS_ALLOWED_ORIGIN`.
5. `mobile/src/services/apiService.ts`'s `DEFAULT_API_BASE_URL` is
   currently hardcoded to this reference deployment's own domain
   (`https://api.baranguardph.win/api/v1`) — a fresh install of THIS
   repo's compiled app already works off any network with zero setup. If
   you're standing up a different deployment under your own domain,
   change that constant to `https://api.yourdomain.win/api/v1` so a
   shipped build of *your* app points at *your* server. Either way, for
   your own local dev, a gitignored `mobile/.env.local` with
   `VITE_API_BASE_URL=http://localhost:8081/api/v1` keeps your dev
   builds targeting the workstation directly regardless of what the
   committed default is.
6. **Not yet automated**: a Cloudflare Access policy (an email-OTP login
   gate in front of the tunnel, so the API isn't reachable by anyone
   with the URL the way it is without one) — set this up from the
   Cloudflare Zero Trust dashboard once you've enabled Zero Trust
   (one-time, pick a team name).

---

## 5. Keep services running across reboots (optional)

By default, Apache, MySQL, and (if you set one up) the Cloudflare tunnel
all need to be started manually every time this machine restarts — real
gap, hit directly building this doc (all three were found down after a
restart and needed manual restart). To make them genuine Windows
services that auto-start on boot:

```powershell
# From an ELEVATED (Run as administrator) PowerShell prompt:
powershell -ExecutionPolicy Bypass -File backend\scripts\install-autostart-services.ps1
```

Installs Apache2.4, MySQL, and (if `~/.cloudflared/config.yml` exists —
stage 4.2) `cloudflared` as real Windows services, set to start
automatically. Idempotent — safe to re-run. Prints an uninstall
cheat-sheet at the end, since this changes how you stop these services
afterward (Services.msc / `net stop <name>`, not just closing the XAMPP
Control Panel window).

---

## 6. Verify

- `GET http://127.0.0.1:8081/api/v1/barangays` — should list the 4
  barangays with no auth needed.
- Log into the web dashboard (stage 1.7) and confirm the header shows a
  real `system/health` probe result, not a static badge.
- If you did stage 4: the same two checks against your real domain
  (`https://yourdomain.win/baranguard/web/`,
  `https://api.yourdomain.win/api/v1/barangays`).
