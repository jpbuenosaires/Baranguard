# Setting up Baranguard on a new machine

Purpose: get the API, web dashboard and (optionally) mobile app running on a new machine.
Status / Last updated: 2026-10-28.

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
4. [Out of scope](#4-out-of-scope-deployment) — remote access and
   auto-start services; the system is not being deployed.

---

## 1. Backend + web (required)

### 1.1 Prerequisites

- **XAMPP** (Apache + MariaDB + PHP 8.2). Only MariaDB and the `mysql`
  CLI are strictly required by the steps below — the backend and web
  dashboard are both run via PHP's own built-in server (`php -S`), so no
  Apache vhost editing is required to get started. See
  [Serving](#serving-through-apache-optional) below to serve through
  Apache instead.
- **Node.js** (LTS) — the API itself is pure PHP, but `backend/`'s own
  CLI tooling (`bootstrap-admin.js`) needs it.
- **Git**.

Not needed for this stage, and safe to skip until you reach the stage
that needs them: Android Studio/JDK/Gradle (stage 2), an ORS API key
(stage 1.4's script asks about this), the GSM SMS gateway
phone (stage 3).

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
you pick. There is no production seed or demo login in the repo (§8
production-realism rule) — this is the only way to get a working account
on a fresh `baranguard` database. (The UAT/demo seed with its own
accounts is described in `docs/UAT_DATA_REQUIREMENTS.md` and
`docs/DEFENSE_DB_RUNBOOK.md`.) (Deliberately NOT automated — it's the one account this repo
has no safe default for.)

### 1.6 Run the API

```bash
cd backend/public
php -S 127.0.0.1:8081
```

Verify it's up: `curl -X POST http://127.0.0.1:8081/api/v1/auth/login -H "Content-Type: application/json" -d "{\"username\":\"<yours>\",\"password\":\"<yours>\"}"`
should return a token.

(To serve through Apache instead, see [Serving](#serving-through-apache-optional).)

### 1.7 Run the web dashboard

```bash
cd web
php -S 127.0.0.1:5173
```

Open `http://127.0.0.1:5173/`. By default `web/index.html` points at
`http://localhost:8081/api/v1` (matches step 1.6) when opened from
`localhost`, and auto-derives `api.<hostname>` when opened from anywhere
else (the tunnel hostnames, see stage 4). If you ran the API on a different local port/host,
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
| Turn-by-turn routing | `ORS_API_KEY` | `ors: not_configured`; a dispatch's route stays `route_status: unavailable`, external nav link still works |
| Push notifications (FCM) | `FCM_SERVICE_ACCOUNT_PATH` | `fcm: not_configured`; notifications fall straight to SMS |
| SMS gateway (local GSM, tethered phone) | `GSM_GATEWAY_ENABLED` | `sms_gsm_gateway: not_configured`; SMS attempts recorded as `failed` (`GSM_GATEWAY_NOT_CONFIGURED`), not silently dropped |

There is no AI feature to configure: the local Ollama/SEA-LION pipeline and
its `OLLAMA_*` settings were removed with migration 0029 (2026-10-01). Old
`.env` files may still carry `OLLAMA_*` lines; they are ignored and can be
deleted. If an older `install-autostart-services.ps1` registered a
`BaranguardAiWorker` Scheduled Task, remove it with
`Unregister-ScheduledTask -TaskName BaranguardAiWorker -Confirm:$false`.

None of these block backend+web development. Every screen has a real
"not configured" state per §2 Rule 6 — there's nothing faked to make an
unconfigured integration look like it's working.

---

### Serving through Apache (optional)

Merged here 2026-10-28 from the former `web/README-serving.md` and
`backend/scripts/README-serving.md`. The API is a single front controller
at `backend/public/index.php` (PHP serves `/api/v1/*`; Node is CLI tooling
only). The web dashboard is static files with no build step.

**API through XAMPP's Apache.** In `httpd-vhosts.conf` add a vhost whose
`DocumentRoot` is `backend/public` (not `backend/`; see the comment in
`backend/.htaccess`), e.g. `Listen 8081` + `<VirtualHost *:8081>` with
`AllowOverride All` and `Require all granted`, then restart Apache. The
`Authorization` header is forwarded by a rewrite in
`backend/public/.htaccess`. PHP's built-in server (step 1.6) is what the
`verify-*.sh` scripts use.

**Dashboard through Apache.** Either a second vhost whose `DocumentRoot` is
`web/`, or the junction `C:\xampp\htdocs\baranguard` pointing at the repo
root:

```
New-Item -ItemType Junction -Path "C:\xampp\htdocs\baranguard" -Target "<repo root>"
```

then open `http://localhost/baranguard/web/`. The API is not reached
through the junction: its front controller matches `/api/v1` exactly, so it
needs its own vhost on `backend/public`.

**Which API the dashboard calls.** `web/index.html` resolves
`window.BARANGUARD_API_BASE_URL` before `main.js`: a `?api_base=` query
param (localhost or same-site only, saved to `localStorage`, then stripped
from the URL bar), then a saved value, then `http://localhost:8081/api/v1`
when opened from localhost, or `api.<hostname>` otherwise.

**`.env` values the API needs beyond `DB_*`:** `JWT_SECRET` (random, from
`setup-env.sh`), optional `JWT_EXPIRES_IN_MINUTES` (default 15) and
`CORS_ALLOWED_ORIGIN` (defaults to `*` for local dev; otherwise a
comma-separated list of exact origins, keeping `http://localhost` for the
mobile app's Capacitor WebView; see the CORS block in
`backend/public/index.php`).

**Test accounts.** A fresh database has only the account from step 1.5.
The UAT/demo seed (`baranguard_uiseed`) carries its own accounts; see
`docs/UAT_DATA_REQUIREMENTS.md`.

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
With the gateway on, also set `GATEWAY_BARANGAY_ID` (see `backend/.env.example`) and run
`backend/scripts/install-scheduled-backup-jobs.ps1` so `BaranguardGsmIngest` (inbound daemon) and
`BaranguardNotificationWorker` (queued broadcasts, SOS repeat) are registered. For a local-development
APK that talks to `http://localhost:8081`, build with `CAP_LOCAL_DEV=1 npx cap sync android`; a release
build blocks cleartext HTTP.

---

## 4. Out of scope: deployment

Remote access (a Cloudflare tunnel, `backend/scripts/setup-cloudflare-tunnel.sh`)
and auto-start Windows services (`backend/scripts/install-autostart-services.ps1`,
elevated) exist as scripts but are not part of the evaluated scope; the
system is not being deployed. See the "not doing" appendix of
`docs/ROADMAP_TO_COMPLETION.md`. The public hostnames, when up, serve the
demo database (`docs/REFERENCE.md` §1). For your own local mobile builds, a
gitignored `mobile/.env.local` with
`VITE_API_BASE_URL=http://localhost:8081/api/v1` targets the workstation.

---

## 5. Verify

- `GET http://127.0.0.1:8081/api/v1/barangays` — should list the 4
  barangays with no auth needed.
- Log into the web dashboard (stage 1.7) and confirm the header shows a
  real `system/health` probe result, not a static badge.
