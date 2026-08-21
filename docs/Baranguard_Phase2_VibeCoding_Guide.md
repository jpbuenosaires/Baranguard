# Phase 2: Development — Vibe Coding Guide for Baranguard

This guide is built around your own Chapter 3 Table 6 sprint plan. The goal isn't just
"make AI write code fast" — it's making sure you end up with a system you can
**defend**, that actually **works when demoed live**, and that produces the
**evidence** (screenshots, logs, test results) your Chapter 4 needs.

---

## 0. Ground Rules Before You Touch a Prompt

### Rule 1: You must be able to explain every module, even if AI wrote it
Panels ask "walk me through this function" or "why did you choose this approach."
"AI generated it" is not an acceptable answer. After each AI-generated feature,
spend 5 minutes actually reading it and asking the AI: *"explain this code to me
like I'm defending it in a thesis panel."*

### Rule 2: One sprint = one clear scope, don't let AI scope-creep you
AI coding assistants love to "helpfully" add extra features, refactor unrelated
files, or suggest architecture changes mid-task. Politely: no. Stick to your
sprint backlog (Table 6). Log anything tempting-but-out-of-scope as a
"Future Work" note instead — this is actually useful, it becomes material for
your Chapter 5 recommendations section.

### Rule 3: Commit constantly, in small chunks
Vibe coding sessions can go sideways fast (AI "fixes" something and breaks three
other things). Git is your undo button.
```bash
git add .
git commit -m "Sprint 2: SQLite offline caching for incident capture"
```
Commit **before** asking AI to do anything risky (big refactor, dependency
change, schema change) so you always have a fallback point.

### Rule 4: Keep a build log from day one
A simple `DEVLOG.md` in your repo, one entry per session:
```
2026-09-01 — Sprint 1
- Built GIS dashboard skeleton (Leaflet + Tailwind)
- Issue: map tiles not loading offline — deferred, will address in Sprint 2
- AI tool used: Claude Code
```
This becomes your **Sprint Review minutes** for Chapter 4 and proves your
Scrum methodology was actually followed, not just claimed on paper.

---

## 1. Tooling Setup

