<?php
declare(strict_types=1);

namespace Baranguard\Services\Ai;

/**
 * AiPrompts — every prompt this system sends to the local SLM, in one
 * versioned place.
 *
 * Kept out of the worker and the controllers on purpose: §2 Rule 16 makes
 * the AI pipeline "ordered and versioned", and Sprint 6's evaluation
 * harness has to be able to say WHICH prompt produced a given
 * precision/recall number. A prompt edited inline in a worker loop would
 * silently invalidate every prior `ai_evaluation_run` without leaving a
 * trace; `PROMPT_VERSION` below is the trace.
 *
 * **Bump PROMPT_VERSION whenever any prompt text below changes.**
 *
 * PLACEHOLDER VOCABULARY is fixed and closed. Sprint 6's baseline regex
 * comparator scores the model against the same categories, so they have
 * to mean the same thing on both sides — an open-ended "replace PII with
 * something sensible" instruction would make the two incomparable.
 */
final class AiPrompts
{
    /** Bump on ANY prompt change below. Recorded alongside evaluation runs. */
    public const PROMPT_VERSION = 'v1-2026-09-03';

    /**
     * The closed placeholder set. Redaction output should contain only
     * these tokens where identifiers used to be.
     */
    public const PLACEHOLDERS = [
        '[NAME]',
        '[ADDRESS]',
        '[PHONE]',
        '[EMAIL]',
        '[ID_NUMBER]',
        '[DATE_OF_BIRTH]',
        '[PLATE_NUMBER]',
        '[ACCOUNT]',
    ];

    /**
     * Step 1 of Rule 16's pipeline: raw narrative -> redaction draft.
     *
     * This is the ONLY prompt that is ever given `raw_narrative`, and it
     * runs exclusively against the local model (Rule 1).
     */
    public static function redaction(string $rawNarrative): string
    {
        $placeholders = implode(', ', self::PLACEHOLDERS);

        return <<<PROMPT
        You are a records officer for a Philippine barangay. Your task is to remove personally identifying information from an incident narrative so the record can be stored and shared under the Data Privacy Act (RA 10173).

        Replace every piece of identifying information with one of these exact placeholders: {$placeholders}

        Rules you must follow:
        - Replace personal names of complainants, respondents, witnesses, and bystanders with [NAME]. Keep official roles (tanod, barangay captain, secretary) as plain words.
        - Replace house numbers, street names, purok/sitio names, and any other precise location that identifies a household with [ADDRESS]. Keep the barangay name and general landmarks.
        - Replace phone numbers with [PHONE], email addresses with [EMAIL], government or company ID numbers with [ID_NUMBER], birth dates with [DATE_OF_BIRTH], vehicle plate numbers with [PLATE_NUMBER], and bank or social media account identifiers with [ACCOUNT].
        - Keep everything else exactly as written: the sequence of events, times, incident type, injuries, property involved, and the language the narrative is written in. Do not translate.
        - Do not summarise, shorten, reword, or add any detail that is not in the original.
        - If there is no identifying information at all, return the narrative unchanged.

        Return ONLY the redacted narrative text. Do not add a preamble, explanation, notes, or quotation marks.

        Narrative:
        {$rawNarrative}
        PROMPT;
    }

    /**
     * Step 2 of Rule 16's pipeline: summary derived from THE DRAFT.
     *
     * Rule 16 is explicit — "Summary generation never reads raw text."
     * The parameter name says `draftRedacted` for that reason, and the
     * only caller (the worker / regenerate-summary) passes the redaction
     * draft, never `incident.raw_narrative`.
     */
    public static function summary(string $draftRedacted): string
    {
        return <<<PROMPT
        You are a records officer for a Philippine barangay. Summarise the following already-redacted incident narrative for a blotter entry.

        Rules you must follow:
        - Write 2 to 4 sentences.
        - Keep every placeholder exactly as it appears (for example [NAME], [ADDRESS]). Never invent a name or address to replace a placeholder.
        - State what happened, when, and what action was taken, in the order it occurred.
        - Do not add any fact that is not in the narrative below. Do not speculate about motive, fault, or outcome.
        - Write in the same language as the narrative below.

        Return ONLY the summary text. Do not add a preamble, explanation, notes, or quotation marks.

        Redacted narrative:
        {$draftRedacted}
        PROMPT;
    }

