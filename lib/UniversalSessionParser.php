<?php

class UniversalSessionParser
{
    private const BOOLEAN_VALUES = ['true' => true, 'false' => false];
    private const DATE_PATTERNS  = ['date', 'since', 'expir', 'renew', 'payment', 'created', 'updated'];
    private const COOKIE_FIELDS  = ['NetflixId', 'SecureNetflixId'];

    public static function parse(string $raw): ?array
    {
        $raw = trim($raw);
        if ($raw === '') {
            return null;
        }

        $format = self::detectFormat($raw);
        $result = match ($format) {
            'raw_cookie' => self::parseRawCookie($raw),
            'multiline'  => self::parseMultiline($raw),
            default      => self::parsePipe($raw),
        };

        if (count($result) === 0 || (count($result) === 1 && $result[0]['type'] === 'header')) {
            return null;
        }

        return $result;
    }

    public static function detectFormat(string $raw): string
    {
        $lines = explode("\n", $raw);
        $nonEmpty = array_filter($lines, fn($l) => trim($l) !== '');

        if (count($nonEmpty) <= 1 && preg_match('/^[A-Za-z_]\w*=/', trim($raw)) && !preg_match('/\|/', $raw)) {
            $pairs = array_filter(preg_split('/;\s*/', trim($raw)), fn($p) => trim($p) !== '');
            $cookieCount = 0;
            foreach ($pairs as $p) {
                if (preg_match('/^[A-Za-z_]\w*=/', trim($p))) $cookieCount++;
            }
            if ($cookieCount >= 1 && $cookieCount === count($pairs)) {
                return 'raw_cookie';
            }
        }

        $kvLines = array_filter($nonEmpty, fn($l) => preg_match('/[A-Za-z].*[:=]/', $l));
        if (count($kvLines) >= 2) {
            return 'multiline';
        }

        return 'pipe';
    }

    private static function parseRawCookie(string $raw): array
    {
        require_once __DIR__ . '/CookieEngine.php';
        return CookieEngine::parseRawCookieString($raw);
    }

    private static function parseMultiline(string $raw): array
    {
        $lines  = explode("\n", $raw);
        $result = [];

        foreach ($lines as $line) {
            $trimmed = trim($line);
            if ($trimmed === '') continue;

            if (!preg_match('/([A-Za-z][A-Za-z0-9 _]*?)\s*[:=]\s*(.+)$/u', $trimmed, $m)) {
                continue;
            }

            $key = trim(self::stripEmojis($m[1]));
            $key = preg_replace('/\s+/', '', $key);
            $rawValue = trim($m[2]);

            if (!$key) continue;

            $keyLower = strtolower($key);

            if ($keyLower === 'cookie' || $keyLower === 'cookies') {
                $pairs = preg_split('/;\s*/', $rawValue);
                foreach ($pairs as $pair) {
                    $eqPos = strpos($pair, '=');
                    if ($eqPos === false) continue;
                    $ck = trim(substr($pair, 0, $eqPos));
                    $cv = trim(substr($pair, $eqPos + 1));
                    if (in_array($ck, self::COOKIE_FIELDS, true)) {
                        $result[] = [
                            'key'      => $ck,
                            'rawValue' => $cv,
                            'value'    => urldecode($cv),
                            'type'     => 'cookie',
                        ];
                    }
                }
                continue;
            }

            if (str_contains($keyLower, 'directloginurl') || str_contains($keyLower, 'loginurl') || $keyLower === 'directlogin') {
                $result[] = [
                    'key'      => 'DirectLoginURL',
                    'rawValue' => $rawValue,
                    'value'    => $rawValue,
                    'type'     => 'url',
                ];
                if (preg_match('/[?&]nftoken=([^&\s]+)/i', $rawValue, $tm)) {
                    $tokenVal = str_contains($tm[1], '%') ? rawurldecode($tm[1]) : $tm[1];
                    $result[] = [
                        'key'      => 'nftoken',
                        'rawValue' => $tm[1],
                        'value'    => $tokenVal,
                        'type'     => 'token',
                    ];
                }
                continue;
            }

            $decoded = str_contains($rawValue, '%') ? urldecode($rawValue) : $rawValue;
            $value   = $decoded;
            $type    = 'string';

            if (in_array($key, self::COOKIE_FIELDS, true)) {
                $type = 'cookie';
            } else {
                $stripped = self::stripEmojis($decoded);
                $lower    = strtolower($stripped);

                if (array_key_exists($lower, self::BOOLEAN_VALUES)) {
                    $value = self::BOOLEAN_VALUES[$lower];
                    $type  = 'boolean';
                } elseif (self::isDateField($key)) {
                    $parsed = self::parseDate($stripped);
                    if ($parsed !== null) {
                        $value = $parsed;
                        $type  = 'date';
                    }
                } elseif (preg_match('/^-?\d+$/', $stripped) && strlen($stripped) > 0 && strlen($stripped) < 16 && !str_starts_with(trim($rawValue), '+')) {
                    $value = (int) $stripped;
                    $type  = 'number';
                }
            }

            $result[] = [
                'key'      => $key,
                'rawValue' => $rawValue,
                'value'    => $value,
                'type'     => $type,
            ];
        }

        return $result;
    }

