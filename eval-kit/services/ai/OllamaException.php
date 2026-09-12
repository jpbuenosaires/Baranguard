<?php
declare(strict_types=1);

namespace Baranguard\Services\Ai;

/**
 * Ollama responded, but the response was unusable — malformed JSON, an
 * HTTP error status, an empty completion, or a model that isn't pulled.
 *
 * DELIBERATELY DISTINCT from `OllamaUnavailableException`, and the
 * distinction is the whole point: this one means the job genuinely
 * FAILED (retrying it unchanged will fail the same way), while
 * "unavailable" means the workstation/service was simply not reachable
 * and the job must go back on the queue untouched (§2 Rule 15: "AI jobs
 * queue. No external AI fallback exists.").
 *
 * Own file, not nested beside OllamaClient — this codebase already lost
 * time to exactly that mistake once (see DEVLOG's Sprint 1 entry: the
 * autoloader maps class name -> filename, so a second class in one file
 * only "works" by accident when something else loads that file first).
 */
final class OllamaException extends \RuntimeException
{
}
