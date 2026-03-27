<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');
session_write_close();

$pdo = getPDO();

$page = max(1, (int)($_GET['page'] ?? 1));
$perPage = min(100, max(1, (int)($_GET['per_page'] ?? 25)));
$offset = ($page - 1) * $perPage;

$totalCount = (int)$pdo->query("SELECT COUNT(*) FROM contact_messages")->fetchColumn();

$stmt = $pdo->prepare("SELECT id, name, email, message, is_read, created_at FROM contact_messages ORDER BY created_at DESC LIMIT ? OFFSET ?");
$stmt->execute([$perPage, $offset]);
$contacts = $stmt->fetchAll();

$unreadCount = (int)$pdo->query("SELECT COUNT(*) FROM contact_messages WHERE is_read = 0")->fetchColumn();

jsonResponse([
    'success' => true,
    'contacts' => $contacts,
    'unread_count' => $unreadCount,
    'csrf_token' => generateCsrfToken(),
    'pagination' => [
        'page' => $page,
        'per_page' => $perPage,
        'total_count' => $totalCount,
        'total_pages' => (int)ceil($totalCount / $perPage),
    ],
]);
