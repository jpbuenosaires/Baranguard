# Baranguard — API Contract

Defined before either web or mobile is built, so both sides code against the
same contract instead of drifting apart. Base URL placeholder: `/api/v1`.

Auth: all endpoints except `/auth/login` require `Authorization: Bearer <token>`.
Role restrictions noted per endpoint, enforced server-side (never trust
client-side role checks alone).

---

## Auth

### `POST /auth/login`
```
body: { username, password }
returns: { token, user: { user_id, full_name, role, barangay_id } }
```

### `POST /auth/logout`
```
returns: { success: true }
```

---

## Users & Roles

### `GET /users?barangay_id=&role=`
Roles allowed: admin, dispatcher
```
returns: [{ user_id, full_name, role, contact_number, is_active }]
```

### `POST /users`
Roles allowed: admin
```
body: { barangay_id, username, password, full_name, role, contact_number }
returns: { user_id }
```

### `PATCH /users/:id`
Roles allowed: admin (or self, limited fields)
```
body: { full_name?, contact_number?, is_active? }
returns: { success: true }
```

---

## Incidents (Electronic Blotter)

### `POST /incidents`
Roles allowed: tanod (mobile), secretary/dispatcher (web, citizen intake)
```
body: {
  barangay_id, reported_by, incident_type,
  raw_narrative, latitude, longitude,
  source: "app" | "sms" | "web",
  device_offline_created_at?   // present if synced from offline queue
}
returns: { incident_id, status: "pending" }
```

### `GET /incidents?barangay_id=&status=&date_from=&date_to=&incident_type=`
Roles allowed: admin, dispatcher, secretary, lupon (redacted narrative only)
```
returns: [{
  incident_id, incident_type, status, source,
  narrative: redacted_narrative_if_available_else_null,
  latitude, longitude, created_at
}]
```
Note: `raw_narrative` is **never** returned in list views — only accessible
via the single-record endpoint below, and only to roles with clearance.

### `GET /incidents/:id`
Roles allowed: admin, secretary (full); dispatcher, lupon (redacted only)
```
returns: {
  incident_id, barangay_id, incident_type, status, source,
  raw_narrative,        // only included if requester role === 'secretary' or 'admin'
  redacted_narrative,
  ai_redacted, redaction_approved_by, redaction_approved_at,
  latitude, longitude, created_at, synced_at
}
```

### `PATCH /incidents/:id/status`
Roles allowed: dispatcher, admin
```
body: { status: "dispatched" | "resolved" }
returns: { success: true }
```

### `POST /incidents/:id/redact`
Roles allowed: system-triggered (auto on creation) or secretary (manual re-run)
```
Triggers SLM redaction + summarization pipeline.
returns: { incident_id, status: "queued" | "processing" }
```
See AI Processing section below for how the result is retrieved/approved.

### `POST /incidents/:id/evidence`
Roles allowed: tanod (mobile)
```
body: multipart/form-data { file, type: "photo" | "voice" }
returns: { attachment_id, uploaded_url }
```

---

## AI Processing (SLM Redaction & Summarization)

### `GET /incidents/:id/ai-draft`
Roles allowed: secretary
```
returns: {
  log_id, incident_id, task_type, model_version,
  draft_redacted_narrative, draft_summary,
  status: "completed" | "processing" | "failed"
}
```

### `POST /incidents/:id/ai-draft/approve`
Roles allowed: secretary only — this is the human-in-the-loop gate (§3.3.4)
```
body: { approved_narrative }  // secretary can edit before approving
returns: { success: true, incident: { redacted_narrative, ai_redacted: true,
  redaction_approved_by, redaction_approved_at } }
```
**Critical rule:** `incident.redacted_narrative` is NEVER written by the
`/redact` endpoint directly — only this approval endpoint commits it to the
permanent record. AI must not build a shortcut that skips this gate.

---

## Dispatch

### `POST /dispatch`
Roles allowed: dispatcher, admin
```
body: { incident_id, tanod_id }
returns: { dispatch_id, status: "assigned" }
```
Server-side: auto-generates `route_json` via routing service, and triggers
either push notification (if tanod app reachable) or SMS payload (fallback —
see SMS section).

