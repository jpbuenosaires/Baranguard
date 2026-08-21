# Baranguard — Finalized Feature Backlog (AI Build Guide)

Use this file, alongside `PROJECT_CONTEXT.md` and your DB schema/API contract,
as the reference you paste into every AI coding session. Each feature has a
clear "done" test so both you and the AI know when it's actually finished.

⚠️ **Items flagged [VERIFY] must be confirmed technically feasible before
building** — see notes below the table.

---

## 1. Mobile Operations App (Tanods)

| # | Feature | Sprint | Acceptance test |
|---|---|---|---|
| 1.1 | Offline incident form (text, incident type, location) | 2 | Fill form + submit with WiFi/data OFF → record persists in local SQLite |
| 1.2 | Photo attachment on incident report | 2 | Attach photo offline → stored locally, uploads on reconnect |
| 1.3 | Voice note attachment on incident report | 2 | Record voice note offline → stored locally, uploads on reconnect |
| 1.4 | Auto-sync queued reports on reconnect | 3 | Queue 5 offline reports → reconnect → all 5 sync with zero duplication |
| 1.5 | Real-time GPS broadcast to command center | 3 | Tanod moves → live marker updates on web dashboard within [X] seconds |
| 1.6 | Receive dispatch assignment + route navigation | 3 | Dispatcher assigns incident → tanod app shows coordinates + route |
| 1.7 | Duty status toggle (On Duty / Responding / Off Duty) | 1–2 | Toggle updates instantly on dashboard when online |
| 1.8 | **[VERIFY]** Duty status → SMS fallback when offline | 4 | Define offline-detection trigger (see note below) → toggle sends SMS → dashboard reflects status |
| 1.9 | Shift schedule view (read-only) | ✅ *Approved scope addition* | Tanod can view assigned shifts |
| 1.10 | Shift swap / time-off request | ✅ *Approved scope addition* | Tanod submits request → appears in admin queue |

## 2. Web-Based Command Center

| # | Feature | Sprint | Acceptance test |
|---|---|---|---|
| 2.1 | GIS live map — responder markers | 1 | Map shows all active tanod locations, updates live |
| 2.2 | GIS live map — active incident markers | 1 | Map shows pending/active incidents with status color coding |
| 2.3 | Historical incident heatmap (non-predictive) | 1 | Heatmap renders from historical DB records only, filterable by date range |
| 2.4 | Statistical report generator | 1 | Generates counts by incident type / response time / date range, exportable |
| 2.5 | Drag-and-drop shift/roster scheduler | ✅ *Approved scope addition* | Admin can assign shift blocks per tanod via drag-drop UI |
| 2.6 | Fatigue/rest-period compliance flag | ✅ *Approved scope addition* | System flags tanods scheduled beyond rest-period threshold |
| 2.7 | Electronic blotter (record list + detail view) | 1 | View, search, filter incident records |
| 2.8 | Dispatch order creation | 1 | Admin/dispatcher assigns tanod to incident, sends order |

## 3. AI & Data Privacy Core

| # | Feature | Sprint | Acceptance test |
|---|---|---|---|
| 3.1 | SLM translation (Taglish/dialect → formal English summary) | 5–6 | Feed raw Taglish narrative → returns coherent English summary, no hallucinated facts |
| 3.2 | SLM PII detection + redaction (draft) | 6 | Run against 200-record synthetic set → recall ≥95%, precision ≥90% |
| 3.3 | Human-in-the-loop approval before permanent storage | 6–7 | AI draft redaction cannot be committed to permanent record without explicit secretary approval action |
| 3.4 | Baseline regex-only redaction filter (comparator) | 6 | Runs independently of SLM, used only for precision/recall benchmarking |
| 3.5 | Voice-to-text transcription pipeline (if voice notes feed into SLM) | 5–6 *(clarify: is this in scope?)* | Voice note → transcribed text → passed into 3.1 pipeline |

## 4. Resiliency & Connectivity Protocols

