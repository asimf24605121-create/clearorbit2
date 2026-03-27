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
        jsonResponse(['success' => false, 'message' => 'No logs selected.'], 400);
    }
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $intIds = array_map('intval', $ids);
    $stmt = $pdo->prepare("DELETE FROM login_attempt_logs WHERE id IN ($placeholders)");
    $stmt->execute($intIds);
    $deleted = $stmt->rowCount();
    logActivity($adminId, "admin_delete_login_logs: {$deleted} record(s)", $ip);
    jsonResponse(['success' => true, 'message' => "Deleted {$deleted} log record(s).", 'deleted' => $deleted]);
} elseif ($action === 'all') {
    $stmt = $pdo->exec("DELETE FROM login_attempt_logs");
    logActivity($adminId, 'admin_delete_all_login_logs', $ip);
    jsonResponse(['success' => true, 'message' => 'All login attempt logs deleted.']);
} else {
    jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);
}
