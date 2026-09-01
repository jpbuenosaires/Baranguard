<?php
declare(strict_types=1);

namespace Baranguard\Lib;

/**
 * Thrown by anything that wants to short-circuit straight to a standard
 * error response. Caught once, centrally, in public/index.php.
 *
 * Split into its own file (was previously declared alongside `Http` in
 * Http.php) because the autoloader is one-class-per-file: a bare
 * `throw new ApiError(...)` from code that never otherwise touches `Http`
 * (e.g. AuthMiddleware) would try to autoload lib/ApiError.php and fail if
 * this class weren't here — caught via a direct unit test of
 * AuthMiddleware, not the end-to-end HTTP tests, which happened to always
 * load Http first and masked it.
 */
class ApiError extends \RuntimeException
{
    // Named `errorCode` (not `code`) because Exception already declares a
    // non-readonly `$code` property — PHP won't let a subclass narrow that
    // to readonly, and reusing the parent's int `$code` would lose our
    // string codes like "VALIDATION_ERROR" anyway.
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }
}
