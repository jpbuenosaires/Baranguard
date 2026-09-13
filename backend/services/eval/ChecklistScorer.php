<?php
declare(strict_types=1);

namespace Baranguard\Services\Eval;

use Baranguard\Services\Ai\AiPrompts;

/**
 * ChecklistScorer — generic constraint-checklist primitives, reused by
 * every open-ended generation task (summary, translation, blotter-assist,
 * sms-compose, threat-analysis — docs/REMAINING.md A6, 2026-09-14).
 *
 * WHY A CHECKLIST INSTEAD OF A SINGLE ACCURACY NUMBER: modern practice for
 * evaluating constrained LLM generation decomposes a prompt's own stated
 * rules into independently-checkable YES/NO items and reports a
 * compliance rate (TICK-style — see the plan this session wrote), rather
 * than inventing one aggregate "quality" score. This is directly
 * actionable here because every prompt in AiPrompts.php already states
 * its constraints as explicit rules (character/sentence limits, an exact
 * placeholder vocabulary, "never invent a fact not given," fixed section
 * headers) — the checks below are direct translations of rules already
 * written there, not new requirements invented for testing.
 *
 * WHY NOT AN LLM-AS-JUDGE: documented self-preference bias makes a model
 * judging its own output actively misleading, not neutral, and a
 * DIFFERENT judge model would need either a second local model (this
 * CPU-bound workstation already struggles with ONE, per A2) or an
 * external API call, which conflicts with §2 Rule 5's zero-external-AI
 * architecture. The genuinely subjective residue (prose fluency, tone)
 * that these mechanical checks cannot reach is deliberately left to a
 * small human-rated sample instead — see each task's own dispatch logic
 * in ai-evaluate.php for what is NOT covered here.
 *
 * Every method here is a single YES/NO primitive. Task-specific
 * "which checks apply, and with what parameters" wiring lives in
 * ai-evaluate.php's per-task dispatch, not in this class — this class
 * stays a reusable, task-agnostic primitive library.
 */
final class ChecklistScorer
{
    /**
     * Every placeholder token present in $source also appears in $output,
     * with the same per-type COUNT (not just "at least one") — catches
     * both a dropped placeholder and an invented one. Used by summary,
     * translation, and blotter-assist, all of which are told to "keep
     * every placeholder exactly as it appears."
     */
    public static function placeholderCountsMatch(string $source, string $output): bool
    {
        foreach (AiPrompts::PLACEHOLDERS as $placeholder) {
            if (substr_count($source, $placeholder) !== substr_count($output, $placeholder)) {
                return false;
            }
        }
        return true;
    }

    /** Rough sentence count via terminal punctuation — good enough for a length-band check, not linguistic analysis. */
    public static function sentenceCount(string $text): int
    {
        $text = trim($text);
        if ($text === '') {
            return 0;
        }
        $count = preg_match_all('/[.!?]+(?:\s|$)/u', $text);
        // A final sentence with no trailing punctuation still counts as one.
        return max($count, 1);
    }

    public static function sentenceCountInRange(string $text, int $min, int $max): bool
    {
        $n = self::sentenceCount($text);
        return $n >= $min && $n <= $max;
    }

    public static function charCountAtMost(string $text, int $max): bool
    {
        return mb_strlen(trim($text)) <= $max;
    }

    /**
     * No string in $denylist appears in $output (case-insensitive) — used
     * for "never recommend a penalty/settlement/legal conclusion"
     * (blotter-assist) and "no signature/sender name" (sms-compose).
     *
     * @param string[] $denylist
     */
    public static function noDenylistTerms(string $output, array $denylist): bool
    {
        foreach ($denylist as $term) {
            if (mb_stripos($output, $term) !== false) {
                return false;
            }
        }
        return true;
    }

    /**
     * Every fact in $facts appears somewhere in $output — a SOFT signal
     * (the prompt allows omitting a fact, it just must never INVENT one
     * that isn't given), reported as its own checklist item rather than
     * folded silently into a pass/fail that would misrepresent an
     * omission as equivalent to a fabrication.
     *
     * @param string[] $facts
     */
    public static function mentionsAllFacts(string $output, array $facts): bool
    {
        foreach ($facts as $fact) {
            if (mb_stripos($output, $fact) === false) {
                return false;
            }
        }
        return true;
    }

    /**
     * Extracts every standalone integer in $output and flags any that
     * does not match one of $knownCounts' actual values — the
     * grounding/no-hallucinated-number check for threat-analysis.
     *
     * KNOWN LIMITATION, disclosed rather than hidden (same spirit as
     * RedactionScorer's own precision-approximation caveat): this is a
     * coincidence-prone heuristic, not span-aware — a small ordinal like
     * "at most three suggestions" would false-positive on "three" being
     * absent from the counts, which is why $ignoreNumbers exists (pass
     * small structural numbers like 1-3 that the prompt's OWN format
     * requires, e.g. "at most three patrol adjustments").
     *
     * @param array<int,array{label:string,count:int}> $knownCounts
     * @param int[] $ignoreNumbers
     * @return array{ok:bool,fabricated:int[]}
     */
    public static function numbersAreGrounded(string $output, array $knownCounts, array $ignoreNumbers = [1, 2, 3]): array
    {
        $known = array_map(static fn ($c) => (int) $c['count'], $knownCounts);
        preg_match_all('/\b\d+\b/', $output, $matches);
        $fabricated = [];
        foreach ($matches[0] as $numStr) {
            $n = (int) $numStr;
            if (in_array($n, $ignoreNumbers, true)) {
                continue;
            }
            if (!in_array($n, $known, true)) {
                $fabricated[] = $n;
            }
        }
        return ['ok' => $fabricated === [], 'fabricated' => array_values(array_unique($fabricated))];
    }

    public static function containsAllHeaders(string $output, array $headers): bool
    {
        foreach ($headers as $header) {
            if (mb_stripos($output, $header) === false) {
                return false;
            }
        }
        return true;
    }

    /** Counts bullet lines (a line starting with "-" or "*") under a rough single-section text. */
    public static function bulletCount(string $text): int
    {
        $count = 0;
        foreach (explode("\n", $text) as $line) {
            if (preg_match('/^\s*[-*]\s+/', $line)) {
                $count++;
            }
        }
        return $count;
    }

    /**
     * Runs a named set of boolean checks and returns a compliance summary.
     * Each entry in $checks is name => bool (already evaluated by the
     * caller) — this stays a pure aggregator so task-specific wiring is
     * visible in the caller, not hidden inside this class.
     *
     * @param array<string,bool> $checks
     * @return array{passed:int,total:int,rate:float,failed:string[]}
     */
    public static function summarize(array $checks): array
    {
        $total = count($checks);
        $failed = array_keys(array_filter($checks, static fn ($ok) => !$ok));
        $passed = $total - count($failed);
        return [
            'passed' => $passed,
            'total' => $total,
            'rate' => $total > 0 ? $passed / $total : 1.0,
            'failed' => $failed,
        ];
    }
}
