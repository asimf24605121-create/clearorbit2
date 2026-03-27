<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$userId = (int)$_SESSION['user_id'];
$pdo = getPDO();
$input = json_decode(file_get_contents('php://input'), true);
$action = $input['action'] ?? 'mark_one';

if ($action === 'mark_all') {
    $stmt = $pdo->prepare("UPDATE user_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0");
    $stmt->execute([$userId]);
    jsonResponse(['success' => true, 'message' => 'All notifications marked as read.']);
}

$id = (int)($input['id'] ?? 0);
if ($id <= 0) {
    jsonResponse(['success' => false, 'message' => 'Invalid notification ID.'], 400);
}

$stmt = $pdo->prepare("UPDATE user_notifications SET is_read = 1 WHERE id = ? AND user_id = ?");
$stmt->execute([$id, $userId]);

if ($stmt->rowCount() === 0) {
    jsonResponse(['success' => false, 'message' => 'Notification not found.'], 404);
}

jsonResponse(['success' => true, 'message' => 'Notification marked as read.']);
