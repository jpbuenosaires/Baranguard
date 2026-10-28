# 03 - Messaging audit (2026-10-28)

Read-only audit. No source edited. Scope: SMS pipeline, message content, mobile and web notification UI, FCM delivery.
Paths are relative to the repo root. "Verified" = read in code (or confirmed by grep). "Suspected" = depends on runtime or device behavior I could not run. Nothing here was device- or browser-tested.

## Reading of "the messages are not good"

The ambiguity is real. The evidence points at three separate problems, in this order:

1. The Conversations screen can never show a message that someone SENT TO the system. Only outbound threads appear (P0-1).
2. The message text sent to Tanods is rough: raw enum names, coordinates only, no "last known" label (P1-6, P1-7).
3. Delivery status is overstated in the UI, and the delivery plumbing is fragile (P0-2, P1-1 to P1-5).

Ask the owner which one they mean.

## P0

### P0-1 Inbound human SMS is never stored, so Conversations and unread counts are dead (verified)
- `backend/services/sms/SmsGatewayService.php:300-315` (`logInbound`) is the only inbound `sms_log` writer. It never sets `sender_number`, and there is no `message_body` (the body is an encrypted envelope).
- `grep sender_number backend` shows only READS of that column. `InternalSmsController.php:38-44` documents an optional `sender_number`, but nothing reads it, and `gsm-ingest-daemon.php:221-241,290` posts only the raw body.
- `SmsController::conversations` (`:183-185`) keeps only rows where `COALESCE(sender_number, receiver_number)` is non-null. Every inbound row is therefore invisible, and `unread_count` (`:181`) is always 0.
- Free-text replies from citizens or Tanods fail the JSON check at `gsm-ingest-daemon.php:268-274`. They are logged to stdout as "SKIPPED ... wrong-number text" and discarded.
- Effect: the inbox half of SMS Monitor cannot work. The quick replies "Report received, tanods on the way" (`sms-monitor.js:86-103`), the Unread tab badge, the Unread filter and "Mark resolved" all operate on nothing.
- This contradicts the UI's own comment at `sms-monitor.js:762-766` ("an incoming emergency SMS could be missed").
- Decision needed from the owner (REFERENCE §1): either ingest and store human replies (new migration; Rule 8/PII review for citizen numbers), or remove the inbound UI so it stops promising it.

### P0-2 An unconfirmed SMS is recorded and shown as "Failed / Not delivered" (verified)
- `LocalGsmOutboundClient.php:219-224` throws when no logcat RESULT line appears within about 7 s. The comment admits "the SMS may well have gone out". `SmsGatewayService::sendOutbound:359-363` then logs `failed`.
- The device log itself (`gsm-ingest-daemon.php`, `SendSmsReceiver.java:23-29`) notes that the carrier callback can take about 60 s on this phone.
- Effect: the Admin sees red "Not delivered" (`sms-monitor.js:1159-1162`) for a message the Tanod may have received. Re-sending causes duplicate SOS or dispatch texts. Sending twice also changes the dispatch SMS fallback outcome: `NotificationDispatcher::attemptSms` records `failed`.
- The same applies to the reverse claim. `sent` means "handed to the SIM" (the Android app only waits for `sentIntent`, no delivery report), yet the thread shows "✓✓ Delivered" for `sent` (`sms-monitor.js:1154-1158`). Overstated, and it is a Rule 6 style tell.
- Fix direction: add a distinct `unconfirmed` status, relabel `sent` as "Sent to phone network", and drop the double tick.

## P1

### P1-1 Outbound SMS is synchronous and unbounded inside the HTTP request (verified)
- `sendOutbound` blocks about 12 s (broadcast) plus up to about 37 s (10 polls x 3.7 s) per message (`LocalGsmOutboundClient.php:63-71,202,211`).
- SOS, dispatch, offer, and sweeper fan-outs loop `dispatchAll` per target serially (`NotificationDispatcher.php:85-87`, `TanodSosController.php:345`, `OfferService.php:739-749`). Five Tanods without FCM could mean minutes before the SOS HTTP request returns.
- Worse, the Tanod's SOS POST waits on it, and the mobile client may time out and retry (it is idempotent, so no duplicates, but the alert is delayed).
- Fix direction: queue to an outbox plus a worker (the sweeper pattern already exists). At minimum, send the SOS FCM to everyone first, then the SMS.

