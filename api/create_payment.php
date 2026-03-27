<?php
require __DIR__ . '/../db.php';
session_start();

$input = json_decode(file_get_contents('php://input'), true);
$platformId = (int)($input['platform_id'] ?? 0);
$username = trim($input['username'] ?? '');
$durationKey = $input['duration_key'] ?? '';
$accountType = $input['account_type'] ?? 'shared';

if (!$platformId || !$username || !$durationKey) {
    jsonResponse(['success' => false, 'message' => 'Platform, username, and duration are required.'], 400);
}

if (!in_array($durationKey, ['1_week', '1_month', '6_months', '1_year'])) {
    jsonResponse(['success' => false, 'message' => 'Invalid duration.'], 400);
}

if (!in_array($accountType, ['shared', 'private'])) {
    $accountType = 'shared';
}

$pdo = getPDO();

$plat = $pdo->prepare("SELECT id, name FROM platforms WHERE id = ? AND is_active = 1");
$plat->execute([$platformId]);
$platform = $plat->fetch();
if (!$platform) {
    jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
}

$priceCol = $accountType === 'private' ? 'private_price' : 'shared_price';
$priceStmt = $pdo->prepare("SELECT {$priceCol} AS price FROM pricing_plans WHERE platform_id = ? AND duration_key = ?");
$priceStmt->execute([$platformId, $durationKey]);
$priceRow = $priceStmt->fetch();
$price = $priceRow ? (float)$priceRow['price'] : 0;

if ($price <= 0) {
    jsonResponse(['success' => false, 'message' => 'Pricing not configured for this platform/plan.'], 400);
}

$userRow = $pdo->prepare("SELECT id FROM users WHERE username = ?");
$userRow->execute([$username]);
$userFound = $userRow->fetch();
$userId = $userFound ? $userFound['id'] : null;

$durationLabels = ['1_week' => '1 Week', '1_month' => '1 Month', '6_months' => '6 Months', '1_year' => '1 Year'];
$msg = "Order: {$platform['name']} | User: {$username} | Plan: {$durationLabels[$durationKey]} | Type: {$accountType} | Price: \${$price}";

$stmt = $pdo->prepare("INSERT INTO payments (user_id, platform_id, username, duration_key, account_type, price, status, whatsapp_msg) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)");
$stmt->execute([$userId, $platformId, $username, $durationKey, $accountType, $price, $msg]);

jsonResponse(['success' => true, 'message' => 'Order placed successfully. Admin will confirm your payment.', 'payment_id' => (int)$pdo->lastInsertId()]);
