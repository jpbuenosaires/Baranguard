# Redaction Evaluation Set — PII Category Reference

**Superseded 2026-09-07.** This originally instructed three people to
hand-author the 200-record evaluation set. That never happened; by
explicit user decision, `backend/scripts/generate-eval-dataset.php`
generates `backend/fixtures/redaction-eval-v1.json` instead (template +
pool synthesis, self-validated, disclosed as AI-generated in the
dataset's own `generation_method` field — see `backend/DEVLOG.md`'s
"Friend-runnable AI evaluation kit" entry for the full story). The
hand-authoring process below is no longer followed.

**Kept for one reason:** the PII category definitions and judgement
calls below are still the live contract the generator script follows,
and still the thing to check first if the dataset is ever extended or
disputed.

## The eight PII categories

Fixed — they match `AiPrompts::PLACEHOLDERS` and the baseline regex
comparator scores the same eight. Don't invent a ninth; nothing outside
this list can be scored on either side.

| `type` | Covers | Example |
|---|---|---|
| `NAME` | Any person's name: complainant, respondent, witness, bystander | `Rosalinda Mercado`, `Aling Nena` |
| `ADDRESS` | House number, street, purok, sitio — anything narrowing to a household | `24 Purok Maligaya`, `Sitio Bagong Silang` |
| `PHONE` | Mobile or landline | `0917-555-2841`, `+63 918 555 2841` |
| `EMAIL` | Email address | `rmercado@example.ph` |
| `ID_NUMBER` | Government/company ID, case number tied to a person | `1234-5678-9012` |
| `DATE_OF_BIRTH` | Birth dates only — **not** the date the incident happened | `March 14, 1983` |
| `PLATE_NUMBER` | Vehicle plate | `ABC 1234` |
| `ACCOUNT` | Bank account, e-wallet, social media handle | `@rosie_m`, `GCash 0917...` |

## Judgement calls

- **Official roles are NOT names.** "the barangay captain", "si tanod" —
  `"Kapitan Rogelio Ramos"` → the name part is `NAME`; the title isn't.
- **Barangay names are NOT addresses.** Dao/Binanuahan/Marifosque/Banuyo
  are the tenant, known to everyone. A purok/sitio *within* one IS an
  `ADDRESS`.
- **Public landmarks stay.** "sa palengke", "malapit sa simbahan" are not
  addresses; "sa bahay ni [NAME] sa 24 Purok Maligaya" is.
- **Incident date/time is NOT `DATE_OF_BIRTH`.** Only an actual birth
  date is PII here.
- **Ages stay** — "42 anyos" isn't identifying on its own.
- **Nicknames/aliases ARE names.** "si Boy", "kilala bilang Totoy" →
  `NAME`.

## Scoring (unchanged — still how `ai-evaluate.php` works)

- **True positive** — a planted entity's text no longer appears in the output.
- **False negative** — it's still there (a real privacy failure).
- **False positive** — a placeholder beyond the planted count, or a
  `must_keep` word that disappeared (over-redaction).
- `recall = TP / (TP + FN)` → target ≥95%; `precision = TP / (TP + FP)` → target ≥90%.

Full harness usage: `backend/scripts/ai-evaluate.php`'s own header comment.
