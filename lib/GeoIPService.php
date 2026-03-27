<?php

class GeoIPService {
    private static int $CACHE_HOURS = 72;
    private static string $API_URL = 'https://ip-api.com/json/';

    public static function lookup(string $ip, ?PDO $pdo = null): array {
        if (self::isPrivateIP($ip)) {
            return [
                'ip' => $ip,
                'country' => 'Local',
                'country_code' => 'LO',
                'region' => 'Local',
                'city' => 'Local',
                'isp' => 'Local Network',
                'lat' => 0,
                'lon' => 0,
                'timezone' => date_default_timezone_get(),
                'cached' => false,
            ];
        }

        if ($pdo) {
            $cached = self::getFromCache($pdo, $ip);
            if ($cached) return $cached;
        }

        $data = self::fetchFromAPI($ip);

        if ($pdo && $data['country'] !== 'Unknown') {
            self::saveToCache($pdo, $ip, $data);
        }

        return $data;
    }

    private static function isPrivateIP(string $ip): bool {
        if ($ip === '127.0.0.1' || $ip === '::1' || $ip === 'localhost') return true;
        return !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
    }

    private static function getFromCache(PDO $pdo, string $ip): ?array {
        $cutoff = date('Y-m-d H:i:s', strtotime('-' . self::$CACHE_HOURS . ' hours'));
        $stmt = $pdo->prepare("SELECT * FROM ip_geo_cache WHERE ip_address = ? AND looked_up_at >= ?");
        $stmt->execute([$ip, $cutoff]);
        $row = $stmt->fetch();
        if (!$row) return null;

        return [
            'ip' => $ip,
            'country' => $row['country'] ?? 'Unknown',
            'country_code' => $row['country_code'] ?? '--',
            'region' => $row['region'] ?? 'Unknown',
            'city' => $row['city'] ?? 'Unknown',
            'isp' => $row['isp'] ?? 'Unknown',
            'lat' => (float)($row['lat'] ?? 0),
            'lon' => (float)($row['lon'] ?? 0),
            'timezone' => $row['timezone'] ?? '',
            'cached' => true,
        ];
    }

    private static function fetchFromAPI(string $ip): array {
        $defaults = [
            'ip' => $ip, 'country' => 'Unknown', 'country_code' => '--',
            'region' => 'Unknown', 'city' => 'Unknown', 'isp' => 'Unknown',
            'lat' => 0, 'lon' => 0, 'timezone' => '', 'cached' => false,
        ];

        $ctx = stream_context_create([
            'http' => ['timeout' => 3, 'ignore_errors' => true],
        ]);

        $url = self::$API_URL . urlencode($ip) . '?fields=status,message,country,countryCode,regionName,city,isp,lat,lon,timezone';
        $response = @file_get_contents($url, false, $ctx);
        if ($response === false) return $defaults;

        $json = json_decode($response, true);
        if (!$json || ($json['status'] ?? '') !== 'success') return $defaults;

        return [
            'ip' => $ip,
            'country' => $json['country'] ?? 'Unknown',
            'country_code' => $json['countryCode'] ?? '--',
            'region' => $json['regionName'] ?? 'Unknown',
            'city' => $json['city'] ?? 'Unknown',
            'isp' => $json['isp'] ?? 'Unknown',
            'lat' => (float)($json['lat'] ?? 0),
            'lon' => (float)($json['lon'] ?? 0),
            'timezone' => $json['timezone'] ?? '',
            'cached' => false,
        ];
    }

    private static function saveToCache(PDO $pdo, string $ip, array $data): void {
        $now = date('Y-m-d H:i:s');
        $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);

