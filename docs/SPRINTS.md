# Baranguard — Sprint Prompts (compact)

**Sprints 0–7 are complete.** The full historical prompt library, with
every sprint's original wording and its checked-off menu, is preserved in
`docs/Baranguard_Sprint_Prompts.md` — read it only if you need to know
what a past sprint was actually asked to do.

**Only Sprint 8 is left.** Its menu is below.

---

## Standing rules for every session

1. **Pick exactly ONE "Today's cut" item.** Mark it, build it, stop —
   even if there's time left. Don't slide into the next box.
2. **If nothing is picked, ask.** Never default to the whole sprint,
   never pick on the user's behalf. (A multi-box session is allowed only
   when the user explicitly asks for it; log it as a deliberate
   exception, as past entries do.)
3. **Read the real file before extending it.** `DEVLOG.md` says what
   exists, never its current shape. Build on the code, not the
   description.
4. **Never regenerate what's already built.** If something needed seems
   missing, stop and ask rather than inventing it.
5. **Prove it, don't claim it.** A checked box means real evidence — a
   passing suite, a real DB row, a real browser pass. `[~]` means "code
   exists, unverified". If a session only ran a parse check, say so.
6. **Log deviations in `DEVLOG.md`**, and update `HANDOFF.md` before
   ending a session that changed the picture.
7. **Report the exact cut at the top of your output**, then: files
   changed, endpoints/tables touched, tests performed with evidence.

---

## Sprint 8 (Weeks 17–18) — UAT + Reliability/Safety/Performance Evaluation

```
You are working on Baranguard. Read docs/REFERENCE.md (auto-loaded) and
open the full Master Reference by section when you need exact wording.
Never invent fields, routes, roles, or state transitions.

SPRINT 8 IS VERIFICATION, NOT NEW FEATURES. Do not add scope that isn't
already in §9/§10 without an explicit architecture-review note. Treat
DEVLOG.md as the list of what to TEST, not what to rebuild — and
spot-check its claims against the actual repo before trusting them for a
UAT sign-off.

Pre-UAT exit conditions to confirm before this sprint counts as started
(§11): executable schema matches §5 · every §6 endpoint has a documented
response shape and authorization rule the implementation actually matches
· tenant penetration tests pass · offline duplicate tests pass · critical
notification/SOS fallback tests pass · restore test passes · no
unresolved P0/P1 reference contradictions.
  -> Status: schema, restore test, and incident-tenant penetration are
     DONE. See docs/REMAINING.md for the ones that are not.
  -> `docs/REMAINING.md` §F is the remediation list and it GATES this
     sprint. F2/F3/F5/F6/F8 were fixed and proven 2026-09-12 (each with a
     new verify script — see `backend/DEVLOG.md` 2026-09-12 (4)); **F4
     (evidence upload) closed 2026-09-13** (built end-to-end, proven by
     `backend/scripts/verify-evidence-upload.sh`). **F1 is now
     half-decided**, not fully open: mobile's connectivity has a real
     architectural answer (Tailscale, 2026-09-13), but the web
     dashboard's own API base URL and `CORS_ALLOWED_ORIGIN` are
     unchanged — **do not open a Sprint 8 box that depends on
     browser-verifying the web dashboard against a real deployment
     address until that half is settled**; boxes that only exercise
     mobile/backend behavior are no longer blocked by F1. Evidence:
     `docs/AUDIT_2026-09-07.md`; current status: `docs/REMAINING.md` §F1.
  -> **New as of 2026-09-13, real-device-confirmed, not part of §F but
     directly relevant to this sprint's own "critical notification/SOS
     fallback tests pass" exit condition:** `docs/REMAINING.md` C6 (login
     can leave the old screen visually stuck over Home — the app works
     underneath, but a real Tanod would see a frozen login and assume
     failure) and C7 (the app process died twice, ~50 seconds into
     on-duty patrol GPS, silently stopping tracking) are both open and
     unfixed. Treat these as blocking any UAT scenario that walks through
     login or an on-duty patrol shift until resolved — see their own
     entries for what's known so far.

One Sprint 8 box below was directly affected and is now unblocked:
  * "Dispatch response-time metric" — the double-count bug (F8) that
    would have made this box report a wrong number as a measured one is
    fixed as of 2026-09-12: `ReportsController` now takes the
    per-incident first arrival (`MIN(arrived_at)`), proven by
    `backend/scripts/verify-f8-response-time-dedup.sh`. This box can
    proceed using that fixed definition.
  * "Raw-PII exposure audit" — F2/F3 (the stored-XSS chain) are now
    fixed; F7 was closed by removal 2026-09-10. Starting from those
    closed items' evidence is still useful context, but they are no
    longer open findings to re-verify as part of this box.

Today's cut — pick exactly ONE evaluation hook or ONE UAT scenario:
  [ ] Auth/session revocation + lockout evidence
  [ ] Tenant/ownership penetration tests — a resource type OTHER than
      incidents (dispatch, shifts, citizen reports, or SMS). Incidents
      are already done: verify-sprint7-pentest-incidents.sh, 68/68.
      Reuse that script's four-dimension structure.
  [ ] Offline cache durability + duplicate-reconciliation tests
      (needs a real Android device — see docs/REMAINING.md)
  [ ] Notification end-to-end reliability
      (needs real FCM/Semaphore credentials)
  [ ] Sync latency
  [ ] Raw-PII exposure audit
  [ ] GPS/route accuracy
  [ ] Dispatch response-time metric — incident.created_at ->
      dispatch.arrived_at, per §6's own definition. Don't invent a
      different formula for the UAT report.
  [ ] Offline-map availability
  [ ] Fatigue audit trail
  [ ] Valid JSON contracts (schema-validate every §6 response shape)
  [ ] AI dataset evaluation run / Bikol language-quality validation
      (the 200-record dataset now exists — generated, not hand-authored,
      see docs/REMAINING.md A3; still needs a machine that can run
      SEA-LION at usable speed, see A2 and eval-kit/)
  [ ] SLM inference time / 3+ Android device tiers (workstation-side —
      this session records the methodology, the run happens outside it)
  [ ] One specific end-to-end UAT scenario (name it in prose)

Requirements: report REAL MEASURED NUMBERS, never target numbers restated
as if measured. Any gap found between the reference and the actual
implementation gets logged in DEVLOG.md and reconciled into the
reference — the reference is not correct by default just because it is
older than the code.

Output: the exact cut, then evaluation results per metric, UAT
pass/fail log, updated DEVLOG.md, and — if this is the last sprint — a
final go/no-go against the pre-UAT exit conditions above.
```

---

## If you need a past sprint's prompt

`docs/Baranguard_Sprint_Prompts.md` holds all of Sprints 0–7 verbatim,
including each box's completion note and the evidence behind it. That
file is no longer auto-loaded; open it deliberately.
