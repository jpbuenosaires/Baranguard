# Baranguard — Master Reference

Barangay Intelligence and Emergency Dispatch System. Offline-first, locally
hosted incident reporting and emergency dispatch platform for four
barangays (Dao, Binanuahan, Marifosque, Banuyo) in Pilar, Sorsogon,
Philippines. System of record is local MariaDB 10.4 (via XAMPP); cloud
deployment is deferred and undecided. BSIT capstone, Bicol University —
treat as a real production system, not a demo.

This is the source of truth for schema, API, roles, and screens. Load it
into every session via `CLAUDE.md`. Do not invent field names, endpoints,
or roles not listed here — check §5/§6/§7 first. **If this file and
`docs/REFERENCE.md` (the compact working summary) ever disagree, this
file wins** and REFERENCE.md gets corrected.

**Reconciliation note (2026-10-01) — READ FIRST.** Migration 0029
(`backend/migrations/0029_remove_blotter_and_ai_pipeline.sql`) removed the
Electronic Blotter and the entire local-AI pipeline (redaction, summary,
translation, extraction, AI Tools, evaluation harness). Barangays keep
the blotter and Lupon records in their own binders. This file has been
reconciled in place: anything still describing `blotter_record`,
`blotter_revision`, `ai_processing_log`, `ai_evaluation_run`, Ollama/
SEA-LION, redaction approval, the AI draft endpoints or the Lupon packet
is either removed or marked **(Historical — removed 2026-10-01)**. **Do
not rebuild any of it without an explicit new decision.** Other sections
of this file were NOT re-audited in this pass and still carry the
2026-09-07 baseline; `docs/REFERENCE.md` is the more current summary and
the bodies of §5/§6/§7 should be checked against the code before being
trusted for anything outside the removed features.

**Currency note (2026-09-07):** this rewrite reconciles migrations
0008-0014 (party fields, suspension, `system_settings`, display IDs, the
walk-in blotter and operational-correction endpoints) into the sections
below, and fixes seven internal-logic gaps found the same day (marked
inline where they touch a rule). For what's currently *broken* in the
running system rather than in this document, see `docs/REMAINING.md` §F
and `docs/AUDIT_2026-09-07.md` — two P0s and four P1s are open as of this
writing and are not restated here.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Backend | PHP 8.2 (all of `/api/v1/*`) + Node.js (CLI tooling only) |
| Web frontend | Vanilla JS (ES2023+), plain CSS — no framework, no bundler, no npm step |
| Mobile | Ionic React 9 + Capacitor 8.5 (Android) |
| Server-side DB | MariaDB 10.4 (via XAMPP) — MySQL-compatible; cloud hosting deferred |
| Mobile local DB | SQLite via Capacitor SQLite, encrypted (SQLCipher-backed) |
| AI | **None** — the local Llama-SEA-LION/Ollama pipeline was removed 2026-10-01 (migration 0029). No AI service, local or external |
| SMS | Local GSM gateway — one tethered phone, own SIM, both inbound ingestion AND outbound send (2026-09-23: Semaphore removed, cost; see `backend/DEVLOG.md` and `sms-gateway/README.md`) |
| Push | Firebase Cloud Messaging (FCM) HTTP v1 |
| Mapping | MapLibre with prepackaged offline vector tiles (MBTiles); online tiles when connected |
| Routing | OpenRouteService (ORS, cloud) — free tier, no card required; chosen 2026-09-13 after a self-hosted OSRM build was abandoned (workstation memory constraints) and a built Google Routes API replacement was torn out the same day (requires billing/a card, which this deployment has none of). See `backend/services/routing/OrsClient.php`'s own doc block for the full history. |

**DB engine note:** XAMPP labels this module "MySQL" but ships MariaDB —
this project runs on the actual engine, MariaDB 10.4. JSON columns are
opaque blobs, never queried with MySQL-8-only JSON functions.

**Relationship to DILG BIMSS — settled 2026-09-10, binding on scope.**
DILG BIMSS/BIMS is mandated for all barangays by Memorandum Circular. It
is an 11-subsystem suite; **KPIS** among them already *is* the barangay's
Katarungang Pambarangay case database, and BIMS ships its own electronic
blotter. **Baranguard complements BIMSS and may never be positioned as
replacing it** — a legal constraint, not a design preference.