        if ($driver === 'mysql') {
            $sql = "INSERT INTO ip_geo_cache (ip_address, country, country_code, region, city, isp, lat, lon, timezone, looked_up_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE country=VALUES(country), country_code=VALUES(country_code), region=VALUES(region),
                    city=VALUES(city), isp=VALUES(isp), lat=VALUES(lat), lon=VALUES(lon), timezone=VALUES(timezone), looked_up_at=VALUES(looked_up_at)";
        } else {
            $sql = "INSERT OR REPLACE INTO ip_geo_cache (ip_address, country, country_code, region, city, isp, lat, lon, timezone, looked_up_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        }

        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            $ip, $data['country'], $data['country_code'], $data['region'],
            $data['city'], $data['isp'], $data['lat'], $data['lon'],
            $data['timezone'], $now,
        ]);
    }

    public static function assessRisk(PDO $pdo, int $userId, string $currentIP): array {
        $geo = self::lookup($currentIP, $pdo);

        $stmt = $pdo->prepare("SELECT DISTINCT ip_address FROM user_sessions WHERE user_id = ? AND status = 'active' AND ip_address != ? ORDER BY last_activity DESC LIMIT 5");
        $stmt->execute([$userId, $currentIP]);
        $otherIPs = $stmt->fetchAll(PDO::FETCH_COLUMN);

        $risk = 'LOW';
        $reasons = [];
        $flags = [];

        $histStmt = $pdo->prepare("SELECT DISTINCT ip_address FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20");
        $histStmt->execute([$userId]);
        $knownIPs = $histStmt->fetchAll(PDO::FETCH_COLUMN);

        $isNewIP = !in_array($currentIP, $knownIPs);
        if ($isNewIP) {
            $flags[] = 'new_ip';
        }

        foreach ($otherIPs as $otherIP) {
            $otherGeo = self::lookup($otherIP, $pdo);

            if ($geo['country'] !== $otherGeo['country'] && $otherGeo['country'] !== 'Unknown' && $geo['country'] !== 'Unknown') {
                $risk = 'HIGH';
                $reasons[] = "Active sessions from different countries: {$geo['country']} vs {$otherGeo['country']}";
                $flags[] = 'cross_country';
            } elseif ($geo['city'] !== $otherGeo['city'] && $otherGeo['city'] !== 'Unknown' && $geo['city'] !== 'Unknown') {
                if ($risk !== 'HIGH') $risk = 'MEDIUM';
                $reasons[] = "Different city detected: {$geo['city']} vs {$otherGeo['city']}";
                $flags[] = 'different_city';
            }
        }

        if ($isNewIP && $risk === 'LOW') {
            $risk = 'MEDIUM';
            $reasons[] = "First time login from this IP address";
        }

        $recentStmt = $pdo->prepare("SELECT COUNT(DISTINCT ip_address) FROM login_history WHERE user_id = ? AND created_at >= ?");
        $recentStmt->execute([$userId, date('Y-m-d H:i:s', strtotime('-1 hour'))]);
        $recentIPCount = (int)$recentStmt->fetchColumn();
        if ($recentIPCount >= 3) {
            $risk = 'HIGH';
            $reasons[] = "Rapid IP switching: $recentIPCount different IPs in 1 hour";
            $flags[] = 'rapid_switching';
        }

        $concurrentStmt = $pdo->prepare("SELECT COUNT(DISTINCT ip_address) FROM user_sessions WHERE user_id = ? AND status = 'active'");
        $concurrentStmt->execute([$userId]);
        $concurrentIPs = (int)$concurrentStmt->fetchColumn();
        if ($concurrentIPs > 2) {
            $risk = 'HIGH';
            $reasons[] = "Multiple simultaneous IPs: $concurrentIPs active";
            $flags[] = 'multi_ip';
        }

        return [
            'risk_level' => $risk,
            'reasons' => $reasons,
            'flags' => $flags,
            'geo' => $geo,
            'concurrent_ips' => $concurrentIPs,
            'is_new_ip' => $isNewIP,
            'known_ip_count' => count($knownIPs),
        ];
    }

    public static function logSecurityEvent(PDO $pdo, int $userId, string $eventType, string $severity, string $ip, array $details = []): void {
        $now = date('Y-m-d H:i:s');
        $stmt = $pdo->prepare("INSERT INTO security_events (user_id, event_type, severity, ip_address, details, created_at) VALUES (?, ?, ?, ?, ?, ?)");
        $stmt->execute([$userId, $eventType, $severity, $ip, json_encode($details), $now]);
    }
}
