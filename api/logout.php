<?php
require_once __DIR__ . '/../db.php';

session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

$token = $_SERVER['HTTP_X_CSRF_TOKEN']
    ?? json_decode(file_get_contents('php://input'), true)['csrf_token']
    ?? '';
$csrfValid = !empty($_SESSION['csrf_token']) && hash_equals($_SESSION['csrf_token'], $token);

$userId = $_SESSION['user_id'] ?? null;
$sessionToken = $_SESSION['session_token'] ?? null;
$platforms = [];

if ($userId && $csrfValid) {
    $ip = getClientIP();
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? 'Unknown';

    deactivateAllUserSessions((int)$userId, null, 'Logged out successfully');

    try {
        $pdo = getPDO();

        $stmt = $pdo->prepare("
            SELECT DISTINCT p.cookie_domain 
            FROM account_sessions as_tbl 
            JOIN platforms p ON p.id = as_tbl.platform_id 
            WHERE as_tbl.user_id = ? AND as_tbl.status = 'active'
        ");
        $stmt->execute([(int)$userId]);
        $rows = $stmt->fetchAll();
        foreach ($rows as $row) {
            $domain = $row['cookie_domain'] ?? '';
            if ($domain !== '') {
                $platforms[] = ltrim($domain, '.');
            }
        }

        $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE user_id = ?")->execute([(int)$userId]);
    } catch (Exception $e) {}

    if (empty($platforms)) {
        $platforms = [
            'netflix.com', 'spotify.com', 'disneyplus.com',
            'openai.com', 'canva.com', 'udemy.com',
            'coursera.org', 'skillshare.com', 'grammarly.com'
        ];
    }

    logLoginHistory((int)$userId, 'logout', $ip, $ua);
    logActivity((int)$userId, 'logout', $ip);
}

session_destroy();

jsonResponse([
    'success' => true,
    'message' => 'Logged out successfully.',
    'action' => 'FORCE_BROWSER_LOGOUT',
    'platforms' => $platforms
]);
