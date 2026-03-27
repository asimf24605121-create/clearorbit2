<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess();

$input = json_decode(file_get_contents('php://input'), true);
if (!$input) {
    $userId = (int)($_GET['user_id'] ?? 0);
} else {
    $userId = (int)($input['user_id'] ?? 0);
}

if ($userId <= 0) {
    jsonResponse(['success' => false, 'message' => 'user_id is required.'], 400);
}

$pdo = getPDO();

autoExpireSubscriptions();

$stmt = $pdo->prepare("
    SELECT
        us.id,
        us.user_id,
        us.platform_id,
        us.start_date,
        us.end_date,
        us.is_active,
        p.name AS platform_name,
        p.logo_url,
        p.bg_color_hex
    FROM user_subscriptions us
    INNER JOIN platforms p ON p.id = us.platform_id
    WHERE us.user_id = ?
    ORDER BY us.is_active DESC, us.end_date ASC
");
$stmt->execute([$userId]);
$subs = $stmt->fetchAll();

jsonResponse([
    'success' => true,
    'subscriptions' => $subs,
]);
