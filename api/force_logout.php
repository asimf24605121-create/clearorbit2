<?php
require_once __DIR__ . '/../db.php';

session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

validateCsrfToken();

$userId = (int)$_SESSION['user_id'];
$currentToken = $_SESSION['session_token'] ?? null;
$ip = getClientIP();
$ua = $_SERVER['HTTP_USER_AGENT'] ?? 'Unknown';

$removed = deactivateAllUserSessions($userId, $currentToken, 'Logged out from another device');

logLoginHistory($userId, 'force_logout', $ip, $ua);
logActivity($userId, 'force_logout_other_devices', $ip);

jsonResponse([
    'success' => true,
    'message' => $removed > 0
        ? "Successfully logged out {$removed} other device(s)."
        : 'No other active sessions found.',
    'devices_removed' => $removed,
]);
