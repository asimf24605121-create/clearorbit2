<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('manager');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$username = trim($input['username'] ?? '');
$password = trim($input['password'] ?? '');
$email    = trim($input['email'] ?? '');

if ($username === '' || $password === '' || $email === '') {
    jsonResponse(['success' => false, 'message' => 'Username, email, and password are required.'], 400);
}

if (strlen($username) < 3 || strlen($username) > 50) {
    jsonResponse(['success' => false, 'message' => 'Username must be 3-50 characters.'], 400);
}

if (strlen($password) < 6) {
    jsonResponse(['success' => false, 'message' => 'Password must be at least 6 characters.'], 400);
}

if (!preg_match('/^[a-zA-Z0-9_]+$/', $username)) {
    jsonResponse(['success' => false, 'message' => 'Username can only contain letters, numbers, and underscores.'], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    jsonResponse(['success' => false, 'message' => 'Invalid email address.'], 400);
}

$pdo = getPDO();

$check = $pdo->prepare("SELECT id FROM users WHERE username = ?");
$check->execute([$username]);
if ($check->fetch()) {
    jsonResponse(['success' => false, 'message' => 'Username already exists.'], 409);
}

$emailCheck = $pdo->prepare("SELECT id FROM users WHERE email = ?");
$emailCheck->execute([$email]);
if ($emailCheck->fetch()) {
    jsonResponse(['success' => false, 'message' => 'Email already in use.'], 409);
}

$hash = password_hash($password, PASSWORD_BCRYPT);

$stmt = $pdo->prepare("INSERT INTO users (username, password_hash, email, role, is_active) VALUES (?, ?, ?, 'user', 1)");
$stmt->execute([$username, $hash, $email]);

$newId = (int)$pdo->lastInsertId();

logActivity($_SESSION['user_id'], "user_created: id={$newId} username={$username}", getClientIP());

jsonResponse([
    'success' => true,
    'message' => "User '{$username}' created successfully.",
    'user_id' => $newId,
]);
