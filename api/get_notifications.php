<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$userId = (int)$_SESSION['user_id'];
$pdo = getPDO();

$limit = min(50, max(1, (int)($_GET['limit'] ?? 20)));
$offset = max(0, (int)($_GET['offset'] ?? 0));

$stmt = $pdo->prepare("
    SELECT id, title, message, type, is_read, created_at
    FROM user_notifications
    WHERE user_id = ?
    ORDER BY is_read ASC, created_at DESC
    LIMIT ? OFFSET ?
");
$stmt->execute([$userId, $limit, $offset]);
$notifications = $stmt->fetchAll();

$countStmt = $pdo->prepare("SELECT COUNT(*) FROM user_notifications WHERE user_id = ? AND is_read = 0");
$countStmt->execute([$userId]);
$unreadCount = (int)$countStmt->fetchColumn();

jsonResponse([
    'success' => true,
    'notifications' => $notifications,
    'unread_count' => $unreadCount,
]);
