<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$id = (int)($input['id'] ?? 0);
$action = $input['action'] ?? '';

if ($id <= 0) {
    jsonResponse(['success' => false, 'message' => 'ID is required.'], 400);
}

if (!in_array($action, ['read', 'delete'], true)) {
    jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);
}

$pdo = getPDO();

if ($action === 'read') {
    $pdo->prepare("UPDATE contact_messages SET is_read = 1 WHERE id = ?")->execute([$id]);
    jsonResponse(['success' => true, 'message' => 'Marked as read.']);
} else {
    $pdo->prepare("DELETE FROM contact_messages WHERE id = ?")->execute([$id]);
    jsonResponse(['success' => true, 'message' => 'Message deleted.']);
}
