<?php
declare(strict_types=1);

namespace Baranguard\Services\Eval;

/**
 * ClassificationScorer — exact-match scorer for `task_type=classification`
 * (docs/REMAINING.md A6, 2026-09-14). Net-new — no methodology existed
 * for this task before this rebuild.
 *
 * AiPrompts::classification() returns EXACTLY three fixed lines:
 *   Type: <one of 11 fixed incident types>
 *   Priority: <normal|high|critical>
 *   Reason: <one sentence>
 * "Reason" is not scored here — it's the one open-ended part of this
 * task's output and isn't claimed to be machine-checkable; a human
 * reading a sample of Reason lines is a separate, later step, not this
 * scorer's job.
 *
 * Targets (provisional, see the plan this session wrote): >=85% type
 * accuracy, >=80% priority accuracy — informed by adjacent
 * emergency/incident-classification literature (59-95% F1/accuracy
 * depending on category granularity; this project's 11 types/3
 * priorities is coarser than most cited benchmarks), not a direct
 * benchmark for this exact domain.
 */
final class ClassificationScorer
{
    /**
     * @return array{type:string,priority:string,reason:string}
     */
    public static function parseOutput(string $output): array
    {
        $fields = ['type' => '', 'priority' => '', 'reason' => ''];
        foreach (explode("\n", $output) as $line) {
            $line = trim($line);
            if (preg_match('/^Type:\s*(.*)$/i', $line, $m)) {
                $fields['type'] = trim(mb_strtolower($m[1]));
            } elseif (preg_match('/^Priority:\s*(.*)$/i', $line, $m)) {
                $fields['priority'] = trim(mb_strtolower($m[1]));
            } elseif (preg_match('/^Reason:\s*(.*)$/i', $line, $m)) {
                $fields['reason'] = trim($m[1]);
            }
        }
        return $fields;
    }

    /**
     * @return array{typeMatch:bool,priorityMatch:bool,predictedType:string,predictedPriority:string}
     */
    public static function score(string $goldType, string $goldPriority, string $output): array
    {
        $parsed = self::parseOutput($output);
        return [
            'typeMatch' => $parsed['type'] === mb_strtolower($goldType),
            'priorityMatch' => $parsed['priority'] === mb_strtolower($goldPriority),
            'predictedType' => $parsed['type'],
            'predictedPriority' => $parsed['priority'],
        ];
    }
}
