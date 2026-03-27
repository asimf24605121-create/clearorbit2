<?php
require_once __DIR__ . '/../db.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$name = trim($input['name'] ?? '');
$email = trim($input['email'] ?? '');
$message = trim($input['message'] ?? '');

if ($name === '' || $email === '' || $message === '') {
    jsonResponse(['success' => false, 'message' => 'All fields are required.'], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    jsonResponse(['success' => false, 'message' => 'Please enter a valid email address.'], 400);
}

if (strlen($name) > 100) {
    jsonResponse(['success' => false, 'message' => 'Name must be 100 characters or less.'], 400);
}

if (strlen($message) > 2000) {
    jsonResponse(['success' => false, 'message' => 'Message must be 2000 characters or less.'], 400);
}

$pdo = getPDO();

$ip = getClientIP();
$cutoff = date('Y-m-d H:i:s', strtotime('-10 minutes'));
$recent = $pdo->prepare("SELECT COUNT(*) FROM contact_messages WHERE email = ? AND created_at > ?");
$recent->execute([$email, $cutoff]);
if ((int)$recent->fetchColumn() >= 3) {
    jsonResponse(['success' => false, 'message' => 'Too many messages sent. Please try again later.'], 429);
}

$pdo->prepare("INSERT INTO contact_messages (name, email, message) VALUES (?, ?, ?)")
    ->execute([$name, $email, $message]);

jsonResponse(['success' => true, 'message' => 'Your message has been sent. We\'ll get back to you soon!']);
