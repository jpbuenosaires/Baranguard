# Baranguard — Master Reference

Barangay Intelligence and Emergency Dispatch System. Offline-first, locally
hosted incident reporting and emergency dispatch platform for four
barangays (Dao, Binanuahan, Marifosque, Banuyo) in Pilar, Sorsogon,
Philippines. During initial development the system of record is local
MariaDB 10.4 (via XAMPP, MySQL-compatible); cloud deployment is deferred
and undecided. BSIT capstone,
Bicol University — treat as a real production system being built, not a
demo.

This is the single source of truth for schema, API, roles, screens, and
build prompts. Keep this file in the repo and load it into every session
via your project `CLAUDE.md` (an `@import` works) instead of pasting it
manually. Do not invent field names, endpoints, or roles not listed
here — check §5/§6/§7 first.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Backend | PHP 8.2 + Node.js |
| Web frontend | Vanilla JS (ES2023+), plain CSS — no framework, no Tailwind/Bootstrap |
| Mobile | Ionic React 9.0.1 + Capacitor 8.5.1 (Android) — pinned tested baseline; patch updates require compatibility testing. (Was "Ionic 8.8.5 + Capacitor 8.0" until 2026-09-02: the Ionic starter now generates Ionic 9 + React 19, and adopting it rather than downgrading was an explicit decision at scaffold time — see `backend/DEVLOG.md`. The **React** flavor was also chosen here; §1 previously named only "Ionic", which left Angular/React/Vue undecided.) |
| Server-side DB | MariaDB 10.4 (via XAMPP) — MySQL-compatible; local current system of record; cloud hosting deferred/undecided |
| Mobile local DB | SQLite via a Capacitor SQLite plugin (e.g. `@capacitor-community/sqlite`), encrypted-database mode (SQLCipher-backed) |
| AI | Llama-SEA-LION-v3.5-8B-R via Ollama, self-hosted on the unified administrative workstation — **never** an external AI API |
| SMS | Semaphore SMS Gateway + tethered phone as GSM modem fallback |
| Push | Firebase Cloud Messaging (FCM) HTTP v1 via backend notification service; Android high-priority/full-screen path for M12 |
| Mapping | MapLibre with prepackaged offline vector tiles (MBTiles) for the four barangays; online tiles when connected |
| Routing | OSRM (self-hosted, OpenStreetMap data for the four barangays), runs on the admin workstation — generates `dispatch.route_json`; requires LAN connectivity to the workstation, never internet |

**DB engine note:** XAMPP's Control Panel labels this module "MySQL," but
XAMPP ships MariaDB under that label — this project runs on the actual
installed engine, MariaDB 10.4. All JSON columns in §5 are stored/read as
opaque blobs, never queried with MySQL-8-only JSON functions (e.g.
`JSON_TABLE`), so this stays fully MariaDB-compatible without ruling out
a later move to real MySQL 8.0.

---

## 2. Architecture Rules

1. **No unprotected raw narrative leaves the trusted environment.** `raw_narrative` is stored locally and may be processed only by the local SLM/redaction service or an explicitly approved local workflow. It must never be sent to FCM, Semaphore, a cloud AI API, cloud storage, or any other third-party service. The GSM/SMS fallback is an exception only for a compact, authenticated-encrypted transport envelope defined in §6; raw text is never placed in plaintext SMS and the carrier is treated as an untrusted transport.
2. **Offline capture is durable until reconciliation.** Every incident is persisted to encrypted mobile SQLite before the user can leave the capture flow. The local record remains available until the server confirms acceptance or a duplicate has been safely correlated. Device loss, storage corruption, uninstall, or physical destruction are outside the application guarantee. The server becomes authoritative after successful reconciliation; the local record remains as an audit/cache copy until normal device retention rules allow cleanup.
3. **Only the human-approval endpoint may commit `incident.redacted_narrative`.** AI output remains draft state until Secretary approval. No import, sync, citizen conversion, SMS handler, or other service may write the permanent redacted field.
4. **SMS fallback uses explicit trigger and secure envelope rules.** Fallback starts only after the health-check rule in §6 and never merely because the user has pressed Submit. Transport security, deduplication, expiration, replay protection, and correlation use the message envelope defined in §6.
5. **No telecom-layer silent/Flash SMS is assumed.** Critical alerts use the configured Semaphore priority path plus the app's notification/overlay behavior. Background coordinate beacons are ordinary authenticated SMS messages parsed by the trusted local service. Never describe ordinary SMS as telecom-layer silent SMS.
6. **RBAC and object ownership are enforced server-side.** Client-side hiding is UX only. Every protected endpoint must verify role, tenant, and any object-specific ownership/caller relationship before returning or mutating data.
7. **The system is locally hosted during initial development.** MariaDB, PHP/Node backend, web dashboard, local AI inference, OSRM, and GSM ingestion run in the trusted local environment. No public internet exposure is assumed. Mobile capture must continue in its encrypted cache while the local workstation is unavailable. Recovery/restart requirements are defined in §11.
8. **The four barangays are isolated tenants.** Authenticated callers are permanently scoped to the `barangay_id` in their session. Any endpoint that accepts or resolves a tenant/resource must enforce the same tenant boundary, including all `/:id` routes. A public citizen report is the only pre-auth flow that may select one of the four known barangays.
9. **Authentication/session lifecycle.** Passwords use Argon2id with the password policy in §6. JWTs expire in 15 minutes and carry a unique `jti` mapped to one `auth_session`. Every authenticated request verifies signature, allowed algorithm, expiry, session existence, session revocation, user activation state, and tenant identity. Sliding renewal may extend a still-valid session; the server emits the newest token with a non-decreasing expiry, and the client must keep the token with the latest expiry. An expired/revoked session is never revived. Logout revokes the current session. Deactivation and password reset revoke active sessions as specified in §6. A genuine 15-minute gap without a successful authenticated request causes session expiry; offline mobile capture is unaffected. Failed-login handling is externally indistinguishable for unknown, invalid-password, and locked-account cases. Expired/revoked sessions are retained 90 days, then purged by an auditable job.
10. **Administrative bootstrap is one-time and deterministic.** The four barangay IDs are fixed in the baseline migration. The first Admin in each barangay is created only by the interactive trusted CLI bootstrap. Passwords are never embedded in source code, migration files, seed files, logs, screenshots, or UI. There is no self-registration for privileged roles.
11. **Retention has an operational track and an evidence/audit track.** `raw_narrative` is deleted after successful human-approved redaction plus the defined grace period, subject to legal hold. There is also a maximum raw-data ceiling so an unapproved/abandoned incident cannot retain raw data indefinitely; legal hold is the only documented retention exception. Redacted incident/blotter/evidence records follow the seven-year default unless the LGU records schedule or legal hold requires otherwise. Audit/SMS/AI/device/offline-mirror retention periods are defined in §11. Backup copies are included in retention and deletion controls; a database deletion is not considered complete while retained backups still contain the same data outside their documented backup lifecycle.
12. **Notifications are modeled as logical notifications plus delivery attempts.** FCM and SMS are transport channels; a logical notification has one identity and can have multiple delivery attempts. Third-party payloads contain only minimal identifiers and non-sensitive metadata. If no active FCM registration exists for the target Tanod, SMS is used immediately with no FCM attempt. If an FCM send attempt errors or times out, retry once, then use SMS on the second failure. If FCM succeeds but the client does not acknowledge within 60 seconds, record `ack_timeout`; do not automatically send SMS. The app must be able to render a critical alert from local cached data when the local API is unavailable.
13. **SMS-originated duty changes are first-class.** `duty_status.channel = "sms"` is written only by the validated internal SMS handler. Sender identity is derived server-side from a registered Tanod/device mapping; any user ID included in the SMS payload is ignored for authorization.
14. **Offline maps are part of the offline-first guarantee.** Each approved device has a versioned encrypted/app-private cached basemap package. The workstation publishes packages per barangay. M6/M7 distinguish cached data from live data; route computation requires workstation connectivity, but the last successfully received route remains usable offline.
15. **The unified workstation is an infrastructure single point of failure.** If DB/API/OSRM/Ollama/GSM services are unavailable, the mobile app preserves locally capturable work where the feature contract allows it. AI jobs queue. No external AI fallback exists. Recovery, backup, health checks, and operator diagnostics are mandatory for UAT.
16. **AI pipeline is ordered and versioned.** Raw narrative → redaction draft → summary derived from the draft → Secretary review → approval. Summary generation never reads raw text. Translation is a separate post-approval job against the approved redacted text only. Every AI run records source/target language where relevant, model version, status, and the draft version it operated on. Bikol is treated as unvalidated until empirical testing is completed.
17. **Administrative actions are auditable.** Login success/failure, logout, user changes/deactivation, password changes/resets, shift changes, swap decisions, dispatch create/override/cancel, incident status changes, AI approval/reruns, blotter finalization/amendments, Lupon packet generation, SOS lifecycle, citizen conversion, device changes, configuration changes, and retention jobs produce audit events where applicable. Audit metadata is allow-listed and contains identifiers/statuses only, never raw narrative or credentials.
18. **Mobile read access is least-privilege and cached deliberately.** Tanods read their own dispatches, own duty history, own submitted incidents, and nearby redacted markers. The mobile cache may hold only the fields needed for approved offline screens. Cached data is subject to the same tenant/ownership restrictions as live API responses.
19. **Cloud deployment is deferred.** Current implementation is local only. No cloud database, backend, object storage, or cloud AI is in scope. Revisit the architecture before introducing any cloud-specific code.
20. **Incident priority is server-controlled.** `incident.priority` is `normal|high|critical`. Client input cannot self-promote. Default is `normal`; only configured backend rules/admin workflow may elevate priority.
21. **Incident and dispatch state machines are explicit.** Incident states are `pending → dispatched → resolved`, with `dispatched → pending` only through valid dispatch cancellation before arrival. Dispatch states are `assigned → en_route → arrived → completed`, with `assigned/en_route → cancelled`. No backward or skipped transition is allowed through the ordinary status endpoint. Incident resolution requires that no active dispatch remains for the incident.
22. **Internal GSM ingestion is local-only.** A tethered GSM phone/modem feeds a local ingestion service. Inbound SMS is authenticated, deduplicated, size-limited, decrypted/verified when applicable, parsed, and then passed to internal handlers over loopback or an equally protected local service boundary.
23. **AI draft edits use optimistic concurrency.** Every active draft has a `draft_version`. Editing/regenerating increments it. Approval must identify the exact current version; stale tabs receive `409` and must reload.
24. **Notification delivery has separate logical and transport records.** Reliability reports may aggregate end-to-end notification outcomes or transport-specific outcomes, but the metric definition must be explicit. Ack timeout never silently changes delivery truth.
25. **Public reports and evidence have explicit retention.** Public reports are retained according to the policy in §11; converted reports follow a defined post-conversion rule. Evidence retains independently until its incident/evidence retention deadline or legal hold.
26. **Device secrets are protected.** FCM tokens, local database keys, message-encryption keys, and device-registration secrets are never exposed through ordinary API payloads, audit logs, debug logs, or UI. Keys use platform-protected storage where supported.
27. **Tanod SOS is a dedicated immediate channel.** SOS never depends on incident dispatch triage. It creates a persistent SOS record and sends alerts to Admin and other eligible on-duty Tanods. SOS must have a local/offline fallback path so a workstation/LAN outage does not silently suppress a personal-safety emergency.
28. **Dispatch cancellation is non-destructive.** A cancelled dispatch is retained as history. Its incident returns to `pending` only when the cancellation transaction confirms the dispatch was in `assigned` or `en_route`. GPS, notification, audit, and SMS history remain immutable historical records.
29. **Idempotency is required for retriable writes.** Incident creation, `/sync/batch`, dispatch creation, SOS creation, citizen-report conversion, device registration, evidence upload, and any internally retried transport must use a stable client/correlation key or equivalent transaction check so retries cannot create duplicate business records.
30. **All protected resource lookups are transaction-safe.** Read-modify-write operations that affect dispatch state, citizen conversion, swaps, AI drafts, or retention use row locking/optimistic concurrency as appropriate. A request must not authorize an object using stale tenant/ownership data.
31. **Time policy is explicit.** Persist timestamps in UTC where practical; operational shift times are interpreted in Asia/Manila. Client-created timestamps are informational and never override server receipt timestamps. Client clock skew must not bypass session expiry or retention.
32. **Production recovery is part of correctness.** Backups, restore verification, database migration rollback strategy, service health checks, and workstation restart procedures are required before UAT. The system is not considered production-ready merely because the happy-path UI works.


## 3. Roles

Four active login roles: `admin`, `secretary`, `tanod`, `punong_barangay`.
`lupon` stays in the DB enum for historical/attribution reasons only — not
an active login role.

| Role | Who | Primary responsibility |
|---|---|---|
| Admin | IT/system administrator | Full operational control — user mgmt, scheduling, live dispatch, GPS oversight, incident status — scoped to own barangay only |
| Secretary | Barangay Secretary | Blotter mgmt, PII redaction approval (RA 10173 gate), blotter finalization |
| Tanod | Field responder | Incident capture, GPS broadcast, own dispatch/duty |
| Punong Barangay | Elected chief executive | Oversight — read-only across nearly every module (§7) |
| Lupon | Dispute-resolution mediators | No system account (see below) |

There is no separate Dispatcher role — live dispatch, GPS oversight, and
incident-status updates sit with Admin alongside its user-mgmt/scheduling
duties.

**Admin ≠ Punong Barangay.** Under RA 7160 §389, the Punong Barangay is the
elected chief executive (enforcing laws, peace and order, presiding over
sessions, budget approval, appointing Secretary/Treasurer) — governance and
oversight, not hands-on records/account administration. "Admin" is the
operational role a real PB would delegate to staff. Keeping them separate
preserves least-privilege / separation-of-duties: the person with
appointment power over staff (PB) isn't also the one with write access to
those staff's accounts and schedules (Admin). One person could informally
hold both in a small barangay, but that's an account-provisioning choice —
issue two accounts, don't merge the roles.

**Secretary's permissions have a specific legal basis.** RA 7160 §394(c)
makes the Barangay Secretary custodian of all barangay records; the Revised
Katarungang Pambarangay Law §2 has the Secretary concurrently serve as
Secretary of the Lupon, keeping the complaint record book. That's why only
Secretary holds `raw_narrative` access, redaction approval, and blotter
finalization — a records-custodian mandate, not an executive one, so it
doesn't extend to user management or scheduling (stays Admin).

**Lupon has no system login.** Lupon members are barangay residents
appointed by the PB as mediators, not staff with their own record-keeping
office — the Secretary is the statutory custodian. Lupon/Pangkat
proceedings already have a built-in privacy mechanism. This system reflects
that: Lupon receives case materials as a Secretary-generated printed/
exported packet for one specific referred dispute
(`POST /incidents/:id/lupon-packet`), never a standing dashboard account.

---

## 4. Naming & Folder Conventions

