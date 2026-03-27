<?php

class SessionManager
{
    public static function analyzeHealth(array $cookies, array $classifiedFields, ?array $geoAnalysis = null): array
    {
        $score = 100;
        $factors = [];

        $hasNetflixId = isset($cookies['NetflixId']) && !empty(trim($cookies['NetflixId']));
        $hasSecureId  = isset($cookies['SecureNetflixId']) && !empty(trim($cookies['SecureNetflixId']));

        if (!$hasNetflixId) {
            $score = 0;
            $factors[] = ['factor' => 'missing_primary', 'impact' => -100, 'label' => 'Primary session token missing'];
            return self::buildHealthResult($score, $factors);
        }

        $factors[] = ['factor' => 'has_primary', 'impact' => 0, 'label' => 'Primary session token present'];

        if ($hasSecureId) {
            $factors[] = ['factor' => 'has_secure', 'impact' => 0, 'label' => 'Secure token present — dual-layer auth'];
        } else {
            $score -= 15;
            $factors[] = ['factor' => 'missing_secure', 'impact' => -15, 'label' => 'Secure token missing — single-layer auth'];
        }

        if ($hasNetflixId && strlen($cookies['NetflixId']) < 20) {
            $score -= 20;
            $factors[] = ['factor' => 'short_token', 'impact' => -20, 'label' => 'Token length below expected minimum'];
        }

        if ($hasNetflixId && strlen($cookies['NetflixId']) > 100) {
            $factors[] = ['factor' => 'good_length', 'impact' => 0, 'label' => 'Token length is healthy'];
        }

        $hasUrl = false;
        $hasAccount = false;
        $hasPlan = false;
        foreach ($classifiedFields as $f) {
            if ($f['type'] === 'url') $hasUrl = true;
            if (($f['category'] ?? '') === 'identity' && $f['type'] === 'header') $hasAccount = true;
            if (str_contains(strtolower($f['key']), 'plan')) $hasPlan = true;
        }

        if ($hasUrl) {
            $score += 5;
            $factors[] = ['factor' => 'has_login_url', 'impact' => 5, 'label' => 'Direct login URL available — recovery option'];
        }

        if ($hasAccount) {
            $factors[] = ['factor' => 'has_credentials', 'impact' => 0, 'label' => 'Account credentials available'];
        }

        if ($geoAnalysis) {
            $geoRisk = $geoAnalysis['geo_risk']['score'] ?? 0;
            if ($geoRisk > 0) {
                $score -= $geoRisk;
                $factors[] = ['factor' => 'geo_penalty', 'impact' => -$geoRisk, 'label' => $geoAnalysis['geo_risk']['message'] ?? 'Geo risk detected'];
            } else if (($geoAnalysis['match']['exact_country'] ?? null) === true) {
                $score += 5;
                $factors[] = ['factor' => 'geo_bonus', 'impact' => 5, 'label' => 'Same country — no geo risk'];
            }
        }

        $score = max(0, min(100, $score));

        return self::buildHealthResult($score, $factors);
    }

    public static function estimateLifetime(int $healthScore, bool $hasSecureId, ?bool $geoMatch): array
    {
        $baseHours = 48;

        if ($healthScore >= 80) {
            $multiplier = $hasSecureId ? 3.0 : 2.0;
        } elseif ($healthScore >= 50) {
            $multiplier = $hasSecureId ? 2.0 : 1.5;
        } else {
            $multiplier = 1.0;
        }

        if ($geoMatch === true) {
            $multiplier *= 1.25;
        } elseif ($geoMatch === false) {
            $multiplier *= 0.6;
        }

        $estimatedHours = round($baseHours * $multiplier);

        if ($estimatedHours >= 120) {
            $level = 'HIGH';
            $label = "{$estimatedHours}h+ estimated remaining life";
        } elseif ($estimatedHours >= 48) {
            $level = 'MEDIUM';
            $label = "{$estimatedHours}h estimated remaining life";
        } else {
            $level = 'LOW';
            $label = "{$estimatedHours}h estimated — replace soon";
        }

        return [
            'level'           => $level,
            'estimated_hours' => $estimatedHours,
            'label'           => $label,
        ];
    }

