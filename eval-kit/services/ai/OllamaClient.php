<?php
declare(strict_types=1);

namespace Baranguard\Services\Ai;

/**
 * OllamaClient — the ONLY place this codebase talks to the local SLM.
 *
 * §1: "Llama-SEA-LION-v3.5-8B-R via Ollama, self-hosted on the unified
 * administrative workstation — **never** an external AI API." §2 Rule 1:
 * raw narrative "may be processed only by the local SLM/redaction service"
 * and "must never be sent to ... a cloud AI API". Both are structural
 * here, not aspirational: this client only ever posts to the URL in
 * `OLLAMA_URL`, and there is no fallback branch anywhere in this class
 * that could reach a hosted provider. If a future change adds one, it
 * violates Rule 1 outright.
 *
 * Configuration (see .env.example):
 *   OLLAMA_URL             e.g. http://127.0.0.1:11434  — UNSET means
 *                          "this deployment has never wired up Ollama",
 *                          which is what makes /system/health report
 *                          `not_configured` rather than `unhealthy` (§6's
 *                          own distinction). Deliberately NOT defaulted to
 *                          localhost: a default would make every
 *                          deployment claim to be configured.
 *   OLLAMA_MODEL           e.g. aisingapore/Llama-SEA-LION-v3.5-8B-R
 *   OLLAMA_TIMEOUT_SECONDS generation timeout (default 300 — an 8B model
 *                          on CPU is slow, and a redaction job that takes
 *                          three minutes is normal, not a hang).
 *
 * Two distinct failure modes, deliberately not collapsed into one (see
 * each exception's own doc): `OllamaUnavailableException` = requeue the
 * job; `OllamaException` = fail the job.
 */
final class OllamaClient
{
    /** Health/ping calls get a short timeout — this runs inside a web request. */
    private const PING_TIMEOUT_SECONDS = 3;
    private const DEFAULT_GENERATE_TIMEOUT_SECONDS = 300;

    private string $baseUrl;
    private string $model;
    private int $generateTimeout;

    public function __construct(?string $baseUrl = null, ?string $model = null, ?int $generateTimeout = null)
    {
        $this->baseUrl = rtrim($baseUrl ?? (string) (baranguard_env('OLLAMA_URL') ?: ''), '/');
        $this->model = $model ?? (string) (baranguard_env('OLLAMA_MODEL') ?: '');
        $this->generateTimeout = $generateTimeout
            ?? (int) (baranguard_env('OLLAMA_TIMEOUT_SECONDS') ?: self::DEFAULT_GENERATE_TIMEOUT_SECONDS);
    }

    /**
     * False when this deployment has never wired Ollama up at all — the
     * `not_configured` case in §6's three-state health contract, as
     * opposed to `unhealthy` (configured but failing its check).
     */
    public function isConfigured(): bool
    {
        return $this->baseUrl !== '' && $this->model !== '';
    }

    public function model(): string
    {
        return $this->model;
    }

    /**
     * Lists the models actually pulled on this workstation
     * (`GET /api/tags`). Used by the health check because it proves two
     * things at once in a single cheap call: the service is up, AND the
     * configured model is really present — a running Ollama with the
     * model not yet pulled would otherwise look "healthy" right up until
     * the first real job fails.
     *
     * @return string[] model names as Ollama reports them
     * @throws OllamaUnavailableException when the service can't be reached
     * @throws OllamaException when it responds with something unusable
     */
    public function listModels(): array
    {
        $payload = $this->request('GET', '/api/tags', null, self::PING_TIMEOUT_SECONDS);
        $models = [];
        foreach (($payload['models'] ?? []) as $entry) {
            if (isset($entry['name']) && is_string($entry['name'])) {
                $models[] = $entry['name'];
            }
        }
        return $models;
    }