| Layer | Convention | Example |
|---|---|---|
| DB tables/fields | snake_case | `incident_id`, `raw_narrative` |
| API JSON keys | snake_case (matches DB, no translation layer) | `{ "incident_id": 1 }` |
| PHP | snake_case | `$incident_id`, `get_incident_by_id()` |
| JS/TS (web & mobile) | camelCase | `incidentId`, `getIncidentById()` |
| JS components/classes | PascalCase | `IncidentForm`, `DispatchMap` |
| JS files | kebab-case (pages/routes), PascalCase (components) | `incident-log.js`, `IncidentForm.js` |
| CSS classes | kebab-case, BEM modifiers | `.dispatch-card`, `.dispatch-card__header` |
| CSS custom properties | kebab-case, `--` prefix | `--color-primary` |
| Git branches | `sprint-N/feature-short-name` | `sprint-3/gps-live-tracking` |
| Git commits | `[SprintN][USx] Short description` | `[Sprint2][US3] Add offline SQLite incident capture` |

**Boundary rule:** exactly ONE central API client file per platform
(`apiClient.js` web, `apiService.ts` mobile) does snake_case → camelCase
conversion. Never convert ad-hoc inside a component.

```
/baranguard
├── /backend    → /routes /controllers /models /middleware
│                 /services(/sms /ai /sync) /config /migrations
├── /web        → /src(/pages /components /styles /api)
├── /mobile     → Ionic/Capacitor app
└── /ai         → SLM prompts, /test-data (synthetic PII only — never real data)
```

---

## 5. Database Schema

### Local Server-Side MariaDB 10.4 (via XAMPP, MySQL-compatible) — System of Record

**Schema contract:** Every column must have an explicit SQL type, nullability, default, and index/constraint decision in the migration. Migrations are applied in dependency order: `barangay` → `user` → `mobile_device` → `incident` → `dispatch` → `tanod_sos` → `notification` → `notification_target` → `notification_delivery` → remaining dependent tables; no unresolved foreign-key cycle is permitted. (`mobile_device` must precede `incident`: `incident.device_id` is a FK into it.) Foreign keys must declare delete behavior. Unless a section explicitly says otherwise, tenant/resource integrity is enforced both in application logic and by relational constraints where feasible. Database timestamps are stored in UTC (`DATETIME`/`TIMESTAMP` as specified by the migration); roster/business-time calculations and UI display use `Asia/Manila`. Client-supplied timestamps are informational and never replace authoritative server receipt time. MariaDB partial/filtered unique indexes are not assumed; nullable composite UNIQUE constraints plus transactional checks are used where a partial constraint would otherwise be required.

**`barangay`** — `barangay_id` SMALLINT UNSIGNED PK · `name` VARCHAR(128) NOT NULL · `municipality` VARCHAR(128) NOT NULL · `province` VARCHAR(128) NOT NULL · `population` INT UNSIGNED NULL · `boundary_geojson` JSON NULL · `created_at` DATETIME NOT NULL · UNIQUE(`name`,`municipality`,`province`). Four baseline rows use deterministic IDs and are never regenerated.

**`user`** — `user_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `username` VARCHAR(64) NOT NULL UNIQUE · `password_hash` VARCHAR(255) NOT NULL · `full_name` VARCHAR(255) NOT NULL · `role` ENUM('admin','secretary','tanod','punong_barangay','lupon') NOT NULL · `contact_number` VARCHAR(32) NULL · `is_active` BOOLEAN NOT NULL DEFAULT TRUE · `failed_login_attempts` INT UNSIGNED NOT NULL DEFAULT 0 · `login_failure_window_started_at` DATETIME NULL · `locked_until` DATETIME NULL · `created_at` DATETIME NOT NULL · `updated_at` DATETIME NULL · INDEX(`barangay_id`,`role`,`is_active`). `lupon` remains historical-only and cannot be created/activated for login. Username normalization is deterministic: trim surrounding whitespace, convert to lowercase using application-defined ASCII username rules, then validate and persist the normalized value before uniqueness/authentication checks.

**`auth_session`** — `session_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` CASCADE · `jti` CHAR(36) NOT NULL UNIQUE · `issued_at` DATETIME NOT NULL · `expires_at` DATETIME NOT NULL · `revoked_at` DATETIME NULL · `ip_address` VARCHAR(45) NULL · `user_agent` VARCHAR(512) NULL · `last_seen_at` DATETIME NULL · `last_renewed_at` DATETIME NULL · INDEX(`user_id`,`expires_at`) · INDEX(`revoked_at`,`expires_at`). A revoked or expired session can never be renewed.

**`mobile_device`** — `device_id` VARCHAR(64) PK · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` CASCADE · `platform` ENUM('android') NOT NULL · `fcm_token` TEXT NOT NULL · `device_secret_ref` VARCHAR(255) NULL · `app_version` VARCHAR(64) NULL · `last_seen_at` DATETIME NOT NULL · `is_active` BOOLEAN NOT NULL DEFAULT TRUE · `created_at` DATETIME NOT NULL · INDEX(`user_id`,`is_active`). Only one active device per Tanod; this invariant is enforced transactionally by the registration service because a partial unique index is not used.

**`notification`** — `notification_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `notification_type` ENUM('dispatch','sos','priority_alert','other') NOT NULL · `dispatch_id` BIGINT UNSIGNED NULL FK → `dispatch.dispatch_id` SET NULL · `sos_id` BIGINT UNSIGNED NULL FK → `tanod_sos.sos_id` SET NULL · `incident_id` BIGINT UNSIGNED NULL FK → `incident.incident_id` SET NULL · `created_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `created_at` DATETIME NOT NULL · `expires_at` DATETIME NULL · INDEX(`barangay_id`,`notification_type`,`created_at`). Exactly one relevant target entity relationship is required by the notification integrity matrix.

**Notification entity integrity:** `notification_type=dispatch` requires `dispatch_id` and `incident_id` may be set only when useful for context; `notification_type=sos` requires `sos_id`; `notification_type=priority_alert` requires `incident_id` or `dispatch_id`; `notification_type=other` may use a documented entity relationship. Server validation and transaction-level checks enforce this matrix before insert/update.

**`notification_target`** — `notification_target_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `notification_id` BIGINT UNSIGNED NOT NULL FK → `notification.notification_id` CASCADE · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `device_id` VARCHAR(64) NULL FK → `mobile_device.device_id` SET NULL · `targeted_at` DATETIME NOT NULL · `acknowledged_at` DATETIME NULL · `ack_status` ENUM('pending','acknowledged','not_required') NOT NULL DEFAULT 'pending' · UNIQUE(`notification_id`,`user_id`). Target `user_id`, optional `device_id`, and notification `barangay_id` must agree on tenant membership; this is enforced transactionally before target creation. Acknowledgment belongs to the logical notification target, not to one transport.

**`notification_delivery`** — `delivery_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `notification_id` BIGINT UNSIGNED NOT NULL FK → `notification.notification_id` CASCADE · `notification_target_id` BIGINT UNSIGNED NOT NULL FK → `notification_target.notification_target_id` CASCADE · `channel` ENUM('fcm','sms') NOT NULL · `attempt_no` TINYINT UNSIGNED NOT NULL · `status` ENUM('initiated','sent','failed','ack_timeout') NOT NULL · `provider_message_id` VARCHAR(128) NULL · `initiated_at` DATETIME NOT NULL · `sent_at` DATETIME NULL · `ack_timeout_at` DATETIME NULL · `failure_reason` VARCHAR(255) NULL · `metadata_json` JSON NULL · UNIQUE(`notification_target_id`,`channel`,`attempt_no`) · INDEX(`notification_id`,`status`,`initiated_at`). FCM retries and SMS fallback are separate delivery rows. An FCM ack timeout does not automatically become an SMS attempt unless the fallback rule explicitly requires it.

**`audit_log`** — `audit_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `barangay_id` SMALLINT UNSIGNED NULL FK → `barangay.barangay_id` SET NULL · `actor_user_id` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `action` VARCHAR(128) NOT NULL · `entity_type` VARCHAR(64) NOT NULL · `entity_id` BIGINT UNSIGNED NULL · `metadata_json` JSON NULL · `ip_address` VARCHAR(45) NULL · `user_agent` VARCHAR(512) NULL · `created_at` DATETIME NOT NULL · INDEX(`barangay_id`,`created_at`) · INDEX(`actor_user_id`,`created_at`) · INDEX(`action`,`created_at`). Write-once except controlled retention deletion.

**`duty_status`** — `status_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `status` ENUM('on_duty','responding','off_duty') NOT NULL · `channel` ENUM('app','sms') NOT NULL · `client_event_id` CHAR(36) NULL · `changed_at` DATETIME NOT NULL · INDEX(`user_id`,`changed_at`) · UNIQUE(`user_id`,`client_event_id`). Deduplication uses the stable event ID for app/SMS writes.

**`gps_track`** — `track_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `dispatch_id` BIGINT UNSIGNED NULL FK → `dispatch.dispatch_id` SET NULL · `latitude` DECIMAL(10,7) NOT NULL · `longitude` DECIMAL(10,7) NOT NULL · `accuracy_m` DECIMAL(8,2) NOT NULL · `recorded_at` DATETIME NOT NULL · `received_at` DATETIME NOT NULL · `synced_at` DATETIME NULL · `client_event_id` CHAR(36) NULL · INDEX(`user_id`,`recorded_at`) · INDEX(`dispatch_id`,`recorded_at`) · UNIQUE(`user_id`,`client_event_id`). If `dispatch_id` is present, it must belong to the caller and same barangay at write time.

**`incident`** — `incident_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `reported_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `device_id` VARCHAR(64) NULL FK → `mobile_device.device_id` SET NULL · `incident_type` ENUM('theft','physical_injury','disturbance','domestic_dispute','vandalism','traffic_incident','fire','medical_emergency','missing_person','animal_complaint','other') NOT NULL · `priority` ENUM('normal','high','critical') NOT NULL DEFAULT 'normal' · `raw_narrative` TEXT NOT NULL · `redacted_narrative` TEXT NULL · `redaction_approved_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `redaction_approved_at` DATETIME NULL · `status` ENUM('pending','dispatched','resolved') NOT NULL DEFAULT 'pending' · `source` ENUM('app','sms','web') NOT NULL · `latitude` DECIMAL(10,7) NULL · `longitude` DECIMAL(10,7) NULL · `created_at` DATETIME NOT NULL · `device_offline_created_at` DATETIME NULL · `client_event_id` CHAR(36) NULL · `synced_at` DATETIME NULL · `updated_at` DATETIME NOT NULL · INDEX(`barangay_id`,`status`,`created_at`) · INDEX(`reported_by`,`created_at`) · INDEX(`incident_type`,`created_at`) · UNIQUE(`device_id`,`client_event_id`). `redaction_approved_at IS NOT NULL` is the approval signal. Client event identity is the idempotency key for mobile writes; trusted web writes use the required `Idempotency-Key` header and persist that request key in the server request/audit context.

**`dispatch`** — `dispatch_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `incident_id` BIGINT UNSIGNED NOT NULL FK → `incident.incident_id` RESTRICT · `dispatched_by` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `tanod_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `priority` ENUM('normal','high','critical') NOT NULL · `route_json` JSON NULL · `route_status` ENUM('available','unavailable','stale') NOT NULL DEFAULT 'unavailable' · `status` ENUM('assigned','en_route','arrived','completed','cancelled') NOT NULL DEFAULT 'assigned' · `dispatched_at` DATETIME NOT NULL · `en_route_at` DATETIME NULL · `arrived_at` DATETIME NULL · `completed_at` DATETIME NULL · `cancelled_at` DATETIME NULL · `cancelled_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `created_client_request_id` CHAR(36) NOT NULL UNIQUE · INDEX(`incident_id`,`status`) · INDEX(`tanod_id`,`status`,`dispatched_at`). At most one active dispatch (`assigned`,`en_route`,`arrived`) may exist for an incident; this invariant is enforced transactionally by locking the incident row before creation. Admin override cannot reverse a completed/cancelled dispatch.

**`evidence_attachment`** — `attachment_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `incident_id` BIGINT UNSIGNED NOT NULL FK → `incident.incident_id` RESTRICT · `type` ENUM('photo','voice') NOT NULL · `file_path` VARCHAR(512) NOT NULL · `uploaded_by` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `uploaded_at` DATETIME NOT NULL · `sha256` CHAR(64) NOT NULL · `byte_size` BIGINT UNSIGNED NOT NULL · `mime_type` VARCHAR(100) NOT NULL · `original_filename` VARCHAR(255) NOT NULL · `retention_expires_at` DATETIME NULL · `legal_hold` BOOLEAN NOT NULL DEFAULT FALSE · `client_request_id` CHAR(36) NULL · UNIQUE(`client_request_id`) · INDEX(`incident_id`,`uploaded_at`). Files are stored outside the public web root.

**`blotter_record`** — `blotter_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `incident_id` BIGINT UNSIGNED NOT NULL UNIQUE FK → `incident.incident_id` RESTRICT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `recorded_by` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `approved_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `narrative_summary` TEXT NOT NULL · `finalized_at` DATETIME NULL · `revision_no` INT UNSIGNED NOT NULL DEFAULT 1 · `amended_at` DATETIME NULL · `amended_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · INDEX(`barangay_id`,`finalized_at`). Once finalized, normal overwrite is forbidden; amendment is explicit and audited.

**`citizen_report`** — `report_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `incident_id` BIGINT UNSIGNED NULL UNIQUE FK → `incident.incident_id` SET NULL · `contact_number` VARCHAR(32) NULL · `description` TEXT NOT NULL · `latitude` DECIMAL(10,7) NULL · `longitude` DECIMAL(10,7) NULL · `submitted_at` DATETIME NOT NULL · `converted_at` DATETIME NULL · `retention_expires_at` DATETIME NULL · `legal_hold` BOOLEAN NOT NULL DEFAULT FALSE · INDEX(`barangay_id`,`submitted_at`,`incident_id`). Conversion locks the report row and permits exactly one incident linkage.

