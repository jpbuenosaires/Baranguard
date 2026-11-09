<?php
declare(strict_types=1);

namespace Baranguard\Lib;

/**
 * Thrown by anything that wants to short-circuit straight to a standard
 * error response. Caught once, centrally, in public/index.php.
 *
 * Lives in its own file because the autoloader is one-class-per-file: code that
 * never touches `Http` (e.g. AuthMiddleware) can still `throw new ApiError(...)`.
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
