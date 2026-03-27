<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];
$input = json_decode(file_get_contents('php://input'), true);
$platformId = (int)($input['platform_id'] ?? 0);

if ($platformId < 1) {
    jsonResponse(['success' => false, 'message' => 'Missing platform ID.'], 400);
}

$now = date('Y-m-d H:i:s');

$stmt = $pdo->prepare("
    SELECT id, account_id FROM account_sessions
    WHERE user_id = ? AND platform_id = ? AND status = 'active'
    LIMIT 1
");
$stmt->execute([$userId, $platformId]);
$session = $stmt->fetch();

if (!$session) {
    jsonResponse(['success' => false, 'message' => 'No active session found.', 'expired' => true]);
}

$pdo->prepare("UPDATE account_sessions SET last_active = ? WHERE id = ?")->execute([$now, $session['id']]);

jsonResponse(['success' => true, 'updated' => true, 'session_id' => (int)$session['id']]);
