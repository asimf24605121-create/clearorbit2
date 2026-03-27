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

$stmt = $pdo->prepare("SELECT id, name, logo_url FROM platforms WHERE id = ?");
$stmt->execute([$platform_id]);
$platform = $stmt->fetch();

if (!$platform) {
    jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
}

if ($platform['logo_url'] && !str_starts_with($platform['logo_url'], 'http')) {
    $uploadsDir = realpath(__DIR__ . '/../uploads');
    $filePath = realpath(__DIR__ . '/../' . $platform['logo_url']);
    if ($filePath && $uploadsDir && str_starts_with($filePath, $uploadsDir) && file_exists($filePath)) {
        unlink($filePath);
    }
}

$pdo->beginTransaction();
try {
    $pdo->prepare("DELETE FROM cookie_vault WHERE platform_id = ?")->execute([$platform_id]);
    $pdo->prepare("DELETE FROM user_subscriptions WHERE platform_id = ?")->execute([$platform_id]);
    $pdo->prepare("DELETE FROM platforms WHERE id = ?")->execute([$platform_id]);
    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    jsonResponse(['success' => false, 'message' => 'Failed to delete platform.'], 500);
}

logActivity($_SESSION['user_id'], "platform_deleted: id={$platform_id} name={$platform['name']}", getClientIP());

jsonResponse([
    'success' => true,
    'message' => "Platform '{$platform['name']}' deleted permanently.",
]);
