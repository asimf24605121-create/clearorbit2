<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$platform_id   = (int)($input['platform_id']   ?? 0);
$cookie_string = trim($input['cookie_string']   ?? '');
$expires_at    = trim($input['expires_at']       ?? '');
$slot          = max(1, min(4, (int)($input['slot'] ?? 1)));

if ($cookie_string === '') {
    jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
}

$pdo = getPDO();

$parsed = parseCookieInput($cookie_string);

$detectedDomains = extractDomainsFromCookies($parsed, $cookie_string);

$platform = null;
$detectedPlatform = null;

if (!empty($detectedDomains)) {
    $allPlatforms = $pdo->query("SELECT id, name, cookie_domain, login_url FROM platforms WHERE cookie_domain IS NOT NULL AND cookie_domain != ''")->fetchAll();
    foreach ($allPlatforms as $p) {
        $platDomain = ltrim($p['cookie_domain'], '.');
        foreach ($detectedDomains as $cookieDomain) {
            $cookieDomain = ltrim($cookieDomain, '.');
            if ($cookieDomain === $platDomain || str_ends_with($cookieDomain, '.' . $platDomain) || str_ends_with($platDomain, '.' . $cookieDomain)) {
                $detectedPlatform = $p;
                break 2;
            }
        }
    }
}

if ($detectedPlatform) {
    $platform = $detectedPlatform;
    $platform_id = (int)$platform['id'];
} elseif ($platform_id > 0) {
    $stmt = $pdo->prepare("SELECT id, name, cookie_domain, login_url FROM platforms WHERE id = ?");
    $stmt->execute([$platform_id]);
    $platform = $stmt->fetch();
    if (!$platform) {
        jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
    }
} else {
    $domainList = !empty($detectedDomains) ? implode(', ', $detectedDomains) : 'unknown';
    jsonResponse(['success' => false, 'message' => "Could not auto-detect platform from cookie domains ({$domainList}). No matching platform found. Please select manually or add the platform first."], 400);
}

if (!empty($detectedDomains) && !empty($platform['cookie_domain'])) {
    $platDomain = ltrim($platform['cookie_domain'], '.');
    $domainMatch = false;
    foreach ($detectedDomains as $cookieDomain) {
        $cookieDomain = ltrim($cookieDomain, '.');
        if ($cookieDomain === $platDomain || str_ends_with($cookieDomain, '.' . $platDomain) || str_ends_with($platDomain, '.' . $cookieDomain)) {
            $domainMatch = true;
            break;
        }
    }
    if (!$domainMatch) {
        $domainList = implode(', ', $detectedDomains);
        jsonResponse([
            'success' => false,
            'message' => "Domain mismatch! Cookie domains ({$domainList}) do not match platform '{$platform['name']}' ({$platform['cookie_domain']}). Save blocked to prevent data corruption.",
        ], 400);
    }
}

if (!$parsed['valid']) {
    jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
}

$cookieCount = $parsed['count'];
$normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
$encodedCookie = base64_encode($normalizedJson);

$expiresVal = null;
if ($expires_at !== '') {
    try {
        $dt = new DateTime($expires_at);
        $expiresVal = $dt->format('Y-m-d H:i:s');
    } catch (Exception $e) {
        jsonResponse(['success' => false, 'message' => 'Invalid expires_at format. Use YYYY-MM-DD.'], 400);
    }
} elseif ($parsed['earliest_expiry']) {
    $expiresVal = $parsed['earliest_expiry'];
}

$now = date('Y-m-d H:i:s');

$check = $pdo->prepare("SELECT id FROM cookie_vault WHERE platform_id = ? AND slot = ?");
$check->execute([$platform_id, $slot]);
$existing = $check->fetch();

if ($existing) {
    $upd = $pdo->prepare("UPDATE cookie_vault SET cookie_string = ?, expires_at = ?, updated_at = ?, cookie_count = ? WHERE platform_id = ? AND slot = ?");
    $upd->execute([$encodedCookie, $expiresVal, $now, $cookieCount, $platform_id, $slot]);
} else {
    $ins = $pdo->prepare("INSERT INTO cookie_vault (platform_id, cookie_string, expires_at, updated_at, cookie_count, slot) VALUES (?, ?, ?, ?, ?, ?)");
    $ins->execute([$platform_id, $encodedCookie, $expiresVal, $now, $cookieCount, $slot]);
}

$autoDetected = $detectedPlatform !== null;
logActivity($_SESSION['user_id'], "cookie_" . ($existing ? 'updated' : 'added') . ": platform={$platform['name']} slot={$slot} count={$cookieCount}" . ($autoDetected ? ' (auto-detected)' : ''), getClientIP());

jsonResponse([
    'success'        => true,
    'message'        => "{$cookieCount} cookie(s) saved for '{$platform['name']}'" . ($autoDetected ? ' (auto-detected)' : '') . ".",
    'cookie_count'   => $cookieCount,
    'expires_at'     => $expiresVal,
    'format'         => $parsed['format'],
    'auto_detected'  => $autoDetected,
    'platform_id'    => $platform_id,
    'platform_name'  => $platform['name'],
    'cookie_domain'  => $platform['cookie_domain'] ?? null,
    'login_url'      => $platform['login_url'] ?? null,
]);

