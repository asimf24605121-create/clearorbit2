<?php
require_once __DIR__ . '/../db.php';
session_start();
validateCsrfToken();

checkAdminAccess('super_admin');

$input = json_decode(file_get_contents('php://input'), true);
$logId = (int)($input['log_id'] ?? 0);
$deleteAll = (bool)($input['delete_all'] ?? false);

$pdo = getPDO();

if ($deleteAll) {
    $count = (int)$pdo->query("SELECT COUNT(*) FROM activity_logs")->fetchColumn();
    $pdo->exec("DELETE FROM activity_logs");
    logActivity($_SESSION['user_id'], "Purged all activity logs ({$count} entries)", getClientIP());
    jsonResponse(['success' => true, 'message' => 'All activity logs deleted.']);
}

if (!$logId) {
    jsonResponse(['success' => false, 'message' => 'Log ID is required.'], 400);
}

$stmt = $pdo->prepare("SELECT id FROM activity_logs WHERE id = ?");
$stmt->execute([$logId]);
if (!$stmt->fetch()) {
    jsonResponse(['success' => false, 'message' => 'Log entry not found.'], 404);
}

$del = $pdo->prepare("DELETE FROM activity_logs WHERE id = ?");
$del->execute([$logId]);

logActivity($_SESSION['user_id'], "Deleted activity log #{$logId}", getClientIP());

jsonResponse(['success' => true, 'message' => 'Log entry deleted.']);
