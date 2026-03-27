<?php

class LoginVerifier
{
    private const NETFLIX_BROWSE_URL = 'https://www.netflix.com/browse';
    private const NETFLIX_PROFILES_URL = 'https://www.netflix.com/api/shakti/mre/pathEvaluator';
    private const NETFLIX_BUILD_URL = 'https://www.netflix.com/buildIdentifier';

    private const PLATFORM_VERIFIERS = [
        '.netflix.com' => 'verifyNetflix',
    ];

    private const REQUIRED_TOKENS = [
        '.netflix.com' => ['NetflixId', 'SecureNetflixId'],
    ];

    private const CURL_TIMEOUT = 15;

    public static function verify(string $cookieData, string $domain = ''): array
    {
        $cookies = self::extractCookiesFromData($cookieData);
        if (empty($cookies)) {
            return self::result('INVALID', 'No cookies could be extracted from data.', []);
        }

        $normalizedDomain = self::normalizeDomain($domain);

        if (isset(self::REQUIRED_TOKENS[$normalizedDomain])) {
            $required = self::REQUIRED_TOKENS[$normalizedDomain];
            $cookieNames = array_map('strtolower', array_keys($cookies));
            foreach ($required as $token) {
                if (!in_array(strtolower($token), $cookieNames, true)) {
                    return self::result('INVALID', "Required token '{$token}' is missing.", [
                        'missing_token' => $token,
                        'available_tokens' => array_keys($cookies),
                    ]);
                }
                $val = self::getCookieValue($cookies, $token);
                if (empty(trim($val))) {
                    return self::result('INVALID', "Required token '{$token}' is empty.", [
                        'empty_token' => $token,
                    ]);
                }
            }
        }

        if (isset(self::PLATFORM_VERIFIERS[$normalizedDomain])) {
            $method = self::PLATFORM_VERIFIERS[$normalizedDomain];
            return self::$method($cookies);
        }

        return self::result('VALID', 'No platform-specific verification available. Token check passed.', [
            'method' => 'token_only',
        ]);
    }

    private static function verifyNetflix(array $cookies): array
    {
        $cookieHeader = self::buildCookieHeader($cookies);
        $checks = [];

        $browseResult = self::curlGet(self::NETFLIX_BROWSE_URL, $cookieHeader);

        if ($browseResult === null) {
            return self::result('PARTIAL', 'Could not reach Netflix servers for verification.', [
                'method' => 'http_verify',
                'error' => 'connection_failed',
            ]);
        }

        $checks['http_code'] = $browseResult['http_code'];
        $checks['final_url'] = $browseResult['final_url'];
        $checks['redirect_count'] = $browseResult['redirect_count'];

        $finalUrl = $browseResult['final_url'];
        $httpCode = $browseResult['http_code'];
        $body = $browseResult['body'];

        if (str_contains($finalUrl, '/login') || str_contains($finalUrl, '/Login')) {
            return self::result('INVALID', 'Redirected to Netflix login page. Cookies are not authenticated.', $checks);
        }

        if (str_contains($finalUrl, '/LoginHelp') || str_contains($finalUrl, '/password')) {
            return self::result('INVALID', 'Redirected to Netflix password reset. Session expired.', $checks);
        }

        if ($httpCode === 403 || $httpCode === 401) {
            return self::result('INVALID', "Netflix returned HTTP {$httpCode}. Access denied.", $checks);
        }

        if ($httpCode >= 500) {
            return self::result('PARTIAL', "Netflix returned server error (HTTP {$httpCode}). Try again later.", $checks);
        }

        if ($httpCode !== 200) {
            return self::result('PARTIAL', "Unexpected HTTP code: {$httpCode}.", $checks);
        }

        $domIndicators = [
            'profiles-gate-container',
            'profile-icon',
            'browse-content',
            'lolomo',
            'jawBone',
            'profilesGate',
            '"displayName"',
            'data-uia="profile',
            'continue-watching',
        ];

        $foundIndicators = [];
        foreach ($domIndicators as $indicator) {
            if (stripos($body, $indicator) !== false) {
                $foundIndicators[] = $indicator;
            }
        }
        $checks['dom_indicators_found'] = $foundIndicators;
        $checks['dom_indicator_count'] = count($foundIndicators);

        if (str_contains($finalUrl, '/browse') || str_contains($finalUrl, '/profiles')) {
            if (count($foundIndicators) >= 2) {
                return self::result('VALID', 'Full Netflix login verified. Profile UI detected.', $checks);
            }

            if (count($foundIndicators) >= 1) {
                return self::result('VALID', 'Netflix browse page loaded with partial UI indicators.', $checks);
            }

            return self::result('PARTIAL', 'Netflix browse page loaded but no profile UI elements detected.', $checks);
        }

        if (count($foundIndicators) >= 2) {
            return self::result('VALID', 'Netflix profile elements found in page content.', $checks);
        }

        $buildResult = self::curlGet(self::NETFLIX_BUILD_URL, $cookieHeader);
        if ($buildResult !== null && $buildResult['http_code'] === 200) {
            $buildBody = $buildResult['body'];
            if (!empty($buildBody) && str_starts_with(trim($buildBody), '{')) {
                $buildJson = @json_decode($buildBody, true);
                if (is_array($buildJson) && !empty($buildJson['BUILD_IDENTIFIER'] ?? null)) {
                    $checks['build_api_valid'] = true;
                    return self::result('VALID', 'Netflix build API responded with valid session.', $checks);
                }
            }
        }
        $checks['build_api_valid'] = false;

        return self::result('PARTIAL', 'Netflix page loaded but could not confirm full authentication.', $checks);
    }