function parseCookieInput(string $raw): array {
    $raw = trim($raw);

    $jsonData = json_decode($raw, true);
    if (is_array($jsonData) && !empty($jsonData)) {
        if (isset($jsonData[0]) && is_array($jsonData[0])) {
            return validateJsonCookies($jsonData, 'json_array');
        }
        if (isset($jsonData['name']) && isset($jsonData['value'])) {
            return validateJsonCookies([$jsonData], 'json_object');
        }
    }

    return parsePlainCookieString($raw);
}

function validateJsonCookies(array $cookies, string $format): array {
    $valid = [];
    $errors = [];
    $earliestExpiry = null;

    foreach ($cookies as $i => $cookie) {
        if (!is_array($cookie)) {
            $errors[] = "Cookie #" . ($i + 1) . ": not an object";
            continue;
        }

        $name  = trim($cookie['name'] ?? '');
        $value = $cookie['value'] ?? '';

        if ($name === '') {
            $errors[] = "Cookie #" . ($i + 1) . ": missing 'name' field";
            continue;
        }

        $rawSameSite = array_key_exists('sameSite', $cookie) ? $cookie['sameSite'] : 'lax';

        $normalized = [
            'name'     => $name,
            'value'    => (string)$value,
            'domain'   => $cookie['domain'] ?? null,
            'path'     => $cookie['path'] ?? '/',
            'secure'   => (bool)($cookie['secure'] ?? true),
            'httpOnly' => (bool)($cookie['httpOnly'] ?? true),
            'sameSite' => normalizeSameSite($rawSameSite),
        ];

        if (isset($cookie['expirationDate']) && is_numeric($cookie['expirationDate'])) {
            $expTs = (int)$cookie['expirationDate'];
            $normalized['expirationDate'] = $expTs;

            $expDt = date('Y-m-d H:i:s', $expTs);
            if ($earliestExpiry === null || $expDt < $earliestExpiry) {
                $earliestExpiry = $expDt;
            }
        }

        $valid[] = $normalized;
    }

    if (empty($valid)) {
        return [
            'valid' => false,
            'error' => 'No valid cookies found. ' . implode('; ', $errors),
        ];
    }

    return [
        'valid'           => true,
        'cookies'         => $valid,
        'count'           => count($valid),
        'format'          => $format,
        'earliest_expiry' => $earliestExpiry,
        'warnings'        => $errors,
    ];
}

function parsePlainCookieString(string $raw): array {
    $cookies = [];
    $pairs = array_filter(array_map('trim', explode(';', $raw)));

    $skipKeys = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'];

    foreach ($pairs as $pair) {
        $eqPos = strpos($pair, '=');
        if ($eqPos === false || $eqPos < 1) continue;

        $name  = trim(substr($pair, 0, $eqPos));
        $value = trim(substr($pair, $eqPos + 1));

        if (in_array(strtolower($name), $skipKeys, true)) continue;

        $cookies[] = [
            'name'     => $name,
            'value'    => $value,
            'domain'   => null,
            'path'     => '/',
            'secure'   => true,
            'httpOnly' => true,
            'sameSite' => 'lax',
        ];
    }

    if (empty($cookies)) {
        return [
            'valid' => false,
            'error' => 'No valid cookie pairs found. Expected format: name=value; name2=value2 or JSON array [{name,value,domain}].',
        ];
    }

    return [
        'valid'           => true,
        'cookies'         => $cookies,
        'count'           => count($cookies),
        'format'          => 'plain_string',
        'earliest_expiry' => null,
        'warnings'        => [],
    ];
}

function normalizeSameSite($value): string {
    if ($value === null || $value === '') {
        return 'unspecified';
    }
    $v = strtolower(trim((string)$value));
    if ($v === 'no_restriction' || $v === 'none') {
        return 'none';
    }
    if (in_array($v, ['strict', 'lax', 'unspecified'], true)) {
        return $v;
    }
    return 'lax';
}

function extractDomainsFromCookies(array $parsed, string $rawInput): array {
    $domains = [];

    if ($parsed['valid'] && !empty($parsed['cookies'])) {
        foreach ($parsed['cookies'] as $cookie) {
            if (!empty($cookie['domain'])) {
                $d = strtolower(trim($cookie['domain']));
                if ($d !== '' && !in_array($d, $domains, true)) {
                    $domains[] = $d;
                }
            }
        }
    }

    if (empty($domains)) {
        $jsonData = @json_decode($rawInput, true);
        if (is_array($jsonData)) {
            $items = isset($jsonData[0]) ? $jsonData : [$jsonData];
            foreach ($items as $item) {
                if (is_array($item) && !empty($item['domain'])) {
                    $d = strtolower(trim($item['domain']));
                    if ($d !== '' && !in_array($d, $domains, true)) {
                        $domains[] = $d;
                    }
                }
            }
        }
    }

    return $domains;
}
