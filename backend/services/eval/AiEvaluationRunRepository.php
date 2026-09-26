<?php
declare(strict_types=1);

namespace Baranguard\Services\Eval;

/**
 * AiEvaluationRunRepository — the single place that writes
 * `ai_evaluation_run` (docs/REMAINING.md A6, 2026-09-14 rebuild).
 *
 * Before this, the INSERT was raw SQL copy-pasted identically into BOTH
 * `backend/scripts/ai-evaluate.php` and `eval-kit/scripts/ai-evaluate.php`
 * (confirmed byte-identical, no shared class, while exploring this
 * rebuild) — a real, if harmless, duplication this factors out.
 *
 * Migration 0021 added `metric_a_name`/`metric_a_value`/`metric_b_name`/
 * `metric_b_value` alongside the original `precision_score`/
 * `recall_score` so tasks that aren't precision/recall-shaped
 * (summary's checklist pass rate, translation's human rating — and,
 * historically, classification's accuracy before it and the AI Tools
 * screen it lived on were removed, migration 0028) have somewhere
 * self-describing to go, without overloading what precision_score/
 * recall_score mean for `redaction`/`extraction`, which keep writing
 * those two columns exactly as before.
 */
final class AiEvaluationRunRepository
{
    public function __construct(private \PDO $pdo)
    {
    }

    /**
     * @param array{
     *   datasetName:string, datasetVersion:string, modelVersion:string,
     *   taskType:string, sampleCount:int, notes:string,
     *   precisionScore?:?float, recallScore?:?float,
     *   metricAName?:?string, metricAValue?:?float,
     *   metricBName?:?string, metricBValue?:?float,
     * } $run
     */
    public function record(array $run): void
    {
        // §5 UNIQUE(dataset_name, dataset_version, model_version, task_type)
        // — a re-run of the same combination REPLACES its result rather
        // than failing, since re-running an evaluation after a prompt
        // change is routine.
        $stmt = $this->pdo->prepare(
            'INSERT INTO ai_evaluation_run
                (dataset_name, dataset_version, model_version, task_type, sample_count,
                 precision_score, recall_score, metric_a_name, metric_a_value,
                 metric_b_name, metric_b_value, created_at, notes)
             VALUES
                (:dataset_name, :dataset_version, :model_version, :task_type, :sample_count,
                 :precision_score, :recall_score, :metric_a_name, :metric_a_value,
                 :metric_b_name, :metric_b_value, UTC_TIMESTAMP(), :notes)
             ON DUPLICATE KEY UPDATE
                sample_count = VALUES(sample_count),
                precision_score = VALUES(precision_score),
                recall_score = VALUES(recall_score),
                metric_a_name = VALUES(metric_a_name),
                metric_a_value = VALUES(metric_a_value),
                metric_b_name = VALUES(metric_b_name),
                metric_b_value = VALUES(metric_b_value),
                created_at = UTC_TIMESTAMP(),
                notes = VALUES(notes)'
        );
        $stmt->execute([
            'dataset_name' => $run['datasetName'],
            'dataset_version' => $run['datasetVersion'],
            'model_version' => $run['modelVersion'],
            'task_type' => $run['taskType'],
            'sample_count' => $run['sampleCount'],
            'precision_score' => isset($run['precisionScore']) ? round($run['precisionScore'], 5) : null,
            'recall_score' => isset($run['recallScore']) ? round($run['recallScore'], 5) : null,
            'metric_a_name' => $run['metricAName'] ?? null,
            'metric_a_value' => isset($run['metricAValue']) ? round($run['metricAValue'], 5) : null,
            'metric_b_name' => $run['metricBName'] ?? null,
            'metric_b_value' => isset($run['metricBValue']) ? round($run['metricBValue'], 5) : null,
            'notes' => $run['notes'],
        ]);
    }
}