    /**
     * Post-approval translation (Rule 16: "Translation is a separate
     * post-approval job against the approved redacted text only").
     *
     * `bcl` (Bikol) is accepted because §6 lists it, but Rule 16 also says
     * "Bikol is treated as unvalidated until empirical testing is
     * completed" — the caller is responsible for surfacing that, see
     * AiDraftController::translate().
     */
    public static function translation(string $approvedRedacted, string $targetLanguage): string
    {
        $languageName = self::languageName($targetLanguage);

        return <<<PROMPT
        Translate the following redacted barangay incident record into {$languageName}.

        Rules you must follow:
        - Keep every placeholder exactly as it appears, unchanged and untranslated (for example [NAME], [ADDRESS]).
        - Preserve the meaning precisely. Do not summarise, shorten, or add detail.
        - Keep the same paragraph structure.

        Return ONLY the translated text. Do not add a preamble, explanation, notes, or quotation marks.

        Text:
        {$approvedRedacted}
        PROMPT;
    }

    /**
     * Electronic Blotter follow-up: extract complainant/respondent/
     * contact-number as structured fields, reviewed/edited by the
     * Secretary before becoming part of the finalized record (see
     * migration 0008). Independent of the redaction pipeline — same
     * relationship translation already has to it — so this runs against
     * **raw_narrative**, the same privileged input redaction() gets, not
     * the redacted draft (which has deliberately already stripped the
     * names this prompt needs).
     *
     * Not covered by `PROMPT_VERSION`: that constant tracks the
     * redaction/summary prompt wording specifically, because that's what
     * `ai-evaluate.php`'s dataset run measures. This prompt has its own,
     * separate concern (structured-field extraction, not PII redaction
     * quality) and no evaluation harness measures it yet.
     */
    public static function extraction(string $rawNarrative): string
    {
        return <<<PROMPT
        You are a records officer for a Philippine barangay. Read the incident narrative below and identify the complainant, the respondent, and a contact number if one is mentioned.

        Rules you must follow:
        - "Complainant" is the person who reported the incident or is the aggrieved party. "Respondent" is the person the complaint is against, if any.
        - Only use names and numbers that actually appear in the narrative. Never invent, guess, or infer a name or number that is not written there.
        - If the narrative does not name a complainant, respondent, or contact number, leave that line blank after the colon.
        - A narrative may have no identifiable respondent at all (for example a fire or an animal complaint) — that is expected, leave it blank.

        Return EXACTLY these three lines, in this order, and nothing else — no preamble, no explanation:
        Complainant: <name or blank>
        Respondent: <name or blank>
        Contact: <phone number or blank>

        Narrative:
        {$rawNarrative}
        PROMPT;
    }

    // ------------------------------------------------------------------
    // AI Tools (migration 0015). None is covered by PROMPT_VERSION — that
    // constant tracks redaction/summary wording because that is what
    // `ai-evaluate.php`'s dataset run measures, and none of these four is
    // measured by any harness yet. Say so plainly rather than implying an
    // evaluated number exists (§2 Rule 6).
    // ------------------------------------------------------------------

    /**
     * AI Blotter Assistant — drafts a formal case write-up a Secretary can
     * re-key into DILG BIMSS/KPIS, which is the mandated Katarungang
     * Pambarangay ledger.
     *
     * TAKES RAW NARRATIVE AND MUST THEREFORE REDACT AS IT WRITES. This is
     * the second prompt ever given `raw_narrative` (redaction() is the
     * other), and it exists because the handoff draft has to read as a
     * finished entry rather than as a placeholder-riddled excerpt. Its
     * output still goes only to a Secretary — the sole role §2 Rule 1
     * allows to see raw text at all — so the redaction here protects the
     * document once it leaves the screen, not the reader in front of it.
     */
    public static function blotterAssist(string $rawNarrative, string $incidentType): string
    {
        $placeholders = implode(', ', self::PLACEHOLDERS);

        return <<<PROMPT
        You are a records officer for a Philippine barangay. Draft a formal blotter entry from the incident narrative below, so it can be transcribed into the barangay's official case record.

        Rules you must follow:
        - Write 3 to 6 sentences in formal, factual language suitable for an official record.
        - State what happened, when, where in general terms, who was involved by role, and what action the barangay took.
        - Replace every piece of identifying information with one of these exact placeholders: {$placeholders}
        - Never invent a detail that is not in the narrative. Do not speculate about motive, fault, guilt, or outcome.
        - Do not recommend a penalty, a settlement, or any legal conclusion. That is for the Lupon to decide, not for this draft.
        - Write in the same language as the narrative below. Do not translate.

        The recorded incident type is: {$incidentType}

        Return ONLY the draft entry text. Do not add a preamble, explanation, notes, or quotation marks.

        Narrative:
        {$rawNarrative}
        PROMPT;
    }