| # | Feature | Sprint | Acceptance test |
|---|---|---|---|
| 4.1 | Data-to-SMS parsing (offline incident → SMS → decoded to e-blotter) | 4 | Send incident via SMS in airplane mode → correctly parsed into DB record |
| 4.2 | ✅ *Resolved* — Background SMS coordinate beacon (renamed from "silent SMS ping") | 4 | Periodic regular SMS (not telecom Type-0/silent SMS — confirmed unsupported by any HTTP SMS gateway) containing compact coordinate code, sent via `/api/v4/messages` or `/priority`; parsed automatically by backend so dispatcher never sees raw text → coordinates update on dashboard during data-drop |
| 4.3 | SMS-triggered dispatch (web → SMS payload → mobile intercepts) | 4 | Dispatch order sent as SMS → mobile app receives, parses, triggers alert + routing without internet |
| 4.4 | ✅ *Resolved* — Priority critical alert (renamed from "Flash SMS Class 0") | 4 | Sent via Semaphore's `POST /api/v4/priority` endpoint with a reserved tag prefix (e.g. `#CRITICAL#`) in the message body — bypasses default queue, immediate send, not rate-limited. Mobile app uses a native SMS listener (Capacitor community SMS plugin) watching for the tag; on detection, triggers a full-screen overlay (Android `SHOW_WHEN_LOCKED` + `TURN_SCREEN_ON`), alarm-stream audio (bypasses silent mode, same mechanism as alarm-clock apps), and vibration — interruption is handled at the app layer, not the SMS protocol layer. Class 0/binary flash SMS confirmed unsupported by Semaphore or any comparable third-party gateway (requires direct SMSC access). |
| 4.5 | Tethered GSM modem phone setup | 4 | Physical phone registered to Semaphore, sends/receives independent of barangay hall broadband |

## 5. Evaluation Framework Hooks (build logging in as you go — don't bolt on later)

| # | Requirement | Sprint | What to instrument now |
|---|---|---|---|
| 5.1 | Performance Efficiency | 5–7 | Log sync latency, SLM inference time on unified workstation |
| 5.2 | Reliability | 3–4, 7 | Log SQLite cache success rate, SMS fallback delivery rate |
| 5.3 | Security | 7 | Log/audit PII exposure points, confirm no raw narrative leaves local env |
| 5.4 | Safety | 3, 4.3 | Verify GPS routing accuracy, dispatch alert delivery confirmation |
| 5.5 | Portability | 2, 7 | Test on 3+ Android device tiers (per your own Acceptance Criteria §3.3.4) |
| 5.6 | Flexibility | 7 | Confirm all API responses are valid JSON, eGIF v2.0 aligned |

---

## Resolved: Semaphore API capability check (verified against official docs, semaphore.co/docs)

Semaphore exposes exactly three send endpoints — nothing else exists:
- `POST /api/v4/messages` — regular/bulk SMS, up to 1,000 recipients per call, rate-limited to 120 calls/min
- `POST /api/v4/priority` — bypasses the default queue for immediate sending, 2 credits per 160-char SMS, not rate-limited
- `POST /api/v4/otp` — dedicated OTP-traffic lane, not rate-limited

**No Class 0 Flash SMS and no Type-0/silent SMS exist in this or any comparable
third-party gateway API** — these require direct SMSC (telco-level) access
that aggregators like Semaphore don't expose. This is a hard architectural
limit, not a documentation gap.

**Resolution applied to 4.2 and 4.4 above:** both features are still
buildable, just re-scoped to use the `/priority` endpoint for speed +
in-app (not telecom-layer) alert handling. Update your manuscript's Chapter
2/3 language if it currently implies telecom-layer Class 0 or silent SMS —
keep the technical claims accurate for your defense.

## Still to resolve

*(none — all items resolved, see below)*

## Resolved: Offline-detection trigger (1.8)

No single fixed "industry standard" exists for this threshold — it's
context-dependent. General mobile connectivity best practice favors short
timeouts, limited retries, and fast fallback rather than long waits before
declaring a device offline.

**Decision for Baranguard:** given the safety-critical, time-sensitive nature
of dispatch (unlike, say, a shopping app that can tolerate long waits), use
an aggressive threshold:

> **3 consecutive failed API health-check pings, 5-second timeout each,
> spaced 2 seconds apart → declare offline after ~21 seconds total, then
> immediately trigger SMS fallback.** Once offline, don't keep silently
> retrying on a long timer — check connectivity again on the next user
> action, plus a lightweight background ping every ~30 seconds, and revert
> to normal API mode as soon as one succeeds.

Rationale: 3 attempts avoids false positives from a single dropped packet
(common with barangay hall Wi-Fi); ~21 seconds total is fast enough not to
delay an emergency but slow enough not to trigger on momentary latency spikes.
Document this rationale in your manuscript as "adapted from standard mobile
connectivity handling practices (short timeout, limited retries, fast
fallback) for the safety-critical dispatch context."

## Approved

2. **Scope additions (1.9, 1.10, 2.5, 2.6 — shift portal, shift swap,
   drag-drop scheduler, fatigue flag):** Adviser-approved. Make sure Chapter
   1's Scope and Delimitations section is updated to reflect these before
   final defense, so manuscript and system stay aligned.

---

## Still needed before Sprint 0 (from previous planning session)

- [ ] Full DB schema, field-level (not just ERD entities)
- [ ] API contract (all endpoints, request/response shapes)
- [ ] Complete screen inventory (web + mobile)
- [ ] Role/permission matrix (Admin, Dispatcher, Secretary, Tanod)
- [ ] Architecture rules doc (non-negotiables, e.g. no raw PII leaves local env)
- [ ] Naming/folder conventions
