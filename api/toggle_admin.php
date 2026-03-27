<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$admin_id = (int)($input['admin_id'] ?? 0);
$action   = $input['action'] ?? '';

if ($admin_id <= 0) {
    jsonResponse(['success' => false, 'message' => 'admin_id is required.'], 400);
}

if (!in_array($action, ['activate', 'deactivate', 'change_role'], true)) {
    jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);
}

if ($admin_id === (int)$_SESSION['user_id']) {
    jsonResponse(['success' => false, 'message' => 'You cannot modify your own account.'], 403);
}

if (isPermanentSuperAdmin($admin_id)) {
    if ($action === 'deactivate' || $action === 'change_role') {
        jsonResponse(['success' => false, 'message' => 'This account is a permanent Super Admin and cannot be deactivated or demoted.'], 403);
    }
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, username, role, admin_level, is_active FROM users WHERE id = ? AND role = 'admin'");
$stmt->execute([$admin_id]);
$admin = $stmt->fetch();

if (!$admin) {
    jsonResponse(['success' => false, 'message' => 'Admin account not found.'], 404);
}

if ($action === 'activate') {
    $pdo->prepare("UPDATE users SET is_active = 1 WHERE id = ?")->execute([$admin_id]);
    logActivity($_SESSION['user_id'], "admin_activated: id={$admin_id} username={$admin['username']}", getClientIP());
    jsonResponse(['success' => true, 'message' => "Admin '{$admin['username']}' activated."]);
}

if ($action === 'deactivate') {
    $pdo->prepare("UPDATE users SET is_active = 0 WHERE id = ?")->execute([$admin_id]);
    logActivity($_SESSION['user_id'], "admin_deactivated: id={$admin_id} username={$admin['username']}", getClientIP());
    jsonResponse(['success' => true, 'message' => "Admin '{$admin['username']}' deactivated."]);
}

if ($action === 'change_role') {
    $newRole = $input['new_role'] ?? '';
    if (!in_array($newRole, ['super_admin', 'manager'], true)) {
        jsonResponse(['success' => false, 'message' => 'new_role must be super_admin or manager.'], 400);
    }
    $pdo->prepare("UPDATE users SET admin_level = ? WHERE id = ?")->execute([$newRole, $admin_id]);
    $label = $newRole === 'super_admin' ? 'Super Admin' : 'Manager';
    logActivity($_SESSION['user_id'], "admin_role_changed: id={$admin_id} username={$admin['username']} new_role={$label}", getClientIP());
    jsonResponse(['success' => true, 'message' => "'{$admin['username']}' role changed to {$label}."]);
}