    /**
     * Incident Classifier — suggests a type and priority for an incident.
     *
     * DELIBERATELY READS THE REDACTED NARRATIVE, NOT THE RAW ONE. That is
     * what keeps its output safe for an Admin to see: an Admin may run
     * this tool, and §2 Rule 1 puts raw text out of their reach. Feeding
     * it raw narrative would quietly turn an Admin-visible tool into a
     * raw-text leak.
     *
     * The output is a SUGGESTION for a human to accept or ignore — it is
     * never written to `incident` by any automatic path.
     */
    public static function classification(string $redactedNarrative, string $currentType, string $currentPriority): string
    {
        return <<<PROMPT
        You are assisting a barangay dispatcher in the Philippines. Read the already-redacted incident narrative below and suggest how it should be classified.

        Choose the incident type from exactly this list: theft, physical_injury, disturbance, domestic_dispute, vandalism, traffic_incident, fire, medical_emergency, missing_person, animal_complaint, other

        Choose the priority from exactly this list: normal, high, critical
        - critical means there is an immediate threat to life or a fire in progress.
        - high means injury, an ongoing confrontation, or a situation likely to escalate.
        - normal is everything else.

        Rules you must follow:
        - Base your answer only on what the narrative says. Placeholders like [NAME] or [ADDRESS] are redacted details, not missing information — do not treat them as suspicious or speculate about what they hid.
        - If the narrative does not support changing the current values, repeat the current ones.
        - Keep the reason to a single sentence quoting what in the narrative drove your choice.

        The incident is currently recorded as type "{$currentType}" with priority "{$currentPriority}".

        Return EXACTLY these three lines, in this order, and nothing else — no preamble, no explanation:
        Type: <one type from the list>
        Priority: <one priority from the list>
        Reason: <one sentence>

        Narrative:
        {$redactedNarrative}
        PROMPT;
    }

    /**
     * SMS Composer — drafts an alert/advisory message.
     *
     * TAKES ONLY OPERATOR-TYPED TEXT. NEVER A NARRATIVE, RAW OR REDACTED.
     * Its output is destined for Semaphore, an external gateway, and §2
     * Rule 1 forbids narrative content leaving the system through any
     * channel but the approved pipeline. The controller enforces this by
     * having no parameter that could carry an incident's text; this
     * docblock states the reason so the parameter is never "helpfully"
     * added later.
     */
    public static function smsCompose(string $operatorPrompt): string
    {
        return <<<PROMPT
        You are helping a barangay official in the Philippines write a short SMS advisory to residents.

        Rules you must follow:
        - Write at most 300 characters. SMS messages are billed per segment, so be brief.
        - Write in the mix of Filipino and English that barangay officials normally use with residents. Keep it plain and direct.
        - Say what is happening, what residents should do, and where to get help if that applies.
        - Do not include any personal name, house address, or phone number, even if the request below contains one.
        - Do not invent details such as times, place names, or casualty numbers that the request does not give you.
        - Do not add a signature, a sender name, or a disclaimer.

        Return ONLY the message text. Do not add a preamble, explanation, notes, or quotation marks.

        What the official wants to tell residents:
        {$operatorPrompt}
        PROMPT;
    }