### P1-2 Broadcast is one long request with a re-send hazard (verified)
- `SmsController::broadcast:527-549` sends serially and writes the idempotency audit row only AFTER all sends. The web modal creates a new `crypto.randomUUID()` per submit (`sms-monitor.js:1692`) and re-enables the button on error.
- A client or Apache timeout during a slow batch, followed by a re-click, re-sends the whole broadcast. This is also true of single sends (`:1266`): the key is minted inside the click handler, so retries get a new key.
- No per-recipient outcome comes back. Only "N sent / M failed" (`:1694`). The failed numbers cannot be listed or retried from the UI.
- The 5/hour/barangay limit (`:439`) exists; manual single sends have no limit.

### P1-3 Daemon head-of-line blocking and terminal skip drop SOS fallbacks (verified; the 5xx replay path suspected)
- `gsm-ingest-daemon.php:310-313`: any non-2xx other than 422 does `break` and retries the same message forever. One persistently bad envelope (a 500) blocks every later SOS, because `last_id` never advances.
- `:301-309`: any 422 is terminal and advances `last_id`. This includes expired envelopes (1500 s TTL, `sosEnvelopeCore.ts:33`, so a daemon down for 25 min loses the SOS), an unknown or inactive device, and a replay.
- `sms_envelope_replay` is inserted BEFORE the device lookup and decrypt (`SmsGatewayService.php:249-257`), with no wrapping transaction (`grep beginTransaction` in `internal.php`/`index.php` finds none). If `TanodSosController::createItem` then throws a 500, the next poll gets 422 "already processed" and the SOS is skipped for good. Suspected: needs a forced failure to prove.
- No `sms_log` row with status `rejected` is ever written (the enum value and UI label exist; `grep 'rejected'` finds no writer). A dropped SOS fallback therefore leaves no trace in the Activity Log, only stdout.

### P1-4 Push ack-timeout sweep is not scheduled, and ack-timeout never escalates (verified)
- `notification-worker.php` is referenced by no `.ps1`, `.bat` or `.sh` installer (`grep` finds it only in DEVLOG, the verify suite and the device test plan). `install-scheduled-backup-jobs.ps1` registers other jobs but not this one. Rule 24's `ack_timeout` therefore never gets set in production.
- Even when run, ack-timeout deliberately does not trigger SMS (`NotificationDispatcher.php:19-35`). An FCM "sent" to a sleeping or Doze phone for an SOS ends with no SMS and no admin alert. This is a documented design choice (Rule 24), flagged here as a real gap for SOS and priority alerts. Needs an owner decision.

### P1-5 Critical alert collisions and fragile background path (verified in code; device behavior suspected)
- `criticalAlertStore.ts:154-155,174-175`: a new alert overwrites `currentAlert`. An SOS overlay is silently replaced by a later dispatch alert, and the first one is never acknowledged.
- `CriticalAlertNotifier.java:42,97` use a fixed `NOTIFICATION_ID = 2001`, so the tray notification is replaced the same way.
- `FcmClient.php:87-98` sends a `notification` block plus `data`, with no `android.notification.channel_id` and no `ttl`/`collapse_key`. On Android, a message with a notification block received while the app is backgrounded or killed goes to the system tray and does NOT invoke `onMessageReceived`. `CriticalAlertMessagingService` would then never raise the full-screen alert, only an ordinary default-channel notification. Foreground and data-only work. HANDOFF already says the native path was never compiled or run on a device. Suspected, high confidence from FCM semantics.
- No TTL: a stale SOS push can arrive hours later after it was resolved.
- `CriticalAlertOverlay.tsx:69-79`: if the ack call fails, the alert dismisses and the ack is never retried (its own comment says "follow-up work"). The server keeps `ack_status='pending'`, so the Admin bell and the (unscheduled) reliability numbers say "unacknowledged" for an alert the Tanod handled.
- Tapping a plain push (`report_update`, `roster_published`, `dispatch`) does nothing: `parseAlert` returns null for non-critical types (`criticalAlertStore.ts:103-105`), and `dispatch` has no navigation either. The mobile app has no notification list (no screen calls `GET /notifications`; `apiService.ts:1565-1572` has only ack), so a dismissed push cannot be seen again.

