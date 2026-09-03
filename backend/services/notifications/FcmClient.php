<?php
declare(strict_types=1);

namespace Baranguard\Services\Notifications;

/**
 * FcmClient — the ONLY place this codebase talks to Firebase Cloud
 * Messaging. §1: "Firebase Cloud Messaging (FCM) HTTP v1 via backend
 * notification service." HTTP v1 (not the deprecated legacy server-key
 * API, which Google shut down in June 2024) means authenticating as a
 * service account: sign a short-lived JWT with the account's private key,
 * exchange it for an OAuth2 access token, then call
 * `https://fcm.googleapis.com/v1/projects/{project_id}/messages:send`
 * with that token. No Composer dependency exists in this repo (same
 * reasoning as Jwt.php), so both the JWT signing and the HTTP calls are
 * hand-rolled here against Google's documented contracts, using
 * `openssl_sign`/`curl` directly rather than the `firebase/php-jwt` or
 * `google/auth` packages.
 *
 * Configuration (see .env.example): FCM_SERVICE_ACCOUNT_PATH, a path to a
 * downloaded service-account JSON key file. The project id is read FROM
 * that file's own `project_id` field, not a separate env var — one fewer
 * place for the two to drift out of sync. UNSET means "this deployment
 * has no Firebase project wired up", which is what makes
 * `GET /system/health` report `fcm: not_configured` rather than
 * `unhealthy`, and what makes `NotificationDispatcher` skip straight to
 * SMS for every target — never a hard failure of the parent request
 * (§2 Rule 27/the SOS class doc: "a missing transport is never allowed to
 * fail the request").
 *
 * NEVER CALLED WITH REAL CREDENTIALS AS OF THIS COMMIT — there is no
 * funded Firebase project on this workstation. This class is written
 * against Google's real, documented v1 API contract so it starts working
 * the moment a service-account key is dropped in, exactly like
 * OllamaClient before the model was ever actually pulled. See DEVLOG.md.
 */
final class FcmClient
{
    private const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
    private const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
    private const CONNECT_TIMEOUT_SECONDS = 5;
    private const REQUEST_TIMEOUT_SECONDS = 8;

    private ?string $serviceAccountPath;
    /** @var array{project_id:string,client_email:string,private_key:string}|null|false null=not loaded yet, false=load failed */
    private array|null|false $account = null;

    /** In-process cache only — a fresh access token is fetched once per
     *  PHP process/request and reused for every target notified during it
     *  (an SOS may fan out to several recipients). No persistent cache is
     *  used: this is a stateless web request, and re-signing a JWT is
     *  cheap compared to the network round trips either way. */
    private static ?string $cachedAccessToken = null;
    private static int $cachedAccessTokenExpiresAt = 0;

    public function __construct(?string $serviceAccountPath = null)
    {
        $this->serviceAccountPath = $serviceAccountPath ?? (baranguard_env('FCM_SERVICE_ACCOUNT_PATH') ?: null);
    }

    public function isConfigured(): bool
    {
        return $this->loadAccount() !== false;
    }

    public function projectId(): ?string
    {
        $account = $this->loadAccount();
        return $account !== false ? $account['project_id'] : null;
    }

    /**
     * Sends one high-priority data+notification message to one device.
     *
     * @param array<string,string> $data string-only per FCM's own
     *        requirement — every `data` value must be a string, not a
     *        nested structure.
     * @return array{provider_message_id:string}
     * @throws FcmException on any failure — configuration, auth, or send.
     *         NotificationDispatcher treats every failure identically
     *         (Rule 12 does not distinguish failure causes for the
     *         "retry once, then SMS" rule), so this class does not need a
     *         second exception type the way OllamaClient does.
     */
    public function send(string $fcmToken, string $title, string $body, array $data): array
    {
        $account = $this->loadAccount();
        if ($account === false) {
            throw new FcmException('FCM is not configured (set FCM_SERVICE_ACCOUNT_PATH).');
        }

        $accessToken = $this->accessToken($account);

        $payload = [
            'message' => [
                'token' => $fcmToken,
                'notification' => ['title' => $title, 'body' => $body],
                'data' => $data,
                'android' => [
                    // Rule 5's "critical alerts use ... the app's
                    // notification/overlay behavior" needs the OS to wake
                    // the app promptly rather than batching delivery.
                    'priority' => 'high',
                ],
            ],
        ];

        $url = "https://fcm.googleapis.com/v1/projects/{$account['project_id']}/messages:send";
        $response = $this->httpJson('POST', $url, $payload, [
            'Authorization: Bearer ' . $accessToken,
            'Content-Type: application/json; charset=utf-8',
        ]);

        $name = $response['name'] ?? null; // "projects/{p}/messages/{message_id}"
        if (!is_string($name) || $name === '') {
            throw new FcmException('FCM accepted the request but returned no message name.');
        }

        return ['provider_message_id' => $name];
    }

