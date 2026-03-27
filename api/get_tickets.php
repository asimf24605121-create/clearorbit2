<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');
session_write_close();

$pdo = getPDO();

$status = $_GET['status'] ?? 'all';
$page = max(1, (int)($_GET['page'] ?? 1));
$perPage = min(100, max(1, (int)($_GET['per_page'] ?? 25)));
$offset = ($page - 1) * $perPage;

$where = '';
$params = [];
if ($status === 'pending') {
    $where = 'WHERE st.status = ?';
    $params[] = 'pending';
} elseif ($status === 'resolved') {
    $where = 'WHERE st.status = ?';
    $params[] = 'resolved';
}

$countStmt = $pdo->prepare("SELECT COUNT(*) FROM support_tickets st $where");
$countStmt->execute($params);
$totalCount = (int)$countStmt->fetchColumn();

$params[] = $perPage;
$params[] = $offset;
$stmt = $pdo->prepare("
    SELECT st.id, st.user_id, st.platform_name, st.message, st.status, st.created_at,
           u.username, u.name AS user_name, u.email AS user_email
    FROM support_tickets st
    LEFT JOIN users u ON u.id = st.user_id
    $where
    ORDER BY st.created_at DESC
    LIMIT ? OFFSET ?
");
$stmt->execute($params);
$tickets = $stmt->fetchAll();

$pendingCount = (int)$pdo->query("SELECT COUNT(*) FROM support_tickets WHERE status = 'pending'")->fetchColumn();

jsonResponse([
    'success' => true,
    'tickets' => $tickets,
    'pending_count' => $pendingCount,
    'csrf_token' => generateCsrfToken(),
    'pagination' => [
        'page' => $page,
        'per_page' => $perPage,
        'total_count' => $totalCount,
        'total_pages' => (int)ceil($totalCount / $perPage),
    ],
]);
