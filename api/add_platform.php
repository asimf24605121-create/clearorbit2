<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$name          = trim($input['name'] ?? '');
$logo_url      = trim($input['logo_url'] ?? '');
$color         = trim($input['bg_color_hex'] ?? '#1e293b');
$cookie_domain = trim($input['cookie_domain'] ?? '');
$login_url     = trim($input['login_url'] ?? '');

if ($name === '') {
    jsonResponse(['success' => false, 'message' => 'Platform name is required.'], 400);
}

if (strlen($name) > 150) {
    jsonResponse(['success' => false, 'message' => 'Platform name must be 150 characters or less.'], 400);
}

if ($color !== '' && !preg_match('/^#[0-9a-fA-F]{6}$/', $color)) {
    jsonResponse(['success' => false, 'message' => 'Invalid color format. Use #RRGGBB.'], 400);
}

if ($cookie_domain !== '' && !preg_match('/^\.?[a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}$/', $cookie_domain)) {
    jsonResponse(['success' => false, 'message' => 'Invalid cookie domain format. Example: .netflix.com'], 400);
}

if ($login_url !== '' && !filter_var($login_url, FILTER_VALIDATE_URL)) {
    jsonResponse(['success' => false, 'message' => 'Invalid login URL format. Example: https://www.netflix.com/'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("INSERT INTO platforms (name, logo_url, bg_color_hex, is_active, cookie_domain, login_url) VALUES (?, ?, ?, 1, ?, ?)");
$stmt->execute([$name, $logo_url ?: null, $color, $cookie_domain ?: null, $login_url ?: null]);

logActivity($_SESSION['user_id'], "platform_added: {$name}", getClientIP());

jsonResponse([
    'success'     => true,
    'message'     => "Platform '{$name}' added successfully.",
    'platform_id' => (int)$pdo->lastInsertId(),
]);
