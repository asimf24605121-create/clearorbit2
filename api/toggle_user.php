<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('manager');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$user_id    = (int)($input['user_id'] ?? 0);
$action     = trim($input['action'] ?? '');

if ($user_id <= 0) {
    jsonResponse(['success' => false, 'message' => 'user_id is required.'], 400);
}

if (!in_array($action, ['activate', 'deactivate', 'reset_device'], true)) {
    jsonResponse(['success' => false, 'message' => 'action must be activate, deactivate, or reset_device.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, username, role FROM users WHERE id = ?");
$stmt->execute([$user_id]);
$user = $stmt->fetch();

if (!$user) {
    jsonResponse(['success' => false, 'message' => 'User not found.'], 404);
}

if ($user['role'] === 'admin') {
    jsonResponse(['success' => false, 'message' => 'Cannot modify an admin account.'], 403);
}

if ($action === 'activate') {
    $pdo->prepare("UPDATE users SET is_active = 1 WHERE id = ?")->execute([$user_id]);
    $msg = "User '{$user['username']}' activated.";
} elseif ($action === 'deactivate') {
    $pdo->prepare("UPDATE users SET is_active = 0 WHERE id = ?")->execute([$user_id]);
    deactivateAllUserSessions($user_id, null, 'Account disabled by admin');
    $msg = "User '{$user['username']}' deactivated.";
} elseif ($action === 'reset_device') {
    $pdo->prepare("UPDATE users SET device_id = NULL WHERE id = ?")->execute([$user_id]);
    deactivateAllUserSessions($user_id, null, 'Device lock reset by admin');
    $msg = "Device lock and all sessions reset for '{$user['username']}'.";
} else {
    $pdo->prepare("UPDATE users SET device_id = NULL WHERE id = ?")->execute([$user_id]);
    $msg = "Device lock reset for '{$user['username']}'.";
}

logActivity($_SESSION['user_id'], "user_{$action}: id={$user_id} username={$user['username']}", getClientIP());

jsonResponse(['success' => true, 'message' => $msg]);