**`sms_log`** — `log_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `report_id` BIGINT UNSIGNED NULL FK → `citizen_report.report_id` SET NULL · `incident_id` BIGINT UNSIGNED NULL FK → `incident.incident_id` SET NULL · `dispatch_id` BIGINT UNSIGNED NULL FK → `dispatch.dispatch_id` SET NULL · `sender_number` VARCHAR(32) NULL · `receiver_number` VARCHAR(32) NULL · `transport` ENUM('gsm_modem','semaphore') NOT NULL · `message_type` ENUM('incident','dispatch','priority_alert','coord_ping','confirmation','duty_status','sos') NOT NULL · `direction` ENUM('inbound','outbound') NOT NULL · `gateway_message_id` VARCHAR(128) NULL · `modem_message_id` VARCHAR(128) NULL · `correlation_id` CHAR(36) NULL · `status` ENUM('queued','pending','sent','failed','refunded','received','rejected','deduplicated') NOT NULL · `sent_at` DATETIME NULL · `received_at` DATETIME NULL · `failure_reason` VARCHAR(255) NULL · `created_at` DATETIME NOT NULL · INDEX(`report_id`) · INDEX(`incident_id`,`created_at`) · INDEX(`dispatch_id`,`created_at`) · INDEX(`status`,`created_at`). Phone numbers are protected at rest and masked in ordinary UI.

**`ai_processing_log`** — `log_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `incident_id` BIGINT UNSIGNED NOT NULL FK → `incident.incident_id` RESTRICT · `pipeline_run_id` CHAR(36) NOT NULL · `task_type` ENUM('summarization','redaction','translation') NOT NULL · `model_version` VARCHAR(128) NOT NULL · `source_language` VARCHAR(16) NULL · `target_language` VARCHAR(16) NULL · `draft_redacted_narrative` TEXT NULL · `draft_summary` TEXT NULL · `draft_summary_stale` BOOLEAN NOT NULL DEFAULT FALSE · `draft_version` INT UNSIGNED NOT NULL DEFAULT 1 · `translated_text` TEXT NULL · `status` ENUM('queued','processing','completed','failed','superseded') NOT NULL · `error_code` VARCHAR(128) NULL · `processed_at` DATETIME NULL · `created_at` DATETIME NOT NULL · INDEX(`incident_id`,`status`,`created_at`) · INDEX(`pipeline_run_id`) · one current redaction/summary pipeline row is enforced transactionally per incident; translation rows are independent.

**`ai_evaluation_run`** — `evaluation_run_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `dataset_name` VARCHAR(128) NOT NULL · `dataset_version` VARCHAR(64) NOT NULL · `model_version` VARCHAR(128) NOT NULL · `task_type` VARCHAR(64) NOT NULL · `sample_count` INT UNSIGNED NOT NULL · `precision_score` DECIMAL(6,5) NULL · `recall_score` DECIMAL(6,5) NULL · `created_at` DATETIME NOT NULL · `notes` TEXT NULL · UNIQUE(`dataset_name`,`dataset_version`,`model_version`,`task_type`). Dataset-level metrics are not stored only on production incident rows.

**`offline_queue`** — `queue_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `device_id` VARCHAR(64) NOT NULL FK → `mobile_device.device_id` RESTRICT · `client_event_id` CHAR(36) NOT NULL · `payload_type` ENUM('incident','gps','duty_status','sos','dispatch_status') NOT NULL · `sync_metadata_json` JSON NOT NULL · `created_offline_at` DATETIME NOT NULL · `received_at` DATETIME NULL · `synced_at` DATETIME NULL · `reconciliation_status` ENUM('pending','success','duplicate','failed') NOT NULL DEFAULT 'pending' · `failure_reason` VARCHAR(255) NULL · UNIQUE(`device_id`,`client_event_id`) · INDEX(`reconciliation_status`,`created_offline_at`). Server mirror never stores original raw payload.

**`tanod_sos`** — `sos_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `dispatch_id` BIGINT UNSIGNED NULL FK → `dispatch.dispatch_id` SET NULL · `latitude` DECIMAL(10,7) NOT NULL · `longitude` DECIMAL(10,7) NOT NULL · `triggered_at` DATETIME NOT NULL · `received_at` DATETIME NOT NULL · `status` ENUM('active','acknowledged','resolved') NOT NULL DEFAULT 'active' · `acknowledged_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `acknowledged_at` DATETIME NULL · `resolved_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `resolved_at` DATETIME NULL · `client_event_id` CHAR(36) NOT NULL · `fallback_channel` ENUM('app','sms') NOT NULL DEFAULT 'app' · UNIQUE(`user_id`,`client_event_id`) · INDEX(`barangay_id`,`status`,`triggered_at`). Only the caller's own active dispatch may be referenced. The primary logical SOS notification is the `notification` row whose `notification_type='sos'` and `sos_id` references this SOS; recipient-level deliveries live in `notification_target`/`notification_delivery`.

**`shift_schedule`** — `shift_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `patrol_zone` VARCHAR(128) NULL · `start_at` DATETIME NOT NULL · `end_at` DATETIME NOT NULL · `created_by` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `version` INT UNSIGNED NOT NULL DEFAULT 1 · `client_request_id` CHAR(36) NULL · `updated_at` DATETIME NULL · UNIQUE(`client_request_id`) · INDEX(`barangay_id`,`start_at`,`end_at`) · INDEX(`user_id`,`start_at`,`end_at`). `start_at < end_at`; overlapping active shifts for the same Tanod are rejected transactionally. Roster calculations interpret the timestamps in Asia/Manila. `version` increments on every update and backs the optimistic-concurrency check in `PATCH /shifts/:id`. `client_request_id` persists the `request_id` idempotency key from `POST /shifts` so a retried create returns the original row instead of duplicating it.

**`shift_swap_request`** — `request_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `requesting_user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `shift_id` BIGINT UNSIGNED NOT NULL FK → `shift_schedule.shift_id` RESTRICT · `target_user_id` BIGINT UNSIGNED NULL FK → `user.user_id` RESTRICT · `reason` VARCHAR(1000) NULL · `status` ENUM('pending','approved','denied') NOT NULL DEFAULT 'pending' · `requested_at` DATETIME NOT NULL · `resolved_at` DATETIME NULL · `resolved_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `version` INT UNSIGNED NOT NULL DEFAULT 1 · `client_request_id` CHAR(36) NULL · UNIQUE(`client_request_id`) · INDEX(`shift_id`,`status`). Approval locks request + shift and revalidates all current constraints.

**`fatigue_flag`** — `flag_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `user_id` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `shift_id` BIGINT UNSIGNED NOT NULL FK → `shift_schedule.shift_id` RESTRICT · `hours_worked_7day` DECIMAL(5,2) NOT NULL · `calculation_basis` ENUM('scheduled_hours') NOT NULL DEFAULT 'scheduled_hours' · `flagged_at` DATETIME NOT NULL · `acknowledged_by` BIGINT UNSIGNED NULL FK → `user.user_id` SET NULL · `acknowledged_at` DATETIME NULL · UNIQUE(`user_id`,`shift_id`) · INDEX(`user_id`,`flagged_at`).

**`offline_map_package`** — `package_id` BIGINT UNSIGNED PK AUTO_INCREMENT · `barangay_id` SMALLINT UNSIGNED NOT NULL FK → `barangay.barangay_id` RESTRICT · `version` VARCHAR(64) NOT NULL · `file_path` VARCHAR(512) NOT NULL · `checksum_sha256` CHAR(64) NOT NULL · `byte_size` BIGINT UNSIGNED NOT NULL · `created_by` BIGINT UNSIGNED NOT NULL FK → `user.user_id` RESTRICT · `created_at` DATETIME NOT NULL · `is_published` BOOLEAN NOT NULL DEFAULT FALSE · UNIQUE(`barangay_id`,`version`) · INDEX(`barangay_id`,`is_published`). Exactly one package is published per barangay, enforced transactionally by locking the barangay package set before publication.

### Mobile Local (SQLite, encrypted with SQLCipher-backed plugin)

Mobile local tables are intentionally limited to data required by approved offline screens. Local integer IDs are device-local unless a server ID field is explicitly present. All local timestamps are stored as ISO 8601 UTC strings; UI converts to Asia/Manila.

- **`incident_local`** — `local_id` TEXT PRIMARY KEY · `server_incident_id` INTEGER NULL · `barangay_id` INTEGER NOT NULL · `reported_by` INTEGER NULL · `incident_type` TEXT NOT NULL · `priority` TEXT NOT NULL DEFAULT 'normal' · `raw_narrative` TEXT NOT NULL encrypted at rest · `redacted_narrative` TEXT NULL · `status` TEXT NOT NULL DEFAULT 'pending' · `source` TEXT NOT NULL · `latitude` REAL NULL · `longitude` REAL NULL · `created_offline_at` TEXT NOT NULL · `client_event_id` TEXT NOT NULL UNIQUE · `synced` INTEGER NOT NULL DEFAULT 0 · `last_sync_error` TEXT NULL.
- **`dispatch_local`** — `local_id` TEXT PRIMARY KEY · `server_dispatch_id` INTEGER NULL · `server_incident_id` INTEGER NOT NULL · `tanod_id` INTEGER NOT NULL · `priority` TEXT NOT NULL · `redacted_incident_type` TEXT NULL · `redacted_incident_summary` TEXT NULL · `latitude` REAL NULL · `longitude` REAL NULL · `route_json` TEXT NULL · `route_status` TEXT NOT NULL DEFAULT 'unavailable' · `status` TEXT NOT NULL · `last_status_event_id` TEXT NULL · `dispatched_at` TEXT NOT NULL · `en_route_at` TEXT NULL · `arrived_at` TEXT NULL · `completed_at` TEXT NULL · `cached_at` TEXT NOT NULL · `stale_after` TEXT NOT NULL · `synced` INTEGER NOT NULL DEFAULT 0.
- **`gps_track_local`** — `local_id` TEXT PRIMARY KEY · `server_track_id` INTEGER NULL · `dispatch_id` INTEGER NULL · `latitude` REAL NOT NULL · `longitude` REAL NOT NULL · `accuracy_m` REAL NOT NULL · `recorded_at` TEXT NOT NULL · `client_event_id` TEXT NOT NULL UNIQUE · `synced` INTEGER NOT NULL DEFAULT 0.
- **`duty_status_local`** — `local_id` TEXT PRIMARY KEY · `status` TEXT NOT NULL · `channel` TEXT NOT NULL · `changed_at` TEXT NOT NULL · `client_event_id` TEXT NOT NULL UNIQUE · `synced` INTEGER NOT NULL DEFAULT 0.
- **`evidence_attachment_local`** — `local_id` TEXT PRIMARY KEY · `server_attachment_id` INTEGER NULL · `incident_local_id` TEXT NOT NULL · `type` TEXT NOT NULL · `file_path` TEXT NOT NULL · `sha256` TEXT NOT NULL · `byte_size` INTEGER NOT NULL · `mime_type` TEXT NOT NULL · `synced` INTEGER NOT NULL DEFAULT 0 · `uploaded_url` TEXT NULL · `last_attempt_at` TEXT NULL · `attempts` INTEGER NOT NULL DEFAULT 0.
- **`offline_queue_local`** — `queue_id` INTEGER PRIMARY KEY AUTOINCREMENT · `client_event_id` TEXT NOT NULL UNIQUE · `payload_type` TEXT NOT NULL · `payload_json` TEXT NOT NULL encrypted at rest · `created_offline_at` TEXT NOT NULL · `sync_attempts` INTEGER NOT NULL DEFAULT 0 · `last_attempt_at` TEXT NULL · `reconciliation_status` TEXT NOT NULL DEFAULT 'pending'. Allowed `payload_type`: `incident|gps|duty_status|sos|dispatch_status`.
- **`mobile_device_local`** — `device_id` TEXT PRIMARY KEY · `user_id` INTEGER NOT NULL · `fcm_token_ref` TEXT NULL protected at rest · `platform` TEXT NOT NULL DEFAULT 'android' · `app_version` TEXT NULL · `last_seen_at` TEXT NULL · `is_active` INTEGER NOT NULL DEFAULT 1 · `synced` INTEGER NOT NULL DEFAULT 0.
- **`offline_map_package_local`** — `package_id` INTEGER PRIMARY KEY · `barangay_id` INTEGER NOT NULL · `version` TEXT NOT NULL · `file_path` TEXT NOT NULL · `checksum_sha256` TEXT NOT NULL · `installed_at` TEXT NOT NULL · `is_active` INTEGER NOT NULL DEFAULT 0.

**Sync invariants:** each local write has a stable `client_event_id`; `/sync/batch` uses that identity for deduplication; SMS fallback and direct POST use the same event ID; attachments wait for the server incident ID; failed records remain queued; no last-write-wins merge is used for field-captured incident content.

---


## 6. API Contract

Base URL `/api/v1`. All endpoints except `/auth/login`, public `/citizen-reports`, and protected internal `/sms/*`/service endpoints require `Authorization: Bearer <token>`.

### Global API invariants

