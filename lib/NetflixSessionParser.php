<?php

class NetflixSessionParser
{
    private const URL_DECODE_FIELDS = ['NetflixId', 'SecureNetflixId'];
    private const BOOLEAN_VALUES    = ['true' => true, 'false' => false];
    private const DATE_PATTERNS     = ['date', 'since', 'expir', 'renew', 'payment', 'created', 'updated'];

    public static function parse(string $raw): ?array
    {
        $raw = trim($raw);
        if ($raw === '') {
            return null;
        }

        $segments  = explode('|', $raw);
        $header    = trim(array_shift($segments));

        if ($header === '') {
            return null;
        }

        $result = [
            'AccountCredentials' => $header,
        ];

        foreach ($segments as $segment) {
            $segment = trim($segment);
            if ($segment === '') {
                continue;
            }

            $eqPos = strpos($segment, '=');
            if ($eqPos === false) {
                continue;
            }

            $key   = trim(substr($segment, 0, $eqPos));
            $value = trim(substr($segment, $eqPos + 1));

            $key   = self::normalizeKey($key);
            $value = self::castValue($key, $value);

            $result[$key] = $value;
        }

        if (!isset($result['NetflixId']) || $result['NetflixId'] === '') {
            return null;
        }

        return $result;
    }

    private static function normalizeKey(string $key): string
    {
        return preg_replace('/\s+/', '', $key);
    }

    private static function castValue(string $key, string $value): mixed
    {
        if (in_array($key, self::URL_DECODE_FIELDS, true)) {
            $value = urldecode($value);
        }

        $stripped = self::stripEmojis($value);

        $lower = strtolower($stripped);
        if (array_key_exists($lower, self::BOOLEAN_VALUES)) {
            return self::BOOLEAN_VALUES[$lower];
        }

        if (self::isDateField($key)) {
            $parsed = self::parseDate($stripped);
            if ($parsed !== $stripped) {
                return $parsed;
            }
        }

        if (ctype_digit($stripped) || (strlen($stripped) > 1 && $stripped[0] === '-' && ctype_digit(substr($stripped, 1)))) {
            return (int) $stripped;
        }

        return $value;
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

    private static function parseDate(string $raw): string
    {
        $raw = trim($raw);

        $formats = [
            'd-F-Y',
            'd-M-Y',
            'd/m/Y',
            'Y-m-d',
            'd-m-Y',
            'F d, Y',
            'M d, Y',
        ];

        foreach ($formats as $fmt) {
            $dt = DateTimeImmutable::createFromFormat($fmt, $raw);
            if ($dt !== false) {
                return $dt->format('Y-m-d');
            }
        }

        $ts = strtotime($raw);
        if ($ts !== false) {
            return date('Y-m-d', $ts);
        }

        return $raw;
    }

    public static function prettyPrint(array $data): string
    {
        $lines   = [];
        $maxKey  = 0;

        foreach ($data as $k => $v) {
            $maxKey = max($maxKey, mb_strlen($k));
        }

        foreach ($data as $k => $v) {
            $display = match (true) {
                is_bool($v)   => $v ? 'true' : 'false',
                is_int($v)    => (string) $v,
                is_null($v)   => '(null)',
                default        => (string) $v,
            };
            $lines[] = str_pad($k, $maxKey + 2) . ': ' . $display;
        }

        return implode("\n", $lines);
    }
}
