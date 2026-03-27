<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess();

$userId = (int)($_GET['user_id'] ?? 0);
if ($userId <= 0) {
    jsonResponse(['success' => false, 'message' => 'user_id is required.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("
    SELECT
        acs.id AS session_id,
        acs.account_id,
        acs.status AS session_status,
        acs.last_active,
        pa.slot_name,
        pa.health_status,
        pa.cookie_status,
        pa.login_status,
        pa.max_users,
        p.id AS platform_id,
        p.name AS platform_name,
        p.logo_url,
        p.bg_color_hex
    FROM account_sessions acs
    INNER JOIN platform_accounts pa ON pa.id = acs.account_id
    INNER JOIN platforms p ON p.id = pa.platform_id
    WHERE acs.user_id = ? AND acs.status = 'active'
    ORDER BY acs.last_active DESC
");
$stmt->execute([$userId]);
$slots = $stmt->fetchAll();

$now = time();
foreach ($slots as &$s) {
    $lastActive = strtotime($s['last_active'] ?? '');
    $minutesAgo = $lastActive ? round(($now - $lastActive) / 60) : null;
    $s['minutes_ago'] = $minutesAgo;
    $s['is_stale'] = ($s['session_status'] === 'active' && $minutesAgo !== null && $minutesAgo > 10);
}
unset($s);

jsonResponse([
    'success' => true,
    'slots' => $slots,
]);
