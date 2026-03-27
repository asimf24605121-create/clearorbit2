<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$userId = (int)$_SESSION['user_id'];
$pdo = getPDO();
$limit = min(50, max(1, (int)($_GET['limit'] ?? 20)));

$stmt = $pdo->prepare("SELECT ip_address, device_type, browser, os, action, created_at FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?");
$stmt->execute([$userId, $limit]);
$history = $stmt->fetchAll();

$sessStmt = $pdo->prepare("SELECT device_id, ip_address, device_type, browser, os, status, last_activity, created_at FROM user_sessions WHERE user_id = ? ORDER BY status ASC, last_activity DESC LIMIT 10");
$sessStmt->execute([$userId]);
$sessions = $sessStmt->fetchAll();

$activeCount = 0;
foreach ($sessions as $s) {
    if ($s['status'] === 'active') $activeCount++;
}

jsonResponse([
    'success'        => true,
    'history'        => $history,
    'sessions'       => $sessions,
    'active_devices' => $activeCount,
    'device_limit'   => 2,
]);
