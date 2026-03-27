<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$cookieData = trim($input['cookie_string'] ?? '');

if ($cookieData === '') {
    jsonResponse(['success' => false, 'message' => 'No cookie data provided.'], 400);
}

$domains = [];
$jsonData = @json_decode($cookieData, true);
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

if (empty($domains)) {
    $lines = preg_split('/\r?\n/', $cookieData);
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') continue;
        if (strpos($line, '#HttpOnly_') === 0) {
            $line = substr($line, 10);
        } elseif (strpos($line, '#') === 0) {
            continue;
        }
        $fields = preg_split('/\t+/', $line);
        if (count($fields) >= 7) {
            $domain = strtolower(trim($fields[0]));
            $domain = ltrim($domain, '.');
            $domain = '.' . $domain;
            if ($domain !== '.' && !in_array($domain, $domains, true)) {
                $domains[] = $domain;
            }
        }
    }
}

if (empty($domains)) {
    jsonResponse([
        'success'  => true,
        'detected' => false,
        'message'  => 'No domain field found in cookie data. Manual platform selection may be needed.',
        'domains'  => [],
    ]);
}

$pdo = getPDO();
$allPlatforms = $pdo->query("SELECT id, name, cookie_domain, login_url FROM platforms WHERE cookie_domain IS NOT NULL AND cookie_domain != ''")->fetchAll();

$matchedPlatform = null;
foreach ($allPlatforms as $p) {
    $platDomain = ltrim($p['cookie_domain'], '.');
    foreach ($domains as $cookieDomain) {
        $cd = ltrim($cookieDomain, '.');
        if ($cd === $platDomain || str_ends_with($cd, '.' . $platDomain) || str_ends_with($platDomain, '.' . $cd)) {
            $matchedPlatform = $p;
            break 2;
        }
    }
}

if ($matchedPlatform) {
    jsonResponse([
        'success'       => true,
        'detected'      => true,
        'platform_id'   => (int)$matchedPlatform['id'],
        'platform_name' => $matchedPlatform['name'],
        'cookie_domain' => $matchedPlatform['cookie_domain'],
        'login_url'     => $matchedPlatform['login_url'],
        'domains'       => $domains,
    ]);
} else {
    jsonResponse([
        'success'  => true,
        'detected' => false,
        'message'  => 'No matching platform found for domains: ' . implode(', ', $domains),
        'domains'  => $domains,
    ]);
}
