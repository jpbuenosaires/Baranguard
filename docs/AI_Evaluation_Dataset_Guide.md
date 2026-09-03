# Building the 200-Record Redaction Evaluation Set

**Status:** manual task, deferred from Sprint 6 by decision. Three people
are doing this together.

**Why it exists:** §10 sets a target of **recall ≥95% / precision ≥90%**
for PII redaction, benchmarked against a baseline regex comparator. Those
are the numbers that go into `ai_evaluation_run` (§5) and into the
capstone's evaluation chapter. They cannot be estimated, asserted, or
copied from the model card — Sprint 6's own rule is "record actual
numbers, don't estimate them." That means we need 200 records where **we
already know the right answer**, so a script can compare the model's
output against it.

---

## 1. The one rule that matters most

**Every record must be invented. Do not use real incident narratives.**

Not paraphrased real ones, not "a real one with the names changed." Real
narratives are real personal data under RA 10173 — they carry retention
obligations (§11), they are Secretary-only (§7), and a committed test
fixture is the opposite of both. A leaked evaluation file would be an
actual privacy incident, not a testing inconvenience.

Invented records are also the only way this works technically: scoring
needs to know exactly which spans are PII, and you only know that for
certain if you put them there yourself.

Write realistic content — plausible Filipino names, real barangay names
(Dao, Binanuahan, Marifosque, Banuyo), plausible purok/sitio names,
realistic incident types. Realistic is good. Real is forbidden.

---

## 2. What one record looks like

Each record is one object. 200 of them go in a JSON array.

```json
{
  "id": "eval-041",
  "author": "A",
  "incident_type": "theft",
  "narrative": "Nagreklamo si Rosalinda Mercado, 42 anyos, naninirahan sa 24 Purok Maligaya, na nawala ang kanyang cellphone kaninang alas-tres ng hapon sa palengke. Ang contact number niya ay 0917-555-2841. Nakita ni Danilo Reyes ang suspek na tumakas sakay ng motorsiklo na may plate ABC 1234.",
  "entities": [
    { "type": "NAME",         "text": "Rosalinda Mercado" },
    { "type": "ADDRESS",      "text": "24 Purok Maligaya" },
    { "type": "PHONE",        "text": "0917-555-2841" },
    { "type": "NAME",         "text": "Danilo Reyes" },
    { "type": "PLATE_NUMBER", "text": "ABC 1234" }
  ],
  "must_keep": ["cellphone", "palengke", "motorsiklo"]
}
```

### Field by field

| Field | What it is |
|---|---|
| `id` | `eval-001` … `eval-200`, zero-padded. Assigned by range, see §4. |
| `author` | `"A"`, `"B"`, or `"C"` — who wrote it. Lets us spot per-author bias later. |
| `incident_type` | One of the 11 §5 enum values. Spread them out, see §5. |
| `narrative` | The invented incident text. |
| `entities` | Every piece of PII you planted, **copied character-for-character**. |
| `must_keep` | 2–4 non-PII words that must SURVIVE redaction. |

### `entities` — the part scoring depends on

`text` must match the narrative **exactly**: same spelling, same
capitalisation, same spacing. The scoring script searches for these
strings in the model's output. `"Rosalinda Mercado"` when the narrative
says `"Rosalinda  Mercado"` (two spaces) is a scoring failure that is our
fault, not the model's.

If the same person is named twice, list the entity twice **only if the
surface text differs** (`"Rosalinda Mercado"` and later `"Rosalinda"` are
two entries; the identical string twice is one entry).

### `must_keep` — how we catch over-redaction

Recall alone rewards a model that redacts everything. `must_keep` is the
counterweight: ordinary incident words that carry no identity and must
still be there afterwards. Pick words that are clearly *not* PII —
objects, places-in-general, actions. Never a name, never a location
specific enough to identify a household.

---

## 3. The eight PII categories

These are fixed. They match the placeholder vocabulary the model is
instructed to use (`AiPrompts::PLACEHOLDERS`) and the baseline regex
comparator scores the same eight. **Do not invent a ninth category** —
anything outside this list can't be scored on either side.

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

### Judgement calls — decide these the same way, all three of you

These come up constantly. Agreeing now is what makes the three sets
mergeable:

- **Official roles are NOT names.** "the barangay captain", "si tanod",
  "ang secretary" stay as-is. `"Kapitan Rogelio Ramos"` → the name part is
  `NAME`; the title is not.
- **Barangay names are NOT addresses.** Dao / Binanuahan / Marifosque /
  Banuyo are the tenant, known to everyone, and stay. A purok or sitio
  *within* one is an `ADDRESS`.
- **Public landmarks stay.** "sa palengke", "sa plaza", "malapit sa
  simbahan" are not addresses. "sa bahay ni [NAME] sa 24 Purok Maligaya"
  is.
- **The incident date/time is NOT `DATE_OF_BIRTH`.** "kaninang alas-tres
  ng hapon", "noong Lunes" stay — they're case facts. Only an actual birth
  date is PII here.
- **Ages stay.** "42 anyos" is not identifying on its own.
- **Nicknames and aliases ARE names.** "si Boy", "kilala bilang Totoy" →
  `NAME`.

---

## 4. Splitting the work three ways

| Person | `id` range | Records | `author` |
|---|---|---|---|
| Person A | `eval-001` – `eval-067` | 67 | `"A"` |
| Person B | `eval-068` – `eval-134` | 67 | `"B"` |
| Person C | `eval-135` – `eval-200` | 66 | `"C"` |

Fixed ranges mean nobody collides and the merge is a concatenation.

**Work in three separate files**, then merge at the end:

```
docs/eval-dataset/part-a.json
docs/eval-dataset/part-b.json
docs/eval-dataset/part-c.json
```

