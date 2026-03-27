<?php
require __DIR__ . '/../db.php';
session_start();

if (!isset($_SESSION['user_id']) || ($_SESSION['role'] ?? '') !== 'admin' || ($_SESSION['admin_level'] ?? '') === 'manager') {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}
session_write_close();

$pdo = getPDO();

$status = $_GET['status'] ?? 'all';
$page = max(1, (int)($_GET['page'] ?? 1));
$perPage = min(100, max(1, (int)($_GET['per_page'] ?? 25)));
$offset = ($page - 1) * $perPage;

$where = '';
$params = [];
if (in_array($status, ['pending', 'approved', 'rejected'])) {
    $where = 'WHERE pay.status = ?';
    $params[] = $status;
}

$countStmt = $pdo->prepare("SELECT COUNT(*) FROM payments pay $where");
$countStmt->execute($params);
$totalCount = (int)$countStmt->fetchColumn();

$params[] = $perPage;
$params[] = $offset;
$stmt = $pdo->prepare("
    SELECT pay.id, pay.user_id, pay.platform_id, pay.username, pay.duration_key,
           pay.account_type, pay.price, pay.status, pay.screenshot, pay.payment_method,
           pay.reseller_id, pay.created_at, pay.updated_at,
           p.name AS platform_name
    FROM payments pay
    JOIN platforms p ON p.id = pay.platform_id
    $where
    ORDER BY pay.created_at DESC
    LIMIT ? OFFSET ?
");
$stmt->execute($params);
$payments = $stmt->fetchAll();

jsonResponse([
    'success' => true,
    'payments' => $payments,
    'pagination' => [
        'page' => $page,
        'per_page' => $perPage,
        'total_count' => $totalCount,
        'total_pages' => (int)ceil($totalCount / $perPage),
    ],
]);
