<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$username = trim($input['username'] ?? '');
$password = trim($input['password'] ?? '');
$name     = trim($input['name'] ?? '');
$email    = trim($input['email'] ?? '');
$role     = trim($input['admin_level'] ?? '');

if ($username === '' || $password === '' || $name === '') {
    jsonResponse(['success' => false, 'message' => 'Username, password, and name are required.'], 400);
}

if (strlen($username) < 3 || strlen($username) > 50) {
    jsonResponse(['success' => false, 'message' => 'Username must be 3-50 characters.'], 400);
}

if (!preg_match('/^[a-zA-Z0-9_]+$/', $username)) {
    jsonResponse(['success' => false, 'message' => 'Username can only contain letters, numbers, and underscores.'], 400);
}

if (strlen($password) < 6) {
    jsonResponse(['success' => false, 'message' => 'Password must be at least 6 characters.'], 400);
}

if (!in_array($role, ['super_admin', 'manager'], true)) {
    jsonResponse(['success' => false, 'message' => 'Role must be super_admin or manager.'], 400);
}

if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    jsonResponse(['success' => false, 'message' => 'Invalid email address.'], 400);
}

$pdo = getPDO();

$check = $pdo->prepare("SELECT id FROM users WHERE username = ?");
$check->execute([$username]);
if ($check->fetch()) {
    jsonResponse(['success' => false, 'message' => 'Username already exists.'], 409);
}

if ($email !== '') {
    $emailCheck = $pdo->prepare("SELECT id FROM users WHERE email = ? AND email IS NOT NULL");
    $emailCheck->execute([$email]);
    if ($emailCheck->fetch()) {
        jsonResponse(['success' => false, 'message' => 'Email already in use.'], 409);
    }
}

$hash = password_hash($password, PASSWORD_BCRYPT);

$stmt = $pdo->prepare("INSERT INTO users (username, password_hash, role, is_active, admin_level, name, email) VALUES (?, ?, 'admin', 1, ?, ?, ?)");
$stmt->execute([$username, $hash, $role, $name, $email ?: null]);

$newId = (int)$pdo->lastInsertId();

$roleLabel = $role === 'super_admin' ? 'Super Admin' : 'Manager';
logActivity($_SESSION['user_id'], "admin_created: id={$newId} username={$username} role={$roleLabel}", getClientIP());

jsonResponse([
    'success' => true,
    'message' => "{$roleLabel} '{$username}' created successfully.",
    'admin_id' => $newId,
]);
