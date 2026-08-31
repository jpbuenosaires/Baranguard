# services
Business logic that doesn't belong to a single request/response cycle —
called by controllers or background workers. Subfolders:
- sms/   — Semaphore + GSM modem fallback, envelope encryption (§2 Rule 4)
- ai/    — Ollama/SEA-LION pipeline: redaction draft, summary, translation
- sync/  — /sync/batch reconciliation, offline_queue processing
