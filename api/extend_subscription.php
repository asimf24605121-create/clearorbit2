<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$sub_id = (int)($input['subscription_id'] ?? 0);
$days   = (int)($input['days'] ?? 7);

if ($sub_id <= 0) {
    jsonResponse(['success' => false, 'message' => 'subscription_id is required.'], 400);
}

if ($days < 1 || $days > 365) {
    jsonResponse(['success' => false, 'message' => 'Days must be between 1 and 365.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT us.id, us.end_date, us.user_id, us.platform_id, u.username, p.name AS platform_name FROM user_subscriptions us JOIN users u ON u.id = us.user_id JOIN platforms p ON p.id = us.platform_id WHERE us.id = ?");
$stmt->execute([$sub_id]);
$sub = $stmt->fetch();

if (!$sub) {
    jsonResponse(['success' => false, 'message' => 'Subscription not found.'], 404);
}

$currentEnd = new DateTime($sub['end_date']);
$now = new DateTime();
if ($currentEnd < $now) {
    $currentEnd = $now;
}
$currentEnd->modify("+{$days} days");
$newEnd = $currentEnd->format('Y-m-d');

$pdo->prepare("UPDATE user_subscriptions SET end_date = ?, is_active = 1 WHERE id = ?")->execute([$newEnd, $sub_id]);

syncUserExpiryDate($pdo, (int)$sub['user_id']);

logActivity($_SESSION['user_id'], "subscription_extended: sub={$sub_id} user={$sub['username']} platform={$sub['platform_name']} +{$days}d", getClientIP());

jsonResponse([
    'success'  => true,
    'message'  => "Extended {$sub['username']}'s {$sub['platform_name']} access by {$days} day(s). New expiry: {$newEnd}.",
    'end_date' => $newEnd,
]);