- Every authenticated endpoint resolves the caller's `user_id` and `barangay_id` from the validated session, never from request JSON.
- Every resource-ID endpoint performs object lookup **and tenant/ownership authorization before mutation or disclosure**.
- Every state-changing POST that can be retried accepts/derives a stable idempotency/correlation key.
- For authenticated web writes, the `Idempotency-Key` header is a required UUID on retryable state-changing requests; mobile writes use `client_event_id`. The server persists the key with the resulting resource and returns the original result on a replay.
- Default page size is 25; maximum is 100 unless explicitly documented otherwise.
- Timestamps are ISO 8601; server timestamps are authoritative.
- JSON API keys remain snake_case; the single client boundary converts to camelCase in JS/TS.
- Standard errors: `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `422 UNPROCESSABLE_ENTITY` where semantic validation is distinct, `429 RATE_LIMITED`, `500 SERVER_ERROR`, `503 SERVICE_UNAVAILABLE`.
- Error messages never reveal usernames, account existence, raw PII, or security-sensitive implementation details.

### Auth

- `POST /auth/login` — body `{username,password}` → `{token,user:{user_id,full_name,role,barangay_id},expires_at}`. Creates one `auth_session` with unique `jti`. Login failures use the same external response shape/timing class for unknown user, wrong password, and locked account; internal lock state is not disclosed.
- `POST /auth/logout` — revokes the current `jti`; returns `{success:true}`. The server ignores a second logout safely.
- **Sliding renewal:** authenticated responses may include `X-Renewed-Token`; renewal is allowed only when the session is still valid. The server updates `expires_at/last_renewed_at`; clients retain the token whose expiry is latest. Revoked/expired sessions never renew.
- `POST /auth/change-password` — any authenticated role, self only. Body `{current_password,new_password}` → `{success:true}`. Rehashes Argon2id and revokes every other active session for the user. Current session remains valid with updated authentication state.

### Users & device lifecycle

- `GET /users?role=&page=&limit=` — admin only, same barangay only → `{items:[{user_id,full_name,username,role,contact_number,is_active,created_at}],page,limit,total}`.
- `POST /users` — admin only, body `{username,password,full_name,role,contact_number}`; barangay derives from Admin token → `{user_id,created_at}`. New role cannot be `lupon`. At least one active Admin per barangay must always remain.
- `PATCH /users/:id` — admin may edit same-barangay users; self may edit only `full_name/contact_number` → `{user_id,updated:true}`. Self-deactivation is forbidden. Deactivating another user sets `is_active=false`, revokes all sessions, deactivates all devices, and removes notification eligibility in one transaction.
- `POST /users/:id/reset-password` — admin, same barangay, body `{new_password}` → `{success:true}`. Rehashes password, clears lockout, revokes all sessions, deactivates existing devices, and requires new device registration after the next successful login.
- `POST /devices/register` — tanod only; body `{device_id,fcm_token,platform:"android",app_version?}` → `{device_id,registered:true}`. Device ownership is validated. Previous active device registrations for that Tanod are deactivated transactionally. Returns no FCM token.
- `PATCH /devices/:id/deactivate` — tanod own device only → `{success:true}`. Deactivates only the target device after ownership check.

### Incidents

- `POST /incidents` — tanod/secretary/admin as documented in §7. Body `{incident_type,raw_narrative,latitude,longitude,source?,device_offline_created_at?,client_event_id}`. Server derives `barangay_id`, `reported_by`, and `source`; client `source` is ignored. Idempotency key is authenticated `device_id + client_event_id` for Tanod mobile writes; trusted web creation requires the `Idempotency-Key` UUID header. The server persists the request key and returns the original incident on replay. Creates `pending` incident with server `created_at`.
- `GET /incidents?...` — tenant-scoped; Tanod forced to `reported_by=me`; no raw narrative → `{items:[{incident_id,barangay_id,reported_by,incident_type,priority,status,source,latitude,longitude,created_at,device_offline_created_at,synced_at}],page,limit,total}`. Maximum limit 100.
- `GET /incidents/:id` — resource must belong to caller's barangay. Secretary receives `{incident_id,barangay_id,reported_by,incident_type,raw_narrative,redacted_narrative,priority,status,source,latitude,longitude,created_at,synced_at}`; Admin/PB/Tanod receive redacted allow-listed fields only, with Tanod additionally requiring reporter or assigned-dispatch relationship.
- `GET /incidents/:id/blotter` — tenant-scoped convenience lookup → `{blotter_id,incident_id,narrative_summary,recorded_by,approved_by,finalized_at,revision_no}`; 404 when none exists.
- `GET /incidents/nearby?...` — Tanod only; caller's barangay enforced; radius has a server maximum → `{items:[{incident_id,incident_type,priority,status,latitude,longitude,age_seconds}]}`; never raw narrative/contact data.
- `PATCH /incidents/:id/status` — Admin only; resource must be same-barangay. Body is exactly `{status:"resolved"}`. Returns `409` unless current incident is `dispatched` and has no active dispatch (`assigned/en_route/arrived`). A repeated resolve after the incident is already resolved returns `409` with `CONFLICT` rather than mutating the record a second time.
- `POST /incidents/:id/redact` — Secretary manual rerun or trusted system worker → `{incident_id,pipeline_run_id,status}`. Same-barangay resource check. Creates/replaces the active pipeline only when no finalized blotter exists; rerun after approval requires explicit revision workflow.
- `POST /incidents/:id/evidence` — Tanod only. Caller must either be the reporter or the Tanod assigned to an active dispatch for the incident. Same-barangay check is mandatory. File is streamed to protected storage after size/MIME/content validation; request is idempotent using file hash + client request ID. Returns `{attachment_id,uploaded_url}`.
- `GET /incidents/:id/evidence` — Secretary/Admin same barangay; Tanod only if `incident.reported_by = caller.user_id` OR the caller has/had a dispatch for that incident; same-barangay check applies first. Never returns filesystem paths.

### AI processing

- `GET /incidents/:id/ai-draft` — Secretary only, same barangay → `{log_id,incident_id,pipeline_run_id,task_type,model_version,draft_redacted_narrative,draft_summary,draft_summary_stale,draft_version,status}`.
- `POST /incidents/:id/redact` — same endpoint documented under Incidents above; triggers local Ollama pipeline only, raw text remains local.
- `POST /incidents/:id/ai-draft/regenerate-summary` — body `{draft_redacted_narrative,draft_version}` → `{log_id,draft_redacted_narrative,draft_summary,draft_summary_stale,draft_version,status}`. Requires matching current version. Generates summary only from supplied draft text; increments `draft_version`; clears stale flag.
- `POST /incidents/:id/ai-draft/approve` — body `{approved_narrative,draft_version}` → `{incident_id,redaction_approved_at,approved_by}`. Requires current draft version, `status=completed`, `draft_summary_stale=false`, text equality against current draft, and same-barangay Secretary authorization. This is the sole normal endpoint allowed to commit `incident.redacted_narrative` and approval metadata.
- `POST /incidents/:id/ai-draft/translate` — Secretary only; requires approved redaction. Body `{target_language:"en"|"fil"|"bcl"}` → `{log_id,translated_text,source_language,target_language,status}`. Runs locally against approved redacted narrative and creates a new translation log row. Translation never modifies the canonical incident narrative.

### Blotter

- `POST /incidents/:id/finalize` — Secretary only. Requires approved redaction and same-barangay resource. Body `{narrative_summary}` → `{blotter_id,finalized_at,revision_no}`. If no record exists, creates and finalizes it. If `finalized_at` is already set, returns `409`; use the amendment endpoint for later changes. `recorded_by` and `approved_by` capture the Secretary actor for the current workflow.
- `POST /incidents/:id/blotter/amend` — Secretary only. Body `{narrative_summary,reason}` → `{blotter_id,revision_no,amended_at}`. Requires finalized record, creates an audited revision, increments `revision_no`, and never deletes the previous finalized value.
- `GET /blotter/:id` — same-barangay resource check first; Tanod access additionally requires reporter/assignment relationship → `{blotter_id,incident_id,narrative_summary,recorded_by,approved_by,finalized_at,revision_no}`.
- `POST /incidents/:id/lupon-packet` — Secretary only; requires approved redaction **and finalized blotter**; generates the case PDF from the approved redaction plus finalized summary → `{file_url}`.

### Dispatch

- `POST /dispatch` — Admin only → `{dispatch_id,status,incident_id,route_status}`. Body `{incident_id,tanod_id,request_id}`; `request_id` is a required UUID idempotency key. Validates same-barangay incident and Tanod, active Tanod, on-duty status, no conflicting active dispatch, and current incident status `pending`. Transaction locks the incident row, creates dispatch, copies priority, updates incident to `dispatched`, computes route if possible; OSRM failure does not roll back dispatch creation and leaves `route_status="unavailable"`; records notification creation. Retry with the same `request_id` returns the existing dispatch instead of creating a duplicate.
- `GET /dispatch?status=&page=&limit=` — Admin/PB tenant-scoped; Tanod forced to own `tanod_id` and same barangay → `{items:[{dispatch_id,incident_id,tanod_id,priority,route_json,route_status,status,dispatched_at,en_route_at,arrived_at,completed_at,cancelled_at}],page,limit,total}`.
- `GET /dispatch/:id` — same-barangay resource check; Tanod only if assigned; PB read-only → `{dispatch_id,incident_id,tanod_id,priority,route_json,route_status,status,dispatched_at,en_route_at,arrived_at,completed_at,cancelled_at}`.
- `PATCH /dispatch/:id/status` — body `{status,override_reason?}` → `{dispatch_id,status,updated_at}`. Tanod own assigned dispatch or Admin override. Allowed transitions only: `assigned→en_route`, `en_route→arrived`, `arrived→completed`. Admin corrections require explicit `override_reason` and audit event; they may correct timestamps or move an active dispatch only to another valid forward state, but cannot reverse `completed`/`cancelled`, fabricate impossible timestamp ordering, or bypass tenant/ownership checks.
- `PATCH /dispatch/:id/cancel` — Admin only → `{dispatch_id,status:"cancelled",incident_id,incident_status:"pending",cancelled_at}`. Same-barangay resource. Only `assigned` or `en_route`; transaction sets cancelled metadata and reverts incident `dispatched→pending`. Cannot cancel `arrived`/`completed`.

### GPS

- `POST /gps` — Tanod only → `{track_id,received_at}`. If `dispatch_id` is supplied, it must belong to caller, same barangay, and be active. `client_event_id` required for offline/retryable writes. Server records `received_at` and validates coordinate ranges/accuracy bounds.
- `GET /gps/live?barangay_id=` — Admin/PB only; caller's barangay enforced. Returns latest position plus freshness metadata: `recorded_at`, `received_at`, `age_seconds`, `is_stale`. `is_stale=true` at ≥120 seconds without a fresh point.
- `GET /gps/history?user_id=&date_from=&date_to=` — Admin only, same barangay as both user and history. Date range capped → `{items:[{track_id,user_id,dispatch_id,latitude,longitude,accuracy_m,recorded_at,received_at}],page,limit,total}`.

### Tanod SOS

- `POST /tanod-sos` — Tanod only → `{sos_id,status,received_at}`. Body `{latitude,longitude,dispatch_id?,client_event_id,fallback_channel?}`. Own user/barangay are derived from token. Optional dispatch must belong to caller and be active. Creates idempotent SOS record, creates logical notifications, and immediately attempts configured FCM/SMS channels.
- `GET /tanod-sos?status=&page=&limit=` — Admin/PB same barangay → `{items:[{sos_id,user_id,dispatch_id,latitude,longitude,triggered_at,received_at,status,acknowledged_at,resolved_at}],page,limit,total}`.
- `PATCH /tanod-sos/:id/acknowledge` — Admin only, same barangay, active/acknowledged target → `{sos_id,status:"acknowledged",acknowledged_at,acknowledged_by}`. Does not resolve.
- `PATCH /tanod-sos/:id/resolve` — Admin only, same barangay → `{sos_id,status:"resolved",resolved_at,resolved_by}`. Cannot resolve an unrelated tenant record.

### Duty status

- `POST /duty-status` — Tanod only; body `{status,client_event_id}` → `{status_id,status,channel:"app",changed_at}`. Valid statuses are `on_duty|responding|off_duty`; server writes `channel=app`.
- `GET /duty-status?user_id=me` — Tanod own only → `{items:[{status_id,status,channel,changed_at}]}`.
- `GET /duty-status?barangay_id=` — Admin/PB own barangay → `{items:[{user_id,status,channel,changed_at}]}`. “Current” status is the latest row by `changed_at` per active user.

### System health

- `GET /system/health` — Admin only; local-only service endpoint. Returns `{api,db,osrm,ollama,gsm_ingestion,notification_config,backup_last_success,restore_test_at}` using coarse statuses only. It never exposes credentials, tokens, internal filesystem paths, or raw data. Each status is one of `healthy|unhealthy|not_configured` (`not_configured` for a dependency this deployment has never wired up — e.g. OSRM/Ollama/GSM ingestion/notification transports before their respective sprints are built — distinct from `unhealthy`, which means a configured dependency actually failed its check). `api` is `healthy` whenever this endpoint can respond at all. `db` runs a trivial live query. `backup_last_success`/`restore_test_at` read real file timestamps from the configured backup directory (never a hardcoded/simulated value); `null` when no backup/restore has run yet, not a fabricated recent time.

### Reference / lookup

- `GET /barangays` — public, no auth (needed pre-auth by W19's barangay picker) → `{items:[{barangay_id,name,municipality,province}]}`. Always exactly the four deterministic seeded rows (§5); added so W19 stops hardcoding that list client-side per §8's production-realism rule — every barangay a screen offers must come from this table, not a literal array in a component file.
- `GET /search?q=` — any authenticated web role; same tenant/ownership scoping `GET /incidents` already applies (Tanod forced to own incidents). `q` is required, 2–64 chars, else `400 VALIDATION_ERROR`. Matches against `incident_id` (exact/substring on the numeric string) and `incident_type`/`status` enum values → `{items:[{incident_id,incident_type,status,priority,created_at}]}`, capped at 10 rows, newest first. Same field allow-list as the existing incident list item — **never** `raw_narrative`, regardless of caller role. This is the topbar global search's real backing endpoint; nothing else (Tanods, locations) is in scope for it — see §8.

### Audit / reports

- `GET /audit-log?...` — Admin own barangay → `{items:[{audit_id,actor_user_id,action,entity_type,entity_id,metadata_json,created_at}],page,limit,total}`, paginated newest-first.
- `GET /reports/summary?...` — Admin/PB own barangay → `{total_incidents,resolved_count,avg_response_time_minutes,active_tanods,by_incident_type,by_status,trend}`. `avg_response_time_minutes` is explicitly `incident.created_at → dispatch.arrived_at` for incidents that reached `arrived`.
- `GET /reports/heatmap?...` — Admin/PB own barangay → `{items:[{latitude,longitude,weight}]}`; historical coordinates only.
- `GET /reports/notifications-summary?...` — Admin/PB own barangay; includes logical notification targets, FCM attempts, SMS attempts, acknowledged targets, timeout attempts, failed attempts, and end-to-end acknowledgement time. Definitions: `total_targets` = unique notification targets created in-range; `acknowledged_count` = unique targets with `ack_status=acknowledged`; `total_sent` = delivery attempts with `status=sent`; `ack_timeout_count` = attempts marked `ack_timeout`; `failed_count` = attempts marked `failed`; `avg_ack_seconds` = average (`acknowledged_at - targeted_at`) for acknowledged targets in-range. End-to-end metrics are reported separately from transport-attempt metrics.
- `GET /reports/export?...` — Admin/PB own barangay → `{file_url,format,generated_at}` for approved formats; request is scoped and audited.

### Shifts and fatigue

- `POST /shifts` — Admin only. Body `{user_id,patrol_zone,start_at,end_at,barangay_id?,request_id}`. `request_id` is persisted as `shift_schedule.client_request_id`; a retry with the same `request_id` returns the original shift instead of creating a duplicate. Same-barangay Tanod, `start_at<end_at`, overlap rejected, fatigue recalculated for affected user.
- `GET /shifts?...` — Admin same-barangay; Tanod self only → `{items:[{shift_id,user_id,patrol_zone,start_at,end_at}],page,limit,total}`.
- `PATCH /shifts/:id` — Admin same-barangay. Body `{patrol_zone?,start_at?,end_at?,user_id?,version}` → `{shift_id,updated_at,version}`. `version` is required and must match `shift_schedule.version`; mismatch returns `409` and the row is not updated. On success the update increments `version`. If assignment/time changes, recalculates fatigue for both old and new assignments and rechecks overlaps.
- `POST /shift-swap-requests` — Tanod only; requester must own the shift. Optional target must be same-barangay active Tanod. Uses `client_request_id`.
- `GET /shift-swap-requests?...` — Admin same-barangay; Tanod own requests → `{items:[{request_id,requesting_user_id,shift_id,target_user_id,reason,status,requested_at,resolved_at,resolved_by,version}],page,limit,total}`.
- `PATCH /shift-swap-requests/:id` — Admin same-barangay. Body `{status:"approved"|"denied",version}` → `{request_id,status,resolved_at,resolved_by,shift_id,target_user_id}`. Locks request + shift, revalidates current assignment/active accounts/overlaps/fatigue, then approves or denies. Approved named target reassigns the shift atomically; an approved open request without target marks requester released but leaves the shift unassigned and visible in W11.
- `GET /shifts/fatigue-flags?...` — Admin/PB same barangay → `{items:[{flag_id,user_id,shift_id,hours_worked_7day,calculation_basis,flagged_at,acknowledged_at}],page,limit,total}`.
- `PATCH /fatigue-flags/:id/acknowledge` — Admin same barangay → `{flag_id,acknowledged_by,acknowledged_at}`; retains flag.

### Map packages

- `GET /map-packages/:barangay_id` — Admin or Tanod, but only when requested barangay equals caller's tenant → `{version,checksum_sha256,download_url,is_published}`.
- `GET /map-packages/:barangay_id/download` — Tanod only, own barangay. Streams the published package; client verifies SHA-256 before activation.
- `POST /map-packages` — Admin only, own barangay. Body multipart `{version,file}`; server derives barangay, validates MBTiles structure/checksum/size/version uniqueness, publishes atomically → `{package_id,version,checksum_sha256,is_published}`.

### Citizen reports

- `POST /citizen-reports` — public, rate-limited and size-limited. Body `{barangay_id,contact_number?,description,latitude?,longitude?}`. Only the four known barangays are accepted. Creates report before attempting optional confirmation SMS. Response includes `{report_id,confirmation}`. Correlation is stored in `sms_log.report_id`.
- `GET /citizen-reports?status=unconverted&page=&limit=` — Admin/Secretary same barangay → `{items:[{report_id,description,contact_number,latitude,longitude,submitted_at,incident_id}],page,limit,total}`.
- `POST /citizen-reports/:id/convert` — Admin/Secretary only. Tenant derived from the stored report. Transaction locks report, requires `incident_id IS NULL`, creates exactly one incident with `reported_by=NULL`, links report, writes audit, and sets `converted_at`. Retry returns the already-converted incident → `{incident_id,citizen_report_id,converted_at}`.

### Sync

- `POST /sync/batch` — Tanod only → `{results:[{client_event_id,server_id,status,reason?}]}`. Body `{device_id,incidents[],gps_tracks[],duty_status_updates[],dispatch_status_updates[],sos[]}`. Device ownership must match authenticated Tanod. Every item has `client_event_id`; dispatch status updates use the same event-key/idempotency rules as other mobile writes; server processes oldest-first per device, locks/deduplicates by event key, and returns `{results:[{client_event_id,server_id,status:"success"|"duplicate"|"failed",reason?}]}`. Server mirror stores only reconciliation metadata. Direct POST and SMS fallback use the same event IDs.
- Evidence files are not in JSON sync. After an incident receives a server ID, unsynced attachments upload individually to `/incidents/:id/evidence` with idempotent request keys.

### Internal SMS / GSM

Inbound handlers are callable only by the local ingestion service over loopback or a mutually authenticated internal channel; they are never exposed on the public API surface.

- `POST /sms/incident-fallback` — body `{encrypted_envelope}`. Envelope includes version, message_id, device_id, client_event_id, created_at, nonce, ciphertext, authentication tag, expiry, and message type. Server validates sender/device, integrity, freshness, replay status, then reconstructs the same offline incident event. Plaintext raw narrative is never transported as ordinary SMS.
- `POST /sms/dispatch-payload` — sends a compact dispatch instruction; creates/updates logical notification + SMS delivery attempt and correlates it with dispatch ID.
- `POST /sms/priority-alert` — sends priority notification via configured Semaphore priority endpoint and creates delivery attempt record.
- `POST /sms/coord-ping` — resolves user from validated sender/device mapping; ignores any embedded user ID; rejects stale/replayed envelopes.
- `POST /sms/duty-status` — derives user from validated sender/device mapping, ignores embedded user ID, writes `channel=sms`.
- `POST /sms/sos` — dedicated SOS fallback path; same sender/integrity/dedup rules; creates or correlates the SOS if app submission could not reach the workstation.
- `GET /sms/logs?...` — Admin own barangay → `{items:[{log_id,report_id,incident_id,dispatch_id,transport,message_type,direction,status,correlation_id,gateway_message_id,modem_message_id,sent_at,received_at,created_at,failure_reason}],page,limit,total}`; phone numbers are masked in UI.

**Offline detection:** 3 consecutive failed health-check pings, 5s timeout each, 2s apart → offline after the documented ~21s attempt window. The app rechecks on next user action and background health ping. Fallback transport does not overwrite or destroy the local queue item.

### Notification lifecycle automation

After an FCM delivery is marked `sent`, a local worker waits 60 seconds for `notification_target.acknowledged_at`. If no acknowledgement exists, that delivery row becomes `ack_timeout`. This does not create an SMS row unless the original fallback rule explicitly calls for SMS because the FCM send itself failed. A successful FCM acknowledgement ends the notification-target delivery requirement even if a separate transport attempt was previously recorded.

### Notification acknowledgment

- `POST /notifications/:id/ack` — body `{}`. Tanod only for a target notification assigned to that user. Server resolves the caller's own `notification_target`, verifies same-barangay ownership, records `ack_status=acknowledged` and `acknowledged_at`, and returns `{success:true,notification_id,acknowledged_at}`. The endpoint is idempotent for an already-acknowledged target. This acknowledgment is distinct from transport delivery and does not force a transport attempt to become `sent`.

---


## 7. Role & Permission Matrix

**Legend:** ✓ Full access · R = Read-only/redacted view only · ✗ No access · — = not a system role

| Action | Admin | Secretary | Tanod | Punong Barangay | Lupon |
|---|---|---|---|---|---|
| **Incidents** |
| Log new incident (mobile) | ✗ | ✗ | ✓ | ✗ | — |
| Web-side incident entry | ✓ | ✓ | ✗ | ✗ | — |
| Convert citizen report → incident | ✓ | ✓ | ✗ | ✗ | — |
| View incident list | ✓ | ✓ | own only | R | — |
| View raw narrative | ✗ | ✓ | ✗ | ✗ | — |
| View approved redacted narrative | ✓ | ✓ | own/assigned only | R | packet only |
| View evidence attachments | ✓ | ✓ | own/assigned only | ✗ | — |
| Trigger/rerun AI redaction | ✗ | ✓ | ✗ | ✗ | — |
| Approve AI redaction | ✗ | ✓ | ✗ | ✗ | — |
| Update incident status to resolved | ✓ | ✗ | ✗ | ✗ | — |
| Finalize blotter | ✗ | ✓ | ✗ | ✗ | — |
| Amend finalized blotter | ✗ | ✓ | ✗ | ✗ | — |
| View blotter record | ✓ | ✓ | own/assigned only | R | — |
| Generate Lupon case packet | ✗ | ✓ | ✗ | ✗ | — |
| **Dispatch** |
| Create dispatch order | ✓ | ✗ | ✗ | ✗ | — |
| View own assigned dispatches | ✗ | ✗ | ✓ | ✗ | — |
| Update own dispatch status | ✗ | ✗ | ✓ | ✗ | — |
| View dispatch board | ✓ | ✗ | ✗ | R | — |
| Override dispatch status | ✓ | ✗ | ✗ | ✗ | — |
| Cancel dispatch before arrival | ✓ | ✗ | ✗ | ✗ | — |
| **GIS / Map** |
| View live tracking | ✓ | ✗ | ✗ | R | — |
| View historical heatmap | ✓ | ✗ | ✗ | R | — |
| Broadcast own GPS | ✗ | ✗ | ✓ | ✗ | — |
| View nearby redacted incidents | ✗ | ✗ | ✓ | ✗ | — |
| **Tanod SOS** |
| Trigger SOS | ✗ | ✗ | ✓ | ✗ | — |
| View/acknowledge/resolve SOS | ✓ | ✗ | ✗ | R | — |
| **Duty Status** |
| Toggle own duty status | ✗ | ✗ | ✓ | ✗ | — |
| View own duty status | ✗ | ✗ | ✓ | ✗ | — |
| View all duty statuses | ✓ | ✗ | ✗ | R | — |
| **Reports & Analytics** |
| View/generate reports | ✓ | ✗ | ✗ | R | — |
| View notification reliability | ✓ | ✗ | ✗ | R | — |
| Export reports | ✓ | ✗ | ✗ | R where exposed | — |
| **User Management** |
| Create/edit/deactivate users | ✓ | ✗ | ✗ | ✗ | — |
| Reset another user's password | ✓ | ✗ | ✗ | ✗ | — |
| **Shift Scheduling** |
| Create/edit shifts | ✓ | ✗ | ✗ | ✗ | — |
| View all shifts | ✓ | ✗ | ✗ | ✗ | — |
| View own shifts | ✗ | ✗ | ✓ | ✗ | — |
| Submit shift swap request | ✗ | ✗ | ✓ | ✗ | — |
| Approve/deny swap request | ✓ | ✗ | ✗ | ✗ | — |
| View fatigue flags | ✓ | ✗ | ✗ | R | — |
| Acknowledge fatigue flag | ✓ | ✗ | ✗ | ✗ | — |
| **Citizen Reports** |
| View citizen report inbox | ✓ | ✓ | ✗ | ✗ | — |
| **SMS / Audit** |
| View SMS activity log | ✓ | ✗ | ✗ | ✗ | — |
| View audit log | ✓ | ✗ | ✗ | ✗ | — |
| **Map Packages** |
| Publish map package | ✓ | ✗ | ✗ | ✗ | — |
| View current own-barangay package metadata | ✓ | ✗ | ✓ | ✗ | — |
| **Account** |
| Own account settings | ✓ | ✓ | ✓ | ✓ | — |
| Change own password | ✓ | ✓ | ✓ | ✓ | — |

**Tenant rule:** every ✓/R action is limited to the caller's own barangay unless the endpoint is public intake. Tanod “own/assigned” means the server checks the caller relationship to the specific incident/dispatch/evidence, not merely the caller's role. Lupon has no login.

---


## 8. Design System (Global — applies to every screen)

**Tone:** clean, premium, modern, enterprise government-tech SaaS —
comparable to a real CAD (computer-aided dispatch) system or civic-tech
dashboard. Trust, reliability, security, government professionalism.
Never playful, never cluttered, never "student project" looking — but
still scannable in under 2 seconds during an active incident.

**Design tokens** (`/web/src/styles/base.css`):
```css
:root {
  --color-navy: #1E3A6E;          --color-primary: #1D4ED8;
  --color-accent: #3B82F6;        --color-surface-blue: #E0F2FE;
  --color-white: #FFFFFF;         --color-bg: #F8FAFC;
  --color-border: #E2E8F0;        --color-text-primary: #0F172A;
  --color-text-secondary: #475569;
  --color-critical: #DC2626;      --color-warning: #D97706;
  --color-success: #16A34A;       --color-info: #0891B2;
  --spacing-xs: 4px; --spacing-sm: 8px; --spacing-md: 16px;
  --spacing-lg: 24px; --spacing-xl: 32px; --spacing-2xl: 48px;
  --font-base: "Inter", system-ui, -apple-system, sans-serif;
  --font-size-label: 0.75rem; --font-size-sm: 0.875rem; --font-size-md: 1rem;
  --font-size-lg: 1.25rem; --font-size-xl: 1.75rem; --font-size-2xl: 2.25rem;
  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
  --shadow-card: 0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.06);
  --shadow-elevated: 0 4px 12px rgba(15,23,42,.10);
}
```
Never hardcode a hex value, pixel spacing, or font name in a component file.

**Typography:** H1 bold hero (`2xl`, sparing — page titles) · H2 strong
section headers (`xl`) · H3 clean card titles (`lg`) · Body readable
(`md`/`sm`) · Labels subtle uppercase (`label`, ~0.05em tracking).

**Status pills:** fully-rounded (`999px`), small uppercase label, tinted
low-opacity background of the status color, solid color as text — never a
flat solid-fill badge.

| Status | Token | Used on |
|---|---|---|
| Pending | `--color-warning` | Incidents, redaction approval, swap requests |
| Queued / Processing | `--color-info` | AI processing log, SMS log |
| Dispatched / En Route | `--color-info` | Incidents, dispatch |
| Resolved / Completed / Approved | `--color-success` | Incidents, dispatch, swap requests |
| Active / Online / On Duty | `--color-success` | Duty status, live connections |
| Offline / Off Duty / Cancelled / Denied | `--color-text-secondary` | Duty status, sync indicator, dispatch, swap requests |
| Ack Timeout / Refunded | `--color-warning` | Notification log, SMS log |
| Failed / SOS / Critical / Priority Alert | `--color-critical` | AI processing log, notification log, dispatch, SMS log, alert overlay |

**Note on SOS `acknowledged`:** don't bucket under Resolved/Approved — W3
(§9) is explicit that acknowledging an SOS does not clear the banner, so
this state keeps a `--color-critical`/`--color-warning` treatment
(still-urgent) rather than the calm green used for genuinely closed
items, until it reaches `resolved`.

**Required states — every data-driven screen:** Loading (skeleton/spinner,
never blank) · Empty (icon + short explanation, never a blank table) ·
Error (banner + retry, matches §6's error format) · Populated. Mobile
screens add a fifth: **Offline** (queued locally, shown via M11).

**Nav shell:** Web — dark navy collapsible sidebar, role-filtered per §7;
white top bar (breadcrumbs, search, avatar dropdown). Critical operational alerts appear in W3/W4 rather than a generic web notification inbox.
Mobile — bottom nav: **Home, Assignments, Log Incident, Map, Profile**;
persistent offline banner (M11) docks above it when active. **RESOLVED
2026-09-03** (confirmed with the user): Log Incident takes the persistent
bottom-tab slot instead of Schedule, on the Figma reference's reasoning
that a field emergency app should put its most time-critical action one
tap away at all times. Schedule (M8) is reachable from Profile instead —
it isn't built yet, and when it is, it's used at most a few times a week,
not dozens of times a shift the way Log Incident is. Implemented in
`mobile/src/App.tsx`'s `TabbedShell`; Assignments/Map/Profile tabs are
real and reachable now but route to an honest "not built yet" placeholder
(`NotBuiltYetPage`) until their own Sprint 3+ boxes land.

**Responsive:** Desktop-first 1440px (primary) → Tablet 768px (sidebar
collapses, multi-column stacks) → Mobile 375px (tables become stacked
cards, emergency actions stay large/one-handed).

**Accessibility / field-use:** 44×44px min tap target on mobile (gloves,
one-handed use) · never rely on color alone for status (always pair with
text) · Critical Alert Overlay (M12) must be readable at arm's length in
direct sunlight — high contrast, large type, minimal text · every
interactive control is keyboard-operable with a visible focus ring
(real `<button>`/`<a>`/form elements, never a clickable `<div>`) ·
form fields have a programmatically associated label, not a
placeholder-only or visually-adjacent one · loading/error regions
announce to assistive tech (`role="status"`/`role="alert"`) · any
chart/graphic that conveys data has a text/data-table equivalent, not
color/shape alone.

### Adopted UI reference: Figma Make visual/component library

A full high-fidelity Figma Make export (`Downloads/Baranguard.zip`,
`https://www.figma.com/design/llfBj3M4ilW1bZNnEnLGLY/Baranguard`) is the
canonical visual/layout/component reference for this design system — match
its spacing, card/panel composition, and component patterns exactly where
they don't conflict with the exclusions below. It is a generic AI-generated
"enterprise SaaS" design brief, not derived from this project's own §2/§6/§7
rules, so every pattern below was individually checked against those rules
before being adopted. When implementing a screen, check this list (and the
per-screen notes in §9) for the specific component pattern to reuse before
inventing a new one.

