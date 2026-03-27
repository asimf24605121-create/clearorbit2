<?php
require_once __DIR__ . '/../db.php';

session_start();
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

checkAdminAccess('super_admin');
validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$action = $input['action'] ?? '';
$ids = $input['ids'] ?? [];

$pdo = getPDO();
$adminId = (int)$_SESSION['user_id'];
$ip = getClientIP();

if ($action === 'single' || $action === 'bulk') {
    if (!is_array($ids) || count($ids) === 0) {
        jsonResponse(['success' => false, 'message' => 'No sessions selected.'], 400);
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $intIds = array_map('intval', $ids);
    $stmt = $pdo->prepare("DELETE FROM user_sessions WHERE id IN ($placeholders)");
    $stmt->execute($intIds);
    $deleted = $stmt->rowCount();
    logActivity($adminId, "admin_delete_sessions: {$deleted} record(s)", $ip);
    jsonResponse(['success' => true, 'message' => "Deleted {$deleted} session record(s).", 'deleted' => $deleted]);
} elseif ($action === 'all') {
    $stmt = $pdo->exec("DELETE FROM user_sessions");
    logActivity($adminId, 'admin_delete_all_sessions', $ip);
    jsonResponse(['success' => true, 'message' => 'All session records deleted.']);
} else {
    jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);
}
