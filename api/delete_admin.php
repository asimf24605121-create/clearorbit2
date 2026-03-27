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

if ($admin_id <= 0) {
    jsonResponse(['success' => false, 'message' => 'admin_id is required.'], 400);
}

if ($admin_id === (int)$_SESSION['user_id']) {
    jsonResponse(['success' => false, 'message' => 'You cannot delete your own account.'], 403);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, username, role, admin_level FROM users WHERE id = ? AND role = 'admin'");
$stmt->execute([$admin_id]);
$admin = $stmt->fetch();

if (!$admin) {
    jsonResponse(['success' => false, 'message' => 'Admin account not found.'], 404);
}

if (isPermanentSuperAdmin($admin_id)) {
    jsonResponse(['success' => false, 'message' => 'This account is a permanent Super Admin and cannot be deleted.'], 403);
}

$pdo->prepare("DELETE FROM users WHERE id = ?")->execute([$admin_id]);

$roleLabel = $admin['admin_level'] === 'super_admin' ? 'Super Admin' : 'Manager';
logActivity($_SESSION['user_id'], "admin_deleted: id={$admin_id} username={$admin['username']} role={$roleLabel}", getClientIP());

jsonResponse([
    'success' => true,
    'message' => "{$roleLabel} '{$admin['username']}' deleted successfully.",
]);
