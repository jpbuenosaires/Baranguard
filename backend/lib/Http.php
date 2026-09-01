<?php
declare(strict_types=1);

namespace Baranguard\Lib;

/**
 * Shared HTTP helpers: JSON body parsing, JSON responses, and the
 * standard error envelope. Master Reference §6 defines the standard error
 * *codes* (400 VALIDATION_ERROR, 401 UNAUTHORIZED, 403 FORBIDDEN,
 * 404 NOT_FOUND, 409 CONFLICT, 422 UNPROCESSABLE_ENTITY, 429 RATE_LIMITED,
 * 500 SERVER_ERROR, 503 SERVICE_UNAVAILABLE) but never states the exact
 * JSON envelope shape — that's a decision this file makes and every
 * future controller must reuse verbatim, not reinvent per-endpoint:
 *
 *   { "error": { "code": "UNAUTHORIZED", "message": "..." } }
 *
 * Logged as a resolved decision in DEVLOG.md.
 */
final class Http
{
    /** @return array<string,mixed> */
    public static function jsonBody(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === '' || $raw === false) {
            return [];
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new ApiError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
        }
        return $decoded;
    }

    public static function header(string $name): ?string
    {
        // Apache/PHP normalizes to HTTP_<UPPER_WITH_UNDERSCORES>; PHP-CLI's
        // built-in server (used for local dev/testing) does the same.
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        $value = $_SERVER[$key] ?? null;
        return is_string($value) && $value !== '' ? $value : null;
    }

    public static function bearerToken(): ?string
    {
        $auth = self::header('Authorization');
        if ($auth === null || !str_starts_with($auth, 'Bearer ')) {
            return null;
        }
        $token = trim(substr($auth, strlen('Bearer ')));
        return $token !== '' ? $token : null;
    }

    /** @param array<string,mixed> $body */
    public static function send(int $status, array $body): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function sendError(ApiError $error): never
    {
        self::send($error->status, [
            'error' => [
                'code' => $error->errorCode,
                'message' => $error->getMessage(),
            ],
        ]);
    }
}