### `GET /dispatch?status=&barangay_id=`
Roles allowed: admin, dispatcher
```
returns: [{ dispatch_id, incident_id, tanod_id, status, dispatched_at }]
```

### `PATCH /dispatch/:id/status`
Roles allowed: tanod (mobile, self only), dispatcher
```
body: { status: "en_route" | "arrived" | "completed" }
returns: { success: true }
```

---

## GPS Tracking

### `POST /gps`
Roles allowed: tanod (mobile)
```
body: { user_id, dispatch_id?, latitude, longitude, accuracy_m, recorded_at }
returns: { track_id }
```
Called on a regular interval (define ping frequency, e.g. every 15–30s while
on duty) plus immediately on dispatch assignment.

### `GET /gps/live?barangay_id=`
Roles allowed: admin, dispatcher
```
returns: [{ user_id, full_name, latitude, longitude, accuracy_m, recorded_at }]
```
Returns latest known position per active tanod — used for the live map (2.1).

### `GET /gps/history?user_id=&date_from=&date_to=`
Roles allowed: admin, dispatcher — used for heatmap generation (2.3)
```
returns: [{ latitude, longitude, recorded_at }]
```

---

## Duty Status

### `POST /duty-status`
Roles allowed: tanod (mobile)
```
body: { user_id, status: "on_duty" | "responding" | "off_duty", channel: "app" }
returns: { success: true }
```

### `GET /duty-status?barangay_id=`
Roles allowed: admin, dispatcher
```
returns: [{ user_id, full_name, status, changed_at }]
```

---

## SMS (Resiliency Layer)

These endpoints are internal/backend-triggered — mobile app doesn't call
Semaphore directly, it goes through your own backend so all SMS activity is
logged centrally in `sms_log`.

### `POST /sms/incident-fallback` *(internal — triggered by mobile when offline threshold reached)*
```
body: { encoded_payload }   // compact code representing incident data
Backend decodes, creates incident record with source: "sms", logs to sms_log
returns: { incident_id }
```

### `POST /sms/dispatch-payload` *(internal — triggered on dispatch when tanod unreachable via app)*
```
body: { dispatch_id, tanod_contact_number }
Sends via Semaphore /api/v4/messages, logs to sms_log
returns: { sms_log_id, status }
```

### `POST /sms/priority-alert` *(internal — critical alerts)*
```
body: { dispatch_id, tanod_contact_number, message }
Sends via Semaphore /api/v4/priority with #CRITICAL# tag prefix
returns: { sms_log_id, status }
```

### `POST /sms/coord-ping` *(internal — periodic background beacon, see backlog 4.2)*
```
body: { user_id, encoded_coordinates }
Sends via Semaphore /api/v4/messages, decoded server-side into gps_track
returns: { sms_log_id, status }
```

### `GET /sms/logs?date_from=&date_to=&status=`
Roles allowed: admin — used for Reliability metric (95% delivery acceptance criterion)
```
returns: [{ log_id, message_type, direction, status, sent_at }]
```

---

## Statistical Reports & Analytics

### `GET /reports/summary?barangay_id=&date_from=&date_to=`
Roles allowed: admin, dispatcher
```
returns: {
  total_incidents, resolved_count, avg_response_time_minutes,
  by_incident_type: [{ type, count }],
  by_status: [{ status, count }]
}
```

### `GET /reports/heatmap?barangay_id=&date_from=&date_to=`
Roles allowed: admin, dispatcher
```
returns: [{ latitude, longitude, weight }]   // weight = incident density for heatmap rendering
```

---

## Shift Scheduling *(approved scope addition)*

### `POST /shifts`
Roles allowed: admin
```
body: { barangay_id, user_id, patrol_zone, start_time, end_time }
returns: { shift_id }
```

### `GET /shifts?user_id=&barangay_id=&date_from=&date_to=`
Roles allowed: admin (all), tanod (self only)
```
returns: [{ shift_id, user_id, patrol_zone, start_time, end_time }]
```

### `POST /shifts/:id/swap-request`
Roles allowed: tanod
```
body: { target_user_id?, reason }
returns: { request_id, status: "pending" }
```

### `PATCH /shift-swap-requests/:id`
Roles allowed: admin
```
body: { status: "approved" | "denied" }
returns: { success: true }
```

