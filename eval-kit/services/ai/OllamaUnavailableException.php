<?php
declare(strict_types=1);

namespace Baranguard\Services\Ai;

/**
 * The local Ollama service could not be reached at all — not configured,
 * connection refused, DNS/socket failure, or a timeout before any
 * response arrived.
 *
 * §2 Rule 15: "If DB/API/OSRM/Ollama/GSM services are unavailable ... AI
 * jobs queue. No external AI fallback exists." So every catch site for
 * THIS exception must put the job back on the queue unchanged — never
 * mark it failed, and never reach for a cloud model (§1: "never an
 * external AI API", Rule 1).
 *
 * See OllamaException for the other half of that distinction.
 */
final class OllamaUnavailableException extends \RuntimeException
{
}
