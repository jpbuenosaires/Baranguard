<?php
declare(strict_types=1);

namespace Baranguard\Services\Auth;

/**
 * Minimal HS256 JWT encode/decode. No Composer dependency (deliberately —
 * Sprint 0 never wired up a PHP package manager, and pulling one in just
 * for JWT felt like scope creep for what this needs: one algorithm, one
 * fixed claim shape). If a future sprint wants RS256/JWKS rotation, swap
 * this for firebase/php-jwt then — HS256 with a server-side secret is
 * enough for a single trusted local workstation (Master Reference §2
 * Rule 7/19: locally hosted, no cloud deployment in scope).
 *
 * Master Reference §2 Rule 9: JWTs expire in 15 minutes, carry a unique
 * `jti` mapped to one auth_session row, and every authenticated request
 * verifies signature, allowed algorithm, expiry, session existence,
 * session revocation, user activation, and tenant identity. This class
 * only does the signature/algorithm/expiry part — AuthMiddleware does the
 * rest (session/user/tenant checks) against the database.
 */
final class Jwt
{
    public const ALG = 'HS256';

    /** @param array<string,mixed> $claims */
    public static function encode(array $claims, string $secret): string
    {
        $header = ['alg' => self::ALG, 'typ' => 'JWT'];
        $segments = [
            self::base64UrlEncode(json_encode($header, JSON_UNESCAPED_SLASHES)),
            self::base64UrlEncode(json_encode($claims, JSON_UNESCAPED_SLASHES)),
        ];
        $signingInput = implode('.', $segments);
        $signature = hash_hmac('sha256', $signingInput, $secret, true);
        $segments[] = self::base64UrlEncode($signature);
        return implode('.', $segments);
    }

    /**
     * Verifies signature + `alg` + `exp`/`nbf` only. Throws JwtException on
     * any failure — callers never get a partially-trusted payload back.
     *
     * @return array<string,mixed>
     */
    public static function decode(string $token, string $secret): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new JwtException('Malformed token');
        }
        [$headerB64, $claimsB64, $sigB64] = $parts;

        $header = json_decode(self::base64UrlDecode($headerB64), true);
        if (!is_array($header) || ($header['alg'] ?? null) !== self::ALG || ($header['typ'] ?? null) !== 'JWT') {
            // Explicit algorithm allow-list — never trust an attacker-chosen
            // `alg` (e.g. "none").
            throw new JwtException('Unsupported or missing algorithm');
        }

        $expectedSig = hash_hmac('sha256', "{$headerB64}.{$claimsB64}", $secret, true);
        $actualSig = self::base64UrlDecode($sigB64);
        if (!hash_equals($expectedSig, $actualSig)) {
            throw new JwtException('Invalid signature');
        }

        $claims = json_decode(self::base64UrlDecode($claimsB64), true);
        if (!is_array($claims)) {
            throw new JwtException('Malformed claims');
        }

        $now = time();
        if (isset($claims['exp']) && $now >= (int) $claims['exp']) {
            throw new JwtException('Token expired');
        }
        if (isset($claims['nbf']) && $now < (int) $claims['nbf']) {
            throw new JwtException('Token not yet valid');
        }

        return $claims;
    }

    private static function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function base64UrlDecode(string $data): string
    {
        $padded = str_pad($data, strlen($data) % 4 === 0 ? strlen($data) : strlen($data) + (4 - strlen($data) % 4), '=');
        $decoded = base64_decode(strtr($padded, '-_', '+/'), true);
        if ($decoded === false) {
            throw new JwtException('Invalid base64url segment');
        }
        return $decoded;
    }
}
