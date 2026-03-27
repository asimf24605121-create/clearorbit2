<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$user_id          = (int)($input['user_id'] ?? 0);
$duration_in_days = (int)($input['duration_in_days'] ?? 0);

$platform_ids = [];
if (isset($input['platform_ids']) && is_array($input['platform_ids'])) {
    $platform_ids = array_map('intval', $input['platform_ids']);
    $platform_ids = array_filter($platform_ids, fn($id) => $id > 0);
} elseif (isset($input['platform_id']) && (int)$input['platform_id'] > 0) {
    $platform_ids = [(int)$input['platform_id']];
}

if ($user_id <= 0 || empty($platform_ids) || $duration_in_days <= 0) {
    jsonResponse(['success' => false, 'message' => 'user_id, platform(s), and duration_in_days are required and must be positive.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id FROM users WHERE id = ? AND role = 'user'");
$stmt->execute([$user_id]);
if (!$stmt->fetch()) {
    jsonResponse(['success' => false, 'message' => 'User not found.'], 404);
}

$startDate = new DateTime();
$endDate   = new DateTime();
$endDate->modify("+{$duration_in_days} days");
$startStr = $startDate->format('Y-m-d');
$endStr   = $endDate->format('Y-m-d');

$assigned = [];
$skipped  = [];
$extended = [];

$platCheck = $pdo->prepare("SELECT id, name FROM platforms WHERE id = ?");
$existCheck = $pdo->prepare("SELECT id, end_date FROM user_subscriptions WHERE user_id = ? AND platform_id = ? AND is_active = 1");
$deact = $pdo->prepare("UPDATE user_subscriptions SET is_active = 0 WHERE user_id = ? AND platform_id = ? AND is_active = 1");
$insert = $pdo->prepare("INSERT INTO user_subscriptions (user_id, platform_id, start_date, end_date, is_active) VALUES (?, ?, ?, ?, 1)");

foreach ($platform_ids as $pid) {
    $platCheck->execute([$pid]);
    $plat = $platCheck->fetch();
    if (!$plat) {
        $skipped[] = "Platform #{$pid} not found";
        continue;
    }

    $existCheck->execute([$user_id, $pid]);
    $existing = $existCheck->fetch();

    if ($existing) {
        $existingEnd = new DateTime($existing['end_date']);
        if ($existingEnd > $startDate) {
            $newEnd = clone $existingEnd;
            $newEnd->modify("+{$duration_in_days} days");
            $pdo->prepare("UPDATE user_subscriptions SET end_date = ? WHERE id = ?")->execute([$newEnd->format('Y-m-d'), $existing['id']]);
            $extended[] = $plat['name'];
            continue;
        }
    }

    $deact->execute([$user_id, $pid]);
    $insert->execute([$user_id, $pid, $startStr, $endStr]);
    $assigned[] = $plat['name'];
}

$totalDone = count($assigned) + count($extended);
$parts = [];
if (count($assigned) > 0) $parts[] = count($assigned) . ' platform(s) assigned';
if (count($extended) > 0) $parts[] = count($extended) . ' platform(s) extended';
if (count($skipped) > 0) $parts[] = count($skipped) . ' skipped';
$msg = implode(', ', $parts) . " for {$duration_in_days} day(s).";

logActivity($_SESSION['user_id'], "bulk_subscription: user={$user_id} platforms=" . implode(',', $platform_ids) . " days={$duration_in_days}", getClientIP());

jsonResponse([
    'success'  => $totalDone > 0,
    'message'  => $msg,
    'assigned' => $assigned,
    'extended' => $extended,
    'skipped'  => $skipped,
]);
