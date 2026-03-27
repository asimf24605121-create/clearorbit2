<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$user_id = (int)($input['user_id'] ?? 0);

if ($user_id <= 0) {
    jsonResponse(['success' => false, 'message' => 'user_id is required.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, username, role FROM users WHERE id = ?");
$stmt->execute([$user_id]);
$user = $stmt->fetch();

if (!$user) {
    jsonResponse(['success' => false, 'message' => 'User not found.'], 404);
}

if ($user['role'] === 'admin') {
    jsonResponse(['success' => false, 'message' => 'Cannot delete an admin account.'], 403);
}

$cascadeTables = [
    'user_subscriptions',
    'account_sessions',
    'user_sessions',
    'activity_logs',
    'login_history',
    'user_notifications',
    'payments',
];

try {
    $pdo->beginTransaction();

    foreach ($cascadeTables as $table) {
        try {
            $pdo->prepare("DELETE FROM {$table} WHERE user_id = ?")->execute([$user_id]);
        } catch (Exception $ignore) {}
    }

    $pdo->prepare("DELETE FROM users WHERE id = ?")->execute([$user_id]);

    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    error_log("delete_user failed for id={$user_id}: " . $e->getMessage());
    jsonResponse(['success' => false, 'message' => 'Failed to delete user. Please try again.'], 500);
}

logActivity($_SESSION['user_id'], "user_deleted: id={$user_id} username={$user['username']}", getClientIP());

jsonResponse(['success' => true, 'message' => "User '{$user['username']}' and all related data deleted successfully."]);
