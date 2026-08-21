# Baranguard — Database Schema (Field-Level)

Based on your Appendix C ERD entities, expanded to field-level detail, plus
new tables required for the approved scope additions (shift swap, fatigue
flag) and features from your finalized backlog.

Paste this into `PROJECT_CONTEXT.md` so every AI session builds against the
same exact schema instead of inventing field names session to session.

---

## Cloud Database (MySQL 8.0) — System of Record

### `barangay`
| Field | Type | Notes |
|---|---|---|
| barangay_id | INT, PK, AUTO_INCREMENT | |
| name | VARCHAR(100) | e.g. "Dao" |
| municipality | VARCHAR(100) | "Pilar" |
| province | VARCHAR(100) | "Sorsogon" |
| population | INT | from PhilAtlas per manuscript |
| boundary_geojson | JSON | for GIS zone overlay |
| created_at | TIMESTAMP | default CURRENT_TIMESTAMP |

### `user`
| Field | Type | Notes |
|---|---|---|
| user_id | INT, PK, AUTO_INCREMENT | |
| barangay_id | INT, FK → barangay | |
| username | VARCHAR(50), UNIQUE | |
| password_hash | VARCHAR(255) | bcrypt/argon2, never plaintext |
| full_name | VARCHAR(150) | |
| role | ENUM('admin','dispatcher','secretary','tanod','punong_barangay','lupon') | drives RBAC |
| contact_number | VARCHAR(20) | PH format, used for SMS fallback |
| is_active | BOOLEAN | default true |
| created_at | TIMESTAMP | |

### `duty_status`
| Field | Type | Notes |
|---|---|---|
| status_id | INT, PK, AUTO_INCREMENT | |
| user_id | INT, FK → user | |
| status | ENUM('on_duty','responding','off_duty') | |
| channel | ENUM('app','sms') | how the toggle was received — for Reliability metric logging |
| changed_at | TIMESTAMP | |

### `gps_track`
| Field | Type | Notes |
|---|---|---|
| track_id | BIGINT, PK, AUTO_INCREMENT | |
| user_id | INT, FK → user | |
| dispatch_id | INT, FK → dispatch, NULLABLE | linked if actively responding |
| latitude | DECIMAL(10,7) | |
| longitude | DECIMAL(10,7) | |
| accuracy_m | FLOAT | GPS accuracy radius |
| recorded_at | TIMESTAMP | device-side timestamp |
| synced_at | TIMESTAMP, NULLABLE | server receipt time |

### `incident`
| Field | Type | Notes |
|---|---|---|
| incident_id | INT, PK, AUTO_INCREMENT | |
| barangay_id | INT, FK → barangay | |
| reported_by | INT, FK → user, NULLABLE | null if citizen-submitted |
| incident_type | VARCHAR(50) | e.g. Theft, Disturbance, Medical |
| raw_narrative | TEXT | original, unredacted — access restricted |
| redacted_narrative | TEXT, NULLABLE | filled after AI + human approval |
| ai_redacted | BOOLEAN | default false |
| redaction_approved_by | INT, FK → user, NULLABLE | must be role='secretary' |
| redaction_approved_at | TIMESTAMP, NULLABLE | |
| status | ENUM('pending','dispatched','resolved') | |
| source | ENUM('app','sms','web') | for reliability/testing analysis |
| latitude | DECIMAL(10,7) | |
| longitude | DECIMAL(10,7) | |
| created_at | TIMESTAMP | |
| synced_at | TIMESTAMP, NULLABLE | null while still only in local cache |

### `dispatch`
| Field | Type | Notes |
|---|---|---|
| dispatch_id | INT, PK, AUTO_INCREMENT | |
| incident_id | INT, FK → incident | |
| dispatcher_id | INT, FK → user | |
| tanod_id | INT, FK → user | |
| route_json | JSON, NULLABLE | routing polyline/waypoints |
| status | ENUM('assigned','en_route','arrived','completed') | |
| dispatched_at | TIMESTAMP | |
| completed_at | TIMESTAMP, NULLABLE | |

### `blotter_record`
| Field | Type | Notes |
|---|---|---|
| blotter_id | INT, PK, AUTO_INCREMENT | |
| incident_id | INT, FK → incident | |
| barangay_id | INT, FK → barangay | |
| recorded_by | INT, FK → user | |
| approved_by | INT, FK → user, NULLABLE | |
| narrative_summary | TEXT | AI-generated summary, post-redaction |
| finalized_at | TIMESTAMP, NULLABLE | null until secretary finalizes |

### `citizen_report`
| Field | Type | Notes |
|---|---|---|
| report_id | INT, PK, AUTO_INCREMENT | |
| incident_id | INT, FK → incident, NULLABLE | linked once processed into an incident |
| reporter_name_redacted | VARCHAR(150), NULLABLE | store redacted form only |
| contact_number | VARCHAR(20) | for SMS confirmation receipt |
| description | TEXT | |
| submitted_at | TIMESTAMP | |

### `sms_log`
| Field | Type | Notes |
|---|---|---|
| log_id | BIGINT, PK, AUTO_INCREMENT | |
| incident_id | INT, FK → incident, NULLABLE | |
| dispatch_id | INT, FK → dispatch, NULLABLE | |
| sender_number | VARCHAR(20) | |
| receiver_number | VARCHAR(20) | |
| message_type | ENUM('incident','dispatch','priority_alert','coord_ping','confirmation') | |
| direction | ENUM('inbound','outbound') | |
| gateway_message_id | VARCHAR(50), NULLABLE | Semaphore's message_id for tracing |
| status | ENUM('queued','pending','sent','failed','refunded') | mirrors Semaphore's status values |
| sent_at | TIMESTAMP | |