**Adopt these patterns (real UI structure, wire to real data):**
- Sidebar nav item set, colored icon tiles, gradient brand mark — already
  the current implementation (`web/src/components/AppShell.js`,
  `icons.js`).
- KPI card row: colored icon-badge, trend value, big number, label
  (W2, W9).
- Chart taxonomy for W9: line/area trend (already built), donut breakdown
  by incident type (buildable now — `by_incident_type` is already
  returned by `GET /reports/summary`, this is a visualization change
  only). An "incident count by hour-of-day" bar chart is a real backlog
  idea but is **not** buildable today without a backend change — `GET
  /reports/summary` doesn't return an hourly bucket today, only
  `trend[]` (daily); see §10 item 7. A horizontal "response time by
  barangay" bar chart, as literally shown in the Figma reference, is
  **not adopted at all** — every Admin/PB session is tenant-scoped to
  exactly one barangay (Rule 8), so no session can ever see another
  barangay's data to compare against; a cross-barangay comparison chart
  is architecturally impossible under the current tenant model, not
  just unbuilt. If a same-idea, tenant-safe breakdown is wanted later
  (e.g. by patrol zone within the caller's own barangay), that needs
  its own design pass, not a reuse of this chart concept. A
  radar/spider "overall performance score" chart is **not** adopted as
  specified — its axes/weights in the mockup are arbitrary demo numbers
  with no defined formula; treat "a composite performance score chart"
  as an unscoped backlog idea (§10) that needs its own scoring-formula
  design pass first, the same way `avg_response_time_minutes` already
  has one exact formula in §6 — never ship a chart backed by an
  undefined number.
- Search + filter bar pattern (text search, type-filter pills,
  status/priority `<select>`) for list screens (W6, W7 successor,
  W16).
- Master/detail split and 384px-wide slide-over detail panel, used
  interchangeably per screen density (W7, W8, W10, W16 successor
  detail views).
- Status-driven action button (button label/color changes with the
  record's current status, e.g. "Dispatch" → "Mark Resolved" → "Close")
  — good pattern for W3/W7, but the button set and the states it
  switches on must match §5's real enums (`incident.status`:
  `pending|dispatched|resolved`; `dispatch.status`:
  `assigned|en_route|arrived|completed|cancelled`) — the mockup's own
  4-state `Active/Responding/Resolved/Closed` incident model does **not**
  exist in this schema and is not adopted; map its UI pattern onto the
  real 3-state `incident.status` instead.
- Vertical colored-dot timeline component for incident/dispatch history
  (W7) — populate from real audit/status-timestamp data
  (`dispatch.dispatched_at/en_route_at/arrived_at/completed_at`,
  `audit_log`), never a hardcoded relative-time string.
- Avatar-initials-circle pattern for user rows (W10, Tanod picker).
- SMS chat-bubble conversation UI (incoming left/white, outgoing
  right/blue) as the visual pattern for W14, if/when W14 grows a reply
  capability — see the explicit scope note in §9's W14 entry before
  building that; it's not in the current endpoint set.
- Live map legend + color convention (green=available/on-duty,
  blue=dispatched/en route, red=emergency/SOS, gray=offline/stale) and
  the surrounding chrome (filter checkboxes, personnel list, live
  activity feed panel) for W3/W4 — layered **around** the real MapLibre
  map already implemented, which is already a genuine improvement over
  the mockup (see exclusion below).
- Settings sidebar-tabs-with-form-panel layout for W15 (already the
  general shape; W15 itself stays scoped to self profile/password per
  §9 — see the new backlog item in §10 for the separate system-config
  screen this pattern also suggests).

**Do not adopt (checked against §2/§7/§8's own rules and rejected):**
- **Login role-selector.** The mockup's `LoginPage` lets the user click
  Admin/Dispatcher/Tanod before signing in and routes on that clicked
  value with no credential check at all. W1 already correctly has no
  role selector (§9); role is resolved server-side from the
  authenticated account only (Rule 6, Rule 9). Adopt the mockup's
  two-column visual layout only.
- **Fabricated trust/marketing claims.** "Bank-level encryption,"
  "24/7 Monitoring... 99.9% uptime," "Trusted by 50+ barangays across
  Bicol Region," "The Philippines' first AI-powered..." superlative,
  "Powered by Claude AI, fine-tuned for Philippine barangay
  operations," "AI-Powered Intelligence 95%," "Data Security 100%,"
  "500+ Trained Tanods," "10K+ Incidents Resolved," a permanently-green
  hardcoded "All Systems Operational" badge, and every other
  unverifiable stat/claim in the mockup's `LandingPage`/`LoginPage`/
  `AdminDashboard` System Health banner. These fail the
  production-realism rule below outright, and the Claude AI claim
  additionally contradicts Rule/§1's self-hosted-only AI requirement
  (this system's AI is Llama-SEA-LION-v3.5-8B-R via Ollama, **never**
  an external API/vendor) — never let any screen imply a hosted/vendor
  AI is in use.
- **Hardcoded fake identities.** The mockup bakes "Admin User /
  admin@baranguard.ph" into `DashboardLayout`'s topbar and "Juan Dela
  Cruz" plus fabricated performance stats (128 responses, 98% success
  rate) directly into `TanodMobileApp`'s Home/Profile tabs, with no
  session lookup at all. Every identity/stat shown must come from the
  authenticated session or a real query, never a literal name/number in
  the component.
- **Client-side-only "security" controls.** The mockup's Settings page
  has Two-Factor Authentication and Audit Log toggles that are pure
  local UI state with no backing enforcement; `UserManagement`'s
  Permissions panel computes what a role "can do" from a client-side
  `role === 'admin'` string comparison with no server check. Rule 6
  already forbids this outright — a settings/permissions screen may
  *display* server-confirmed state, but nothing on this system may
  gate a capability by client-side role/flag comparison alone.
- **Fake map rendering.** `DispatcherDashboard`, `GISTracking`, and
  `TanodMobileApp`'s Map tab all render a decorative MapPin icon with
  absolutely-positioned colored dots instead of a real map library —
  this project already implemented a real MapLibre map
  (`web/src/components/LiveMap.js`) for W3/W4, which is strictly better
  than the mockup here; keep it, and only adopt the mockup's
  surrounding chrome (legend, filters, personnel list) as noted above.
- **Scripted fake "AI" responses.** `AITools` and `ElectronicBlotter`'s
  AI Assistant panel show 100%-hardcoded output strings behind a fake
  `setTimeout` "Generating..." spinner, including fabricated confidence
  scores (94%, 95%, a 78/100 "risk score"). If/when W8's redaction/
  summary UI is built, its output comes from the real local Ollama
  pipeline per §6/Rule 16 — never a scripted demo string, and never a
  confidence number without a real evaluation run backing it
  (`ai_evaluation_run`, §5).

**Production-realism rule:** this must look like the live deployed system,
not a demo.
- No "demo account" credentials, "test login" hints, watermarks, "DEMO
  MODE" banners, or any prototype tell.
- Seed/mock data must be realistic (plausible Filipino names, real
  barangay names, plausible incident types) but never labeled fake in the
  UI — distinguish test data in code comments/README only.
- No Lorem Ipsum, "Company Name," "Your Logo Here." Use "Baranguard" and
  real barangay names.
- No hardcoded credentials in committed code — `.env` only, never echoed
  to UI/console/git.
- Mock an unbuilt dependency invisibly at the service layer — never with a
  visible "MOCK DATA" UI label.

---

## 9. Screens

Each screen is implementable from this section plus §§1–8. Every data-driven screen implements Loading/Empty/Error/Populated states; mobile also implements Offline where applicable.

### Web — Command Center

**W1 — Login** · Roles: All (pre-auth) · API: `POST /auth/login`
No role selector. Submit is disabled during authentication. Failed authentication uses a generic message such as “Unable to sign in with those credentials.”

**W2 — Admin Dashboard** · Roles: Admin, Punong Barangay (read-only) · API: `GET /reports/summary`
KPI cards plus trend chart. The API returns `trend[]` with a defined date bucket and counts, so the chart never invents a client-side data shape. Fresh deployments show an intentional empty state. UI reference: colored-icon-badge KPI card row (already built), `by_status`/`by_incident_type` as breakdown cards (already built) — a donut/pie rendering of `by_incident_type` is an acceptable visual upgrade of the existing breakdown card, same data, no API change.

**W3 — Dispatch Center** · Roles: Admin · API: pending incidents, active dispatches, duty status, GPS live, notifications/SOS, dispatch create/cancel
Split-pane queue + live map. Queue contains pending incidents and active dispatches. The Tanod picker includes only same-barangay active Tanods who are currently eligible for assignment. Critical incident presentation is driven by the incident/dispatch state and disappears when the item is dispatched/resolved; SOS stays until resolved. No screen references a nonexistent priority-acknowledgment endpoint. UI reference: priority dot + status pill on each queue card (already built); an optional detail slide-over on card click, showing the assigned Tanod and a real status-timestamp timeline (`dispatched_at/en_route_at/arrived_at/completed_at`), is an acceptable enrichment — no fake elapsed-time strings, compute them from those real timestamps.

**W4 — GIS Live Tracking** · Roles: Admin, Punong Barangay (read-only) · API: `GET /gps/live`, `GET /gps/history`, active SOS
Shows freshness (`age_seconds`, stale badge) on every responder marker. A stale location is not visually presented as live. SOS markers remain visible above ordinary map filters. UI reference: on the real MapLibre map already implemented, the sidebar "stats row (Available/Dispatched/Active) + personnel list + legend" chrome is an acceptable enrichment (already close to built); an optional "live activity feed" panel populated from real `audit_log`/dispatch-status-change rows is acceptable — never a hardcoded activity script.

**W5 — Historical Heatmap** · Roles: Admin, Punong Barangay (read-only) · API: `GET /reports/heatmap`
Historical only, bounded date range, explicit non-predictive label.

**W6 — Electronic Blotter List** · Roles: Admin, Secretary, Punong Barangay (redacted/read-only) · API: `GET /incidents`, `POST /incidents`
Server-provided redacted excerpt only. New-entry form derives source server-side. UI reference: text search + status-filter pattern (already built) is an acceptable enrichment target for a client-side search box over the loaded page (no new search endpoint implied); the Export button ties to W9's existing `GET /reports/export` scope (Sprint 7), not a new endpoint.

**W7 — Electronic Blotter Detail** · Roles: Secretary (full incl. raw), others per §7 · API: incident detail, incident blotter lookup, evidence, Admin status update, Secretary finalize/amend
Evidence access follows the same ownership policy as the API. Finalized blotter data is read-only until an explicit amendment workflow. Admin incident resolution is shown only when the dispatch/state prerequisites are met. UI reference: master/detail split or 384px slide-over panel (either is acceptable); status-driven action button labeled per the real `incident.status`/dispatch-prerequisite state (not the mockup's 4-state model — see §8); a real status/timestamp timeline (`created_at`, `dispatched_at`, `arrived_at`, `redaction_approved_at`, `finalized_at`), never a scripted one.

**W8 — AI Redaction Review** · Roles: Secretary only · API: draft/read/redact/regenerate/approve/translate/Lupon packet
Side-by-side raw vs draft. Displays `draft_version`, model version, status, and stale warning. Editing requires regeneration using the matching version. Approval requires exact current version equality. Once approved, translation and Lupon packet are available only when their prerequisites are met. Re-running redaction after finalization is blocked in the normal path and requires revision policy. UI reference: the mockup's "AI Assistant" panel layout (input card, generate action, output card) is an acceptable visual shape, but every value must come from the real `ai_processing_log` row for the actual pipeline run — never a scripted demo string or a fabricated confidence score (see §8's exclusions), and the model badge must name the real self-hosted model (`ai_processing_log.model_version`), never a vendor/hosted-AI name.

**W9 — Statistical Reports** · Roles: Admin, Punong Barangay (read-only) · API: summary, notification summary, export
Contains exact trend, incident, status, response-time, and notification reliability datasets. Generate and Export are separate; Export calls `GET /reports/export` and is audited. UI reference: see §8's adopted chart taxonomy (trend line/area, incident-type donut, avg-response-by-barangay bar, incident-count-by-hour bar) — all computable from existing `GET /reports/summary` data or a documented, reviewed extension of it; a composite "performance score" chart is explicitly not in scope until it has a real formula (§8, §10).

**W10 — User Management** · Roles: Admin only · API: users/device/session-related effects
Deactivation warns that it revokes sessions and device notification registration. Self-deactivation is unavailable. At least one active Admin must remain. UI reference: avatar-initials table row, role/status pills, master/detail split (already-adjacent patterns to W7). A "what this role can normally do" permissions summary in the detail view is acceptable as a **static, server-authored reference table keyed by role** (matching §7's own matrix) — never a live `selected.role === 'admin'`-style client comparison standing in for real authorization (§8's exclusions; Rule 6).

**W11 — Shift & Roster Scheduler** · Roles: Admin only · API: shifts, fatigue flags
Week view uses real `start_at/end_at`. Overlaps are rejected. Fatigue recalculates on create/edit/reassignment and shows its calculation basis.

**W12 — Shift Swap Requests** · Roles: Admin only · API: swap list/update, shift detail/edit
Approvals occur transactionally and revalidate current users, assignment, time overlap, and fatigue. Open approved requests explicitly show “unassigned — Admin action required.”

**W13 — Fatigue Flags** · Roles: Admin, Punong Barangay (read-only) · API: flags/acknowledge
Sorted by over-threshold hours. Acknowledgment never deletes or hides the historical record.

**W14 — SMS Activity Log** · Roles: Admin only · API: `GET /sms/logs`
Shows transport, message type, direction, status, timestamps, correlation ID/provider ID. Phone numbers are masked. Read-only per its own API — a two-way inbox/reply/compose console (chat-bubble UI, quick replies, broadcast) is an unscoped backlog idea only (§10, §8's adopted-patterns list); it needs new endpoints (send/reply/broadcast) that don't exist in §6 today. Do not build a compose/send UI against this endpoint.

**W15 — Settings / Account** · Roles: All · API: self profile, change password, logout
Logout is one atomic server action from the user's perspective. Web client clears local auth state after success/failure-safe completion. Scope stays self-profile-only — a broader system-configuration screen (notification channels, SMS gateway, GIS parameters, backup schedule, appearance) is a distinct, unscoped screen; see the new W21 backlog entry below, not this one.

**W16 — Citizen Reports Inbox** · Roles: Secretary, Admin · API: list/convert
Displays contact/description only as permitted. Conversion is disabled once converted and is idempotent on retries.

**W17 — Audit Log Viewer** · Roles: Admin only · API: `GET /audit-log`
Last 7 days default, paginated, no edit/delete controls.

**W18 — Map Package Management** · Roles: Admin only · API: `GET /map-packages/:barangay_id`, `POST /map-packages`
Shows only the Admin's own barangay package. Displays published version/checksum and upload validation result. It no longer assumes an Admin-only endpoint is Tanod-only.

**W19 — Public Citizen Report** · Roles: Public · API: `POST /citizen-reports`
Public form with one of four barangays, description, optional contact/location, rate-limit messaging, privacy notice, success confirmation, and non-sensitive reference number. No internal role/account information is exposed.

**W20 — Service Health / Recovery** · Roles: Admin only · API: `GET /system/health` (local-only)
Shows MariaDB, API, OSRM, Ollama, GSM ingestion, notification configuration, and backup/last-restore-test status. This is operational diagnostics, not a public endpoint. Any "system status" indicator shown elsewhere in the shell (e.g. a topbar badge) must read from this real endpoint — never a hardcoded "All Systems Operational" badge (§8's exclusions).

**W21 — System Settings** · Roles: Admin only · API: **none yet — NEW, unscoped, no sprint assignment**
Not yet in scope; added here only as a named placeholder so a future session doesn't invent it ad hoc. The Figma reference's Settings screen groups admin-level system configuration (notification channels/escalation, SMS gateway integration + credentials, GIS/tracking parameters like polling interval and default map center/zoom, backup schedule/storage/retention, appearance) distinct from W15's self-profile scope. None of these fields exist in §5 today. Before building any part of this: (1) confirm which subsections are actually needed for this deployment (a single-workstation, four-barangay system may not need most of them — e.g. "Backup Storage: Google Drive/AWS S3" contradicts Rule 19's local-only/cloud-deferred stance and should likely be dropped, not adopted), (2) design real backing columns/tables and a real read/write API per confirmed subsection, (3) update §5/§6/§7 first, per §14's own rule, before writing any UI against it. Do not store gateway credentials (e.g. an SMS provider secret) in a plaintext settings row or expose them through any read endpoint — Rule 26 applies here as much as it does to device secrets.

### Mobile — Tanod Operations App

**M1 — Login** · APIs: login, device register, map-package metadata/download
After successful authentication the app validates the device, registers FCM, checks map package version, and enters M2 without blocking on map download.

**M2 — Home** · APIs: duty status, own status, SOS
Duty control remains primary. SOS supports the local/offline fallback path; if workstation connectivity is absent, the app preserves an SOS event locally and attempts the GSM fallback transport. UI reference: greeting card with on/off-duty toggle, a quick-stat row, and a 2×2 quick-actions grid (SOS/Log Incident/Call Dispatch/Share Location) are acceptable patterns — every name/stat shown must come from the authenticated session and real queries, never a hardcoded identity (the Figma reference bakes in a fake "Juan Dela Cruz" with fabricated stats — see §8's exclusions). The duty toggle must call `POST /duty-status`, not just flip local UI state.

**M3 — Log New Incident** · APIs: local SQLite, POST incident, sync, evidence upload
Every field writes locally immediately. A stable `client_event_id` is created when the record is first saved. The same ID follows direct POST, sync, and SMS fallback. Voice/photo files use app-private storage.

**M4 — Incident Submitted Confirmation** · Local state + sync status
Displays “Saved locally,” “Queued,” “Synced,” “Duplicate reconciled,” or “Needs attention.” It never claims server submission when only local persistence has occurred.

**M5 — Assignments List** · APIs: `dispatch_local`, live dispatch API when available
Reads cached assignments so the screen still works when the workstation/API is unreachable. Shows stale/cached indicator. UI reference: card per assignment (priority dot, ID, priority pill, type, location, distance) with Navigate/Call Dispatch/Mark as Arrived actions, and an explicit "No Active Assignments" empty state — both acceptable patterns, wired to `dispatch_local`.

**M6 — Assignment Detail / Navigation** · APIs: cached dispatch + route, dispatch status, GPS
Status changes may be made offline and queue into `dispatch_status_updates[]`; they reconcile using idempotent client event IDs and the dispatch transition matrix. A client must not locally skip states. Cached route is labeled cached/last known. New OSRM routing is unavailable offline.

**M7 — Live Map** · APIs: GPS, nearby incidents; cached local map
Shows location freshness and cached marker status. No claim of live server data when disconnected.

**M8 — Shift Schedule** · API: self shifts; uses actual `start_at/end_at` and patrol zone.

**M9 — Shift Swap Request** · API: create/list self requests; client-generated request ID prevents duplicates.

**M10 — Profile** · APIs: self profile, password change, **atomic logout/device deactivation behavior**
Logout must not call a revoked-token endpoint afterward. Preferred behavior is one authenticated `POST /auth/logout` that revokes the session and deactivates the current device in one server transaction; client then clears local auth state. A performance/activity-summary section (total responses, avg response time, hours on duty) is an acceptable pattern **only if** backed by a real query over the caller's own `dispatch`/`duty_status` rows — the Figma reference's numbers (128 responses, 98% success rate) are fabricated demo content and must not be treated as a target or copied as placeholder values that look real.

**M11 — Offline Indicator** · Persistent element
Shows offline, queued count, oldest pending age, and sync errors across incident, dispatch-status, GPS, duty, SOS, and attachment queues. It does not disappear while unresolved records remain.

**M12 — Critical Alert Overlay** · API: notification acknowledgment
Critical notifications request high-priority/full-screen presentation where the OS permits. The app must also support heads-up/banner fallback and local cached rendering when the local API cannot be reached. Notification permission/channel state is visible in diagnostics.

**M13 — SMS Fallback Confirmation** · Persistent element
Text reflects the actual transport state: “Sent by SMS,” “SMS pending,” “SMS failed,” or “Saved locally for retry.” It never says successful merely because the fallback attempt was queued.

**M14 — My Incident Reports** · APIs: own incident list + `GET /incidents/:id/blotter`
Shows sync state and only exposes the blotter summary once a finalized record exists. The incident response or convenience endpoint provides the relationship; the UI does not guess a nonexistent blotter ID.

### Cross-Screen Consistency Checklist

- [ ] Tenant/ownership checks are enforced server-side on every object ID.
- [ ] All state transitions follow §§2 and 6.
- [ ] All retryable writes use idempotency/client event IDs.
- [ ] Offline screens use explicitly cached tables and show stale/cached state.
- [ ] Loading/Empty/Error/Populated and Mobile Offline states exist.
- [ ] No raw narrative appears outside Secretary-authorized surfaces.
- [ ] Design tokens only; no hardcoded colors/spacing/fonts.
- [ ] All displayed data exists in the declared API response or local cache.
- [ ] Finalized blotter and approved redaction are protected from silent overwrite.
- [ ] Notification UI matches logical notification/delivery records.
- [ ] No screen uses an endpoint that its role does not have.
- [ ] No demo/prototype tells.


## 10. Feature Backlog (Sprint-Mapped)

**1. Mobile App (Tanods)** — offline incident form (S2) · encrypted SQLite cache (S2) · cached dispatch/route detail (S2–3) · offline basemap package (S2) · photo/voice attachment (S2) · auto-sync on reconnect with idempotent reconciliation (S3) · GPS broadcast (S3) · dispatch assignment + cached route navigation (S3) · duty toggle + duty fallback (S1–4) · dedicated SOS local/SMS fallback (S4) · My Incident Reports (S3–4)

**2. Web Command Center** — responders/incidents (S1) · live dispatch board (S1) · GIS tracking with freshness (S1/S3) · historical heatmap (S1) · statistical reports + trend + export (S1/S7) · scheduler with date/time and overlap validation (S1–2) · fatigue calculation (S1–2) · electronic blotter list/detail + amendment flow (S1/S6–7) · dispatch creation/cancel (S1/S3) · Citizen Reports Inbox + public intake (S1) · service health (S7)

**3. AI & Data Privacy Core** — SLM setup and queue handling (S5) · redaction draft (S6) · summary derived only from draft (S6) · draft versioning/concurrency (S6–7) · target recall ≥95%/precision ≥90% on 200-record evaluation set (S6) · baseline regex comparator (S6) · human approval gate (S6–7) · translation after approval (S5–6) · ~~voice-to-text scope confirmation (S5–6)~~ **RESOLVED 2026-09-03: OUT OF SCOPE — see below** · blotter finalization + amendment controls (S6–7) · Lupon packet after finalized summary (S6–7)

**Voice-to-text — RESOLVED 2026-09-03 (Sprint 5): explicitly OUT of scope
for the capstone.** This was flagged above as an open S5–6 "scope
confirmation"; leaving it implicit any longer would let it drift into an
assumed deliverable. Voice *capture* stays in scope and is already built
(Sprint 2: `capacitor-voice-recorder` → `evidence_attachment_local` with
`type='voice'`); what is out of scope is *transcription* of that audio
into text. Four reasons, in order of weight:

1. **Mobile-side transcription would break Rule 1.** Android's default
   `SpeechRecognizer` routes audio to Google's servers. Incident audio is
   unredacted narrative content, so that is precisely the "raw narrative
   leaves the trusted environment" this system's first rule forbids.
   On-device recognition avoids the network but has poor Filipino and
   effectively no Bikol coverage.
2. **Server-side transcription means a SECOND self-hosted model.**
   `Llama-SEA-LION-v3.5-8B-R` is a text model and cannot transcribe
   audio; ASR would need Whisper or equivalent running alongside it on the
   same unified workstation that is already the documented single point of
   failure (Rule 15). §1 budgets one model, not two.
3. **Bikol ASR quality is unvalidated and worse-supported than Bikol
   text.** Rule 16 already treats Bikol *text* output as unvalidated
   pending empirical testing; layering an unvalidated transcription step
   underneath an unvalidated translation step compounds two unknowns into
   an unmeasurable one.
4. **The field need is already met without it.** A Tanod who cannot type
   one-handed at an incident records a voice note, which attaches to the
   incident as evidence and is playable by the Secretary. Transcription
   would be a convenience on top of a working path, not an enabler of a
   blocked one.

If this is ever revisited, the only acceptable shape is a **self-hosted
ASR model as a second queued job type** reusing Sprint 5's existing
`ai_processing_log` queue (`task_type` would need a new enum member) —
never a cloud speech API, and never the platform recognizer.

**4. Resiliency & Connectivity** — offline map packaging (S2) · FCM registration/critical notifications (S4) · notification logical/delivery model (S4) · GSM incident/duty/coord/SOS fallback (S4) · SMS authenticity/encryption/replay protection (S4) · local workstation health monitoring (S7) · backup/restore verification (S7)

**5. Evaluation Framework Hooks** — authentication/session revocation + lockout evidence · tenant/ownership penetration tests · offline cache durability and duplicate-reconciliation tests · notification end-to-end reliability · sync latency · SLM inference time · raw-PII exposure audit · GPS/route accuracy · dispatch response-time metric · offline-map availability · fatigue audit trail · 3+ Android device tiers · valid JSON contracts · AI dataset evaluation run records · Bikol language-quality validation before broader reliance

**6. Data/Operational Hardening** — database migrations with explicit constraints/indexes · foreign-key delete policy · retention jobs + legal-hold support · backup lifecycle · restore test · evidence upload security · report pagination/max limits · audit completeness test.

**7. Unscoped ideas from the Figma Make UI reference (§8) — none of these have a sprint assignment, schema, or endpoint yet; each needs its own design pass before implementation, per §14:**
- W21 System Settings (admin system-config screen — see its own §9 entry for what needs deciding first).
- Two-way SMS console (reply/broadcast) as a future extension of W14 — needs new send/reply/broadcast endpoints.
- AI incident auto-classifier and AI threat/risk scorer as possible future additions to W8's AI scope — both need real model/scoring design and a real evaluation run before any confidence/score number ships; do not adopt the Figma reference's illustrative 94%/78-out-of-100 numbers as targets.
- A composite "performance score" chart for W9 — needs a defined, documented scoring formula first (same rigor as `avg_response_time_minutes`'s exact formula in §6).
- Public marketing landing page (the Figma reference's own "top priority" item, `LandingPage.tsx`). **Not recommended as a priority for this project**: this is a specific system built for four named barangays, not a SaaS product being sold to acquire barangay customers, so a landing page's usual job (convert visitors into signups, cite customer/scale metrics) doesn't apply here — and every metric in the reference's version is fabricated (§8's exclusions). The real public-facing entry point is already scoped and built: W19 Public Citizen Report. If a public informational page is wanted later, scope it as a short, honest description of the system and its four barangays with a link to W19 — not a metrics-driven marketing page.

**Resolved decisions (don't reopen without an explicit architecture review):**
- Current system of record is local MariaDB 10.4 via XAMPP; cloud deployment is deferred/undecided.
- Four barangays are isolated tenants.
- Authentication uses Argon2id + 15-minute JWTs + server-side session revocation; no refresh-token flow.
- Sliding renewal is permitted only while the session is still valid.
- Offline mobile data uses encrypted local SQLite and stable client event IDs.
- Dispatch cancellation returns `dispatched→pending` only before arrival.
- One active dispatch per incident is the current scope.
- Lupon has no system login; packet is Secretary-generated.
- FCM and SMS are notification transports under a logical notification/delivery model.
- FCM ack timeout does not itself imply SMS fallback.
- Raw narrative is never sent in plaintext through external services; GSM fallback uses authenticated-encrypted envelopes if sensitive content must be transported.
- SOS is a dedicated safety path and has an out-of-band/local fallback.
- Shift scheduling uses real start/end timestamps and rejects overlap.
- Fatigue threshold is a project safety rule, not a statutory claim about tanods.
- Finalized blotters require an explicit amendment path.
- AI drafts are versioned; approval requires exact current version match.
- Translation occurs only after human-approved redaction.
- Bikol quality is empirically unvalidated until S5 testing.
- Retention periods are fixed per the §11 table: 30-day post-approval grace / 90-day unapproved ceiling for `raw_narrative`, 7 years for redacted incident/blotter/evidence/audit_log, 1 year for unconverted citizen reports/SMS logs/AI processing logs, 90 days for deactivated device records — all subject to legal hold.


## 11. Sprint Map

| Sprint | Weeks | Focus |
|---|---|---|
| 0 | 1–2 | Local MariaDB setup, executable schema/constraints, auth/session, first-admin bootstrap, backup baseline |
| 1 | 3–4 | Web command center + GIS dashboard + public citizen intake + reports |
| 2 | 5–6 | Mobile UI + encrypted SQLite cache + `dispatch_local` + offline basemaps + evidence local storage |
| 3 | 7–8 | GPS tracking + idempotent sync + cached dispatch + offline state reconciliation |
| 4 | 9–10 | Notification model + FCM + GSM/SMS fallback + SOS fallback + device lifecycle |
| 5 | 11–12 | Ollama + SEA-LION setup + AI health/queue + translation evaluation |
| 6 | 13–14 | PII redaction + summary pipeline + draft versioning + evaluation dataset |
| 7 | 15–16 | RBAC/ownership hardening + audit + retention/legal hold + blotter amendment + backup/restore + integration/security testing |
| 8 | 17–18 | UAT + reliability/safety/performance evaluation + ISO/IEC 25010:2023 assessment |

**Retention periods (referenced by Rules 11 and 25 in §2):**

| Record | Retention | Notes |
|---|---|---|
| `raw_narrative` | Deleted 30 days after human-approved redaction; hard ceiling of 90 days from `created_at` if never approved | 30-day grace covers post-approval correction/dispute; 90-day ceiling is the abandoned/unapproved-incident cap in Rule 11; legal hold is the only exception to either |
| Redacted incident / blotter / evidence | 7 years default | Overridden by LGU records schedule or legal hold where applicable |
| `citizen_report` (unconverted) | 1 year from `submitted_at`, then purged | Converted reports drop their own clock and follow the linked incident's retention once `incident_id` is set |
| `audit_log` | 7 years default, aligned with blotter retention | Write-once except controlled retention deletion (Rule 17) |
| `sms_log` | 1 year default | Independent of the linked incident's own retention |
| `ai_processing_log` (drafts, translations) | 1 year default, or until the linked incident's retention expires, whichever is longer | Superseded draft rows follow the same rule as the current row |
| `mobile_device` / device secrets | Deleted 90 days after deactivation | Matches the `auth_session` purge window in Rule 9 |
| Offline mirror (`offline_queue`, mobile local tables) | Cleared on confirmed sync per device retention rules (Rule 2); no independent retention beyond that | Server mirror never holds raw payload, so no separate raw-data ceiling applies here |
| Backups | Follow the retention of the source data they contain | Per Rule 11, a deletion is not complete while a retained backup still holds the same data outside its documented backup lifecycle |

These are resolved decisions (see §10's "Resolved decisions" list) and implement directly as retention-job constants; a later change requires the same architecture-review process as any other resolved decision, not a runbook edit.

**Required pre-UAT exit conditions:** executable schema matches §5; every §6 endpoint has a documented response shape and authorization rule; tenant penetration tests pass; offline duplicate tests pass; critical notification/SOS fallback tests pass; restore test passes; no unresolved P0/P1 reference contradictions remain. Recovery baseline: daily local database backup with encrypted storage, documented backup retention, periodic restore verification, and a tested workstation restart procedure. Backups are recovery copies, not a separate archive. Backup expiration follows the applicable source-data retention and legal-hold policy; they are never treated as an independent indefinite archive. Any final backup schedule/retention number must be recorded in the deployment runbook before UAT.


## 12. Super Prompt Library

### 0. Base Prompt (load into every session via CLAUDE.md, no exceptions)
```
You are working on Baranguard, a real offline-first, locally hosted Barangay
Intelligence and Emergency Dispatch System for four barangays in Pilar,
Sorsogon, Philippines. Initial development uses local MariaDB through XAMPP;
cloud deployment is deferred and undecided. Treat this as a production system,
not a demo.

This Master Reference is the source of truth. Before coding, inspect §§2, 5, 6,
7, 8, and 9 for the feature being changed. Never invent fields, routes, roles,
permissions, or state transitions.

NON-NEGOTIABLE IMPLEMENTATION RULES
- Enforce tenant and object ownership server-side on every protected endpoint.
- Use stable idempotency/client_event_id values for retryable writes.
- Use the exact MariaDB/mobile schema names in §5.
- Never store or print raw narrative in logs, external notifications, or cloud services.
- Use the approved AI workflow and draft_version concurrency rules.
- Treat offline local cache as a durable state, not as temporary UI state.
- Do not silently overwrite finalized blotter records.
- Do not treat stale GPS as live.
- Do not assume an FCM alert can fetch local-server data when the LAN is down.
- Use cached dispatch/route data when offline.
- Follow §6's exact HTTP methods, request bodies, response fields, and errors.
- No client-side role check is a security boundary.
- No demo/prototype labels, fake credentials, lorem ipsum, or unmarked mock UI.

BEFORE STARTING
- Confirm the target Screen ID/backlog item.
- Check all referenced endpoints against §6.
- Check every referenced table/field against §5.
- Check permission/ownership against §7.
- Check state transitions and fallback behavior against §2.

OUTPUT
- Build only the requested scope.
- Report files changed and tests performed.
- Explicitly report any deviation from this reference instead of inventing a new behavior.
```

### 1. Sprint 0 — Local MariaDB Setup + DB Schema
```
[Base Prompt] +
SPRINT 0 — Local MariaDB 10.4 environment + executable schema.
Scope: (a) env-driven DB connection; (b) migrations for §5 with explicit
SQL types, nullability, foreign keys, indexes, uniqueness, and delete behavior;
(c) seed only the four deterministic barangay rows; (d) interactive first-admin
bootstrap; (e) backup/restore baseline.

Do not seed incident/PII data in the local development database.
Validate: schema applies cleanly from an empty database, rollback strategy is
documented, tenant constraints are testable, and the bootstrap password never
appears in source/logs.
```

### 2. Sprints 1–8 — Reusable Template
```
[Base Prompt] +
SPRINT [N] — [focus area from §11].
Scope: Build screen [ID] or backlog item [#].

Requirements:
1. Match §5 schema and §6 API exactly.
2. Enforce §7 role + tenant + ownership rules server-side.
3. Include loading/empty/error/populated; mobile also offline.
4. Use shared design tokens/components from §8.
5. Implement idempotency/concurrency rules for state changes.
6. Do not invent missing API fields; update the reference first if a contract
   genuinely needs to change.
7. Test the failure path, not only the happy path.

Output: files changed, endpoints/tables touched, tests performed, and any
remaining deviation recorded in DEVLOG.md.
```

### Reusable Single-Screen Prompt
```
[Base Prompt] +
Build screen [ID] — [name] per §9.

Before coding, verify:
- Every displayed field has a declared API/local-cache source.
- Every action maps to a permitted §6 endpoint.
- Every resource ID is tenant/ownership checked server-side.
- Offline behavior matches the screen's cached data contract.
- Error/empty/loading/offline states are present.

Output: files + test evidence.
```


## 13. Daily Session Checklist

**Before:**
- [ ] Confirm CLAUDE.md still resolves to the current version of this file (no stale copy)
- [ ] Confirm migrations still match §5 and routes/responses still match §6
- [ ] Confirm role + tenant + ownership checks for every endpoint touched
- [ ] Confirm state transitions/idempotency/concurrency rules for every write touched
- [ ] Scope today's task to ONE backlog item or ONE screen, not multiple

**After:**
- [ ] Test happy path + retry + unauthorized + cross-tenant + offline path where applicable
- [ ] Verify no raw narrative appears in logs, network payloads, notifications, or unauthorized UI
- [ ] Verify loading/empty/error/populated/offline states
- [ ] Scan the diff for demo/prototype tells before committing
- [ ] Commit with `[SprintN][USx] Short description`
- [ ] Log bugs/deviations/future-work ideas in `DEVLOG.md`
- [ ] Save evidence (screenshot/test log) for demoable features

---

## 14. Development Integrity Note

This reference now contains explicit cross-section contracts for authentication,
first-admin provisioning, tenant and ownership enforcement, idempotency, offline
incident/dispatch caching, SOS fallback, notification logical-vs-transport
records, GSM message security, AI draft versioning, finalized blotter amendment,
shift dates/times and overlap handling, GPS freshness, citizen conversion
concurrency, evidence security, report/export data shapes, map-package access,
retention/backup handling, and the local-first MariaDB deployment decision.

The intended source-of-truth rule is strict: when implementation differs from this
document, record the deviation in `DEVLOG.md`, then update the relevant schema/API/
role/screen section before treating code as the new reference. Do not create a
parallel undocumented behavior merely to make a build pass.

---

## 15. Reference Audit Status

**Status: FINAL — implementation contract hardened and validated.**

This reference is closed for architecture/design changes unless a deliberate architecture review is approved. All previously identified P0/P1 reference contradictions have been resolved, including a second-pass audit that fixed a migration-order defect (`mobile_device` now precedes `incident`), added the missing `shift_schedule.version`/`client_request_id` columns to back §6's optimistic-concurrency and idempotency claims, and closed the §11 retention cross-reference with fixed, resolved retention numbers. Beyond that: §5's schema was written out as real DDL and applied to a live MariaDB 10.11 instance from empty — 24 tables, 57 foreign keys, zero errors — and §16 walks one incident through the entire lifecycle against that schema with captured, real output, including a live proof that the idempotency/replay-protection constraint actually rejects duplicates. Remaining work is implementation verification beyond what a single trace can cover: the full test suite, security tests, device/OS compatibility tests, restore drills, UAT, and deployment-runbook completion.

**Architecture review addendum (2026-09-02):** the user provided a
full high-fidelity Figma Make export as the intended visual/UI reference
and asked that its look/features be adopted. §8/§9/§10 were revised
accordingly — visual language, component patterns, and a small number of
clearly-flagged, unscoped new backlog ideas (§10 item 7) were added. §5/§6/§7
(schema, API contract, role matrix) and §11's sprint map/retention table
were **not** changed by this review — none of the adopted UI patterns
required a schema/endpoint change, and the ones that would (W21 System
Settings, a two-way SMS console, AI classifier/threat-scorer, a composite
performance-score chart) are explicitly marked unscoped rather than
silently added to scope. Several mockup patterns were deliberately
**not** adopted because they conflict with rules already in this
document — see §8's "Do not adopt" list for the specific items and the
rule each one would have violated (a client-side login role-selector,
fabricated trust/marketing statistics, a "Claude AI" branding claim that
contradicts the self-hosted-only AI rule, hardcoded fake user identities,
and client-side-only security/permission toggles).

Final closure checklist:
- [x] Local MariaDB 10.4 remains the initial system of record; cloud deployment is deferred/undecided.
- [x] Every protected endpoint requires role + tenant + object-ownership authorization where applicable.
- [x] All retryable writes have stable idempotency semantics.
- [x] Incident, dispatch, SOS, GPS, duty, evidence, and sync offline paths are defined.
- [x] Dispatch and incident state transitions are explicit and cancellation is bounded before arrival.
- [x] Logical notifications, targets, transport attempts, fallback, and acknowledgement are modeled separately.
- [x] FCM timeout automation and SMS fallback semantics are explicit.
- [x] Sensitive SMS fallback payloads use authenticated encryption and replay protection; plaintext raw narrative is prohibited.
- [x] Shift timestamps, overlap, swap concurrency, and fatigue calculation basis are defined.
- [x] AI draft versioning, approval prerequisites, translation boundary, and finalization/amendment rules are explicit.
- [x] Evidence security, retention, legal hold, backup handling, and raw-data maximum retention are defined.
- [x] Report trends, export, response-time formulas, pagination, and response shapes are defined.
- [x] Map-package authorization and publication behavior are defined.
- [x] Mobile cached dispatch/route behavior exists for local API outages.
- [x] The web shell does not depend on an undefined notification inbox.
- [x] Schema migration order and constraint strategy are defined for MariaDB 10.4 (`mobile_device` precedes `incident`, per its FK).

**Implementation gate:** Do not begin feature implementation from assumptions. Build Sprint 0 migrations from §5, then execute the authorization/idempotency/state tests described in the relevant sprint acceptance criteria. Any mismatch discovered in code must be recorded in `DEVLOG.md` and reconciled here before the code becomes the new source of truth.

---

## 16. Worked End-to-End Trace (validated against a live MariaDB 10.11 instance)

§5's migration and §6's contract are proven here, not just described: `migrations/0001_baseline_schema.sql` and `migrations/0002_seed_barangays.sql` were run against an empty MariaDB database, followed by `examples/worked_trace_demo.sql`, which walks one incident through the full lifecycle using the exact rules in §2/§6. This section is the actual output of that run.

**What the trace does, in order:**
1. Creates one Admin, one Secretary, one Tanod in barangay `Dao` — mirrors the first-admin bootstrap shape from Rule 10.
2. Registers the Tanod's mobile device (M1).
3. Mobile incident capture with a `client_event_id` (M3 → `POST /incidents`), using the same idempotency mechanism mobile writes rely on.
4. AI redaction draft (`ai_processing_log`, `task_type='redaction'`), then Secretary approval — sets `redaction_approved_by`/`redaction_approved_at`, which is the approval signal §5 defines.
5. Admin creates a dispatch (`POST /dispatch`) — incident moves `pending → dispatched`.
6. Logical notification + target + FCM delivery row (Rule 12/24's transport/logical split), then Tanod acknowledgment (`POST /notifications/:id/ack`).
7. Dispatch runs its full state machine: `assigned → en_route → arrived → completed` (Rule 21 — no skipped or backward transition used).
8. Admin resolves the incident (`PATCH /incidents/:id/status`) — only legal because no active dispatch remains, per Rule 21.
9. Secretary finalizes the blotter (`POST /incidents/:id/finalize`) — only legal because redaction was already approved.

**Captured output of the final verification query** (one row, confirming every stage committed correctly):

| incident_status | redaction_approved | dispatch_status | ack_status | delivery channel/status | blotter_finalized |
|---|---|---|---|---|---|
| `resolved` | `1` (true) | `completed` | `acknowledged` | `fcm` / `sent` | `1` (true) |

**Replay protection, proven, not asserted:** a second `POST /incidents` retry with the same `device_id` + `client_event_id` was attempted against the live database and rejected by the engine itself:
```
ERROR 1062 (23000): Duplicate entry 'device-tanod1-abc123-<uuid>' for key 'uq_incident_device_event'
```
This is the mechanism §6's "server persists the request key and returns the original incident on replay" depends on — the constraint exists and does what it's supposed to do.

**One real defect this process caught and fixed:** an earlier draft of `0001_baseline_schema.sql` added a table-level `CHECK` constraint encoding the notification entity-integrity matrix from §5. MariaDB rejected it with `ERROR 1901: Function or expression 'dispatch_id' cannot be used in the CHECK clause` — because `notification.dispatch_id`/`sos_id`/`incident_id` each carry an `ON DELETE SET NULL` foreign key, and MariaDB won't let a CHECK reference a column whose FK action could silently violate it. The migration now matches what §5 already said in prose: that matrix is enforced in application code and by a transaction-level check before insert/update, not by a database CHECK constraint. Worth knowing before anyone tries to "helpfully" add that CHECK back in Sprint 0 — it will fail the same way.

**Files delivered alongside this reference:**
- `migrations/0001_baseline_schema.sql` — all 24 server-side tables, correct dependency order, 57 foreign keys, applies cleanly to an empty database.
- `migrations/0002_seed_barangays.sql` — the four deterministic barangay rows.
- `examples/worked_trace_demo.sql` — the trace above, runnable against a disposable database for onboarding or demo purposes. Not part of the migration chain.

---
