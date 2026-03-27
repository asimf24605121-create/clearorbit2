<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$id            = (int)($input['id'] ?? 0);
$name          = trim($input['name'] ?? '');
$logo_url      = trim($input['logo_url'] ?? '');
$bg_color_hex  = trim($input['bg_color_hex'] ?? '#1e293b');
$cookie_domain = trim($input['cookie_domain'] ?? '');
$login_url     = trim($input['login_url'] ?? '');
$is_active     = isset($input['is_active']) ? (int)$input['is_active'] : 1;

if (!in_array($is_active, [0, 1], true)) {
    jsonResponse(['success' => false, 'message' => 'Invalid status value.'], 400);
}

if ($id <= 0) {
    jsonResponse(['success' => false, 'message' => 'Invalid platform ID.'], 400);
}

if ($name === '') {
    jsonResponse(['success' => false, 'message' => 'Platform name is required.'], 400);
}

if (strlen($name) > 150) {
    jsonResponse(['success' => false, 'message' => 'Platform name must be 150 characters or less.'], 400);
}

if ($bg_color_hex !== '' && !preg_match('/^#[0-9a-fA-F]{6}$/', $bg_color_hex)) {
    jsonResponse(['success' => false, 'message' => 'Invalid color format. Use #RRGGBB.'], 400);
}

if ($cookie_domain !== '' && !preg_match('/^\.?[a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}$/', $cookie_domain)) {
    jsonResponse(['success' => false, 'message' => 'Invalid cookie domain format. Example: .netflix.com'], 400);
}

if ($login_url !== '' && !filter_var($login_url, FILTER_VALIDATE_URL)) {
    jsonResponse(['success' => false, 'message' => 'Invalid login URL format. Example: https://www.netflix.com/'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, name FROM platforms WHERE id = ?");
$stmt->execute([$id]);
$existing = $stmt->fetch();
if (!$existing) {
    jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
}

$stmt = $pdo->prepare("UPDATE platforms SET name = ?, logo_url = ?, bg_color_hex = ?, cookie_domain = ?, login_url = ?, is_active = ? WHERE id = ?");
$stmt->execute([
    $name,
    $logo_url ?: null,
    $bg_color_hex,
    $cookie_domain ?: null,
    $login_url ?: null,
    $is_active,
    $id,
]);

logActivity($_SESSION['user_id'], "platform_updated: {$name} (ID: {$id})", getClientIP());

jsonResponse([
    'success' => true,
    'message' => "Platform '{$name}' updated successfully.",
]);