Each file is a JSON array of that person's records. Merging into the final
`backend/fixtures/redaction-eval-v1.json` is one small script (or a
careful copy-paste — it's three arrays into one).

### Before you split up, do a calibration round — this is worth the hour

All three of you write **the same 3 records** from the same brief, then
compare `entities` lists side by side. You will disagree about at least
one thing (usually whether a sitio is an address, or whether a nickname
counts). Settle it, write the ruling into §3's judgement-call list above,
*then* start your 67.

Skipping this is how you end up with three internally-consistent sets that
disagree with each other — and a precision number that measures your
disagreement instead of the model.

### Cross-check at the end

Swap 10 records each (A checks B's, B checks C's, C checks A's) and
re-list the entities without looking at the original list. Compare. If you
disagree on more than ~1 in 10, the categories need another conversation
before the numbers mean anything.

---

## 5. Coverage targets

Don't write 200 easy records. The point is to find where the model fails.

**Spread across incident types** — roughly 15–20 each across the 11 §5
types (`theft`, `physical_injury`, `disturbance`, `domestic_dispute`,
`vandalism`, `traffic_incident`, `fire`, `medical_emergency`,
`missing_person`, `animal_complaint`, `other`).

**Spread across languages.** The system serves Bikol-speaking barangays
and Rule 16 flags Bikol as unvalidated:

- ~70 records mostly English
- ~70 records Tagalog/Taglish (realistic for how reports get written)
- ~60 records with Bikol phrasing

The Bikol records matter most — they're the ones that will expose whether
the "Bikol is unvalidated" caveat is a formality or a real problem.

**Include hard cases deliberately.** Aim for ~40 records that are
genuinely difficult:

- A name that's also a common word (`Mercado` = market, `Cruz` = cross,
  `Reyes` = kings). Does the model redact the word when it *isn't* a name?
- Two people with the same surname.
- A name in the middle of a sentence with no title before it.
- A purok name that sounds like a landmark.
- Numbers that look like IDs but aren't (case numbers, amounts in pesos,
  house counts).
- **~10 records with NO PII at all** (`entities: []`). These only measure
  precision, and they're the cleanest way to catch a model that redacts
  out of habit.
- 1–2 records with unusual formatting: ALL CAPS, no punctuation, a
  run-on. Real blotter text looks like this more often than you'd like.

---

## 6. How this gets scored (so you know why the fields matter)

Once the dataset exists, a harness runs each narrative through **both** the
local model and the baseline regex comparator, then scores both the same
way:

- **True positive** — a planted entity's text no longer appears in the output.
- **False negative** — it's still there. *This is a real privacy failure.*
- **False positive** — a placeholder was emitted beyond the planted count,
  or a `must_keep` word disappeared. Over-redaction.

```
recall    = TP / (TP + FN)      →  target ≥ 95%
precision = TP / (TP + FP)      →  target ≥ 90%
```

Results are written to `ai_evaluation_run` with the real `model_version`
and `AiPrompts::PROMPT_VERSION`, so a number can always be traced back to
the exact model and prompt that produced it.

The regex baseline is expected to do **well** on phone/email/ID/plate and
**badly** on names and addresses. That contrast is the finding, not a bug —
it's what justifies running a self-hosted language model instead of a
pattern list.

---

## 7. Checklist before declaring it done

- [ ] 200 records, ids `eval-001`–`eval-200`, no gaps or duplicates
- [ ] Calibration round done, judgement calls written into §3
- [ ] Every `entities[].text` copy-pasted from the narrative, not retyped
- [ ] Every record has 2–4 `must_keep` words
- [ ] ~10 records with `entities: []`
- [ ] All 11 incident types represented
- [ ] Language mix roughly 70 / 70 / 60
- [ ] Cross-check of 10 records each, disagreements resolved
- [ ] All three parts are valid JSON (paste into any JSON validator)
- [ ] **No record came from a real incident**

---

## 8. The scoring harness is already built and working

You only need to produce the dataset. Everything that consumes it exists:

- `backend/scripts/ai-evaluate.php` — the scoring harness
- `backend/services/ai/RegexRedactor.php` — the baseline comparator
- `backend/fixtures/redaction-eval-sample.json` — 10 invented records used
  to prove the harness scores correctly. **It is not the evaluation set**,
  but it IS a worked example of the exact format described above — copy its
  shape.

The only missing piece is `backend/fixtures/redaction-eval-v1.json`, the
merged 200 records. That's your job.

### The baseline number already exists

The regex comparator needs no model, so it has already been run against the
10-record sample:

```
php scripts/ai-evaluate.php --engine=baseline     --dataset=fixtures/redaction-eval-sample.json --dry-run --verbose
```

```
Entities:  TP=9 FN=14 FP=0
Recall:    39.13%   (target >= 95%)
Precision: 100.00%  (target >= 90%)
```

Every single miss was a NAME or an ADDRESS; regex caught every phone,
email, ID number, plate and birth date. **That is the finding the capstone
needs** — it is the concrete evidence that a pattern list cannot do this
job and a language model is required. Expect the same shape on the real
200: high precision, poor recall, failing almost entirely on names and
addresses.

### Running it once the dataset exists

```bash
# baseline — instant, any machine
php scripts/ai-evaluate.php --engine=baseline --dataset=fixtures/redaction-eval-v1.json

# the model — slow (minutes per record on CPU); sample first
php scripts/ai-evaluate.php --engine=model --limit=5 --verbose
php scripts/ai-evaluate.php --engine=model
```

Both write to `ai_evaluation_run`, keyed so a re-run updates its own row
rather than duplicating. `--dry-run` prints without writing. The model run
needs the machine that can actually run SEA-LION at a reasonable speed;
building the dataset needs nothing but writing, and can start immediately.