### P1-6 Dispatch push and SMS use the raw enum and cut the most useful facts (verified)
`NotificationDispatcher.php:167-168`:
- It interpolates `{$row['incident_type']}` directly: "You've been assigned a physical_injury incident near 13.12345, 123.54321." (also "a medical_emergency", "a other"). The offer/priority paths use `describeIncidentType`; the dispatch path does not. This is the same bug HANDOFF recorded as fixed for offers.
- Location is raw coordinates only. `incident.location_description` and the barangay are not used, and there is no map link.
- The Ref appears after the location, and the SMS lacks the barangay name. A responder on a lock screen sees "You've been assigned a ..." first.
- Better order: "DISPATCH [Priority] Fire - Purok/landmark - INC-2026-014 - Open app". Length today is about 150 chars of GSM-7 (my estimate), so the headroom is thin.

### P1-7 SOS text hides location uncertainty and the "who/where" order (verified)
- `NotificationDispatcher.php:186-191`: `formatLocation` ignores `tanod_sos.location_source`. A `last_known` fix reads as a live position, and `no_fix` silently drops the location clause: "X needs help. Respond immediately." with nothing saying "location unknown".
- The Tanod's own backup SMS handles this honestly (`utils/sosFallbackSms.ts:55-58`), so the two SOS messages disagree on tone and content.
- That backup SMS writes `Time: ${new Date().toLocaleString()}` (`sosFallbackSms.ts:60`): device locale and device clock, not Manila, and it can read as US month/day ordering. This violates Rule 11 for the one message where the time matters most.
- SOS recipients are `admin` plus on-duty tanods only (`NotificationService.php:173-198`). Rule 89 makes the Secretary the back-up dispatcher who may acknowledge and resolve SOS on the web, yet they get no SOS notification at all.

### P1-8 Conversation thread returns the OLDEST 200 messages (verified)
`SmsController::conversationMessages:250-252` uses `ORDER BY created_at ASC LIMIT 200`. Beyond 200 rows, the newest messages (the ones that matter) are dropped, and the UI shows no truncation note. A busy contact (a Tanod, the gateway) will look stale.

### P1-9 Conversations list does not refresh (verified)
Only the live feed polls (`sms-monitor.js:668`, every 10 s). `loadConversations` and the unread badge update only on mount or after the user acts. New messages and unread counts do not appear until a manual action. The live-feed help toast says "every few seconds" (`:1386`).

### P1-10 Advisory broadcast has no opt-out path (verified)
- Subscribers are consent-tracked (good: `SmsController.php:494-504`, `0018`), but the broadcast text has no "Reply STOP" line. There is no inbound keyword handler anywhere in `backend` (`grep` for stop/unsubscribe/`sms_keyword` finds only the manual consent-source label). Even if a resident replied, P0-1 means it would be discarded.
- Withdrawal is therefore possible only when staff record it by hand (`optOutSubscriber`). Fine as a stopgap, but the message should say how to withdraw. RA 10173 exposure.
- `addSubscriber` only checks length <= 32. There is no number format validation, so garbage numbers get "sent" and counted as failures.

## P2