| Tool | Purpose | Notes for your stack |
|---|---|---|
| **Claude Code** (terminal or desktop) | Main dev agent for PHP/Node, JS, SQL, Ionic | Best for repo-aware, multi-file work |
| **VS Code** | Editor + AI pair programming | You already listed this in Table 1 |
| **Git + GitHub** | Version control | You listed this — use it for real, not just as a checkbox |
| **Ollama** | Local LLM runtime for Llama-SEA-LION | Set this up **early** (Sprint 5 per your plan, but test-install in Sprint 0 to catch hardware issues before you're time-pressured) |
| **Postman / Thunder Client** | Test your REST APIs manually before wiring up frontend | Catches bugs before they cascade into UI bugs |
| **Android Studio + Ionic/Capacitor CLI** | Mobile build/test | Emulator first, real device later (esp. for offline/airplane-mode tests) |

**Before Sprint 0 starts:** get Ollama + Llama-SEA-LION-v3.5-8B-R running on your
actual unified administrative workstation hardware, even just to say "hello
world." If your GPU/VRAM can't handle it, you want to know in **week 0**, not
week 12 when you're already committed to it in your manuscript.

---

## 2. How to Prompt Effectively for Each Sprint

The single biggest failure mode in vibe coding a capstone is **treating every
prompt like a standalone request**, so the AI has no memory of your schema, your
conventions, or what already exists. Fix this with a **project brief file**.

### Create a `PROJECT_CONTEXT.md` once, at the very start
Put this in your repo root and reference it in every session:
```markdown
# Baranguard — Project Context

## Stack
- Backend: PHP 8.2 + Node.js
- Frontend (web): Vanilla JS (ES2023+), Tailwind CSS 4.2.4
- Mobile: Ionic 8.8.5 + Capacitor 8.0 (Android)
- DB: MySQL 8.0 (cloud), SQLite/Room (mobile offline cache)
- AI: Llama-SEA-LION-v3.5-8B-R via Ollama, local inference only — NEVER call
  external AI APIs for narrative text (RA 10173 compliance requirement)
- SMS: Semaphore gateway + tethered mobile device fallback

## Architecture rules (do not violate)
- No unredacted PII may ever leave the local environment
- All incident capture must work fully offline; sync happens opportunistically
- AI-drafted redactions require human (barangay secretary) approval before
  being committed to the permanent record — never auto-commit AI output

## Current DB schema
[paste your ERD entities/fields here, keep updated as you build]

## Coding conventions
- [naming conventions, folder structure, etc. — establish early, stay consistent]
```
Paste or reference this file at the start of every new session/sprint. This
alone will save you dozens of "wait, why did it rename my table" moments.

### Sprint-by-sprint prompting notes

**Sprint 0 — Cloud + schema**
- Prompt AI to generate the schema *from your Appendix C ERD*, not from
  scratch — paste your ERD field list, don't just say "make me a database for
  a barangay system." Vague prompts = AI invents its own schema that won't
  match your manuscript's diagrams.
- Ask it to generate migration scripts, not just raw SQL — makes Sprint 7
  (integration testing) much less painful.

**Sprint 1 — Web command center + GIS dashboard**
- Build incrementally: static layout first, then wire up mock data, then real
  DB queries. Don't ask for "the whole dashboard with live data" in one prompt
  — you'll get something that half-works and is hard to debug.
- Explicitly reference your Appendix D mockups (D-2, D-3, D-4) as the visual
  target so output matches what you already showed your panel.

**Sprint 2 — Mobile UI + offline SQLite cache**
- This is where things get trickier because you have two data layers (SQLite
  local, MySQL cloud) that need to reconcile later. Ask AI to build the local
  schema **mirroring** your cloud schema exactly, with a `synced` boolean flag
  and `created_offline_at` timestamp — you'll need this for Sprint 4's sync
  logic and for demonstrating "zero data loss" in your defense.

**Sprint 3 — GPS tracking + async sync**
- Test sync logic in isolation first (unit-test style) before integrating
  with UI. Ask AI: "write a test script that simulates 10 offline records,
  then reconnects, and verifies all 10 sync without duplication."
- Duplication and conflict handling (what happens if the same incident is
  edited offline AND online) is the classic bug here — explicitly ask AI to
  handle this case, don't assume it will.

**Sprint 4 — SMS gateway integration**
- Test with Semaphore's sandbox/test credits first, not your real quota.
- Airplane-mode testing (mentioned in your own Sprint Review section 3.2.4) —
  do this on a real device, not emulator. Emulators don't reliably simulate
  cellular signal loss.
- Log every test attempt (timestamp, device, success/fail) — this raw data
  feeds directly into your Acceptance Criterion #3 (95% delivery rate table).

**Sprint 5 — Ollama + Llama-SEA-LION setup**
- This is infrastructure, not application code — go slow, verify each step
  manually (model downloads, quantization settings, API response format)
  before wiring it into your app.
- Benchmark inference speed on your actual hardware now — you need this
  number for your Performance Efficiency section under ISO 25010.

**Sprint 6 — PII redaction pipeline**
- Build your 200-record synthetic test set **before** you start tuning
  prompts — you need a fixed target to measure precision/recall against,
  otherwise you're just eyeballing it.
- Ask AI to build you a scoring script that compares model output against
  your pre-tagged PII entities and auto-computes precision/recall — don't
  score 200 records by hand.
- Also build the baseline regex-only filter here (Section 3.3.3-C) — cheap to
  build in parallel, and you need it as your comparator.

**Sprint 7 — RBAC, security, integration testing**
- Ask AI specifically to audit for: SQL injection, unauthenticated API
  endpoints, and PII appearing in logs/error messages. This is a real
  security pass, not a formality — you're handling sensitive government data.
- Do a full end-to-end test of every DFD Level 1 process path (Incident
  Capture → Sync → AI Processing → Cloud DB → Dispatch → Analytics).

**Sprint 8 — UAT + ISO 25010 evaluation**
- This is people, not code — but make sure your system is stable and
  **frozen** (no more feature changes) before UAT starts. Nothing tanks a
  usability score like testing an app that's still being actively rewritten.

---

## 3. Vibe Coding Pitfalls Specific to a Thesis/Capstone Context

- **Hallucinated packages/APIs.** AI sometimes references libraries or
  Semaphore/Ollama API methods that don't actually exist or are outdated.
  Always verify against the real docs before building on top of AI-suggested
  code, especially for Semaphore SMS API calls and Ollama's REST endpoints.
- **Inconsistent architecture across sessions.** If you start a new chat
  session per feature without your `PROJECT_CONTEXT.md`, you'll get drift —
  different naming conventions, different folder structures, sometimes even a
  different auth pattern. Re-paste context every session.
- **Untested "it should work" code.** Vibe coding tends to produce code that
  *looks* plausible but hasn't been run. Always run/test before moving to the
  next feature — don't stack five unverified features on top of each other.
- **Losing manuscript-code alignment.** Your Chapter 1-3 already promises
  specific things (9 ISO characteristics, 4 barangays, specific user stories).
  If mid-development you or the AI simplify something ("let's skip the
  heatmap for now"), you now have a mismatch between manuscript and system —
  flag these deviations immediately and discuss with your adviser, don't let
  them silently accumulate.
- **Not understanding the AI/redaction logic well enough to defend it.** This
  is your most technically "novel" component (Section 2.1.3). Be able to
  explain in plain language: how does the model decide what's PII, why
  human-in-the-loop review, why local inference over cloud API. Panels will
  probe this hardest.

---

## 4. What to Capture as Evidence, Per Sprint

For each sprint, save into a `/evidence` folder in your repo:
- Screenshot(s) of the working feature
- Git commit hash / log for that sprint
- Any test results (sync tests, SMS delivery logs, redaction precision/recall)
- Sprint review notes (what was demoed, feedback received)
- Sprint retrospective notes (what you'd do differently)

This turns Phase 2 from "we vibe coded it and hoped for the best" into a
traceable, defensible development record — exactly what strengthens your
Chapter 4 Results section and survives panel scrutiny.

---

## 5. Quick Daily Vibe Coding Checklist

- [ ] Pulled latest code, no uncommitted changes from last session
- [ ] Re-shared `PROJECT_CONTEXT.md` / relevant schema with AI if new session
- [ ] Scoped today's task to ONE sprint backlog item, not multiple
- [ ] Tested the feature manually after AI builds it — don't just trust it
- [ ] Committed with a clear message tied to sprint/user story number
- [ ] Logged any bugs, deviations, or "future work" ideas in DEVLOG.md
- [ ] Screenshot/evidence saved if this completes a demoable feature