    private static function extractCookiesFromData(string $cookieData): array
    {
        $cookieData = trim($cookieData);
        if ($cookieData === '') return [];

        $decoded = @base64_decode($cookieData, true);
        if ($decoded !== false && strlen($decoded) > 2) {
            $cookieData = $decoded;
        }

        $json = @json_decode($cookieData, true);
        $result = [];

        if (is_array($json) && !empty($json)) {
            foreach ($json as $c) {
                if (is_array($c) && !empty($c['name'])) {
                    $result[$c['name']] = $c['value'] ?? '';
                }
            }
            if (!empty($result)) return $result;
        }

        if (strpos($cookieData, '=') !== false) {
            $pairs = preg_split('/;\s*/', $cookieData);
            foreach ($pairs as $pair) {
                $pair = trim($pair);
                if ($pair === '') continue;
                $eqPos = strpos($pair, '=');
                if ($eqPos === false || $eqPos < 1) continue;
                $name = trim(substr($pair, 0, $eqPos));
                $value = trim(substr($pair, $eqPos + 1));
                $skipKeys = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'];
                if (in_array(strtolower($name), $skipKeys, true)) continue;
                $result[$name] = $value;
            }
        }

        return $result;
    }

    private static function buildCookieHeader(array $cookies): string
    {
        $pairs = [];
        foreach ($cookies as $name => $value) {
            $pairs[] = $name . '=' . $value;
        }
        return implode('; ', $pairs);
    }

    private static function curlGet(string $url, string $cookieHeader): ?array
    {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 10,
            CURLOPT_TIMEOUT => self::CURL_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_ENCODING => '',
            CURLOPT_HTTPHEADER => [
                'Cookie: ' . $cookieHeader,
                'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language: en-US,en;q=0.5',
                'Accept-Encoding: gzip, deflate, br',
                'Connection: keep-alive',
                'Upgrade-Insecure-Requests: 1',
                'Sec-Fetch-Dest: document',
                'Sec-Fetch-Mode: navigate',
                'Sec-Fetch-Site: none',
                'Sec-Fetch-User: ?1',
            ],
        ]);

        $body = curl_exec($ch);
        $err = curl_error($ch);

        if ($err || $body === false) {
            curl_close($ch);
            return null;
        }

        $info = curl_getinfo($ch);
        curl_close($ch);

        return [
            'http_code' => (int)$info['http_code'],
            'final_url' => $info['url'] ?? $url,
            'redirect_count' => (int)($info['redirect_count'] ?? 0),
            'body' => $body,
            'total_time' => $info['total_time'] ?? 0,
        ];
    }

    private static function getCookieValue(array $cookies, string $name): string
    {
        foreach ($cookies as $key => $val) {
            if (strcasecmp($key, $name) === 0) return $val;
        }
        return '';
    }

    private static function normalizeDomain(string $domain): string
    {
        $domain = strtolower(trim($domain));
        if ($domain !== '' && $domain[0] !== '.') {
            $domain = '.' . $domain;
        }
        return $domain;
    }

    private static function result(string $status, string $reason, array $checks): array
    {
        return [
            'login_status' => $status,
            'reason' => $reason,
            'checks' => $checks,
            'verified_at' => date('Y-m-d H:i:s'),
        ];
    }
}