    /**
     * True when the configured model is among the pulled ones. Ollama
     * reports names with an explicit tag (`repo/model:latest`), while
     * OLLAMA_MODEL is usually written without one, so an exact string
     * comparison would produce a false negative on a perfectly good
     * install — compare on the pre-tag portion too.
     *
     * @param string[] $available
     */
    public function isModelAvailable(array $available): bool
    {
        foreach ($available as $name) {
            if ($name === $this->model) {
                return true;
            }
            $withoutTag = explode(':', $name, 2)[0];
            if ($withoutTag === explode(':', $this->model, 2)[0]) {
                return true;
            }
        }
        return false;
    }

    /**
     * Runs one non-streaming completion.
     *
     * `stream: false` is required — this is a batch/queue worker, not a
     * chat UI, and a streamed body would arrive as newline-delimited JSON
     * objects rather than one parseable document.
     *
     * Temperature is pinned low (0.1): for redaction, a "creative" model
     * that paraphrases or invents detail is actively harmful — the task
     * is to remove identifiers from real text, not to rewrite it.
     *
     * @return array{text:string,model:string} `model` is what the SERVER
     *         reported it actually ran, which is what Rule 16 requires be
     *         recorded — not merely what we asked for.
     * @throws OllamaUnavailableException|OllamaException
     */
    public function generate(string $prompt): array
    {
        if (!$this->isConfigured()) {
            throw new OllamaUnavailableException('Ollama is not configured (set OLLAMA_URL and OLLAMA_MODEL).');
        }

        $payload = $this->request('POST', '/api/generate', [
            'model' => $this->model,
            'prompt' => $prompt,
            'stream' => false,
            'options' => ['temperature' => 0.1],
        ], $this->generateTimeout);

        $text = $payload['response'] ?? null;
        if (!is_string($text) || trim($text) === '') {
            // Service answered but produced nothing usable — a real
            // failure, not a connectivity problem, so the job should fail
            // rather than silently requeue forever.
            throw new OllamaException('Ollama returned an empty completion.');
        }

        return [
            'text' => $text,
            'model' => is_string($payload['model'] ?? null) ? $payload['model'] : $this->model,
        ];
    }

    /**
     * @param array<string,mixed>|null $body
     * @return array<string,mixed>
     * @throws OllamaUnavailableException|OllamaException
     */
    private function request(string $method, string $path, ?array $body, int $timeoutSeconds): array
    {
        if (!$this->isConfigured()) {
            throw new OllamaUnavailableException('Ollama is not configured (set OLLAMA_URL and OLLAMA_MODEL).');
        }
        if (!function_exists('curl_init')) {
            throw new OllamaException('PHP ext-curl is required to reach Ollama.');
        }

        $handle = curl_init($this->baseUrl . $path);
        if ($handle === false) {
            throw new OllamaException('Could not initialise an HTTP request to Ollama.');
        }

        curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($handle, CURLOPT_TIMEOUT, $timeoutSeconds);
        curl_setopt($handle, CURLOPT_CONNECTTIMEOUT, min(5, $timeoutSeconds));
        if ($method === 'POST') {
            curl_setopt($handle, CURLOPT_POST, true);
            curl_setopt($handle, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            curl_setopt($handle, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        }

        $raw = curl_exec($handle);
        $errorNo = curl_errno($handle);
        $errorMessage = curl_error($handle);
        $httpStatus = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if ($raw === false || $errorNo !== 0) {
            // Connection refused, DNS failure, timeout before any bytes —
            // all "the workstation's Ollama isn't answering", i.e. requeue.
            throw new OllamaUnavailableException("Could not reach Ollama: {$errorMessage}");
        }
        if ($httpStatus >= 500) {
            throw new OllamaUnavailableException("Ollama returned HTTP {$httpStatus}.");
        }
        if ($httpStatus >= 400) {
            // 404 here is typically "model not found" — a real, actionable
            // failure rather than a transient one.
            throw new OllamaException("Ollama rejected the request with HTTP {$httpStatus}.");
        }

        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded)) {
            throw new OllamaException('Ollama returned a non-JSON response.');
        }
        return $decoded;
    }
}