### `GET /shifts/fatigue-flags?barangay_id=`
Roles allowed: admin
```
returns: [{ user_id, full_name, hours_worked_7day, flagged_at }]
```
Server-side: auto-computed whenever a new shift is created — checks rolling
7-day total against a **48-hour threshold**, adapted from the Labor Code's
general 8-hour/day working-hour standard (Art. 83) as a reasonable safety
benchmark. Note for your manuscript: tanods are honorarium-based barangay
personnel, not Labor Code employees, so no statutory rest-period rule
specifically applies to them — this threshold is used analogously for
field-safety purposes, not as a claimed legal requirement.

---

## Citizen Reports (Public-facing intake, if in scope)

### `POST /citizen-reports`
No auth required (public), but rate-limited server-side to prevent spam
```
body: { contact_number, description, latitude?, longitude? }
returns: { report_id, confirmation: "sms_sent" }
```
Triggers SMS confirmation receipt to the citizen automatically.

---

## Sync (Mobile Offline Reconciliation)

### `POST /sync/batch`
Roles allowed: tanod (mobile) — called automatically on reconnect
```
body: {
  device_id,
  incidents: [ {...incident_local records not yet synced...} ],
  gps_tracks: [ {...} ],
  duty_status_updates: [ {...} ],
  evidence_attachments: [ {...} ]
}
returns: {
  results: [
    { local_id, cloud_id, status: "success" | "duplicate" | "failed", reason? }
  ]
}
```
Process in `created_offline_at` order (oldest first). Server checks for
duplicate submissions (e.g. same device_id + local_id already synced) before
inserting — prevents double-counting if a sync retry occurs.

---

## Security Design Rationale (for RA 10173 / Chapter 3 Security evaluation)

The PII-handling rules already built into this contract (see `GET /incidents`
and `GET /incidents/:id` above) follow established API security practice,
not ad-hoc rules — cite this reasoning directly in your Security
characteristic evaluation and defense:

1. **Explicit field allow-listing, not full object exposure.** List endpoints
   (`GET /incidents`) never include `raw_narrative` — only single-record
   endpoints do, and only for roles cleared to see it. This follows the
   general API security principle that returning entire database objects by
   default leads to accidental sensitive-data exposure; the safer pattern is
   allow-listing exactly which fields each role/endpoint returns.

2. **Field-level (not just endpoint-level) authorization.** A dispatcher can
   call `GET /incidents/:id` but receives `redacted_narrative` only, never
   `raw_narrative` — authorization is checked per-field, not just per-route,
   consistent with the practice of enforcing authorization at both the
   endpoint and object/field level.

3. **Single-gate write path for redacted data.** Only `POST
   /incidents/:id/ai-draft/approve` (secretary role) can ever write to
   `incident.redacted_narrative`. No other endpoint — including the AI
   redaction trigger itself — has permission to write that field. This
   enforces least privilege and prevents the human-in-the-loop requirement
   (§3.3.4) from being bypassed by a shortcut in the code.

4. **PII minimization in logs.** `sms_log` and `ai_processing_log` store
   references/IDs and status values, not narrative content — logs should
   never contain raw PII, consistent with the practice of minimizing
   sensitive data in logs and redacting or tokenizing before ingestion.

5. **Role-based access enforced server-side.** Every endpoint above states
   its allowed roles; these checks must be implemented in backend middleware,
   never trusted from client-side role flags, since server-side enforcement
   is the only way to guarantee least-privilege access actually holds when
   the API is called directly.

When writing your Security section methodology (§3.3), reference these five
points as your API-level PII protection design, separate from and
complementary to the SLM redaction pipeline itself.

---

## Error Response Format (standardize across all endpoints)

```json
{
  "error": true,
  "code": "VALIDATION_ERROR" | "UNAUTHORIZED" | "NOT_FOUND" | "SERVER_ERROR",
  "message": "Human-readable explanation"
}
```

## Response Status Code Convention

| Code | Meaning |
|---|---|
| 200 | Success |
| 201 | Resource created |
| 400 | Validation error |
| 401 | Missing/invalid auth token |
| 403 | Authenticated but role not permitted |
| 404 | Resource not found |
| 409 | Conflict (e.g. duplicate sync record) |
| 500 | Server error |
