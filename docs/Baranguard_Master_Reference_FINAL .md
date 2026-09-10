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
| AI | Llama-SEA-LION-v3.5-8B-R via Ollama, self-hosted — **never** an external AI API |
| SMS | Semaphore SMS Gateway (cloud) + tethered phone as GSM modem (local, inbound ingestion) |
| Push | Firebase Cloud Messaging (FCM) HTTP v1 |
| Mapping | MapLibre with prepackaged offline vector tiles (MBTiles); online tiles when connected |
| Routing | OSRM (self-hosted), runs on the admin workstation, LAN-only |

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
real-time dispatch, Tanod GPS, SOS, offline field capture, and local-AI
redaction. That test is why `POST /blotter` (walk-in entry) and the W6
records list were both removed on 2026-09-10, and why the AI Blotter
Assistant drafts text *for transcription into KPIS* rather than
establishing a competing record.

---

## 2. Architecture Rules

1. **No unprotected raw narrative leaves the trusted environment.** `raw_narrative` is processed only by the local SLM/redaction service. Never sent to FCM, Semaphore, a cloud AI API, cloud storage, or any third party. GSM/SMS fallback for sensitive content uses an authenticated-encrypted envelope only — raw text is never plaintext SMS.
2. **Offline capture is durable until reconciliation.** Every incident persists to encrypted mobile SQLite before the user can leave the capture flow. The local record survives until the server confirms acceptance or a duplicate is safely correlated. The server becomes authoritative after reconciliation; the local record remains an audit/cache copy.
3. **Only the human-approval endpoint may commit `incident.redacted_narrative`.** AI output is draft until Secretary approval. No import, sync, citizen conversion, SMS handler, or other service may write the permanent redacted field.
4. **SMS fallback uses explicit trigger and secure envelope rules.** Fallback starts only after the health-check rule in §6, never merely on Submit. Transport security, dedup, expiration, replay protection, and correlation use the envelope defined in §6.
5. **No telecom-layer silent/Flash SMS is assumed.** Critical alerts use the Semaphore priority path plus the app's notification/overlay. Background coordinate beacons are ordinary authenticated SMS parsed by the trusted local ingestion service.
6. **RBAC and object ownership are enforced server-side.** Client-side hiding is UX only. Every protected endpoint verifies role, tenant, and object-specific ownership before returning or mutating data.
7. **No public internet exposure to this system's own inbound services, ever.** MariaDB, the backend, the web dashboard, local AI inference, OSRM, and GSM ingestion accept connections only from the trusted local environment — LAN/localhost, enforced by network placement and CORS configuration, not merely assumed. *(A violation of this — a public tunnel in front of the API — was found and is an open P0; see `docs/AUDIT_2026-09-07.md` F1.)* This does **not** mean the workstation has no internet dependency at all: FCM and Semaphore are both outbound calls to cloud services and need the workstation to have internet access for those two transports specifically. When it doesn't, health reports `not_configured`/`unhealthy` per §6 and alerting degrades to the GSM/local paths — a known degradation, not a silent failure. Mobile capture continues in its encrypted cache regardless. Recovery/restart requirements are in §11.
8. **The four barangays are isolated tenants.** Authenticated callers are permanently scoped to the `barangay_id` in their session. Every endpoint that accepts or resolves a tenant/resource enforces the same boundary, including all `/:id` routes. A public citizen report is the only pre-auth flow that may select one of the four barangays.
9. **Authentication/session lifecycle.** Argon2id passwords. JWTs expire in 15 minutes, carry a unique `jti` mapped to one `auth_session`. Every authenticated request verifies signature, algorithm, expiry, session existence/revocation, user activation state, and tenant identity. Sliding renewal may extend a still-valid session with a non-decreasing expiry. **Failed-login lockout: 5 attempts within a rolling window locks the account for 15 minutes**, and the failure response is externally indistinguishable for unknown-user, wrong-password, and locked-account cases. Logout revokes the current session; deactivation/password reset revoke active sessions per §6. Expired/revoked sessions are purged after 90 days.
10. **Administrative bootstrap is one-time and deterministic.** The four barangay IDs are fixed in the baseline migration. The first Admin per barangay is created only by the interactive trusted CLI bootstrap. No password ever appears in source, migrations, seeds, logs, or UI. No self-registration for privileged roles.
11. **Retention has an operational track and an evidence/audit track** — full table in §11. Legal hold is the intended universal exception; backups are included in retention/deletion controls.
12. **Notifications are logical notifications plus delivery attempts.** FCM and SMS are transport channels; one logical notification can have multiple delivery attempts. If no active FCM registration exists, SMS is used immediately. If an FCM attempt errors/times out, retry once, then SMS on the second failure. An FCM success with no client ack within 60s records `ack_timeout` — this does not automatically trigger SMS. The app renders a critical alert from local cache when the local API is unreachable.
13. **SMS-originated duty changes are first-class.** `duty_status.channel = "sms"` is written only by the validated internal SMS handler; sender identity is derived server-side from a registered device mapping, never from a client-supplied user ID.
14. **Offline maps are part of the offline-first guarantee.** Each approved device has a versioned encrypted basemap package, published per barangay. Route computation needs workstation connectivity; the last successfully received route stays usable offline.
15. **The unified workstation is an infrastructure single point of failure.** If DB/API/OSRM/Ollama/GSM are unavailable, mobile preserves locally capturable work where the feature contract allows it. AI jobs queue; no external AI fallback exists under any failure mode.
16. **AI pipeline is ordered and versioned.** Raw → redaction draft → summary derived from the draft (never raw) → Secretary review → approval. Translation is a separate post-approval job against approved text only. Every run records model version, status, and the draft version it operated on. Bikol is unvalidated until empirical testing.
17. **Administrative actions are auditable**, allow-listed to identifiers/statuses only — never raw narrative or credentials.
18. **Mobile read access is least-privilege.** Tanods read their own dispatches, own duty history, own submitted incidents, and nearby redacted markers. Cached data carries the same tenant/ownership restrictions as live responses.
19. **Cloud deployment is deferred.** No cloud database, backend, storage, or cloud AI is in scope.
20. **Incident priority is server-controlled.** `normal|high|critical`, client input cannot self-promote, default `normal`.
21. **Incident and dispatch state machines are explicit.** Incident: `pending → dispatched → resolved`, with `dispatched → pending` only via valid cancellation before arrival. Dispatch: `assigned → en_route → arrived → completed`, with `assigned/en_route → cancelled`. No backward/skipped transition through the ordinary status endpoint. Incident resolution requires no active dispatch remains, **and only a `dispatched` incident may be resolved** — `pending` (nothing to conclude) and an already-`resolved` repeat are both `409`. That gating is what makes `PATCH /incidents/:id/status` safe without an `Idempotency-Key`: a double submit finds no resolvable incident and so cannot write a second audit row. *(The former exception here — walk-in blotter entries born `resolved` — is gone with `POST /blotter`, removed 2026-09-10; see §6. The `source` discriminator idea it motivated survives in `docs/REMAINING.md` §G4 for the `avg_response_time_minutes` fix.)*
22. **Internal GSM ingestion is local-only.** A tethered GSM phone/modem feeds a local ingestion service. Inbound SMS is authenticated, deduplicated, size-limited, decrypted/verified, parsed, then passed to internal handlers over loopback or an equally protected boundary. *(§6's SMS section separates these genuinely-inbound handlers from the outbound sends the backend itself triggers — the two were conflated in an earlier draft; see §6.)*
23. **AI draft edits use optimistic concurrency.** Every active draft has a `draft_version`; editing/regenerating increments it; approval must match the exact current version or gets `409`.
24. **Notification delivery has separate logical and transport records.** A reliability metric's definition (end-to-end vs. transport-specific) must be explicit; ack timeout never silently changes delivery truth.
25. **Public reports and evidence have explicit retention** (§11); converted reports follow the linked incident's clock. Evidence retains independently until its own deadline or legal hold.
26. **Device secrets are protected** — FCM tokens, local DB keys, message-encryption keys, device-registration secrets never appear in ordinary API payloads, audit logs, debug logs, or UI.
27. **Tanod SOS is a dedicated immediate channel**, never dependent on incident dispatch triage — creates a persistent record, alerts Admin and eligible on-duty Tanods. **Two fallback tiers exist today** — app (needs the local API) and SMS (needs the local GSM ingestion service) — and both terminate on the same unified workstation Rule 15 already names as a single point of failure, so **neither survives a total workstation/power outage**. This is a real, currently-unmitigated residual risk, not a solved one. The honest fix, not yet built: a third tier that never touches the workstation — the mobile app sends a native-OS SMS (the device's own SIM, no gateway) directly to a configured backup contact when both other paths are confirmed unreachable.
28. **Dispatch cancellation is non-destructive.** A cancelled dispatch is retained as history; its incident returns to `pending` only when the cancellation transaction confirms the dispatch was `assigned` or `en_route`.
29. **Idempotency is required for retriable writes** — incident creation, `/sync/batch`, dispatch/SOS creation, citizen-report conversion, device registration, evidence upload, and any internally-retried transport use a stable client/correlation key.
30. **All protected resource lookups are transaction-safe** — row locking/optimistic concurrency for dispatch state, citizen conversion, swaps, AI drafts, retention. Never authorize an object using stale tenant/ownership data.
31. **Time policy is explicit.** Persist UTC; operational shift times interpret Asia/Manila. Client timestamps are informational, never authoritative, never bypass session expiry or retention.
32. **Production recovery is part of correctness.** Backups, restore verification, migration rollback strategy, health checks, and restart procedures are required before UAT.

---

## 3. Roles

Four active login roles: `admin`, `secretary`, `tanod`, `punong_barangay`.
`lupon` stays in the DB enum for historical/attribution reasons only.

| Role | Who | Primary responsibility |
|---|---|---|
| Admin | IT/system administrator | Full operational control — user mgmt, scheduling, live dispatch, GPS oversight, incident status — own barangay only |
| Secretary | Barangay Secretary | Blotter mgmt, PII redaction approval (RA 10173 gate), blotter finalization, BIMSS/KPIS handoff drafting |
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
access, redaction approval, and blotter finalization — a
records-custodian mandate, not an executive one, so it doesn't extend to
user management or scheduling.

**Lupon has no system login.** Lupon members are appointed mediators, not
staff with their own records office. Lupon receives case materials as a
Secretary-generated printed packet for one referred dispute
(`POST /incidents/:id/lupon-packet`), never a standing account.

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
│                 /services(/sms /ai /sync) /config /migrations
├── /web        → /src(/pages /components /styles /api)
├── /mobile     → Ionic/Capacitor app
├── /docs       → this file, the compact reference, audits
└── /eval-kit   → standalone AI-evaluation package for a friend's
                  machine (2026-09-07) — not served, not part of the app
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

**`incident`** — `incident_id` PK · `barangay_id` FK RESTRICT · `reported_by` FK SET NULL · `device_id` FK SET NULL · `incident_type` ENUM('theft','physical_injury','disturbance','domestic_dispute','vandalism','traffic_incident','fire','medical_emergency','missing_person','animal_complaint','other') · `priority` ENUM('normal','high','critical') DEFAULT 'normal' · `raw_narrative` TEXT NULL *(NULLable since 0007, for post-retention purge)* · `redacted_narrative` TEXT NULL · `redaction_approved_by`/`redaction_approved_at` NULL · `status` ENUM('pending','dispatched','resolved') DEFAULT 'pending' · `source` ENUM('app','sms','web') · `location_description` VARCHAR(255) NULL *(0010)* · `complainant_name`, `respondent_name` VARCHAR(255) NULL, `complainant_contact_number` VARCHAR(32) NULL *(0008 — extracted from RAW narrative, so these carry `raw_narrative`'s Secretary-only protection, not the broader "approved and shareable" treatment `redacted_narrative` gets)* · `display_id` VARCHAR(20) NULL *(0014, `INC-YYYY-NNN`, new rows only — not backfilled)* · `latitude`/`longitude` DECIMAL(10,7) NULL · `created_at`, `updated_at`, `device_offline_created_at` NULL, `synced_at` NULL · `client_event_id` CHAR(36) NULL · UNIQUE(`device_id`,`client_event_id`). `redaction_approved_at IS NOT NULL` is the approval signal.

**`dispatch`** — `dispatch_id` PK · `incident_id` FK RESTRICT · `dispatched_by`, `tanod_id` FK RESTRICT · `priority` ENUM(same as incident) · `route_json` JSON NULL · `route_status` ENUM('available','unavailable','stale') DEFAULT 'unavailable' · `status` ENUM('assigned','en_route','arrived','completed','cancelled') DEFAULT 'assigned' · `dispatched_at`, `en_route_at`, `arrived_at`, `completed_at`, `cancelled_at` NULL · `cancelled_by` FK SET NULL · `created_client_request_id` CHAR(36) UNIQUE. At most one active dispatch (`assigned`/`en_route`/`arrived`) per incident, enforced transactionally.

**`evidence_attachment`** — `attachment_id` PK · `incident_id` FK RESTRICT · `type` ENUM('photo','voice') · `file_path` VARCHAR(512) (outside web root) · `uploaded_by` FK RESTRICT · `uploaded_at` · `sha256` CHAR(64) · `byte_size`, `mime_type`, `original_filename` · `retention_expires_at` NULL · `legal_hold` BOOLEAN DEFAULT FALSE · `client_request_id` CHAR(36) NULL UNIQUE. **No server-side writer exists for this table as of 2026-09-07** — see `docs/AUDIT_2026-09-07.md` F4; the schema is real, the upload endpoint is not.

**`blotter_record`** — `blotter_id` PK · `incident_id` FK RESTRICT UNIQUE · `barangay_id` FK RESTRICT · `recorded_by` FK RESTRICT · `approved_by` FK SET NULL · `narrative_summary` TEXT · `finalized_at` NULL · `revision_no` INT UNSIGNED DEFAULT 1 · `amended_at`, `amended_by` NULL · `case_status` ENUM('active','under_investigation','settled','resolved') DEFAULT 'active' *(0009 — forward-only past `active`; `resolved` is set only by a linked incident status change, never a manual amend)* · `complainant_name`, `respondent_name`, `complainant_contact_number` (0008, same fields as `incident`, **shared with Admin/PB once finalized** — narrower protection than `raw_narrative`, since a finalized record is the legal ledger) · `display_id` VARCHAR(20) NULL *(0014, `BLT-YYYY-NNN`)*. Once finalized, overwrite is forbidden; amendment is explicit and audited into `blotter_revision`.

**`blotter_revision`** *(0004 — a real table, undocumented until this rewrite)* — `revision_id` PK · `blotter_id` FK RESTRICT · `revision_no` INT UNSIGNED · `narrative_summary` TEXT · `reason` VARCHAR(1000) NULL · `amended_by` FK SET NULL · `superseded_at` DATETIME · `case_status` (0009) and the three party fields (0008) also carried per-revision · UNIQUE(`blotter_id`,`revision_no`). One row per superseded version — `blotter_record` holds only the current values.

**`citizen_report`** — `report_id` PK · `barangay_id` FK RESTRICT · `incident_id` FK SET NULL UNIQUE · `contact_number` VARCHAR(32) NULL · `description` TEXT · `latitude`/`longitude` NULL · `submitted_at` · `converted_at` NULL · `retention_expires_at` NULL · `legal_hold` BOOLEAN DEFAULT FALSE. Conversion locks the row, permits exactly one incident linkage. **Unauthenticated intake — `description`/`contact_number` are the head of an open stored-XSS chain**, see `docs/AUDIT_2026-09-07.md` F2/F3.

**`sms_log`** — `log_id` PK · `report_id`/`incident_id`/`dispatch_id` FK SET NULL · `sender_number`, `receiver_number` NULL · `transport` ENUM('gsm_modem','semaphore') · `message_type` ENUM('incident','dispatch','priority_alert','coord_ping','confirmation','duty_status','sos','manual') *(0013 adds `manual`)* · `direction` ENUM('inbound','outbound') · `gateway_message_id`, `modem_message_id`, `correlation_id` NULL · `status` ENUM('queued','pending','sent','failed','refunded','received','rejected','deduplicated') · `sent_at`, `received_at` NULL · `failure_reason` NULL · `barangay_id` FK *(0006)* · `message_body` TEXT NULL, `read_at` DATETIME NULL *(0013)* · `created_at`. Phone numbers masked in UI. **Known gap: no `legal_hold` column** — retention (§11) currently purges this table on a flat 1-year clock regardless of a hold on the linked incident/dispatch; the target rule (§11) says it should inherit the hold, but the column doesn't exist yet.

**`ai_processing_log`** — `log_id` PK · `incident_id` FK RESTRICT, **NULLable since 0015** *(the two non-incident AI Tools jobs, `sms_compose`/`threat_analysis`, have no parent case; nullability does NOT disturb `purgeOneIncident()`'s ordered cascade, since RESTRICT still applies to every non-null value)* · `barangay_id` FK RESTRICT NULL *(0015 — with `incident_id` NULL this is the ONLY thing scoping a job to a tenant, which §2 Rule 2 requires)* · `requested_by_user_id` FK SET NULL *(0015)* · `tool_input`, `tool_output` TEXT NULL *(0015)* · `pipeline_run_id` CHAR(36) · `task_type` ENUM('summarization','redaction','translation','extraction','blotter_assist','classification','sms_compose','threat_analysis') *(0008 adds `extraction`; 0015 adds the four AI Tools types)* · `model_version` VARCHAR(128) · `source_language`/`target_language` NULL · `draft_redacted_narrative`, `draft_summary` TEXT NULL · `draft_summary_stale` BOOLEAN DEFAULT FALSE · `draft_version` INT UNSIGNED DEFAULT 1 · `draft_complainant_name`, `draft_respondent_name` VARCHAR(255) NULL, `draft_complainant_contact_number` VARCHAR(32) NULL *(0008 — the extraction task's own draft state, approved independently of redaction via `ai-draft/extraction/approve`)* · `translated_text` TEXT NULL · `status` ENUM('queued','processing','completed','failed','superseded') · `error_code` NULL · `processed_at` NULL · `created_at`. One current redaction/summary row per incident; translation, extraction and AI Tools rows are independent (an operator may generate several drafts and compare them, so a tool run neither supersedes nor is superseded). **The "incident tasks carry `incident_id`, tool tasks carry `barangay_id`" invariant is enforced in PHP, not as a table CHECK** — MariaDB 10.4 rejects that shape of constraint with ERROR 1901, as `notification`'s entity matrix already documents.

**`ai_evaluation_run`** — `evaluation_run_id` PK · `dataset_name`, `dataset_version`, `model_version`, `task_type` · `sample_count` · `precision_score`, `recall_score` DECIMAL(6,5) NULL · `created_at` · `notes` TEXT NULL · UNIQUE(`dataset_name`,`dataset_version`,`model_version`,`task_type`).

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
- `GET /incidents/:id` — Secretary gets `raw_narrative` + the three party fields (Secretary-only, same protection as raw narrative — §2 Rule 1); everyone else gets the allow-listed redacted view.
- `PATCH /incidents/:id` *(new, 2026-09-06)* — **operational correction, not a narrative editor.** Admin+Secretary may set `priority`/`incident_type`/`location_description`; `complainant_name` is **Secretary-only**. Sending `raw_narrative`/`redacted_narrative` is a hard `400`. Requires `Idempotency-Key` — **but does not actually replay on it** (validates and discards); every sibling write replays for real. Audit records field *names* only, never values.
- `PATCH /incidents/:id/status` — Admin only, body `{status:"resolved"}`, requires no active dispatch remains. Also flips a linked finalized blotter's `case_status` to `resolved` (non-destructive, audited).
- `POST /incidents/:id/evidence` / `GET /incidents/:id/evidence` — **documented, not implemented.** No POST route exists server-side; `GET` is real but permanently empty. See `docs/AUDIT_2026-09-07.md` F4.
- `GET /incidents/nearby` — Tanod only, radius-capped, never raw narrative/contact data.

### AI processing

- `GET /incidents/:id/ai-draft` — Secretary only.
- `POST /incidents/:id/redact` — Secretary trigger/rerun; enqueues only, never calls Ollama directly — a structural guarantee, not just a convention: the only `OllamaClient` uses in `AiDraftController` are `isConfigured()`/`model()`, never `generate()`.
- `POST /incidents/:id/ai-draft/regenerate-summary` — requires matching `draft_version`, summary generated from supplied draft text only, increments version.
- `POST /incidents/:id/ai-draft/approve` — requires current version, `status=completed`, `draft_summary_stale=false`, exact text match. The **only** endpoint that may commit `incident.redacted_narrative`.
- `POST /incidents/:id/ai-draft/translate` — requires approved redaction, runs against approved text only.
- `GET /incidents/:id/ai-draft/extraction` / `POST .../extraction/approve` *(0008)* — the party-field pipeline (complainant/respondent/contact extracted from raw narrative), independent of redaction/approval, same draft-versioning discipline. Extraction output is Secretary-only, same as `raw_narrative`.

### Blotter

- `POST /incidents/:id/finalize` — Secretary only, requires approved redaction, creates/finalizes the blotter record.
- `POST /incidents/:id/blotter/amend` — Secretary only, requires finalized record, writes a `blotter_revision` row, increments `revision_no`, optionally transitions `case_status` (forward-only past `active`).
- `GET /blotter/:id`, `GET /incidents/:id/blotter` — same-barangay; Tanod additionally needs reporter/assignment relationship.
- `GET /blotter?q=&status=&case_status=` — list, Admin/Secretary/PB(redacted read-only).
- ~~`POST /blotter` — walk-in entry~~ **REMOVED 2026-09-10.** DILG BIMSS is mandated for all barangays by Memorandum Circular, and its **KPIS** subsystem already *is* the Katarungang Pambarangay case database; a walk-in complaint with no prior incident is precisely a native KPIS case. §1 makes Baranguard a complement to BIMSS, never a replacement, so a second intake path for the same record was liability rather than capability. Its removal also closed two known defects outright instead of fixing them: the `200 []` idempotency mismatch, and the fact that this was the one path where `raw_narrative` content reached Admin/PB with no redaction step. `GET /blotter` remains (Analytics' case-status widget consumes it); finalize/amend/lupon-packet remain, because those are incident-originated and BIMSS has no dispatch layer to feed them.

### AI Tools *(new, 2026-09-10 — migration 0015)*

Four local-model **drafting aids**, surfaced inside their host screens rather than on an AI screen of their own (§9). None writes a record: each enqueues an `ai_processing_log` row whose `tool_output` a human reads and retypes elsewhere. §2 Rule 4 still makes `ai-draft/approve` the only writer of `incident.redacted_narrative`, and nothing here touches it. The API never calls Ollama (§2 Rule 15) — these enqueue, and the screen polls.

- `POST /incidents/:id/ai-tools/blotter-assist` — **Secretary only.** Reads `raw_narrative` and redacts as it drafts; the output is the formal case text a Secretary re-keys into BIMSS/KPIS. Secretary-only because §2 Rule 1 makes the Secretary raw narrative's sole reader.
- `POST /incidents/:id/ai-tools/classify` — **Admin + Secretary.** Suggests `incident_type` and `priority`. Reads only the **approved** `redacted_narrative` — that restriction is exactly what makes the tool safe to expose to an Admin. `409` when no approved redaction exists; rechecked again by the worker at write time (§2 Rule 30).
- `POST /ai-tools/sms-compose` — **Admin only**, matching `/sms/send` so the tool cannot draft what its caller may not send. Body `{prompt}` (≤2000 chars) is operator-typed text and the **only** input: the draft is bound for Semaphore, an external channel, and §2 Rule 1 does not permit narrative text to leave that way. There is deliberately no incident parameter.
- `POST /ai-tools/threat-analysis` — **Admin + Punong Barangay.** Aggregate counts only, always the caller's own barangay resolved server-side, never client-supplied. Groups by incident type, time of day and day of week; `location_description` is deliberately excluded as free text an intake officer typed and therefore identifying in practice. Day bucketing uses a fixed `+08:00` offset, never `CONVERT_TZ()` (§2 Rule 11).
- `GET /ai-tools/jobs/:id` — poll one job. **Owner-scoped as well as tenant-scoped:** an Admin may not poll a Secretary's blotter-assist job, since that job's output derives from raw narrative. `404`, never `403`.
- `GET /ai-tools/availability` — `{ollama: healthy|unhealthy|not_configured}`. Same coarse contract as `/system/health`'s `ollama` field and reusing the same probe, but readable by all three roles this screen serves (`/system/health` is Admin-only). It exists so the screen can disable Generate honestly rather than queue work nothing can run (§2 Rule 6).
- `POST /incidents/:id/lupon-packet` (+`/download`) — Secretary only, requires approved redaction **and** finalized blotter.

### Dispatch

- `POST /dispatch` — Admin only, `request_id` idempotency key, validates same-barangay/active/on-duty Tanod, no conflicting active dispatch, incident `pending`. OSRM failure doesn't roll back dispatch creation (`route_status="unavailable"`).
- `GET /dispatch`, `GET /dispatch/:id` — tenant/ownership scoped as in §7.
- `PATCH /dispatch/:id/status` — Tanod own assigned dispatch, or Admin override with required `override_reason`. Forward-only transitions.
- `PATCH /dispatch/:id/cancel` — Admin only, only `assigned`/`en_route`, reverts incident to `pending`.

### GPS / SOS / duty / system health / reference

- `POST /gps`, `GET /gps/live`, `GET /gps/history` — as in §5's `gps_track`; `is_stale=true` at ≥120s without a fresh point.
- `POST /tanod-sos`, `GET /tanod-sos`, `PATCH .../acknowledge`, `PATCH .../resolve` — see §2 Rule 27 for the fallback-tier caveat.
- `POST /duty-status`, `GET /duty-status` — server always writes `channel=app` for this path (SMS-originated duty changes come in via §6's internal SMS handlers, `channel=sms`).
- `GET /system/health` — Admin only, local-only. `{api,db,osrm,ollama,gsm_ingestion,notification_config,backup_last_success,restore_test_at}`, each `healthy|unhealthy|not_configured`. Never fabricated — `backup_last_success` reads a real file timestamp or `null`.
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
- **Outbound triggers** — the backend's own dispatch/notification services call these to *send* an SMS via Semaphore (or the GSM modem): `POST /sms/dispatch-payload`, `/sms/priority-alert`. These create/update a logical notification + delivery attempt; they are not something the ingestion service calls after receiving a message.
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
| **Incidents & Blotter** |
| Log incident (mobile) | ✗ | ✗ | ✓ | ✗ | — |
| Web incident entry / operational correction (`PATCH`) | ✓ | ✓ (+ `complainant_name`) | ✗ | ✗ | — |
| ~~Walk-in blotter entry~~ *(removed 2026-09-10 — BIMSS/KPIS owns it)* | — | — | — | — | — |
| AI Blotter Assistant (BIMSS/KPIS handoff draft) | ✗ | ✓ | ✗ | ✗ | — |
| AI Incident Classifier | ✓ | ✓ | ✗ | ✗ | — |
| AI SMS Composer | ✓ | ✗ | ✗ | ✗ | — |
| AI Threat Analyzer | ✓ | ✗ | ✗ | ✓ | — |
| Convert citizen report → incident | ✓ | ✓ | ✗ | ✗ | — |
| View raw narrative / extracted party fields | ✗ | ✓ | ✗ | ✗ | — |
| View approved redacted narrative | ✓ | ✓ | own/assigned | R | packet only |
| Trigger/approve AI redaction or extraction | ✗ | ✓ | ✗ | ✗ | — |
| Resolve incident status | ✓ | ✗ | ✗ | ✗ | — |
| Finalize / amend blotter | ✗ | ✓ | ✗ | ✗ | — |
| View blotter (finalized fields incl. party names) | ✓ | ✓ | own/assigned | R | — |
| Generate Lupon packet | ✗ | ✓ | ✗ | ✗ | — |
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
"MOCK DATA" label; no confidence/score number without a real
`ai_evaluation_run` behind it; no "All Systems Operational" badge that
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
route key)* (server-redacted excerpt, real `case_status`/`display_id`,
forward-only transition control; **+AI Blotter Assistant** panel,
Secretary-only, 2026-09-10) · **AI assistants embedded in host screens**
*(2026-09-10 — a standalone AI Tools screen shipped and was dissolved the
same day. Each tool is a `components/AiToolPanel.js` mounted where its
work happens: Classifier in Incident Management's detail pane with
"Apply in Edit" prefilling the Edit form — which gained the Incident Type
select `PATCH /incidents/:id` always accepted; Message Composer at the
top of SMS Monitor's feed pane with "Use this draft" filling the compose
box and no send button; Threat Analyzer as Analytics' third tab with an
explicit non-forecast label; Blotter Assistant in incident detail. All
poll, all render a probe-driven unavailable banner, all `textContent`
only. Hosts must call the panel's `stop()` before wiping its DOM.)* ·
W8 AI Redaction Review (Secretary only, real
`draft_version`/model version, never a scripted string) · W9 Statistical
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
- **AI incident auto-classifier / threat-risk scorer** — needs a real scoring design and an `ai_evaluation_run` behind any confidence number; never adopt an illustrative demo percentage as a target.
- **A composite "performance score" chart** — needs a defined scoring formula with the same rigor as `avg_response_time_minutes`'s exact definition.
- **A public marketing landing page** — this is a specific system for four named barangays, not a SaaS product; W19 is the real public entry point. If a public informational page is wanted, keep it a short honest description with a link to W19, never a metrics-driven marketing page.
- **Voice-to-text transcription** (voice *capture* is in scope and built) — would either route audio off-device (violates Rule 1) or require a second self-hosted ASR model alongside SEA-LION on the same single-point-of-failure workstation (Rule 15). If ever revisited: a self-hosted ASR model as a second queued `ai_processing_log` task type, never a cloud speech API.

---

## 11. Retention

| Record | Retention | Notes |
|---|---|---|
| `raw_narrative` | Deleted 30 days after human-approved redaction; 90-day hard ceiling if never approved | Legal hold is the only exception |
| Redacted incident / blotter / evidence | 7 years default | LGU records schedule or legal hold may override |
| `citizen_report` (unconverted) | 1 year from `submitted_at` | Converted reports follow the linked incident's clock |
| `audit_log` | 7 years, write-once except retention deletion | |
| `sms_log` | 1 year default | **Target rule: extended for the duration of any hold on the linked incident/dispatch/citizen report — not currently enforceable, no `legal_hold` column exists on this table yet** (§5 gap) |
| `ai_processing_log` | 1 year, or until the linked incident's retention expires, whichever is longer | |
| AI Tools jobs (`incident_id IS NULL`) | **90 days** from `created_at` | 0015. Needs its own rule because the row above INNER JOINs `incident` and so cannot see these; scoped by "has no parent", not by task type, so `blotter_assist`/`classification` keep following their case. User-signed-off per Rule 10. |
| `mobile_device` / device secrets | Secret columns (`fcm_token`, `device_secret_ref`) cleared 90 days after deactivation | **Target rule, revised from the original "delete the row": the row itself is retained, not deleted, so `incident.device_id` provenance survives on records under longer retention or legal hold** — deleting the row was found to silently strip device attribution from 7-year legal records via `ON DELETE SET NULL`, 90 days after deactivation |
| Offline mirror (`offline_queue`, mobile local tables) | Cleared on confirmed sync | No independent raw-data ceiling; server mirror never holds raw payload |
| Backups | Follow the retention of the source data they contain | A deletion is not complete while a retained backup still holds the same data |

**Pre-UAT exit conditions:** executable schema matches §5 · every §6 endpoint's documented response shape and authorization rule matches the implementation · tenant penetration tests pass · offline duplicate tests pass · critical notification/SOS fallback tests pass · restore test passes · no unresolved P0/P1 contradictions. **As of 2026-09-07, the second and fourth conditions are failing** — see `docs/REMAINING.md` §F.

Recovery baseline: daily encrypted local backup, documented retention,
periodic restore verification, tested restart procedure. Backups are
recovery copies, not an independent archive.

---

*Document status: this file is reconciled against shipped code as of
migration 0014. For what's currently broken in the running system (not
in this document), see `docs/REMAINING.md` and `docs/AUDIT_2026-09-07.md`.
For day-to-day session state, see `docs/HANDOFF.md`. Historical sprint
prompts and the full prompt-engineering scaffolding once carried here now
live in `docs/Baranguard_Sprint_Prompts.md`/`docs/SPRINTS.md` and
`backend/DEVLOG.md` respectively — kept out of this file so it stays a
technical reference, not a process log.*