The practical test for any proposed feature: *does BIMSS already own this
record?* If yes, Baranguard duplicating it is liability, because a
barangay must maintain the BIMSS copy regardless and a second ledger
invites divergence. Baranguard's ground is the layer BIMSS has none of —
real-time dispatch, Tanod GPS, SOS and offline field capture. That test
is why `POST /blotter` (walk-in entry) and the W6 records list were both
removed on 2026-09-10, and why the rest of the blotter (and the AI that
fed it) followed on 2026-10-01 — barangays keep blotter and Lupon records
in their own binders. *(Historical: local-AI redaction and the AI Blotter
Assistant were once listed here as Baranguard's value; both are gone.)*

---

## 2. Architecture Rules

1. **No unprotected raw narrative leaves the trusted environment.** `raw_narrative` is Secretary-only and never sent to FCM, the SMS gateway, any cloud service, cloud storage, logs or audit metadata. *(Historical — removed 2026-10-01: the clause that it was "processed only by the local SLM/redaction service" no longer applies; no AI processes it.)* GSM/SMS fallback for sensitive content uses an authenticated-encrypted envelope only — raw text is never plaintext SMS.
2. **Offline capture is durable until reconciliation.** Every incident persists to encrypted mobile SQLite before the user can leave the capture flow. The local record survives until the server confirms acceptance or a duplicate is safely correlated. The server becomes authoritative after reconciliation; the local record remains an audit/cache copy.
3. **(Historical — retired 2026-10-01.)** Formerly: only the human-approval endpoint (`ai-draft/approve`) may commit `incident.redacted_narrative`. The endpoint and the whole AI draft flow are gone; `redacted_narrative`/`redaction_approved_*` remain as unused legacy columns and **nothing may write them**.
4. **SMS fallback uses explicit trigger and secure envelope rules.** Fallback starts only after the health-check rule in §6, never merely on Submit. Transport security, dedup, expiration, replay protection, and correlation use the envelope defined in §6.
5. **No telecom-layer silent/Flash SMS is assumed.** Critical alerts use the configured priority SMS path (2026-09-23: the local GSM gateway, replacing Semaphore) plus the app's notification/overlay. Background coordinate beacons are ordinary authenticated SMS parsed by the trusted local ingestion service.
6. **RBAC and object ownership are enforced server-side.** Client-side hiding is UX only. Every protected endpoint verifies role, tenant, and object-specific ownership before returning or mutating data.
7. **No public internet exposure to this system's own inbound services, ever.** MariaDB, the backend, the web dashboard and GSM ingestion accept connections only from the trusted local environment — LAN/localhost, enforced by network placement and CORS configuration, not merely assumed. *(A violation of this — a public tunnel in front of the API — was found and is an open P0; see `docs/AUDIT_2026-09-07.md` F1.)* This does **not** mean the workstation has no internet dependency at all: FCM and (since 2026-09-13) ORS routing are outbound calls to cloud services and need the workstation to have internet access for those transports/dependencies specifically. SMS is NO LONGER a cloud dependency as of 2026-09-23 — the local GSM gateway (replacing Semaphore) sends over `adb` to a physically-tethered phone's own SIM, no internet call involved at all. When FCM/ORS internet access is unavailable, health reports `not_configured`/`unhealthy` per §6 and alerting degrades to the GSM/local paths (or, for routing, `route_status` degrades to `stale`/`unavailable` and the mobile app's external-navigation-app link still works) — a known degradation, not a silent failure. Mobile capture continues in its encrypted cache regardless. Recovery/restart requirements are in §11.
8. **The four barangays are isolated tenants.** Authenticated callers are permanently scoped to the `barangay_id` in their session. Every endpoint that accepts or resolves a tenant/resource enforces the same boundary, including all `/:id` routes. A public citizen report is the only pre-auth flow that may select one of the four barangays.
9. **Authentication/session lifecycle.** Argon2id passwords. JWTs carry a unique `jti` mapped to one `auth_session`, whose lifetime depends on its kind (`auth_session.session_kind`, migration 0022, decided 2026-09-19): **web** sessions (the dashboard) expire in 15 minutes; **device** sessions (a Tanod login carrying a well-formed `X-Device-Id` — tanod role only) expire in 24 hours and never renew past 7 days from issue. Both kinds are revoked on the next request by logout/suspension/deactivation/password change, which is what makes the longer device token acceptable. Every authenticated request verifies signature, algorithm, expiry, session existence/revocation, user activation state, and tenant identity. Sliding renewal may extend a still-valid session with a non-decreasing expiry. **Failed-login lockout: 5 attempts within a rolling window locks the account for 15 minutes**, and the failure response is externally indistinguishable for unknown-user, wrong-password, and locked-account cases. Logout revokes the current session; deactivation/password reset revoke active sessions per §6. Expired/revoked sessions are purged after 90 days.
10. **Administrative bootstrap is one-time and deterministic.** The four barangay IDs are fixed in the baseline migration. The first Admin per barangay is created only by the interactive trusted CLI bootstrap. No password ever appears in source, migrations, seeds, logs, or UI. No self-registration for privileged roles.
11. **Retention has an operational track and an evidence/audit track** — full table in §11. Legal hold is the intended universal exception; backups are included in retention/deletion controls.
12. **Notifications are logical notifications plus delivery attempts.** FCM and SMS are transport channels; one logical notification can have multiple delivery attempts. If no active FCM registration exists, SMS is used immediately. If an FCM attempt errors/times out, retry once, then SMS on the second failure. An FCM success with no client ack within 60s records `ack_timeout` — this does not automatically trigger SMS. The app renders a critical alert from local cache when the local API is unreachable.
13. **SMS-originated duty changes are first-class.** `duty_status.channel = "sms"` is written only by the validated internal SMS handler; sender identity is derived server-side from a registered device mapping, never from a client-supplied user ID.
14. **Offline maps are part of the offline-first guarantee.** Each approved device has a versioned encrypted basemap package, published per barangay. Route computation needs workstation connectivity; the last successfully received route stays usable offline.
15. **The unified workstation is an infrastructure single point of failure.** If DB/API/GSM are unavailable, mobile preserves locally capturable work where the feature contract allows it. (Routing, since 2026-09-13, is the one exception to "the workstation" being the relevant point of failure — ORS is an independent cloud service; see Rule 7.)
16. **(Historical — retired 2026-10-01.)** Formerly the ordered, versioned AI pipeline (raw → redaction draft → summary → Secretary review → approval; translation post-approval; Bikol unvalidated). The pipeline was removed in full by migration 0029.
17. **Administrative actions are auditable**, allow-listed to identifiers/statuses only — never raw narrative or credentials.
18. **Mobile read access is least-privilege.** Tanods read their own dispatches, own duty history, own submitted incidents, and nearby redacted markers. Cached data carries the same tenant/ownership restrictions as live responses.
19. **Cloud deployment is deferred.** No cloud database, backend or storage is in scope (a Cloudflare tunnel fronts the workstation per `docs/REFERENCE.md` §1, but nothing is hosted in the cloud) and no AI of any kind is in scope.
20. **Incident priority is server-controlled.** `normal|high|critical`, client input cannot self-promote, default `normal`.
21. **Incident and dispatch state machines are explicit.** Incident: `pending → dispatched → resolved`, with `dispatched → pending` only via valid cancellation before arrival. Dispatch: `assigned → en_route → arrived → completed`, with `assigned/en_route → cancelled`. No backward/skipped transition through the ordinary status endpoint. Incident resolution requires no active dispatch remains, **and only a `dispatched` incident may be resolved** — `pending` (nothing to conclude) and an already-`resolved` repeat are both `409`. *(Amended 2026-10-09, migration 0039: an Admin may also resolve a `pending` or `reopened` incident that never needed a dispatch, but only with a mandatory `reason` of 1 to 255 characters, stored in `incident.resolve_reason` and never written to audit metadata; without a reason it is `400`. An already-`resolved` repeat is still `409`, so the endpoint stays safe without an `Idempotency-Key`.)* That gating is what makes `PATCH /incidents/:id/status` safe without an `Idempotency-Key`: a double submit finds no resolvable incident and so cannot write a second audit row. *(The former exception here — walk-in blotter entries born `resolved` — is gone with `POST /blotter`, removed 2026-09-10; see §6. **The `source = 'web_walkin'` discriminator it motivated is closed as obsolete, 2026-09-12** — with all three creation sites hardcoding `pending` and resolution gated on `dispatched`, there is no off-lifecycle incident left to discriminate, and `avg_response_time_minutes` never depended on it; see `docs/REMAINING.md` §G4.)*
22. **Internal GSM ingestion is local-only.** A tethered GSM phone/modem feeds a local ingestion service. Inbound SMS is authenticated, deduplicated, size-limited, decrypted/verified, parsed, then passed to internal handlers over loopback or an equally protected boundary. *(§6's SMS section separates these genuinely-inbound handlers from the outbound sends the backend itself triggers — the two were conflated in an earlier draft; see §6.)*
23. **(Historical — retired 2026-10-01.)** Formerly `draft_version` optimistic concurrency on AI drafts. No AI drafts exist.
24. **Notification delivery has separate logical and transport records.** A reliability metric's definition (end-to-end vs. transport-specific) must be explicit; ack timeout never silently changes delivery truth.
25. **Public reports and evidence have explicit retention** (§11); converted reports follow the linked incident's clock. Evidence retains independently until its own deadline or legal hold.
26. **Device secrets are protected** — FCM tokens, local DB keys, message-encryption keys, device-registration secrets never appear in ordinary API payloads, audit logs, debug logs, or UI.
27. **Tanod SOS is a dedicated immediate channel**, never dependent on incident dispatch triage — creates a persistent record, alerts Admin and eligible on-duty Tanods. **Two fallback tiers exist today** — app (needs the local API) and SMS (needs the local GSM ingestion service) — and both terminate on the same unified workstation Rule 15 already names as a single point of failure, so **neither survives a total workstation/power outage**. This is a real, currently-unmitigated residual risk, not a solved one. The honest fix, not yet built: a third tier that never touches the workstation — the mobile app sends a native-OS SMS (the device's own SIM, no gateway) directly to a configured backup contact when both other paths are confirmed unreachable.
28. **Dispatch cancellation is non-destructive.** A cancelled dispatch is retained as history; its incident returns to `pending` only when the cancellation transaction confirms the dispatch was `assigned` or `en_route`.
29. **Idempotency is required for retriable writes** — incident creation, `/sync/batch`, dispatch/SOS creation, citizen-report conversion, device registration, evidence upload, and any internally-retried transport use a stable client/correlation key.
30. **All protected resource lookups are transaction-safe** — row locking/optimistic concurrency for dispatch state, citizen conversion, swaps, retention. Never authorize an object using stale tenant/ownership data.
31. **Time policy is explicit.** Persist UTC; operational shift times interpret Asia/Manila. Client timestamps are informational, never authoritative, never bypass session expiry or retention.
32. **Production recovery is part of correctness.** Backups, restore verification, migration rollback strategy, health checks, and restart procedures are required before UAT.

---

## 3. Roles

Four active login roles: `admin`, `secretary`, `tanod`, `punong_barangay`.
`lupon` stays in the DB enum for historical/attribution reasons only.

| Role | Who | Primary responsibility |
|---|---|---|
| Admin | IT/system administrator | Full operational control — user mgmt, scheduling, live dispatch, GPS oversight, incident status — own barangay only |
| Secretary | Barangay Secretary | Records custodian: sole reader of `raw_narrative` and incident party fields; incident lifecycle actions (duplicate/invalid/cancelled/reopened). *(Historical — removed 2026-10-01: blotter management, PII redaction approval, blotter finalization, BIMSS/KPIS handoff drafting.)* |
| Tanod | Field responder | Incident capture, GPS broadcast, own dispatch/duty |
| Punong Barangay | Elected chief executive | Read-only oversight across nearly every module (§7) |
| Lupon | Dispute-resolution mediators | No system account |

No separate Dispatcher role — live dispatch, GPS oversight, and
incident-status updates sit with Admin.

**Admin ≠ Punong Barangay.** Under RA 7160 §389, the PB is the elected
chief executive (governance/oversight), not hands-on records/account
administration — "Admin" is the operational role a real PB would
delegate to staff. Keeping them separate preserves least-privilege: the
person with appointment power over staff (PB) isn't also the one with
write access to those staff's accounts (Admin).

**Secretary's permissions have a specific legal basis.** RA 7160 §394(c)
makes the Secretary custodian of all barangay records; the Revised
Katarungang Pambarangay Law §2 has the Secretary concurrently serve as
Secretary of the Lupon. That's why only Secretary holds `raw_narrative`
access and the incident lifecycle actions (formerly also redaction
approval and blotter finalization, removed 2026-10-01) — a
records-custodian mandate, not an executive one, so it doesn't extend to
user management or scheduling.

**Lupon has no system login.** Lupon members are appointed mediators, not
staff with their own records office. Baranguard no longer generates anything for the Lupon: the
Secretary-generated packet (`POST /incidents/:id/lupon-packet`) was
removed 2026-10-01 and Lupon records are kept in the barangay's own
binders. Lupon never had a standing account.

---

## 4. Naming & Folder Conventions

| Layer | Convention | Example |
|---|---|---|
| DB tables/fields | snake_case | `incident_id`, `raw_narrative` |
| API JSON keys | snake_case (matches DB) | `{ "incident_id": 1 }` |
| PHP | snake_case | `$incident_id`, `get_incident_by_id()` |
| JS/TS | camelCase | `incidentId`, `getIncidentById()` |
| JS components/classes | PascalCase | `IncidentForm` |
| JS files | kebab-case (pages), PascalCase (components) | `incident-log.js` |
| CSS classes | kebab-case, BEM | `.dispatch-card__header` |
| CSS custom properties | `--kebab-case` | `--color-primary` |
| Git commits | `[SprintN] Short description` | |

**Boundary rule:** exactly ONE central API client file per platform
(`apiClient.js` web, `apiService.ts` mobile) does snake_case →
camelCase conversion. Never convert ad-hoc inside a component.

```
/baranguard
├── /backend    → /routes /controllers /models /middleware
│                 /services(/sms /sync) /config /migrations
├── /web        → /src(/pages /components /styles /api)
├── /mobile     → Ionic/Capacitor app
└── /docs       → this file, the compact reference, audits
    (Historical: `/eval-kit`, the standalone AI-evaluation package, and
    `/services/ai` were removed 2026-10-01.)
```

---

## 5. Database Schema

**Schema contract:** every column has explicit SQL type, nullability,
default, and index/constraint decision. Timestamps stored UTC;
roster/business-time calculations use Asia/Manila. Client timestamps are
informational only. Nullable composite UNIQUE + transactional checks
substitute for MariaDB's lack of partial/filtered unique indexes.

**`barangay`** — `barangay_id` SMALLINT UNSIGNED PK · `name`, `municipality`, `province` VARCHAR(128) NOT NULL · `population` INT UNSIGNED NULL · `boundary_geojson` JSON NULL · `created_at` DATETIME NOT NULL · UNIQUE(`name`,`municipality`,`province`). Four baseline rows, deterministic IDs, never regenerated.

**`user`** — `user_id` PK · `barangay_id` FK RESTRICT · `username` VARCHAR(64) UNIQUE · `password_hash` VARCHAR(255) · `full_name` VARCHAR(255) · `role` ENUM('admin','secretary','tanod','punong_barangay','lupon') · `contact_number` VARCHAR(32) NULL · `is_active` BOOLEAN DEFAULT TRUE · `is_suspended` TINYINT(1) NOT NULL DEFAULT 0 · `suspended_reason` VARCHAR(255) NULL · `suspended_at` DATETIME NULL *(0011 — a THIRD, independent axis from `is_active`: a suspended-but-active account and a deactivated account are different states, both unusable for login)* · `failed_login_attempts` INT UNSIGNED DEFAULT 0 · `login_failure_window_started_at`, `locked_until` DATETIME NULL · `created_at`, `updated_at` DATETIME · INDEX(`barangay_id`,`role`,`is_active`). `lupon` cannot be created/activated for login.

**`auth_session`** — `session_id` PK · `user_id` FK CASCADE · `jti` CHAR(36) UNIQUE · `issued_at`, `expires_at` DATETIME · `revoked_at` DATETIME NULL · `ip_address`, `user_agent` NULL · `last_seen_at`, `last_renewed_at` NULL · INDEX(`user_id`,`expires_at`), INDEX(`revoked_at`,`expires_at`).

**`mobile_device`** — `device_id` VARCHAR(64) PK · `user_id` FK CASCADE · `platform` ENUM('android') · `fcm_token` TEXT · `device_secret_ref` VARCHAR(255) NULL · `app_version` NULL · `last_seen_at` DATETIME · `is_active` BOOLEAN DEFAULT TRUE · `created_at`. One active device per Tanod, enforced transactionally.

**`notification`** — `notification_id` PK · `barangay_id` FK RESTRICT · `notification_type` ENUM('dispatch','sos','priority_alert','other') · `dispatch_id`/`sos_id`/`incident_id` FK SET NULL as relevant · `created_by` FK SET NULL · `created_at`, `expires_at` NULL. Entity matrix (which FK is required per type) enforced in application code — MariaDB 10.4 rejects a CHECK referencing an `ON DELETE SET NULL` column (`ERROR 1901`).

**`notification_target`** — `notification_target_id` PK · `notification_id` FK CASCADE · `user_id` FK RESTRICT · `device_id` FK SET NULL · `targeted_at` DATETIME · `acknowledged_at` NULL · `ack_status` ENUM('pending','acknowledged','not_required') DEFAULT 'pending' · UNIQUE(`notification_id`,`user_id`).

**`notification_delivery`** — `delivery_id` PK · `notification_id` FK CASCADE · `notification_target_id` FK CASCADE · `channel` ENUM('fcm','sms') · `attempt_no` TINYINT UNSIGNED · `status` ENUM('initiated','sent','failed','ack_timeout') · `provider_message_id` NULL · `initiated_at`, `sent_at`, `ack_timeout_at` NULL · `failure_reason` NULL · `metadata_json` JSON NULL · UNIQUE(`notification_target_id`,`channel`,`attempt_no`).

**`audit_log`** — `audit_id` PK · `barangay_id` FK SET NULL · `actor_user_id` FK SET NULL · `action` VARCHAR(128) · `entity_type` VARCHAR(64) · `entity_id` NULL · `metadata_json` JSON NULL (identifiers/statuses only — Rule 17) · `ip_address`, `user_agent`, `created_at`. Write-once except controlled retention deletion.

**`duty_status`** — `status_id` PK · `user_id` FK RESTRICT · `status` ENUM('on_duty','responding','off_duty') · `channel` ENUM('app','sms') · `client_event_id` CHAR(36) NULL · `changed_at` · UNIQUE(`user_id`,`client_event_id`).

**`gps_track`** — `track_id` PK · `user_id` FK RESTRICT · `dispatch_id` FK SET NULL · `latitude`/`longitude` DECIMAL(10,7) · `accuracy_m` DECIMAL(8,2) · `recorded_at`, `received_at`, `synced_at` NULL · `client_event_id` NULL · UNIQUE(`user_id`,`client_event_id`).

**`incident`** — `incident_id` PK · `barangay_id` FK RESTRICT · `reported_by` FK SET NULL · `device_id` FK SET NULL · `incident_type` ENUM('theft','physical_injury','disturbance','domestic_dispute','vandalism','traffic_incident','fire','medical_emergency','missing_person','animal_complaint','other') · `priority` ENUM('normal','high','critical') DEFAULT 'normal' · `raw_narrative` TEXT NULL *(NULLable since 0007, for post-retention purge)* · `redacted_narrative` TEXT NULL · `redaction_approved_by`/`redaction_approved_at` NULL *(legacy — kept by 0029, nothing writes them any more; `RetentionService` still reads `redaction_approved_at`, which is therefore always NULL)* · `status` ENUM('pending','dispatched','resolved') DEFAULT 'pending' · `source` ENUM('app','sms','web') · `location_description` VARCHAR(255) NULL *(0010)* · `complainant_name`, `respondent_name` VARCHAR(255) NULL, `complainant_contact_number` VARCHAR(32) NULL *(0008 — extracted from RAW narrative, so these carry `raw_narrative`'s Secretary-only protection, not the broader "approved and shareable" treatment `redacted_narrative` gets)* · `display_id` VARCHAR(20) NULL *(0014, `INC-YYYY-NNN`, new rows only — not backfilled)* · `latitude`/`longitude` DECIMAL(10,7) NULL · `created_at`, `updated_at`, `device_offline_created_at` NULL, `synced_at` NULL · `client_event_id` CHAR(36) NULL · UNIQUE(`device_id`,`client_event_id`). *(Historical: `redaction_approved_at IS NOT NULL` was the approval signal; unreachable since 2026-10-01.)*

**`dispatch`** — `dispatch_id` PK · `incident_id` FK RESTRICT · `dispatched_by`, `tanod_id` FK RESTRICT · `priority` ENUM(same as incident) · `route_json` JSON NULL · `route_status` ENUM('available','unavailable','stale') DEFAULT 'unavailable' · `status` ENUM('assigned','en_route','arrived','completed','cancelled') DEFAULT 'assigned' · `dispatched_at`, `en_route_at`, `arrived_at`, `completed_at`, `cancelled_at` NULL · `cancelled_by` FK SET NULL · `created_client_request_id` CHAR(36) UNIQUE. At most one active dispatch (`assigned`/`en_route`/`arrived`) per incident, enforced transactionally.

**`evidence_attachment`** — `attachment_id` PK · `incident_id` FK RESTRICT · `type` ENUM('photo','voice') · `file_path` VARCHAR(512) (outside web root) · `uploaded_by` FK RESTRICT · `uploaded_at` · `sha256` CHAR(64) · `byte_size`, `mime_type`, `original_filename` · `retention_expires_at` NULL · `legal_hold` BOOLEAN DEFAULT FALSE · `client_request_id` CHAR(36) NULL UNIQUE. **No server-side writer exists for this table as of 2026-09-07** — see `docs/AUDIT_2026-09-07.md` F4; the schema is real, the upload endpoint is not.

**`blotter_record`** — **(Historical — table dropped 2026-10-01, migration 0029; its rows were destroyed with it.)** Formerly the finalized blotter entry (`narrative_summary`, `case_status`, party fields, `display_id` `BLT-YYYY-NNN`). Barangays keep blotter records in their own binders.

**`blotter_revision`** — **(Historical — table dropped 2026-10-01, migration 0029.)** Formerly one row per superseded blotter version.

**`citizen_report`** — `report_id` PK · `barangay_id` FK RESTRICT · `incident_id` FK SET NULL UNIQUE · `contact_number` VARCHAR(32) NULL · `description` TEXT · `latitude`/`longitude` NULL · `submitted_at` · `converted_at` NULL · `retention_expires_at` NULL · `legal_hold` BOOLEAN DEFAULT FALSE. Conversion locks the row, permits exactly one incident linkage. **Unauthenticated intake — `description`/`contact_number` are the head of an open stored-XSS chain**, see `docs/AUDIT_2026-09-07.md` F2/F3.

**`sms_log`** — `log_id` PK · `report_id`/`incident_id`/`dispatch_id` FK SET NULL · `sender_number`, `receiver_number` NULL · `transport` ENUM('gsm_modem','semaphore') · `message_type` ENUM('incident','dispatch','priority_alert','coord_ping','confirmation','duty_status','sos','manual') *(0013 adds `manual`)* · `direction` ENUM('inbound','outbound') · `gateway_message_id`, `modem_message_id`, `correlation_id` NULL · `status` ENUM('queued','pending','sent','failed','refunded','received','rejected','deduplicated') · `sent_at`, `received_at` NULL · `failure_reason` NULL · `barangay_id` FK *(0006)* · `message_body` TEXT NULL, `read_at` DATETIME NULL *(0013)* · `legal_hold` BOOLEAN NOT NULL DEFAULT FALSE *(0016)* · `created_at`. Phone numbers masked in UI. *(The former "no `legal_hold` column" gap is closed — 0016 added it, and §11's rule is now enforced: the retention job checks this column AND the linked incident/citizen_report/dispatch-through-incident holds at purge time.)*

**`ai_processing_log`** — **(Historical — table dropped 2026-10-01, migration 0029.)** Formerly the AI job queue and draft store (redaction/summary/translation/extraction drafts; AI Tools jobs after 0015, themselves removed by 0027/0028).

**`ai_evaluation_run`** — **(Historical — table dropped 2026-10-01, migration 0029.)** Formerly stored AI evaluation metrics.

**`offline_queue`** — `queue_id` PK · `device_id` FK RESTRICT · `client_event_id` · `payload_type` ENUM('incident','gps','duty_status','sos','dispatch_status') · `sync_metadata_json` JSON · `created_offline_at`, `received_at`, `synced_at` NULL · `reconciliation_status` ENUM('pending','success','duplicate','failed') DEFAULT 'pending' · UNIQUE(`device_id`,`client_event_id`). Never stores original raw payload.

**`tanod_sos`** — `sos_id` PK · `user_id` FK RESTRICT · `barangay_id` FK RESTRICT · `dispatch_id` FK SET NULL · `latitude`/`longitude` · `triggered_at`, `received_at` · `status` ENUM('active','acknowledged','resolved') DEFAULT 'active' · `acknowledged_by`/`at`, `resolved_by`/`at` NULL · `client_event_id` UNIQUE with `user_id` · `fallback_channel` ENUM('app','sms') DEFAULT 'app'. Only the caller's own active dispatch may be referenced.

**`shift_schedule`** — `shift_id` PK · `barangay_id` FK RESTRICT · `user_id` FK RESTRICT (nullable since 0003) · `patrol_zone` NULL · `start_at`/`end_at` DATETIME (`start_at < end_at`, overlap rejected transactionally) · `created_by` FK RESTRICT · `version` INT UNSIGNED DEFAULT 1 (optimistic concurrency for `PATCH`) · `client_request_id` UNIQUE · `updated_at` NULL.

**`shift_swap_request`** — `request_id` PK · `requesting_user_id`, `target_user_id` FK RESTRICT NULL · `shift_id` FK RESTRICT · `reason` VARCHAR(1000) NULL · `status` ENUM('pending','approved','denied') DEFAULT 'pending' · `requested_at`, `resolved_at` NULL, `resolved_by` NULL · `version` INT UNSIGNED DEFAULT 1 · `client_request_id` UNIQUE.

**`fatigue_flag`** — `flag_id` PK · `user_id`, `shift_id` FK RESTRICT · `hours_worked_7day` DECIMAL(5,2) · `calculation_basis` ENUM('scheduled_hours') · `flagged_at` · `acknowledged_by`/`at` NULL · UNIQUE(`user_id`,`shift_id`).

**`offline_map_package`** — `package_id` PK · `barangay_id` FK RESTRICT · `version` VARCHAR(64) · `file_path`, `checksum_sha256`, `byte_size` · `created_by` FK RESTRICT · `created_at` · `is_published` BOOLEAN DEFAULT FALSE · UNIQUE(`barangay_id`,`version`). Exactly one published package per barangay.

**`system_settings`** *(0012 — new table, deliberate user-authorized override of the original "no schema for settings" blocker, scoped narrowly)* — `setting_key` VARCHAR(100) PK · `setting_value` TEXT NULL · `updated_at` DATETIME · `updated_by` FK SET NULL. Plain key-value, not one column per setting, so new keys don't need a migration. **The override does not extend past what was explicitly authorized**: only `sms_gateway.api_key`/`sms_gateway.sender_name` (masked on every read) and three non-secret `general.*` display keys (system name, municipality, region) are permitted — `SettingsController` enforces the allow-list. `DEVICE_SECRET_MASTER_KEY`, `INTERNAL_SERVICE_TOKEN`, `JWT_SECRET`, `FCM_SERVICE_ACCOUNT_PATH` stay in `.env`, never a DB row.

### Mobile Local (SQLite, encrypted with SQLCipher-backed plugin)

Limited to fields needed by approved offline screens. Local IDs are
device-local unless a server ID field is explicitly present. Timestamps
are ISO 8601 UTC strings; UI converts to Asia/Manila.

- **`incident_local`**, **`dispatch_local`**, **`gps_track_local`**,
  **`duty_status_local`**, **`evidence_attachment_local`**,
  **`offline_queue_local`**, **`mobile_device_local`**,
  **`offline_map_package_local`** — mirror the server tables above with a
  `local_id TEXT PRIMARY KEY`, a nullable `server_*_id`, a `synced`
  integer flag, and (for `incident_local`/`offline_queue_local`)
  encrypted-at-rest narrative/payload columns. `evidence_attachment_local`
  is currently a dead end — see `evidence_attachment`'s note above; local
  capture works, nothing ever ships it to the server.

**Sync invariants:** each local write has a stable `client_event_id`;
`/sync/batch` uses that identity for deduplication; SMS fallback and
direct POST use the same event ID; no last-write-wins merge for
field-captured incident content.

---

## 6. API Contract

Base URL `/api/v1`. All endpoints except `POST /auth/login`, `GET /barangays`,
public `POST /citizen-reports`, and protected internal `/sms/*`/service
endpoints require `Authorization: Bearer <token>`.

### Global invariants

- Caller `user_id`/`barangay_id` always resolve from the validated session, never request JSON.
- Every resource-ID endpoint does object lookup **and** tenant/ownership authorization before mutation or disclosure. Cross-tenant is `404`, never `403`.
- Web writes require a UUID `Idempotency-Key` header on retryable state-changing requests; mobile writes use `client_event_id`. The server persists the key and returns the original result on replay. *(`PATCH /incidents/:id` is the one exception that validates the header and discards it — see its own entry below; this is a bug, not a documented exception.)*
- Default page size 25, max 100.
- Errors: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `422 UNPROCESSABLE_ENTITY`, `429 RATE_LIMITED`, `500 SERVER_ERROR`, `503 SERVICE_UNAVAILABLE`. Envelope: `{"error":{"code":"...","message":"..."}}`.

### Auth

- `POST /auth/login` — `{username,password}` → `{token,user,expires_at}`. Same external shape/timing for unknown-user, wrong-password, locked-account.
- `POST /auth/logout` — revokes current `jti`, idempotent.
- `POST /auth/change-password` — self only, rehashes, revokes every other session.

### Users & devices

- `GET /users?role=&q=&page=&limit=` — Admin only, same barangay → includes `last_login_at` (from `auth_session`), `is_suspended`.
- `POST /users` — Admin only, own barangay, sets initial password. New role cannot be `lupon`.
- `PATCH /users/:id` — self may edit `full_name`/`contact_number`; Admin may additionally set **exactly one of** `is_active` or `is_suspended` on a same-barangay user (never both in one call — they're independent axes since 0011). Suspending or deactivating revokes all sessions + device registrations in one transaction. At least one usable (active AND not suspended) Admin must remain per barangay.
- `POST /devices/register` / `PATCH /devices/:id/deactivate` — Tanod, own device only.

### Incidents

- `POST /incidents` — tanod/secretary/admin. Idempotency key: mobile = `device_id + client_event_id`; web = `Idempotency-Key` header. Creates `pending`, server derives `barangay_id`/`reported_by`/`source`.
- `GET /incidents?q=&...` — tenant-scoped, Tanod forced to own; no raw narrative.
- `GET /incidents/:id` — Secretary gets `raw_narrative` + the three party fields (Secretary-only, same protection as raw narrative — §2 Rule 1); everyone else gets the allow-listed view with no narrative (there is no redacted narrative any more — nothing writes `redacted_narrative`).
- `PATCH /incidents/:id` *(new, 2026-09-06)* — **operational correction, not a narrative editor.** Admin+Secretary may set `priority`/`incident_type`/`location_description`; `complainant_name` is **Secretary-only**. Sending `raw_narrative`/`redacted_narrative` is a hard `400`. Requires `Idempotency-Key` — **but does not actually replay on it** (validates and discards); every sibling write replays for real. Audit records field *names* only, never values.
- `PATCH /incidents/:id/status` — Admin only, body `{status:"resolved"}`, requires no active dispatch remains. *(Historical: it also flipped a linked finalized blotter's `case_status` to `resolved`; no blotter exists since 2026-10-01.)*
- `POST /incidents/:id/evidence` / `GET /incidents/:id/evidence` — **documented, not implemented.** No POST route exists server-side; `GET` is real but permanently empty. See `docs/AUDIT_2026-09-07.md` F4.
- `GET /incidents/nearby` — Tanod only, radius-capped, never raw narrative/contact data.

### AI processing, Blotter and AI Tools — **(Historical — all removed 2026-10-01, migration 0029; and AI Tools earlier by 0027/0028)**

None of the following routes exist any more. Listed only so older notes
and audit-log rows (which are write-once and still mention them) can be
read. **Do not re-add without an explicit new decision.**

- AI processing: `GET /incidents/:id/ai-draft`, `POST /incidents/:id/redact`, `POST .../ai-draft/regenerate-summary`, `POST .../ai-draft/approve`, `POST .../ai-draft/translate`, `GET`/`POST .../ai-draft/extraction[/approve]`.
- Blotter: `POST /incidents/:id/finalize`, `POST /incidents/:id/blotter/amend`, `GET /blotter/:id`, `GET /incidents/:id/blotter`, `GET /blotter` (list). `POST /blotter` (walk-in) had already been removed 2026-09-10 because DILG BIMSS/KPIS is the mandated case ledger (§1).
- Lupon packet: `POST /incidents/:id/lupon-packet` (+`/download`).
- AI Tools: `/incidents/:id/ai-tools/*`, `/ai-tools/*`.
- Health/queue probes: `GET /system/ollama-status`, `GET /system/ai-queue`.

`PATCH /incidents/:id/lifecycle` (Secretary-only; duplicate/invalid/cancelled/reopened) is **not** part of this removal and remains live.

### Dispatch

- `POST /dispatch` — Admin only, `request_id` idempotency key, validates same-barangay/active/on-duty Tanod, no conflicting active dispatch, incident `pending`. Routing is not computed at creation time (`route_status="unavailable"`) — see `GET /dispatch/:id/route` below, which is what actually computes it, on demand, once a Tanod position exists to route from.
- `GET /dispatch`, `GET /dispatch/:id` — tenant/ownership scoped as in §7.
- `PATCH /dispatch/:id/status` — Tanod own assigned dispatch, or Admin override with required `override_reason`. Forward-only transitions.
- `PATCH /dispatch/:id/cancel` — Admin only, only `assigned`/`en_route`, reverts incident to `pending`.
- `GET /dispatch/:id/route?latitude=&longitude=&mode=car|foot` (2026-09-13) — Admin or the dispatch's own assigned Tanod, tenant-scoped, cross-tenant 404 never 403. Computes a road-snapped route from the CALLER's current position (query params, not a stored one) to the dispatch's incident via OpenRouteService (`OrsClient.php`), persisting the result onto `dispatch.route_json`/`route_status`. A GET that writes — same justification `GET /system/health` gives for itself. Never a 500 on a routing failure: a prior `route_json` is kept and `route_status` set to `stale` rather than discarded; `unavailable` only when no route has ever succeeded. No `Idempotency-Key` (the route depends on live position input, not a one-time creation — same shape as `GET /incidents/nearby`). Not audited (Rule 8 bars raw coordinates in `audit_log`). See `backend/scripts/verify-routing.sh`.

### GPS / SOS / duty / system health / reference

- `POST /gps`, `GET /gps/live`, `GET /gps/history` — as in §5's `gps_track`; `is_stale=true` at ≥120s without a fresh point.
- `POST /tanod-sos`, `GET /tanod-sos`, `PATCH .../acknowledge`, `PATCH .../resolve` — see §2 Rule 27 for the fallback-tier caveat.
- `POST /duty-status`, `GET /duty-status` — server always writes `channel=app` for this path (SMS-originated duty changes come in via §6's internal SMS handlers, `channel=sms`).
- `GET /system/health` — Admin only, local-only. `{api,db,ors,gsm_ingestion,notification_config,backup_last_success,restore_test_at}` *(historical: an `ollama` field was removed with the AI pipeline 2026-10-01; `health_check_log.ollama_status` survives only as historical rows)*, each `healthy|unhealthy|not_configured` (`ors` renamed from `osrm` 2026-09-13 when routing shipped on OpenRouteService instead of a self-hosted engine — a real, live probe, not a presence check). Never fabricated — `backup_last_success` reads a real file timestamp or `null`.
- `GET /barangays` — public, no auth, always exactly the four seeded rows.
- `GET /search?q=` — any authenticated web role, same scoping as `GET /incidents`, 2-64 chars, capped at 10 rows, never `raw_narrative`.

### Audit / reports

- `GET /audit-log` — Admin, own barangay.
- `GET /reports/summary` — `avg_response_time_minutes` is defined as `incident.created_at → dispatch.arrived_at` per incident that reached `arrived`. **Currently double-counts** an incident with more than one arrived dispatch (`AVG()` over an un-deduplicated join) — see `docs/AUDIT_2026-09-07.md` F8; the target fix is a per-incident `MIN(arrived_at)` before averaging.
- `GET /reports/heatmap`, `GET /reports/notifications-summary`, `GET /reports/export` — as specified; export is audited.

### Shifts, fatigue, map packages, citizen reports, sync

- `POST /shifts`, `PATCH /shifts/:id` (optimistic concurrency via `version`), `GET /shifts`.
- `POST /shift-swap-requests`, `PATCH /shift-swap-requests/:id` — locks request + shift, revalidates.
- `GET /shifts/fatigue-flags`, `PATCH /fatigue-flags/:id/acknowledge`.
- `GET /map-packages/:barangay_id` (+`/download`), `POST /map-packages` — Admin publishes, Tanod downloads own barangay only.
- `POST /citizen-reports` — public, rate-limited (per-`REMOTE_ADDR`, defeated if the API sits behind a shared-egress tunnel — see Rule 7's note), size-limited. **Stores `description`/`contact_number` verbatim with no sanitization** — the head of an open stored-XSS chain into the Secretary session once converted (`docs/AUDIT_2026-09-07.md` F2/F3).
- `GET /citizen-reports?status=&q=` (Admin/Secretary), `POST /citizen-reports/:id/convert` — idempotent, one incident per report.
- `POST /sync/batch` — Tanod only, `{device_id,incidents[],gps_tracks[],duty_status_updates[],dispatch_status_updates[],sos[]}`, oldest-first, event-key deduplication. **No evidence channel** — matches evidence upload's absence above.

### Internal SMS / GSM

Two genuinely different kinds of endpoint live under this heading —
conflating them (as an earlier draft of this reference did) misdescribes
half of them:

- **Inbound handlers** — callable only by the local GSM ingestion service over loopback/mutual-auth, never public: `POST /sms/incident-fallback`, `/sms/coord-ping`, `/sms/duty-status`, `/sms/sos`. Each validates sender/device mapping, ignores any embedded user ID, checks freshness/replay, then reconstructs the equivalent app-originated event.
- **Outbound triggers** — the backend's own dispatch/notification services call these to *send* an SMS via the local GSM gateway (replaced Semaphore 2026-09-23): `POST /sms/dispatch-payload`, `/sms/priority-alert`. These create/update a logical notification + delivery attempt; they are not something the ingestion service calls after receiving a message.
- `GET /sms/logs` — Admin, own barangay, phone numbers masked.
- `GET /sms/conversations` (+`/:phone/messages`, +`/:phone/resolve`), `POST /sms/send`, `POST /sms/broadcast` — Admin-only, real in-tenant recipients only (never an arbitrary client-supplied number), Idempotency-Key required. `broadcast`'s idempotency check scans `audit_log` via `JSON_EXTRACT` — works, but unindexed and grows with the log; a future retention pass on `audit_log` would need to account for this.

**Offline detection:** 3 consecutive failed health-check pings, 5s timeout each, 2s apart (~21s window). Fallback transport never overwrites or destroys the local queue item.

### Notification lifecycle & acknowledgment

After an FCM delivery is `sent`, a local worker waits 60s for
`notification_target.acknowledged_at`; no ack → `ack_timeout` on that
delivery row, which does not itself trigger SMS (only an FCM *send*
failure does, per Rule 12). `POST /notifications/:id/ack` is idempotent
for an already-acknowledged target and doesn't force a transport
attempt to become `sent`.

### Settings *(0012)*

- `GET /system-settings` / `PATCH /system-settings` — Admin only. Allow-listed keys only (see §5's `system_settings` entry); secrets masked on every read, write-only from the client's perspective.

---

## 7. Role & Permission Matrix

**Legend:** ✓ Full access · R = Read-only/redacted · ✗ No access · — not a role.
Every ✓/R action is limited to the caller's own barangay unless the
endpoint is public intake. "own/assigned" means the server checks the
caller's relationship to the specific record, not merely their role.

| Action | Admin | Secretary | Tanod | Punong Barangay | Lupon |
|---|---|---|---|---|---|
| **Incidents** |
| Log incident (mobile) | ✗ | ✗ | ✓ | ✗ | — |
| Web incident entry / operational correction (`PATCH`) | ✓ | ✓ (+ `complainant_name`) | ✗ | ✗ | — |
| ~~Walk-in blotter entry~~ *(removed 2026-09-10 — BIMSS/KPIS owns it; the rest of the blotter removed 2026-10-01)* | — | — | — | — | — |
| Convert citizen report → incident | ✓ | ✓ | ✗ | ✗ | — |
| View raw narrative / incident party fields | ✗ | ✓ | ✗ | ✗ | — |
| Incident lifecycle (duplicate/invalid/cancelled/reopened) | ✗ | ✓ | ✗ | ✗ | — |
| Resolve incident status | ✓ | ✗ | ✗ | ✗ | — |
| *(Historical, removed 2026-10-01: AI assistants, redaction trigger/approval, view redacted narrative, finalize/amend blotter, view blotter, generate Lupon packet)* | — | — | — | — | — |
| **Dispatch / GIS / SOS** |
| Create/override/cancel dispatch | ✓ | ✗ | ✗ | ✗ | — |
| Own dispatch status | ✗ | ✗ | ✓ | ✗ | — |
| Live tracking / heatmap / SOS ack-resolve | ✓ | ✗ | ✗ | R | — |
| Broadcast GPS / trigger SOS | ✗ | ✗ | ✓ | ✗ | — |
| **Personnel** |
| Create/edit/deactivate/**suspend** user | ✓ | ✗ | ✗ | ✗ | — |
| Shift scheduling, swap approval, fatigue ack | ✓ | ✗ | ✗ | ✗ | — |
| Own shifts, swap request | ✗ | ✗ | ✓ | ✗ | — |
| View fatigue flags | ✓ | ✗ | ✗ | R | — |
| **Reports / Audit / SMS** |
| Reports, notification reliability, export | ✓ | ✗ | ✗ | R | — |
| Audit log, SMS log/conversations/send | ✓ | ✗ | ✗ | ✗ | — |
| **Citizen reports** |
| View inbox | ✓ | ✓ | ✗ | ✗ | — |
| **Map packages** |
| Publish | ✓ | ✗ | ✗ | ✗ | — |
| View/download own barangay | ✓ | ✗ | ✓ | ✗ | — |
| **System Settings** *(0012)* |
| Read/write SMS gateway + general keys | ✓ | ✗ | ✗ | ✗ | — |
| **Account** |
| Own profile/password | ✓ | ✓ | ✓ | ✓ | — |

---

## 8. Design System (Global)

**Tone:** clean, enterprise government-tech — trust and reliability,
scannable in under 2 seconds during an active incident. Never a "student
project" or demo look.

**Design tokens** (`web/css/base.css`) — never a hardcoded hex/px/font in
a component file: `--color-*` (navy/primary/accent/surface/critical/
warning/success/info + `-solid`/`-text` variants for dark mode), spacing
scale `--spacing-xs..2xl`, `--font-*` sizes, `--radius-*`, `--shadow-*`,
plus `--control-height`/`--pad-panel` and friends added by the 2026-09-06
UI/UX audit. Dark mode is a second value set on the same tokens, resolved
at load (`index.html` stamps `data-theme` before first paint) rather than
relying only on `prefers-color-scheme`.

**Status pills:** fully-rounded, tinted low-opacity background, solid
text — never a flat badge. Pending/queued = warning/info per context;
resolved/completed/approved/on-duty = success; offline/cancelled/denied =
secondary text color; failed/SOS/critical = critical. An acknowledged-but-
not-resolved SOS stays critical/warning, never success, until `resolved`.

**Required states, every data-driven screen:** Loading (skeleton, never
blank) · Empty (icon + explanation) · Error (banner + retry) · Populated.
Mobile adds Offline.

**Nav shell:** web — dark navy collapsible sidebar (role-filtered), white
topbar. Mobile — bottom nav: Home, Assignments, Log Incident, Map,
Profile; persistent offline banner docks above it when active.

**Responsive:** desktop-first 1440px → tablet 768px (sidebar collapses)
→ mobile 375px (tables become cards, emergency actions stay large).

**Accessibility:** 44×44px min mobile tap target · never color-alone for
status · real `<button>`/`<a>`/form elements, never a clickable `<div>` ·
programmatic labels, not placeholder-only · `role="status"`/`"alert"` on
loading/error regions · a text/data equivalent for every chart.

**Production-realism rule** — this must look like the live deployed
system: no demo-account hints, "DEMO MODE" banners, or prototype tells;
seed data is realistic (plausible Filipino names, real barangay names)
but never labeled fake in the UI; no Lorem Ipsum or placeholder branding;
no hardcoded credentials anywhere in committed code; an unbuilt
dependency is mocked invisibly at the service layer, never with a visible
"MOCK DATA" label; no confidence/score number presented as measured without a real
basis (the former `ai_evaluation_run` table no longer exists); no "All Systems Operational" badge that
isn't a real probe result.

---

## 9. Screens

Every data-driven screen implements Loading/Empty/Error/Populated;
mobile also Offline. Screens marked "merged" below now share one nav
entry with tabs — see `docs/REFERENCE.md` §7 for the current mapping,
which has moved since this list was first written (W5+W9 → Analytics,
W10-W13 → Personnel).

**Web:** W1 Login (no role selector, generic failure message) · W2 Admin
Dashboard (`GET /reports/summary`, PB read-only) · W3 Dispatch Center
(queue + live map, Tanod picker same-barangay/eligible-only) · W4 GIS
Live Tracking (freshness-badged markers, SOS always visible above
filters) · W5 Historical Heatmap (bounded range, explicit
non-predictive label) · **W7 Incident Detail** *(W6, the records list,
was removed 2026-09-10 — BIMSS/KPIS is the mandated ledger; W7 stays as
the app's ONLY per-incident detail view and keeps the `blotter-detail`
route key)* (incident dossier, narrative for the Secretary only, evidence, timeline,
Secretary lifecycle actions; *historical, removed 2026-10-01: redacted
excerpt, `case_status` transition control, AI Blotter Assistant panel,
and the Redaction/Blotter tabs*) · ~~**AI assistants embedded in host screens**~~ *(Historical — removed 2026-10-01)*
*(The AI Tools screen and its embedded assistants/`AiToolPanel.js` were removed by migrations 0027–0029.)* ·
~~W8 AI Redaction Review~~ *(Historical — removed 2026-10-01)* · W9 Statistical
Reports (exact trend/response-time/notification datasets, export
audited) · W10 User Management (create/deactivate/reactivate/**suspend**,
one-usable-Admin guard) · W11 Scheduler · W12 Shift Swap Requests · W13
Fatigue Flags · W14 SMS Monitor (activity log + conversations,
compose/broadcast real, delivery honestly reflects no gateway
configured if that's the case) · W15 Settings (self-profile always;
General + SMS Gateway sections since 0012, Admin-only) · W16 Citizen
Reports Inbox (Convert to Incident, location column) · W17 Audit Log
Viewer · W18 Map Package Management · W19 Public Citizen Report (one of
four barangays, rate-limit messaging, non-sensitive reference number) ·
W20 Service Health (real dependency probes, never hardcoded) · W21
System Settings beyond General/SMS Gateway — **still not built**, no
schema/endpoints exist for Notifications/Security/GIS/Backup sections;
don't add a control that looks functional and does nothing (§8).

**Mobile:** M1 Login (device register, map-package check, no download
block) · M2 Home (duty toggle calls `POST /duty-status` for real, SOS
quick action) · M3 Log New Incident (writes locally before leaving the
screen, stable `client_event_id`) · M4 Submitted Confirmation (never
claims server submission from local persistence alone) · M5 Assignments
List (cached, stale-indicator) · M6 Assignment Detail/Navigation (queued
status changes reconcile via idempotent event IDs, cached route labeled
as such) · M7 Live Map · M8 Shift Schedule · M9 Shift Swap Request · M10
Profile (atomic logout + device deactivation) · M11 Offline Indicator
(queue counts across every write type, never disappears with unresolved
records) · M12 Critical Alert Overlay · M13 SMS Fallback Confirmation
(exact transport state, never "successful" for a merely-queued attempt)
· M14 My Incident Reports.

### Cross-Screen Consistency Checklist

- [ ] Tenant/ownership checks enforced server-side on every object ID.
- [ ] All state transitions follow §2/§6.
- [ ] All retryable writes use idempotency/client event IDs — for real, not merely a validated-and-discarded header (see `PATCH /incidents/:id`'s known exception).
- [ ] Offline screens show explicit stale/cached state.
- [ ] No raw narrative appears outside Secretary-authorized surfaces.
- [ ] No screen interpolates server data into `innerHTML` without escaping (see `docs/AUDIT_2026-09-07.md` F2/F3 for the current violations).
- [ ] Design tokens only; no hardcoded colors/spacing/fonts.
- [ ] No demo/prototype tells.

---

## 10. Explicitly out of scope

No sprint assignment, no schema, no endpoint — each would need its own
design pass before implementation:

- **Full W21 System Settings** (Notifications/Security/GIS/Backup sections) — beyond the narrow 0012 override (SMS gateway + general display keys).
- **Two-way SMS console** (reply/broadcast to arbitrary inbound threads) as an extension of W14 beyond what's built.
- **AI incident auto-classifier / threat-risk scorer** — the earlier AI Tools versions were built then removed (0027/0028/0029); any future version needs a real scoring design and a real evaluation basis behind any confidence number, and an explicit new decision.
- **A composite "performance score" chart** — needs a defined scoring formula with the same rigor as `avg_response_time_minutes`'s exact definition.
- **A public marketing landing page** — this is a specific system for four named barangays, not a SaaS product; W19 is the real public entry point. If a public informational page is wanted, keep it a short honest description with a link to W19, never a metrics-driven marketing page.
- **Voice-to-text transcription** (voice *capture* is in scope and built) — would either route audio off-device (violates Rule 1) or require a self-hosted ASR model; no AI runtime exists since 2026-10-01. Needs an explicit new decision.

---

## 11. Retention

| Record | Retention | Notes |
|---|---|---|
| `raw_narrative` | **Hard-purged at 90 days from `created_at`** (`RetentionService::RAW_NARRATIVE_CEILING_DAYS`). *(The original "30 days after human-approved redaction" branch still exists in code but can never fire — nothing can approve a redaction since 2026-10-01.)* | Legal hold is the only exception. **OPEN POLICY DECISION (flagged 2026-10-01, not decided here):** there is no redacted replacement, so the narrative is permanently destroyed at 90 days with nothing kept. Whether the window, a Secretary-authored summary, or the barangay's binder record is the intended continuation needs a decision and an architecture review (Rule 10) |
| Incident record / evidence | 7 years default *("redacted" and "blotter" dropped from this row 2026-10-01 — neither exists)* | LGU records schedule or legal hold may override |
| `citizen_report` (unconverted) | 1 year from `submitted_at` | Converted reports follow the linked incident's clock |
| `audit_log` | 7 years, write-once except retention deletion | |
| `sms_log` | 1 year default, extended for the duration of any hold on the linked incident/dispatch/citizen report | **Built 2026-09-12** (migration 0016). Enforced live at purge time across four paths: the row's own `legal_hold`, the linked incident, the linked citizen report, and the linked dispatch resolved through to its incident. Checking live rather than inheriting on write means a hold placed *after* the message was logged still protects it |
| ~~`ai_processing_log`~~ | **(Historical — table dropped 2026-10-01.)** Formerly 1 year / linked incident's retention | |
| ~~AI Tools jobs~~ | **(Historical — removed 0027/0028/0029.)** Formerly 90 days | |
| `mobile_device` / device secrets | Secret columns (`fcm_token`, `device_secret_ref`) cleared 90 days after deactivation; **the row itself is retained, not deleted**, so `incident.device_id` provenance survives on records under longer retention or legal hold | **Built 2026-09-12** (migration 0016 + `RetentionService::scrubDeactivatedDevices()`). Revised from the original "delete the row", which was found to silently strip device attribution from 7-year legal records via `ON DELETE SET NULL` 90 days after deactivation. `secrets_scrubbed_at` is the per-record evidence and the idempotency guard; `fcm_token` is emptied rather than nulled (NOT NULL in the 0001 baseline) and is unreachable by the send path, which only reads tokens `WHERE is_active = 1` |
| Offline mirror (`offline_queue`, mobile local tables) | Cleared on confirmed sync | No independent raw-data ceiling; server mirror never holds raw payload |
| Backups | Follow the retention of the source data they contain | A deletion is not complete while a retained backup still holds the same data |
| `gps_track` | 1 year from `recorded_at` | **Added 2026-09-26** (H-15, 2026-09-24 external audit + architecture-review sign-off). No `legal_hold` column — operational telemetry, not the evidentiary record. `RetentionService::purgeGpsTracks()` |
| `duty_status` | 1 year from `changed_at` | Same H-15 sign-off; mirrors the National Archives of the Philippines' Daily Time Record retention period (1 year), the closest real-world analog. `RetentionService::purgeDutyStatuses()` |
| `shift_schedule` | 1 year from `end_at` | Same H-15 sign-off, same DTR analog. Purges its two `ON DELETE RESTRICT` dependents (`fatigue_flag`, `shift_swap_request`) in the same per-row transaction as the incident cascade above. `RetentionService::purgeShiftSchedules()` |
| `notification` | 1 year from `created_at` | Same H-15 sign-off; matches the existing `sms_log` default for a comparable dispatch/alert transport record. `notification_target`/`notification_delivery` cascade automatically (`ON DELETE CASCADE`). `RetentionService::purgeNotifications()` |
| `map_package` | No time-based retention | Governed by the per-barangay storage quota (M-07/H-21) instead of a clock — deliberate, not an oversight (H-15's own resolution note) |

**Pre-UAT exit conditions:** executable schema matches §5 · every §6 endpoint's documented response shape and authorization rule matches the implementation · tenant penetration tests pass · offline duplicate tests pass · critical notification/SOS fallback tests pass · restore test passes · no unresolved P0/P1 contradictions. **As of 2026-09-07, the second and fourth conditions are failing** — see `docs/REMAINING.md` §F.

Recovery baseline: daily encrypted local backup, documented retention,
periodic restore verification, tested restart procedure. Backups are
recovery copies, not an independent archive.

---

*Document status: partially reconciled 2026-10-01 for migration 0029
(blotter/AI removal only — see the note at the top); otherwise
reconciled against shipped code as of migration 0014. For what's currently broken in the running system (not
in this document), see `docs/REMAINING.md` and `docs/AUDIT_2026-09-07.md`.
For day-to-day session state, see `docs/HANDOFF.md`. Historical sprint
prompts and the full prompt-engineering scaffolding once carried here now
live in `docs/Baranguard_Sprint_Prompts.md`/`docs/SPRINTS.md` and
`backend/DEVLOG.md` respectively — kept out of this file so it stays a
technical reference, not a process log.*
