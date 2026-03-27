<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

$contentType = $_SERVER['CONTENT_TYPE'] ?? '';
$isBeacon = stripos($contentType, 'text/plain') !== false;
if (!$isBeacon) {
    validateCsrfToken();
}

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];
$input = json_decode(file_get_contents('php://input'), true);
$platformId = (int)($input['platform_id'] ?? 0);

if ($platformId < 1) {
    jsonResponse(['success' => false, 'message' => 'Missing platform ID.'], 400);
}

$stmt = $pdo->prepare("
    UPDATE account_sessions
    SET status = 'inactive'
    WHERE user_id = ? AND platform_id = ? AND status = 'active'
");
$stmt->execute([$userId, $platformId]);
$affected = $stmt->rowCount();

if ($affected > 0) {
    logActivity($userId, "session_released: platform_id={$platformId}", getClientIP());
}

jsonResponse([
    'success' => true,
    'message' => $affected > 0 ? 'Session released successfully.' : 'No active session found.',
    'released' => $affected > 0,
]);
