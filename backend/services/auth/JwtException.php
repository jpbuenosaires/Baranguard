<?php
declare(strict_types=1);

namespace Baranguard\Services\Auth;

/**
 * Split into its own file for the same reason as Lib\ApiError — the
 * autoloader is one-class-per-file, and this was previously declared
 * alongside `Jwt` in Jwt.php, which only worked when something loaded
 * `Jwt` first as a side effect.
 */
final class JwtException extends \RuntimeException
{
}
