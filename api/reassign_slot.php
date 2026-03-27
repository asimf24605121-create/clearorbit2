<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$sessionId = (int)($input['session_id'] ?? 0);
$action = $input['action'] ?? 'reassign';

if ($sessionId <= 0) {
    jsonResponse(['success' => false, 'message' => 'session_id is required.'], 400);
}

$pdo = getPDO();

$session = $pdo->prepare("SELECT acs.*, pa.platform_id FROM account_sessions acs INNER JOIN platform_accounts pa ON pa.id = acs.account_id WHERE acs.id = ?");
$session->execute([$sessionId]);
$sess = $session->fetch();

if (!$sess) {
    jsonResponse(['success' => false, 'message' => 'Session not found.']);
}

if ($action === 'free') {
    $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE id = ?")->execute([$sessionId]);
    logActivity($_SESSION['user_id'] ?? 0, "Freed slot session #$sessionId (user #{$sess['user_id']})");
    jsonResponse(['success' => true, 'message' => 'Slot freed successfully.']);
}

$newAccountId = (int)($input['new_account_id'] ?? 0);
if ($newAccountId <= 0) {
    jsonResponse(['success' => false, 'message' => 'new_account_id is required for reassignment.'], 400);
}

$newSlot = $pdo->prepare("SELECT * FROM platform_accounts WHERE id = ? AND platform_id = ?");
$newSlot->execute([$newAccountId, $sess['platform_id']]);
$slot = $newSlot->fetch();

if (!$slot) {
    jsonResponse(['success' => false, 'message' => 'Target slot not found or belongs to a different platform.']);
}

if (!$slot['is_active']) {
    jsonResponse(['success' => false, 'message' => 'Target slot is disabled.']);
}

$fiveMinAgo = date('Y-m-d H:i:s', strtotime('-5 minutes'));
$activeCount = $pdo->prepare("SELECT COUNT(*) FROM account_sessions WHERE account_id = ? AND status = 'active' AND last_active >= ?");
$activeCount->execute([$newAccountId, $fiveMinAgo]);
$count = (int)$activeCount->fetchColumn();

if ($count >= (int)$slot['max_users']) {
    jsonResponse(['success' => false, 'message' => 'Target slot is at full capacity.']);
}

$update = $pdo->prepare("UPDATE account_sessions SET account_id = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?");
$update->execute([$newAccountId, $sessionId]);

logActivity($_SESSION['user_id'] ?? 0, "Reassigned session #$sessionId to slot {$slot['slot_name']} (account #{$newAccountId})");

jsonResponse([
    'success' => true,
    'message' => 'User reassigned to ' . $slot['slot_name'] . ' successfully.',
]);
