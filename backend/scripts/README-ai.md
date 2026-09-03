# Running the AI pipeline locally (Sprint 5)

The AI stack is **self-hosted only** — §1 of the Master Reference pins it
to `Llama-SEA-LION-v3.5-8B-R` served by a local Ollama, and §2 Rule 1
forbids sending `raw_narrative` to any external AI API. Nothing in this
codebase has a cloud fallback branch, deliberately.

## 1. Install and start Ollama

```bash
ollama serve
```

(The desktop app does this for you. `ollama serve` fails with "address
already in use" if it's already running — that's fine.)

## 2. Pull the model

```bash
ollama pull aisingapore/Llama-SEA-LION-v3.5-8B-R
```

~4.9 GB. `ollama run <model>` also pulls it, then drops you into a chat —
either is fine, the app only needs the model present.

## 3. Point the API at it

In `backend/.env` (copy the block from `.env.example`):

```
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=aisingapore/Llama-SEA-LION-v3.5-8B-R
OLLAMA_TIMEOUT_SECONDS=300
```

Leaving these **blank** is a valid, honest state: `GET /system/health`
then reports `ollama: not_configured`, and `POST /incidents/:id/redact`
returns `503` instead of queueing work nothing can run.

## 4. Check it's wired up

```bash
php scripts/ai-worker.php --status
```

Prints queue depth plus whether Ollama is reachable and whether the
configured model is actually pulled. `GET /system/health`'s `ollama`
field answers the same question over HTTP (Admin only), with three
states:

| state | meaning |
|---|---|
| `not_configured` | `OLLAMA_URL`/`OLLAMA_MODEL` unset — no AI on this deployment |
| `unhealthy` | configured, but the service didn't answer **or** the model isn't pulled |
| `healthy` | service answered and the configured model is present |

## 5. Run jobs

The API **never** calls the model — it only enqueues. That's what makes
`POST /incidents/:id/redact` work identically whether Ollama is running,
stopped, or still downloading (§2 Rule 15: "AI jobs queue"). This worker
is what actually runs them:

```bash
php scripts/ai-worker.php            # drain everything queued, then exit
php scripts/ai-worker.php --once     # run at most one job
php scripts/ai-worker.php --max=5    # run at most five
php scripts/ai-worker.php --daemon   # keep polling (Ctrl-C to stop)
php scripts/ai-worker.php --status   # queue depth + Ollama reachability
php scripts/ai-worker.php --recover  # requeue jobs stuck in 'processing'
```

If Ollama is unreachable mid-run, the claimed job goes **back on the
queue** (not marked failed) and the worker stops. Re-run it once the
service is back; nothing is lost.

`--recover` exists for the crash case: a worker killed mid-job (Ctrl-C,
power cut, XAMPP restart) leaves its row in `processing` with no process
to finish it. A normal worker start also does this automatically for jobs
older than 30 minutes.

## What the pipeline actually does

Per §2 Rule 16, in this exact order:

1. **raw narrative → redaction draft** — the only point where raw text
   meets the model.
2. **redaction draft → summary** — the summary is generated from the
   *draft*, never from the raw text.

Both land on one `ai_processing_log` row (`task_type='redaction'`), which
is the row `GET /incidents/:id/ai-draft` returns.

If step 1 succeeds but step 2 fails (e.g. Ollama dies between the two
calls), the draft is **kept** and the row is marked
`draft_summary_stale=true`. That blocks approval (§6) until the Secretary
runs regenerate-summary — visible and correctable, rather than throwing
away a good redaction because the second call timed out.

## Two things worth knowing

**The model is a reasoning variant.** The `-R` in
`Llama-SEA-LION-v3.5-8B-R` means it emits `<think>…</think>` traces.
`AiPrompts::stripReasoning()` removes them before anything is persisted —
this is not cosmetic: a reasoning trace routinely restates the *original*
narrative, so storing it verbatim would put the exact names the redaction
just removed straight back into the draft.

**The worker never prints content.** Identifiers, statuses, timings and
character counts only — no narrative, draft, summary, or translation ever
reaches stdout, a logfile, or a terminal scrollback.

## Not built yet (Sprint 6)

`POST /incidents/:id/ai-draft/regenerate-summary` and
`POST /incidents/:id/ai-draft/approve` — the second of which is the only
endpoint permitted to commit `incident.redacted_narrative` (§2 Rule 3).
Until approval exists, no incident can reach `redaction_approved_at`, so
the translation endpoint's prerequisite check is real but unsatisfiable
by design.