    private static function parsePipe(string $raw): array
    {
        $result  = [];
        $workStr = $raw;

        if (preg_match('/^(\d{5,}:[^\s|;=]+)/', $workStr, $hm)) {
            $result[] = [
                'key'      => 'AccountCredentials',
                'rawValue' => $hm[1],
                'value'    => $hm[1],
                'type'     => 'header',
            ];
            $workStr = substr($workStr, strlen($hm[0]));
        } elseif (preg_match('/^([^\s|;=]+:[^\s|;=]+)/', $workStr, $hm) && strpos($hm[1], '=') === false) {
            $result[] = [
                'key'      => 'AccountCredentials',
                'rawValue' => $hm[1],
                'value'    => $hm[1],
                'type'     => 'header',
            ];
            $workStr = substr($workStr, strlen($hm[0]));
        }

        $pattern = '/(?:^|[|;,\s])\s*([A-Za-z_]\w*)\s*[=:]\s*([^|;,]*?)(?=\s*[|;,]|$)/';

        if (preg_match_all($pattern, $workStr, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $m) {
                $key      = preg_replace('/\s+/', '', $m[1]);
                $rawValue = trim($m[2]);

                $decoded = str_contains($rawValue, '%') ? urldecode($rawValue) : $rawValue;

                $value = $decoded;
                $type  = 'string';

                if (in_array($key, self::COOKIE_FIELDS, true)) {
                    $type = 'cookie';
                } else {
                    $stripped = self::stripEmojis($decoded);
                    $lower    = strtolower($stripped);

                    if (array_key_exists($lower, self::BOOLEAN_VALUES)) {
                        $value = self::BOOLEAN_VALUES[$lower];
                        $type  = 'boolean';
                    } elseif (self::isDateField($key)) {
                        $parsed = self::parseDate($stripped);
                        if ($parsed !== null) {
                            $value = $parsed;
                            $type  = 'date';
                        }
                    } elseif (preg_match('/^-?\d+$/', $stripped) && strlen($stripped) > 0 && strlen($stripped) < 16 && !str_starts_with(trim($rawValue), '+')) {
                        $value = (int) $stripped;
                        $type  = 'number';
                    }
                }

                $result[] = [
                    'key'      => $key,
                    'rawValue' => $rawValue,
                    'value'    => $value,
                    'type'     => $type,
                ];
            }
        }

        return $result;
    }

    public static function toAssociative(array $data): array
    {
        $out = [];
        foreach ($data as $item) {
            $out[$item['key']] = $item['value'];
        }
        return $out;
    }

    public static function hasCookieTokens(array $data): bool
    {
        foreach ($data as $item) {
            if ($item['key'] === 'NetflixId') {
                return true;
            }
        }
        return false;
    }

    public static function getCookies(array $data): array
    {
        $cookies = [];
        foreach ($data as $item) {
            if ($item['type'] === 'cookie') {
                $cookies[$item['key']] = $item['value'];
            }
        }
        return $cookies;
    }

    public static function generateNetscape(array $data, string $domain = '.netflix.com'): ?string
    {
        $cookies = self::getCookies($data);
        if (empty($cookies)) {
            return null;
        }

        $domain = self::sanitizeDomain($domain);
        $expiry = time() + (365 * 24 * 60 * 60);

        $lines   = [];
        $lines[] = '# Netscape HTTP Cookie File';
        $lines[] = '# Generated by ClearOrbit Universal Session Parser';
        $lines[] = '# https://curl.se/docs/http-cookies.html';
        $lines[] = '';

        foreach ($cookies as $name => $val) {
            $lines[] = implode("\t", [$domain, 'TRUE', '/', 'TRUE', $expiry, $name, $val]);
        }

        return implode("\n", $lines);
    }

    public static function sanitizeDomain(string $domain): string
    {
        $domain = preg_replace('/[^a-zA-Z0-9.\-]/', '', $domain);
        if ($domain === '') {
            $domain = '.netflix.com';
        }
        return $domain;
    }

    private static function stripEmojis(string $value): string
    {
        return trim(preg_replace('/[\x{1F000}-\x{1FFFF}]|[\x{2600}-\x{27BF}]|[\x{FE00}-\x{FEFF}]|[\x{1F900}-\x{1F9FF}]|[\x{200D}\x{20E3}\x{FE0F}]|[\x{2702}-\x{27B0}]|[\x{E0020}-\x{E007F}]|[\x{2300}-\x{23FF}]/u', '', $value));
    }

    private static function isDateField(string $key): bool
    {
        $lower = strtolower($key);
        foreach (self::DATE_PATTERNS as $pattern) {
            if (str_contains($lower, $pattern)) {
                return true;
            }
        }
        return false;
    }

    private static function parseDate(string $raw): ?string
    {
        $raw = trim($raw);

        $formats = [
            'd-F-Y', 'd-M-Y', 'd/m/Y', 'Y-m-d', 'd-m-Y', 'F d, Y', 'M d, Y',
        ];

        foreach ($formats as $fmt) {
            $dt = DateTimeImmutable::createFromFormat($fmt, $raw);
            if ($dt !== false) {
                return $dt->format('Y-m-d');
            }
        }

        $ts = strtotime($raw);
        if ($ts !== false && $ts > 0) {
            return date('Y-m-d', $ts);
        }

        return null;
    }
}