    public static function getStabilityAdvice(int $healthScore, ?array $geoAnalysis = null): array
    {
        $tips = [];

        if ($healthScore < 40) {
            $tips[] = ['priority' => 'critical', 'tip' => 'Session health is critical — consider obtaining a fresh cookie'];
        }

        if ($geoAnalysis && ($geoAnalysis['recommendation']['vpn_needed'] ?? false)) {
            $ip = $geoAnalysis['recommendation']['suggested_ip'] ?? '';
            $tips[] = ['priority' => 'high', 'tip' => "Use a {$ip} IP/VPN for stable connection"];
        }

        $tips[] = ['priority' => 'normal', 'tip' => 'Keep browser activity within 5-10 minute intervals'];
        $tips[] = ['priority' => 'normal', 'tip' => 'Avoid concurrent logins from multiple devices'];
        $tips[] = ['priority' => 'normal', 'tip' => 'Do not clear browser cookies while session is active'];

        if ($healthScore >= 70) {
            $tips[] = ['priority' => 'info', 'tip' => 'Session appears stable — normal usage is safe'];
        }

        return $tips;
    }

    public static function getKeepAliveConfig(int $healthScore): array
    {
        if ($healthScore >= 80) {
            $interval = 600;
        } elseif ($healthScore >= 50) {
            $interval = 420;
        } else {
            $interval = 300;
        }

        $jitter = round($interval * 0.2);

        return [
            'enabled'      => true,
            'interval_sec' => $interval,
            'jitter_sec'   => $jitter,
            'min_interval' => $interval - $jitter,
            'max_interval' => $interval + $jitter,
            'idle_multiplier' => 2.0,
            'max_retries'  => 3,
        ];
    }

    private static function buildHealthResult(int $score, array $factors): array
    {
        if ($score >= 80) {
            $status = 'healthy';
            $emoji  = "\xF0\x9F\x9F\xA2";
            $label  = 'Healthy';
        } elseif ($score >= 50) {
            $status = 'unstable';
            $emoji  = "\xF0\x9F\x9F\xA1";
            $label  = 'Unstable';
        } else {
            $status = 'critical';
            $emoji  = "\xF0\x9F\x94\xB4";
            $label  = 'Critical';
        }

        return [
            'health_score' => $score,
            'status'       => $status,
            'status_emoji' => $emoji,
            'status_label' => $label,
            'factors'      => $factors,
        ];
    }

    public static function initSessionPool(PDO $pdo): void
    {
        $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
        if ($driver === 'sqlite') {
            $pdo->exec("CREATE TABLE IF NOT EXISTS session_pool (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                netflix_id         TEXT    NOT NULL,
                secure_netflix_id  TEXT    NULL,
                domain             TEXT    NOT NULL DEFAULT '.netflix.com',
                account_country    TEXT    NULL,
                health_score       INTEGER NOT NULL DEFAULT 100,
                status             TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','cooldown','dead','locked')),
                locked_by          TEXT    NULL,
                lock_time          TEXT    NULL,
                usage_count        INTEGER NOT NULL DEFAULT 0,
                last_used          TEXT    NULL,
                cooldown_until     TEXT    NULL,
                created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
            )");

            $pdo->exec("CREATE TABLE IF NOT EXISTS session_analytics (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id    INTEGER NULL REFERENCES session_pool(id) ON DELETE SET NULL,
                event      TEXT    NOT NULL,
                detail     TEXT    NULL,
                ip_address TEXT    NULL,
                created_at TEXT    NOT NULL DEFAULT (datetime('now'))
            )");

            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_sp_status ON session_pool(status)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_sp_health ON session_pool(status, health_score)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_sp_cooldown ON session_pool(status, cooldown_until)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_sp_last_used ON session_pool(last_used)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_sa_pool ON session_analytics(pool_id, event)");
        } else {
            $pdo->exec("CREATE TABLE IF NOT EXISTS session_pool (
                id                 INT AUTO_INCREMENT PRIMARY KEY,
                netflix_id         VARCHAR(512) NOT NULL,
                secure_netflix_id  VARCHAR(512) NULL,
                domain             VARCHAR(100) NOT NULL DEFAULT '.netflix.com',
                account_country    VARCHAR(50) NULL,
                health_score       INT NOT NULL DEFAULT 100,
                status             ENUM('active','cooldown','dead','locked') NOT NULL DEFAULT 'active',
                locked_by          VARCHAR(100) NULL,
                lock_time          DATETIME NULL,
                usage_count        INT NOT NULL DEFAULT 0,
                last_used          DATETIME NULL,
                cooldown_until     DATETIME NULL,
                created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $pdo->exec("CREATE TABLE IF NOT EXISTS session_analytics (
                id         INT AUTO_INCREMENT PRIMARY KEY,
                pool_id    INT NULL,
                event      VARCHAR(100) NOT NULL,
                detail     TEXT NULL,
                ip_address VARCHAR(45) NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (pool_id) REFERENCES session_pool(id) ON DELETE SET NULL,
                INDEX idx_sa_pool (pool_id, event)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
        }
    }
}
