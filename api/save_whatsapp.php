<?php
require __DIR__ . '/../db.php';
session_start();
validateCsrfToken();

checkAdminAccess('super_admin');

$input = json_decode(file_get_contents('php://input'), true);
$platformId = (int)($input['platform_id'] ?? 0);
$number = trim($input['number'] ?? $input['shared_number'] ?? '');

if (!$platformId) {
    jsonResponse(['success' => false, 'message' => 'Platform is required.'], 400);
}

$pdo = getPDO();

$plat = $pdo->prepare("SELECT id FROM platforms WHERE id = ?");
$plat->execute([$platformId]);
if (!$plat->fetch()) {
    jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
}

$driver = getenv('DB_DRIVER') ?: 'sqlite';
if ($driver === 'mysql') {
    $stmt = $pdo->prepare("INSERT INTO whatsapp_config (platform_id, shared_number, private_number)
        VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE shared_number = VALUES(shared_number), private_number = VALUES(private_number)");
} else {
    $stmt = $pdo->prepare("INSERT INTO whatsapp_config (platform_id, shared_number, private_number)
        VALUES (?, ?, ?) ON CONFLICT(platform_id) DO UPDATE SET shared_number = excluded.shared_number, private_number = excluded.private_number");
}
$stmt->execute([$platformId, $number, $number]);

logActivity($_SESSION['user_id'], "Updated WhatsApp config for platform #$platformId", getClientIP());
jsonResponse(['success' => true, 'message' => 'WhatsApp configuration saved.']);