    /**
     * @return array{project_id:string,client_email:string,private_key:string}|false
     */
    private function loadAccount(): array|false
    {
        if ($this->account !== null) {
            return $this->account;
        }
        if ($this->serviceAccountPath === null || trim($this->serviceAccountPath) === '') {
            $this->account = false;
            return false;
        }
        if (!is_readable($this->serviceAccountPath)) {
            $this->account = false;
            return false;
        }
        $raw = file_get_contents($this->serviceAccountPath);
        $decoded = is_string($raw) ? json_decode($raw, true) : null;
        if (
            !is_array($decoded)
            || !isset($decoded['project_id'], $decoded['client_email'], $decoded['private_key'])
            || !is_string($decoded['project_id'])
            || !is_string($decoded['client_email'])
            || !is_string($decoded['private_key'])
        ) {
            $this->account = false;
            return false;
        }
        $this->account = [
            'project_id' => $decoded['project_id'],
            'client_email' => $decoded['client_email'],
            'private_key' => $decoded['private_key'],
        ];
        return $this->account;
    }

    /**
     * @param array{project_id:string,client_email:string,private_key:string} $account
     * @throws FcmException
     */
    private function accessToken(array $account): string
    {
        $now = time();
        if (self::$cachedAccessToken !== null && $now < (self::$cachedAccessTokenExpiresAt - 30)) {
            return self::$cachedAccessToken;
        }

        $jwt = $this->buildSignedJwt($account);

        $response = $this->httpJson('POST', self::OAUTH_TOKEN_URL, [
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion' => $jwt,
        ], ['Content-Type: application/x-www-form-urlencoded'], asForm: true);

        $token = $response['access_token'] ?? null;
        $expiresIn = $response['expires_in'] ?? null;
        if (!is_string($token) || $token === '') {
            throw new FcmException('Google OAuth token exchange returned no access_token.');
        }

        self::$cachedAccessToken = $token;
        self::$cachedAccessTokenExpiresAt = $now + (is_int($expiresIn) ? $expiresIn : 3600);

        return $token;
    }

    /**
     * @param array{project_id:string,client_email:string,private_key:string} $account
     * @throws FcmException
     */
    private function buildSignedJwt(array $account): string
    {
        $now = time();
        $header = ['alg' => 'RS256', 'typ' => 'JWT'];
        $claims = [
            'iss' => $account['client_email'],
            'scope' => self::FCM_SCOPE,
            'aud' => self::OAUTH_TOKEN_URL,
            'iat' => $now,
            'exp' => $now + 3600,
        ];

        $segments = [
            self::base64UrlEncode((string) json_encode($header, JSON_UNESCAPED_SLASHES)),
            self::base64UrlEncode((string) json_encode($claims, JSON_UNESCAPED_SLASHES)),
        ];
        $signingInput = implode('.', $segments);

        $privateKey = openssl_pkey_get_private($account['private_key']);
        if ($privateKey === false) {
            throw new FcmException('FCM service-account private key could not be parsed.');
        }

        $signature = '';
        $signed = openssl_sign($signingInput, $signature, $privateKey, OPENSSL_ALGO_SHA256);
        if (!$signed) {
            throw new FcmException('Failed to sign the FCM service-account JWT.');
        }

        $segments[] = self::base64UrlEncode($signature);
        return implode('.', $segments);
    }

    private static function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    /**
     * @param array<string,mixed> $body
     * @param string[] $headers
     * @return array<string,mixed>
     * @throws FcmException
     */
    private function httpJson(string $method, string $url, array $body, array $headers, bool $asForm = false): array
    {
        if (!function_exists('curl_init')) {
            throw new FcmException('PHP ext-curl is required to reach FCM/Google OAuth.');
        }

        $handle = curl_init($url);
        if ($handle === false) {
            throw new FcmException('Could not initialise an HTTP request.');
        }

        curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($handle, CURLOPT_TIMEOUT, self::REQUEST_TIMEOUT_SECONDS);
        curl_setopt($handle, CURLOPT_CONNECTTIMEOUT, self::CONNECT_TIMEOUT_SECONDS);
        curl_setopt($handle, CURLOPT_HTTPHEADER, $headers);
        if ($method === 'POST') {
            curl_setopt($handle, CURLOPT_POST, true);
            $encoded = $asForm ? http_build_query($body) : (string) json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            curl_setopt($handle, CURLOPT_POSTFIELDS, $encoded);
        }

        $raw = curl_exec($handle);
        $errorNo = curl_errno($handle);
        $errorMessage = curl_error($handle);
        $httpStatus = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        if ($raw === false || $errorNo !== 0) {
            throw new FcmException("Could not reach {$url}: {$errorMessage}");
        }

        $decoded = json_decode((string) $raw, true);
        if ($httpStatus >= 400) {
            $message = is_array($decoded) && isset($decoded['error'])
                ? (is_array($decoded['error']) ? json_encode($decoded['error']) : (string) $decoded['error'])
                : "HTTP {$httpStatus}";
            throw new FcmException("Request to {$url} failed: {$message}");
        }
        if (!is_array($decoded)) {
            throw new FcmException("Request to {$url} returned a non-JSON response.");
        }
        return $decoded;
    }
}
