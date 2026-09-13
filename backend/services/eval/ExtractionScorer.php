<?php
declare(strict_types=1);

namespace Baranguard\Services\Eval;

/**
 * ExtractionScorer — field-level exact-match scorer for `task_type=extraction`
 * (docs/REMAINING.md A6, 2026-09-14). No methodology existed for this task
 * before this rebuild — this is net-new, not a port.
 *
 * AiPrompts::extraction() returns EXACTLY three fixed lines:
 *   Complainant: <name or blank>
 *   Respondent: <name or blank>
 *   Contact: <phone number or blank>
 * so parsing is a fixed-format read, not free-text extraction — the
 * scorer's own job is only the field-by-field comparison against ground
 * truth (this evaluation dataset's own `complainant`/`respondent`/
 * `contact` fields, which are exactly the entity strings already used for
 * redaction, just labeled by role).
 *
 * Target (provisional, see the plan this session wrote): >=85%
 * exact-match accuracy PER FIELD — informed by adjacent NER/field-
 * extraction literature (92-96% F1 in clean conditions, lower on messy
 * text), not a direct benchmark for this exact task. A Secretary reviews
 * and edits this output before it becomes part of the record (§6), which
 * is why the bar is a normal accuracy target rather than redaction's
 * safety-critical recall floor.
 */
final class ExtractionScorer
{
    /**
     * @return array{complainant:string,respondent:string,contact:string}
     */
    public static function parseOutput(string $output): array
    {
        $fields = ['complainant' => '', 'respondent' => '', 'contact' => ''];
        foreach (explode("\n", $output) as $line) {
            $line = trim($line);
            if (preg_match('/^Complainant:\s*(.*)$/i', $line, $m)) {
                $fields['complainant'] = trim($m[1]);
            } elseif (preg_match('/^Respondent:\s*(.*)$/i', $line, $m)) {
                $fields['respondent'] = trim($m[1]);
            } elseif (preg_match('/^Contact:\s*(.*)$/i', $line, $m)) {
                $fields['contact'] = trim($m[1]);
            }
        }
        return $fields;
    }

    /**
     * @return array{complainant:bool,respondent:bool,contact:bool}
     */
    public static function score(string $goldComplainant, string $goldRespondent, string $goldContact, string $output): array
    {
        $parsed = self::parseOutput($output);
        return [
            'complainant' => self::fieldMatches($goldComplainant, $parsed['complainant']),
            'respondent' => self::fieldMatches($goldRespondent, $parsed['respondent']),
            'contact' => self::fieldMatches($goldContact, $parsed['contact']),
        ];
    }

    /**
     * A blank gold value matches only a blank (or explicitly "blank"/"none"-
     * worded) output — the model correctly recognizing there is nothing to
     * extract is as much a pass as a correct non-blank match.
     */
    private static function fieldMatches(string $gold, string $parsed): bool
    {
        $normalize = static fn (string $s): string => trim(mb_strtolower($s));
        $goldNorm = $normalize($gold);
        $parsedNorm = $normalize($parsed);

        if ($goldNorm === '') {
            return $parsedNorm === '' || in_array($parsedNorm, ['blank', 'none', 'n/a', '-'], true);
        }
        return $goldNorm === $parsedNorm;
    }
}
