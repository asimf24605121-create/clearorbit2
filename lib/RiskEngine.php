<?php

class RiskEngine
{
    public static function calculateRisk(array $cookies, ?string $accountCountry, ?string $userCountry): array
    {
        $score = 0;
        $flags = [];

        $hasNetflixId  = isset($cookies['NetflixId']) && !empty(trim($cookies['NetflixId']));
        $hasSecureId   = isset($cookies['SecureNetflixId']) && !empty(trim($cookies['SecureNetflixId']));

        if (!$hasNetflixId) {
            $score = 100;
            $flags[] = ['type' => 'critical', 'message' => 'No NetflixId cookie found — session is invalid'];
            return self::buildResult($score, $flags, $accountCountry, $userCountry);
        }

        $score += 20;
        $flags[] = ['type' => 'info', 'message' => 'NetflixId cookie detected'];

        if ($hasSecureId) {
            $score -= 10;
            $flags[] = ['type' => 'positive', 'message' => 'SecureNetflixId present — session strength improved'];
        } else {
            $score += 15;
            $flags[] = ['type' => 'warning', 'message' => 'SecureNetflixId missing — session may be incomplete'];
        }

        $acNorm = $accountCountry ? self::normalizeCountry($accountCountry) : null;
        $usNorm = $userCountry ? self::normalizeCountry($userCountry) : null;

        if ($acNorm && $usNorm && $acNorm !== $usNorm) {
            $score += 40;
            $flags[] = ['type' => 'warning', 'message' => "Geo mismatch: account is {$acNorm}, you are in {$usNorm}"];
        } elseif ($acNorm && $usNorm && $acNorm === $usNorm) {
            $score -= 5;
            $flags[] = ['type' => 'positive', 'message' => "Geo match: both in {$acNorm}"];
        }

        if ($hasNetflixId && strlen($cookies['NetflixId']) < 20) {
            $score += 20;
            $flags[] = ['type' => 'warning', 'message' => 'NetflixId cookie appears shorter than expected'];
        }

        $score = max(0, min(100, $score));

        return self::buildResult($score, $flags, $accountCountry, $userCountry);
    }

    private static function buildResult(int $score, array $flags, ?string $accountCountry, ?string $userCountry): array
    {
        if ($score <= 30) {
            $level   = 'LOW';
            $message = 'Cookie should work normally';
            $emoji   = '✅';
        } elseif ($score <= 60) {
            $level   = 'MEDIUM';
            $message = 'May require same region IP or VPN';
            $emoji   = '⚠️';
        } else {
            $level   = 'HIGH';
            $message = 'High chance of failure — verify source';
            $emoji   = '❌';
        }

        $acNorm = $accountCountry ? self::normalizeCountry($accountCountry) : 'unknown';
        $usNorm = $userCountry ? self::normalizeCountry($userCountry) : 'unknown';

        return [
            'risk_score' => $score,
            'risk_level' => $level,
            'message'    => $message,
            'emoji'      => $emoji,
            'geo'        => [
                'account_country' => $acNorm,
                'user_country'    => $usNorm,
                'match'           => ($acNorm !== 'unknown' && $usNorm !== 'unknown') ? ($acNorm === $usNorm) : null,
            ],
            'flags'      => $flags,
        ];
    }

    public static function normalizeCountry(string $country): string
    {
        $country = preg_replace('/[\x{1F000}-\x{1FFFF}]|[\x{2600}-\x{27BF}]|[\x{FE00}-\x{FEFF}]|[\x{1F900}-\x{1F9FF}]|[\x{200D}\x{20E3}\x{FE0F}]|[\x{2702}-\x{27B0}]|[\x{E0020}-\x{E007F}]|[\x{2300}-\x{23FF}]|[\x{1F1E0}-\x{1F1FF}]/u', '', $country);
        return strtolower(trim($country));
    }
}
