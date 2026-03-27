<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
if (!$input) {
    jsonResponse(['success' => false, 'message' => 'Invalid request body.'], 400);
}

$currentPassword = $input['current_password'] ?? '';
$newPassword = $input['new_password'] ?? '';
$confirmPassword = $input['confirm_password'] ?? '';

if ($currentPassword === '' || $newPassword === '' || $confirmPassword === '') {
    jsonResponse(['success' => false, 'message' => 'All password fields are required.'], 400);
}

if ($newPassword !== $confirmPassword) {
    jsonResponse(['success' => false, 'message' => 'New passwords do not match.'], 400);
}

if (strlen($newPassword) < 6) {
    jsonResponse(['success' => false, 'message' => 'New password must be at least 6 characters.'], 400);
}

if ($currentPassword === $newPassword) {
    jsonResponse(['success' => false, 'message' => 'New password must be different from current password.'], 400);
}

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];

$stmt = $pdo->prepare("SELECT password_hash FROM users WHERE id = ?");
$stmt->execute([$userId]);
$user = $stmt->fetch();

if (!$user || !password_verify($currentPassword, $user['password_hash'])) {
    jsonResponse(['success' => false, 'message' => 'Current password is incorrect.'], 403);
}

$newHash = password_hash($newPassword, PASSWORD_BCRYPT);
$pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ?")->execute([$newHash, $userId]);

logActivity($userId, "password_changed", getClientIP());

jsonResponse(['success' => true, 'message' => 'Password changed successfully.']);