### `ai_processing_log`
| Field | Type | Notes |
|---|---|---|
| log_id | INT, PK, AUTO_INCREMENT | |
| incident_id | INT, FK → incident | |
| task_type | ENUM('summarization','redaction','translation') | |
| model_version | VARCHAR(50) | e.g. "Llama-SEA-LION-v3.5-8B-R" |
| precision_score | FLOAT, NULLABLE | filled during validation testing (Sprint 6) |
| recall_score | FLOAT, NULLABLE | |
| status | ENUM('queued','processing','completed','failed') | queued state used during full-blackout scenarios (§1.4.1) |
| processed_at | TIMESTAMP, NULLABLE | |

### `offline_queue` (cloud-side mirror, for audit/reconciliation)
| Field | Type | Notes |
|---|---|---|
| queue_id | BIGINT, PK, AUTO_INCREMENT | |
| device_id | VARCHAR(100) | identifies originating mobile device |
| payload_type | ENUM('incident','gps','duty_status','sms') | |
| payload_data | JSON | |
| created_offline_at | TIMESTAMP | device-side timestamp |
| synced_at | TIMESTAMP | server receipt time |

### `shift_schedule`
| Field | Type | Notes |
|---|---|---|
| shift_id | INT, PK, AUTO_INCREMENT | |
| barangay_id | INT, FK → barangay | |
| user_id | INT, FK → user | assigned tanod |
| patrol_zone | VARCHAR(100), NULLABLE | |
| start_time | DATETIME | |
| end_time | DATETIME | |
| created_by | INT, FK → user | |

### `shift_swap_request` *(new — approved scope addition)*
| Field | Type | Notes |
|---|---|---|
| request_id | INT, PK, AUTO_INCREMENT | |
| requesting_user_id | INT, FK → user | |
| shift_id | INT, FK → shift_schedule | |
| target_user_id | INT, FK → user, NULLABLE | proposed swap partner, if any |
| reason | TEXT, NULLABLE | |
| status | ENUM('pending','approved','denied') | |
| requested_at | TIMESTAMP | |
| resolved_at | TIMESTAMP, NULLABLE | |
| resolved_by | INT, FK → user, NULLABLE | |

### `fatigue_flag` *(new — approved scope addition)*
| Field | Type | Notes |
|---|---|---|
| flag_id | INT, PK, AUTO_INCREMENT | |
| user_id | INT, FK → user | |
| shift_id | INT, FK → shift_schedule | the shift that triggered the flag |
| hours_worked_7day | DECIMAL(5,2) | rolling 7-day total; flag inserted when this exceeds 48 hours (see API contract for rationale — analogous to Labor Code Art. 83 standard, not a statutory rule for tanods specifically) |
| flagged_at | TIMESTAMP | |
| acknowledged_by | INT, FK → user, NULLABLE | admin who reviewed the flag |

---

## Mobile Local Database (SQLite / Room) — Offline-First Cache

Mirrors the cloud schema for tables that must function fully offline, plus a
`synced` flag pattern on each. Keep field names **identical** to the cloud
schema (except PK naming) so sync logic doesn't need field-mapping code.

### `incident_local`
Same fields as `incident`, plus:
| Field | Type | Notes |
|---|---|---|
| local_id | INTEGER, PK, AUTOINCREMENT | device-local ID, separate from cloud incident_id |
| cloud_incident_id | INTEGER, NULLABLE | filled once synced |
| synced | BOOLEAN | default false |
| created_offline_at | TEXT (ISO8601) | |

### `gps_track_local`
Same as `gps_track`, plus `synced` boolean.

### `duty_status_local`
Same as `duty_status`, plus `synced` boolean.

### `evidence_attachment_local`
| Field | Type | Notes |
|---|---|---|
| attachment_id | INTEGER, PK, AUTOINCREMENT | |
| incident_local_id | INTEGER, FK → incident_local | |
| type | TEXT ('photo','voice') | |
| file_path | TEXT | local device path |
| synced | BOOLEAN | default false |
| uploaded_url | TEXT, NULLABLE | cloud storage URL once synced |

### `offline_queue_local`
| Field | Type | Notes |
|---|---|---|
| queue_id | INTEGER, PK, AUTOINCREMENT | |
| payload_type | TEXT | 'incident', 'gps', 'duty_status', 'sms' |
| payload_json | TEXT | serialized payload |
| created_offline_at | TEXT (ISO8601) | |
| sync_attempts | INTEGER | default 0, for retry/backoff logic |
| last_attempt_at | TEXT, NULLABLE | |

---

## Sync Logic Notes (for Sprint 3–4)

- On reconnect, process `offline_queue_local` in **created_offline_at order**
  (oldest first) to preserve chronological accuracy of the incident timeline.
- Each successful sync: mark `synced = true`, store returned `cloud_incident_id`,
  remove from active queue (or archive, don't hard-delete — useful for your
  Reliability metric evidence).
- Conflict rule: since incidents are field-captured (not typically edited by
  two parties simultaneously), use **last-write-wins is NOT safe** here —
  instead, cloud never overwrites a field-captured incident; it only accepts
  new records or status updates from dispatch (web side), which are a
  separate write path from the incident capture itself. Document this
  explicitly so AI doesn't build naive overwrite logic.