1. Activity Log filters offer "Manual message" (`sms-monitor.js:46,1938`) but `SmsController.php:40` omits `manual` from `MESSAGE_TYPES`. The filter returns a 400. (Verified.) The `STATUSES` list also offers `refunded`, `queued`, `pending`, `deduplicated`, none of which the backend ever writes.
2. `acknowledgeAll` ("Mark all read", `NotificationsController.php:144-177`, `AppShell.js:1305-1316`) marks pending SOS and dispatch targets as acknowledged without anyone having responded. Read and ack are conflated, and Rule 24 timing stats are corrupted. The class doc says "Tanod only", but the code allows all four roles. (Verified.)
3. The web bell loads only 15 items every 15 s (`AppShell.js:1704,1952`). `dispatch_offer`/`report_update`/`roster_published` have no card branch, and an offer would render as "NEW INCIDENT". These types go to Tanods, so the impact is latent. The audible cue plays only for `sos`/`priority_alert` that are new since the first load, and a browser may block autoplay audio (suspected).
4. Contact tags in the thread are guessed from keywords and `type==='manual' && inbound` (`sms-monitor.js:121-142`); "tip" matches "multiple", "stipend". The tag shows on every inbound bubble even though the title admits it is a guess. Remove the heuristic or label as "suggested".
5. Phone numbers are shown unmasked in the list, header and compose line (`sms-monitor.js:1051,1227`), although REFERENCE §6 says masked in UI.
6. Conversation key is the raw string. `0917...` and `+63917...` become different threads, with no normalization in `SmsController` or `sendOutbound`. `conversations()` is also N+1 (two queries per thread, up to 100 threads).
7. FCM has no dead-token handling. `NOT_FOUND`/`UNREGISTERED` is treated as a generic failure (`FcmClient.php:261-265`), the token stays `is_active`, and every later alert burns two attempts (8 s timeout each) before SMS. The FCM retry fires immediately with no backoff.
8. Quick replies: the emergency one says "tumawag agad sa 911 o sa hotline ng barangay" with no number. "Papunta na po ang mga tanod" is a promise the button sends regardless of dispatch state. Broadcasts and replies carry no sender identity or barangay name (messages arrive from an unknown mobile number).
9. Stale copy and remnants: page subtitle "Community reports and dispatch communications" (citizen reports were retired); comments about the removed AI composer (`sms-monitor.js:657-661,1219`); `smsFallbackState.ts` header says on-device SMS sending is "NOT built" though `SosSmsPlugin` exists; `transportLabel` maps anything non-gsm to "Old SMS service".
10. Segment estimator treats GSM-7 extension chars (`[ ] { } \ ^ ~ | €`) as UCS-2, so it overstates cost (`sms-monitor.js:2385-2394`). Counts `length` in UTF-16 units. Cosmetic.
11. Accessibility of the monitor: the live feed signals SOS/failed by dot colour alone (`:1441-1447`); no `aria-live` for new events; the feed refresh failure replaces the list with "Could not load the live feed" every 10 s without keeping stale rows or showing the last-updated time (`:1401-1403`); the unread badge is a `role="status"` that is hidden by style and re-set on each poll. The failure tick has `title` but no `aria-label`. The modals do trap focus and close on Esc (good).
12. `GSM_GATEWAY_ENABLED` unset yields `failed / GSM_GATEWAY_NOT_CONFIGURED` rows. Honest, but there is no SMS Monitor banner when the gateway phone or daemon is down. Admins see only red rows. (Service Health may cover it; I did not audit that page.)
13. Retention/privacy: `sms_log.message_body` stores outbound SOS/dispatch text including coordinates and Tanod names for the 1-year sms_log retention. No Rule 1 leak (no `raw_narrative`, no reporter PII was found in any template), but Rule 8 only restricts audit metadata, so confirm that is the intended policy.
14. Dead `'other'` default: `composeMessage` writes an SMS body for type `other` (`:292`) with `message_type ''`, so the SMS attempt is always `failed UNSUPPORTED_NOTIFICATION_TYPE_FOR_SMS`. Harmless today (no caller).
15. `report_update`: the comment says "approved or returned" (`:259-261`), but the code returns null for anything but `returned`, which is consistent with the paper-only decision. Doc drift only.

## Confirmed good (no action)
- Rule 1: no template reads `raw_narrative`. Offers and `priority_alert` escalations carry type, barangay and Manila time only; the report/roster pushes carry month and outcome only.
- Rule 11: `offerWhat` converts to +08:00 correctly; web monitor times go through `manilaTime.js`; the overlay uses `formatManilaTime`.
- Idempotency exists for manual send (by `correlation_id`) and broadcast (audit key). Consent is recorded and withdrawal is kept as a timestamp. Cross-tenant checks are present on the subscriber and conversation queries.
- adb command quoting (three dialects) is carefully handled and documented.
- Segment-aware multipart sending on the Android gateway.

## Not examined
Service Health GSM probe, `sms-envelope-build.php`, `EnvelopeCrypto`, Android gateway behaviour on a real device, FCM with a real project, iOS (none), Filipino copy review beyond the strings above, mobile offer card UI.
