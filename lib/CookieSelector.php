<?php

class CookieSelector
{
    public static function scoreCookie(array $cookie, ?string $userCountry = null): array
    {
        $score = 0;
        $breakdown = [];

        $hasNid = !empty($cookie['netflix_id'] ?? '');
        $hasSid = !empty($cookie['secure_netflix_id'] ?? '');
        $acCountry = $cookie['account_country'] ?? null;
        $healthScore = $cookie['health_score'] ?? 100;
        $status = $cookie['status'] ?? 'active';
        $usageCount = $cookie['usage_count'] ?? 0;

        if ($hasNid) {
            $score += 50;
            $breakdown[] = ['rule' => 'has_netflix_id', 'points' => 50, 'label' => 'Has NetflixId'];
        }

        if ($hasSid) {
            $score += 20;
            $breakdown[] = ['rule' => 'has_secure_id', 'points' => 20, 'label' => 'Has SecureNetflixId'];
        }

        if ($userCountry && $acCountry) {
            $usNorm = strtolower(trim($userCountry));
            $acNorm = strtolower(trim($acCountry));
            if ($usNorm === $acNorm) {
                $score += 20;
                $breakdown[] = ['rule' => 'geo_match', 'points' => 20, 'label' => 'Geo match'];
            } else {
                $score -= 20;
                $breakdown[] = ['rule' => 'geo_mismatch', 'points' => -20, 'label' => 'Geo mismatch'];
            }
        }

        if ($status === 'cooldown') {
            $score -= 30;
            $breakdown[] = ['rule' => 'cooldown', 'points' => -30, 'label' => 'In cooldown'];
        } elseif ($status === 'dead') {
            $score -= 80;
            $breakdown[] = ['rule' => 'dead', 'points' => -80, 'label' => 'Marked dead'];
        } elseif ($status === 'locked') {
            $score -= 40;
            $breakdown[] = ['rule' => 'locked', 'points' => -40, 'label' => 'Currently locked'];
        }

        $healthBonus = round(($healthScore - 50) * 0.2);
        if ($healthBonus !== 0) {
            $score += $healthBonus;
            $breakdown[] = ['rule' => 'health_bonus', 'points' => $healthBonus, 'label' => "Health score: {$healthScore}"];
        }

        if ($usageCount > 20) {
            $penalty = min(15, round(($usageCount - 20) * 0.5));
            $score -= $penalty;
            $breakdown[] = ['rule' => 'heavy_usage', 'points' => -$penalty, 'label' => "High usage: {$usageCount} times"];
        }

        $score = max(0, min(100, $score));

        return [
            'cookie_score' => $score,
            'breakdown'    => $breakdown,
        ];
    }

    public static function selectBest(array $pool, ?string $userCountry = null): ?array
    {
        $candidates = [];

        foreach ($pool as $cookie) {
            if (($cookie['status'] ?? '') === 'dead') continue;
            if (($cookie['status'] ?? '') === 'cooldown') {
                $cooldownUntil = $cookie['cooldown_until'] ?? null;
                if ($cooldownUntil && strtotime($cooldownUntil) > time()) continue;
            }

            $scoreResult = self::scoreCookie($cookie, $userCountry);
            $candidates[] = [
                'cookie' => $cookie,
                'score'  => $scoreResult['cookie_score'],
                'breakdown' => $scoreResult['breakdown'],
            ];
        }

        if (empty($candidates)) return null;

        usort($candidates, fn($a, $b) => $b['score'] - $a['score']);

        return $candidates[0];
    }

    public static function rankPool(array $pool, ?string $userCountry = null): array
    {
        $ranked = [];

        foreach ($pool as $cookie) {
            $scoreResult = self::scoreCookie($cookie, $userCountry);
            $ranked[] = array_merge($cookie, [
                'cookie_score' => $scoreResult['cookie_score'],
                'score_breakdown' => $scoreResult['breakdown'],
            ]);
        }

        usort($ranked, fn($a, $b) => $b['cookie_score'] - $a['cookie_score']);

        return $ranked;
    }

    public static function analyzeFromParsed(array $cookies, array $classifiedFields, ?string $userCountry = null): array
    {
        $acCountry = null;
        foreach ($classifiedFields as $f) {
            $lower = strtolower($f['key']);
            if ((str_contains($lower, 'country') && !str_contains($lower, 'signup')) || str_contains($lower, 'region')) {
                $acCountry = is_string($f['value']) ? $f['value'] : null;
                break;
            }
        }

        $pseudoCookie = [
            'netflix_id'        => $cookies['NetflixId'] ?? '',
            'secure_netflix_id' => $cookies['SecureNetflixId'] ?? '',
            'account_country'   => $acCountry,
            'health_score'      => 100,
            'status'            => 'active',
            'usage_count'       => 0,
        ];

        $scoreResult = self::scoreCookie($pseudoCookie, $userCountry);

        $quality = 'unknown';
        if ($scoreResult['cookie_score'] >= 70) $quality = 'excellent';
        elseif ($scoreResult['cookie_score'] >= 50) $quality = 'good';
        elseif ($scoreResult['cookie_score'] >= 30) $quality = 'fair';
        else $quality = 'poor';

        return [
            'cookie_score' => $scoreResult['cookie_score'],
            'quality'      => $quality,
            'breakdown'    => $scoreResult['breakdown'],
        ];
    }
}
