<?php
declare(strict_types=1);

namespace Baranguard\Services\Ai;

/**
 * RegexRedactor — the BASELINE comparator for the redaction evaluation
 * (§10: "target recall >=95%/precision >=90% on 200-record evaluation set
 * · baseline regex comparator").
 *
 * This is deliberately NOT a fallback redactor and must never be wired
 * into the real pipeline. Its only job is to answer "does the local SLM
 * actually beat plain pattern matching?" — a question the capstone has to
 * answer with numbers rather than assertion, because if regex scored just
 * as well, the whole self-hosted-model architecture would be
 * unjustified.
 *
 * IT IS EXPECTED TO SCORE BADLY ON NAMES AND ADDRESSES. That is the
 * point of the comparison, not a defect to fix: personal names in a
 * Filipino barangay narrative are ordinary capitalised words, and purok/
 * sitio addresses are free-form prose. No regex distinguishes
 * "Rosalinda Mercado" from "Barangay Dao" without a name list, and
 * maintaining such a list is precisely the brittleness the model is meant
 * to replace. The patterns below therefore cover only the categories
 * regex genuinely handles well — phone, email, ID number, plate, date of
 * birth — and leave [NAME]/[ADDRESS] to the model.
 *
 * Placeholders match AiPrompts::PLACEHOLDERS exactly so both sides of the
 * comparison are scored against the same closed vocabulary.
 */
final class RegexRedactor
{
    /**
     * Ordered patterns. Order matters: the ID-number pattern would
     * otherwise swallow parts of a phone number, so phone runs first.
     *
     * @var array<int, array{0:string,1:string}> [pattern, placeholder]
     */
    private const PATTERNS = [
        // Email — the one category regex is genuinely excellent at.
        ['/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/u', '[EMAIL]'],

        // Philippine mobile numbers: 09XXXXXXXXX, 0917-555-1234,
        // +63 917 555 1234, with optional spaces/dashes between groups.
        ['/(?:\+?63[\s\-]?|0)9\d{2}[\s\-]?\d{3}[\s\-]?\d{4}\b/u', '[PHONE]'],

        // Vehicle plates: 3 letters + 3-4 digits, optionally spaced/hyphened.
        ['/\b[A-Z]{3}[\s\-]?\d{3,4}\b/u', '[PLATE_NUMBER]'],

        // Government/company ID numbers: grouped digits like
        // 1234-5678-9012 or 12-3456789-0.
        ['/\b\d{2,4}[\s\-]\d{3,7}[\s\-]\d{1,7}\b/u', '[ID_NUMBER]'],

        // Dates of birth in the forms this dataset uses: "March 14, 1983",
        // "14 March 1983", "03/14/1983".
        ['/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/ui', '[DATE_OF_BIRTH]'],
        ['/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/ui', '[DATE_OF_BIRTH]'],
        ['/\b\d{1,2}\/\d{1,2}\/\d{4}\b/u', '[DATE_OF_BIRTH]'],
    ];

    /**
     * Applies the baseline patterns. Returns the redacted text — the
     * evaluation harness scores this exactly the way it scores the
     * model's output, so the two are directly comparable.
     */
    public static function redact(string $narrative): string
    {
        $output = $narrative;
        foreach (self::PATTERNS as [$pattern, $placeholder]) {
            $replaced = preg_replace($pattern, $placeholder, $output);
            if ($replaced !== null) {
                $output = $replaced;
            }
        }
        return $output;
    }
}
