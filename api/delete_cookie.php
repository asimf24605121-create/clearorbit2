<?php
require_once __DIR__ . '/../db.php';
session_start();
validateCsrfToken();

checkAdminAccess('super_admin');

$input = json_decode(file_get_contents('php://input'), true);
$cookieId = (int)($input['cookie_id'] ?? 0);

if (!$cookieId) {
    jsonResponse(['success' => false, 'message' => 'Cookie ID is required.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT cv.id, cv.slot, p.name AS platform_name FROM cookie_vault cv JOIN platforms p ON p.id = cv.platform_id WHERE cv.id = ?");
$stmt->execute([$cookieId]);
$cookie = $stmt->fetch();

if (!$cookie) {
    jsonResponse(['success' => false, 'message' => 'Cookie not found.'], 404);
}

$del = $pdo->prepare("DELETE FROM cookie_vault WHERE id = ?");
$del->execute([$cookieId]);

logActivity($_SESSION['user_id'], "Deleted cookie #{$cookieId} ({$cookie['platform_name']} Slot {$cookie['slot']})", getClientIP());

jsonResponse(['success' => true, 'message' => "Cookie for {$cookie['platform_name']} (Slot {$cookie['slot']}) deleted."]);
