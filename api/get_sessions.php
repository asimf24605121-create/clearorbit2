<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');
session_write_close();

$pdo = getPDO();

$page = max(1, (int)($_GET['page'] ?? 1));
$perPage = min(100, max(1, (int)($_GET['per_page'] ?? 25)));
$offset = ($page - 1) * $perPage;

$cutoff = date('Y-m-d H:i:s', strtotime('-' . SESSION_INACTIVITY_TIMEOUT_MINUTES . ' minutes'));
$pdo->prepare("UPDATE user_sessions SET status = 'inactive', logout_reason = 'Session expired due to inactivity' WHERE status = 'active' AND last_activity < ? AND logout_reason IS NULL")->execute([$cutoff]);

$totalCount = (int)$pdo->query("SELECT COUNT(*) FROM user_sessions WHERE status = 'active'")->fetchColumn();

$stmt = $pdo->prepare("
    SELECT
        s.id, s.user_id, u.username, u.name AS user_name,
        s.device_id, s.ip_address, s.device_type, s.browser, s.os,
        s.status, s.last_activity, s.created_at
    FROM user_sessions s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.status = 'active'
    ORDER BY s.last_activity DESC
    LIMIT ? OFFSET ?
");
$stmt->execute([$perPage, $offset]);
$sessions = $stmt->fetchAll();

$userIds = array_unique(array_column($sessions, 'user_id'));
$suspiciousUsers = [];
if (!empty($userIds)) {
    $placeholders = implode(',', array_fill(0, count($userIds), '?'));
    $ipStmt = $pdo->prepare("SELECT user_id, COUNT(DISTINCT ip_address) as ip_count FROM user_sessions WHERE user_id IN ($placeholders) AND status = 'active' GROUP BY user_id HAVING ip_count > 2");
    $ipStmt->execute($userIds);
    foreach ($ipStmt->fetchAll() as $row) {
        $suspiciousUsers[(int)$row['user_id']] = true;
    }
}

foreach ($sessions as &$s) {
    $s['is_suspicious'] = isset($suspiciousUsers[(int)$s['user_id']]);
    if ($s['is_suspicious']) $s['suspicious_reason'] = 'Multiple IPs active';
}
unset($s);

jsonResponse([
    'success'    => true,
    'sessions'   => $sessions,
    'csrf_token' => generateCsrfToken(),
    'pagination' => [
        'page' => $page,
        'per_page' => $perPage,
        'total_count' => $totalCount,
        'total_pages' => (int)ceil($totalCount / $perPage),
    ],
]);
