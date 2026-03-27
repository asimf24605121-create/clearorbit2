<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized. Please log in.'], 401);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$platformName = trim($input['platform_name'] ?? '');
$message = trim($input['message'] ?? '');

if ($platformName === '' || $message === '') {
    jsonResponse(['success' => false, 'message' => 'Platform name and message are required.'], 400);
}

if (strlen($message) > 1000) {
    jsonResponse(['success' => false, 'message' => 'Message must be 1000 characters or less.'], 400);
}

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];

$cutoff = date('Y-m-d H:i:s', strtotime('-5 minutes'));
$recent = $pdo->prepare("SELECT COUNT(*) FROM support_tickets WHERE user_id = ? AND created_at > ?");
$recent->execute([$userId, $cutoff]);
if ((int)$recent->fetchColumn() >= 3) {
    jsonResponse(['success' => false, 'message' => 'Too many tickets submitted. Please wait a few minutes.'], 429);
}

$stmt = $pdo->prepare("INSERT INTO support_tickets (user_id, platform_name, message) VALUES (?, ?, ?)");
$stmt->execute([$userId, $platformName, $message]);

logActivity($userId, "ticket_created: platform={$platformName}", getClientIP());

jsonResponse(['success' => true, 'message' => 'Issue reported successfully. Our team will look into it.']);
