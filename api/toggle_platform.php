<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$platform_id = (int)($input['platform_id'] ?? 0);

if ($platform_id <= 0) {
    jsonResponse(['success' => false, 'message' => 'platform_id is required.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, name, is_active FROM platforms WHERE id = ?");
$stmt->execute([$platform_id]);
$platform = $stmt->fetch();

if (!$platform) {
    jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
}

$newStatus = $platform['is_active'] ? 0 : 1;
$pdo->prepare("UPDATE platforms SET is_active = ? WHERE id = ?")->execute([$newStatus, $platform_id]);

$statusLabel = $newStatus ? 'enabled' : 'disabled';
logActivity($_SESSION['user_id'], "platform_{$statusLabel}: id={$platform_id} name={$platform['name']}", getClientIP());

jsonResponse([
    'success'   => true,
    'message'   => "Platform '{$platform['name']}' {$statusLabel}.",
    'is_active' => $newStatus,
]);
