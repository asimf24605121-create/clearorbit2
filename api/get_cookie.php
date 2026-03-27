<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

$platformId = (int)($_GET['id'] ?? 0);
$slot = max(1, min(50, (int)($_GET['slot'] ?? 1)));
if ($platformId < 1) {
    jsonResponse(['success' => false, 'message' => 'Missing or invalid platform ID.'], 400);
}

$pdo    = getPDO();
$userId = (int)$_SESSION['user_id'];

$stmt = $pdo->prepare("
    SELECT us.id
    FROM user_subscriptions us
    WHERE us.user_id = ?
      AND us.platform_id = ?
      AND us.is_active = 1
      AND us.end_date >= ?
");
$today = date('Y-m-d');
$stmt->execute([$userId, $platformId, $today]);

if (!$stmt->fetch()) {
    jsonResponse(['success' => false, 'message' => 'No active subscription for this platform.'], 403);
}

$stmt2 = $pdo->prepare("
    SELECT cv.cookie_string, cv.expires_at, cv.slot,
           p.name AS platform_name, p.id AS platform_id,
           p.cookie_domain, p.login_url
    FROM cookie_vault cv
    INNER JOIN platforms p ON p.id = cv.platform_id
    WHERE cv.platform_id = ?
      AND cv.slot = ?
      AND p.is_active = 1
    ORDER BY cv.updated_at DESC
    LIMIT 1
");
$stmt2->execute([$platformId, $slot]);
$row = $stmt2->fetch();

if (!$row || empty($row['cookie_string'])) {
    jsonResponse(['success' => false, 'message' => 'No cookie available for this platform. Admin needs to update the cookie vault.'], 404);
}

if ($row['expires_at']) {
    try {
        $expiryDt = new DateTime($row['expires_at']);
        $now = new DateTime();
        if ($expiryDt < $now) {
            jsonResponse(['success' => false, 'message' => 'Cookie for this platform has expired. Admin needs to update the cookie vault.'], 410);
        }
    } catch (Exception $e) {
    }
}

$domain = $row['cookie_domain'] ?? null;
$redirectUrl = $row['login_url'] ?? null;

if (!$domain || !$redirectUrl) {
    jsonResponse([
        'success' => false,
        'message' => 'Platform routing not configured. Contact admin to set up domain mapping for this platform.',
    ], 500);
}

$rawStored = $row['cookie_string'];
$decoded = @base64_decode($rawStored, true);
if ($decoded !== false && strlen($decoded) > 2) {
    $rawStored = $decoded;
}

$jsonCookies = @json_decode($rawStored, true);

$responseBase = [
    'success'       => true,
    'platform_id'   => $platformId,
    'platform_name' => $row['platform_name'],
    'domain'        => $domain,
    'redirect_url'  => $redirectUrl,
    'slot'          => $slot,
];

if (is_array($jsonCookies) && !empty($jsonCookies) && isset($jsonCookies[0]['name'])) {
    foreach ($jsonCookies as &$c) {
        if (empty($c['domain'])) {
            $c['domain'] = $domain;
        }
    }
    unset($c);

    $flatParts = [];
    foreach ($jsonCookies as $c) {
        $flatParts[] = $c['name'] . '=' . $c['value'];
    }
    $cookieString = implode('; ', $flatParts);

    jsonResponse(array_merge($responseBase, [
        'cookie_string' => $cookieString,
        'cookies'       => $jsonCookies,
        'format'        => 'json',
        'count'         => count($jsonCookies),
    ]));
}

jsonResponse(array_merge($responseBase, [
    'cookie_string' => $rawStored,
    'cookies'       => null,
    'format'        => 'plain',
    'count'         => count(array_filter(array_map('trim', explode(';', $rawStored)))),
]));
