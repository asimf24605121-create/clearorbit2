<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');
session_write_close();

$pdo = getPDO();
$page = max(1, (int)($_GET['page'] ?? 1));
$perPage = min(100, max(1, (int)($_GET['per_page'] ?? 25)));
$offset = ($page - 1) * $perPage;
$status = trim($_GET['status'] ?? 'all');

$where = '';
$params = [];
if ($status !== 'all' && in_array($status, ['success', 'failed', 'blocked', 'disabled'], true)) {
    $where = 'WHERE status = ?';
    $params[] = $status;
}

$countStmt = $pdo->prepare("SELECT COUNT(*) FROM login_attempt_logs $where");
$countStmt->execute($params);
$totalCount = (int)$countStmt->fetchColumn();

$params[] = $perPage;
$params[] = $offset;
$stmt = $pdo->prepare("SELECT id, username, ip_address, device_type, browser, os, status, reason, created_at FROM login_attempt_logs $where ORDER BY created_at DESC LIMIT ? OFFSET ?");
$stmt->execute($params);
$attempts = $stmt->fetchAll();

$cutoff24h = date('Y-m-d H:i:s', strtotime('-24 hours'));
$statsStmt = $pdo->prepare("
    SELECT status, COUNT(*) as cnt
    FROM login_attempt_logs
    WHERE created_at >= ?
    GROUP BY status
");
$statsStmt->execute([$cutoff24h]);
$stats = ['failed' => 0, 'blocked' => 0, 'success' => 0];
foreach ($statsStmt->fetchAll() as $row) {
    if (isset($stats[$row['status']])) $stats[$row['status']] = (int)$row['cnt'];
}

jsonResponse([
    'success'  => true,
    'attempts' => $attempts,
    'stats_24h' => $stats,
    'csrf_token' => generateCsrfToken(),
    'pagination' => [
        'page' => $page,
        'per_page' => $perPage,
        'total_count' => $totalCount,
        'total_pages' => (int)ceil($totalCount / $perPage),
    ],
]);