    /**
     * Threat Analyzer — reads an aggregate incident summary and suggests
     * where patrols would help.
     *
     * TAKES COUNTS ONLY — never a narrative, never a person, and
     * deliberately not `location_description` either. That column is free
     * text an intake officer typed ("in front of the sari-sari store by
     * the Cruz house"), so it is identifying in practice even though it
     * is not a name field; the caller therefore groups by incident type
     * and time of day, which answers the scheduling question without it.
     *
     * The prompt forbids naming individuals or predicting who will offend
     * on purpose. This tool answers "when has this barangay been busy, and
     * with what" — a rostering question. It must not drift into profiling
     * residents.
     */
    public static function threatAnalysis(string $aggregateSummary, string $periodLabel): string
    {
        return <<<PROMPT
        You are assisting a barangay in the Philippines with patrol planning. Below is a statistical summary of recorded incidents for {$periodLabel}. It contains counts only — no names, no households.

        Rules you must follow:
        - Base every statement on the counts below. Never estimate, extrapolate, or state a number that is not shown.
        - Describe patterns by incident type, time of day, and day of week only. Never name or describe an individual, a household, or a family.
        - Never predict who will commit an offence. Do not describe any group of residents as a risk.
        - If the counts are too small to show a pattern, say so plainly instead of inventing one.
        - Suggest at most three patrol adjustments, each tied to a specific count you were given.

        Return your answer as these two sections and nothing else — no preamble:
        Patterns:
        - <one bullet per observed pattern, each citing a count>
        Suggested patrols:
        - <one bullet per suggestion, at most three>

        Incident summary for {$periodLabel}:
        {$aggregateSummary}
        PROMPT;
    }

    /** §6 translate body: `target_language: "en"|"fil"|"bcl"`. */
    public static function languageName(string $code): string
    {
        return match ($code) {
            'en' => 'English',
            'fil' => 'Filipino (Tagalog)',
            'bcl' => 'Central Bikol (Bikol Naga)',
            default => throw new \InvalidArgumentException("Unsupported target language: {$code}"),
        };
    }

    /**
     * Strips a reasoning model's chain-of-thought and common preamble
     * chatter from a completion.
     *
     * THIS IS NOT COSMETIC. §1 pins the model to
     * `Llama-SEA-LION-v3.5-8B-R` — the `-R` is the REASONING variant,
     * which routinely emits a `<think> ... </think>` block before its
     * actual answer. Storing that block verbatim into
     * `draft_redacted_narrative` would put the model's restatement of the
     * ORIGINAL, UNREDACTED narrative into the draft — i.e. the reasoning
     * trace can quote the exact names the redaction was supposed to
     * remove. That would defeat the entire pipeline and violate Rule 1,
     * so this runs on every completion before anything is persisted.
     *
     * Fails safe: if an opening `<think>` has no closing tag (a truncated
     * completion), everything up to and including the opener is dropped
     * rather than kept.
     */
    public static function stripReasoning(string $raw): string
    {
        $text = $raw;

        // Complete <think>...</think> blocks, however many.
        $text = preg_replace('#<think>.*?</think>#is', '', $text) ?? $text;
        // Unclosed opener (truncated output) — drop everything before it too.
        if (($openPos = stripos($text, '<think>')) !== false) {
            $text = substr($text, 0, $openPos);
        }
        // A stray closing tag with its opener already stripped: keep only
        // what follows it.
        if (($closePos = stripos($text, '</think>')) !== false) {
            $text = substr($text, $closePos + strlen('</think>'));
        }

        $text = trim($text);

        // Common "Here is the redacted narrative:" style preambles. Only
        // stripped when the line is short and ends in a colon, so a real
        // narrative line that happens to contain a colon survives.
        $lines = preg_split('/\R/', $text) ?: [];
        while ($lines !== []) {
            $first = trim((string) $lines[0]);
            if ($first !== '' && str_ends_with($first, ':') && mb_strlen($first) <= 80) {
                array_shift($lines);
                continue;
            }
            break;
        }
        $text = trim(implode("\n", $lines));

        // Whole-output wrapping quotes or a markdown code fence.
        if (preg_match('/^```[a-z]*\R(.*)\R```$/is', $text, $matches) === 1) {
            $text = trim($matches[1]);
        }
        if (mb_strlen($text) >= 2 && str_starts_with($text, '"') && str_ends_with($text, '"')) {
            $text = trim(mb_substr($text, 1, mb_strlen($text) - 2));
        }

        return $text;
    }
}
