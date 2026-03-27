<?php
require_once __DIR__ . '/../db.php';
session_start();
validateCsrfToken();

if (!isset($_SESSION['user_id']) || ($_SESSION['role'] ?? '') !== 'admin' || ($_SESSION['admin_level'] ?? '') === 'manager') {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$input = json_decode(file_get_contents('php://input'), true);
$subId = (int)($input['subscription_id'] ?? 0);

if (!$subId) {
    jsonResponse(['success' => false, 'message' => 'Subscription ID is required.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT us.id, u.username, p.name AS platform_name FROM user_subscriptions us JOIN users u ON u.id = us.user_id JOIN platforms p ON p.id = us.platform_id WHERE us.id = ?");
$stmt->execute([$subId]);
$sub = $stmt->fetch();

if (!$sub) {
    jsonResponse(['success' => false, 'message' => 'Subscription not found.'], 404);
}

$getUserId = $pdo->prepare("SELECT user_id FROM user_subscriptions WHERE id = ?");
$getUserId->execute([$subId]);
$userId = (int)$getUserId->fetchColumn();

$del = $pdo->prepare("DELETE FROM user_subscriptions WHERE id = ?");
$del->execute([$subId]);

if ($userId > 0) {
    syncUserExpiryDate($pdo, $userId);
}

logActivity($_SESSION['user_id'], "Deleted subscription #{$subId} ({$sub['username']} - {$sub['platform_name']})", getClientIP());

jsonResponse(['success' => true, 'message' => "Subscription for {$sub['username']} ({$sub['platform_name']}) deleted."]);
