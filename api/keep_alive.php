<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$body  = file_get_contents('php://input');
$input = json_decode($body, true);

if (!is_array($input)) {
    jsonResponse(['success' => false, 'message' => 'Invalid JSON payload.'], 400);
}

$poolId = is_numeric($input['pool_id'] ?? null) ? (int)$input['pool_id'] : null;

if ($poolId) {
    try {
        require_once __DIR__ . '/../lib/SessionManager.php';
        $pdo = getPDO();
        SessionManager::initSessionPool($pdo);

        $userId = $_SESSION['user_id'] ?? null;
        $checkStmt = $pdo->prepare("SELECT locked_by FROM session_pool WHERE id = ? AND status = 'active'");
        $checkStmt->execute([$poolId]);
        $row = $checkStmt->fetch();

        if (!$row) {
            jsonResponse(['success' => false, 'message' => 'Session not found or not active'], 404);
        }

        if ($row['locked_by'] !== null && $row['locked_by'] !== (string)$userId) {
            jsonResponse(['success' => false, 'message' => 'Session locked by another user'], 403);
        }

        $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
        $now = $driver === 'sqlite' ? "datetime('now')" : 'NOW()';

        $pdo->exec("UPDATE session_pool SET last_used = {$now}, usage_count = usage_count + 1, updated_at = {$now} WHERE id = " . (int)$poolId . " AND status = 'active'");

        $logStmt = $pdo->prepare("INSERT INTO session_analytics (pool_id, event, ip_address) VALUES (?, 'keep_alive', ?)");
        $logStmt->execute([$poolId, $_SERVER['REMOTE_ADDR'] ?? null]);

        jsonResponse(['success' => true, 'message' => 'Session refreshed', 'pool_id' => $poolId]);
    } catch (Throwable $e) {
        error_log('keep_alive error: ' . $e->getMessage());
        jsonResponse(['success' => false, 'message' => 'Keep-alive failed'], 500);
    }
} else {
    jsonResponse(['success' => true, 'message' => 'Keep-alive acknowledged', 'timestamp' => time()]);
}
