<?php
require_once __DIR__ . '/../db.php';

session_start();
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

checkAdminAccess('super_admin');
validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$sessionId = (int)($input['session_id'] ?? 0);

if ($sessionId < 1) {
    jsonResponse(['success' => false, 'message' => 'Invalid session ID.'], 400);
}

$pdo = getPDO();
$stmt = $pdo->prepare("SELECT user_id, session_token FROM user_sessions WHERE id = ? AND status = 'active'");
$stmt->execute([$sessionId]);
$sess = $stmt->fetch();

if (!$sess) {
    jsonResponse(['success' => false, 'message' => 'Session not found or already inactive.'], 404);
}

deactivateUserSession($sess['session_token'], 'Session terminated by admin');
logActivity((int)$_SESSION['user_id'], 'admin_kill_session_user_' . $sess['user_id'], getClientIP());

jsonResponse([
    'success' => true,
    'message' => 'Session terminated successfully.',
]);
