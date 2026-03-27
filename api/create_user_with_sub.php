<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('manager');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$username = trim($input['username'] ?? '');
$password = trim($input['password'] ?? '');
$email    = trim($input['email'] ?? '');
$duration_in_days = (int)($input['duration_in_days'] ?? 0);
$platform_ids = [];

if (isset($input['platform_ids']) && is_array($input['platform_ids'])) {
    $platform_ids = array_map('intval', $input['platform_ids']);
    $platform_ids = array_filter($platform_ids, fn($id) => $id > 0);
}

if ($username === '' || $password === '' || $email === '') {
    jsonResponse(['success' => false, 'message' => 'Username, email, and password are required.'], 400);
}

if (strlen($username) < 3 || strlen($username) > 50) {
    jsonResponse(['success' => false, 'message' => 'Username must be 3-50 characters.'], 400);
}

if (strlen($password) < 6) {
    jsonResponse(['success' => false, 'message' => 'Password must be at least 6 characters.'], 400);
}

if (!preg_match('/^[a-zA-Z0-9_]+$/', $username)) {
    jsonResponse(['success' => false, 'message' => 'Username can only contain letters, numbers, and underscores.'], 400);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    jsonResponse(['success' => false, 'message' => 'Invalid email address.'], 400);
}

if ($duration_in_days < 0 || $duration_in_days > 365) {
    jsonResponse(['success' => false, 'message' => 'Duration must be between 0 and 365 days.'], 400);
}

$pdo = getPDO();
$userCreated = false;
$userUpdated = false;
$userId = 0;
$assigned = [];
$extended = [];
$skipped = [];

try {
    $pdo->beginTransaction();

    $check = $pdo->prepare("SELECT id, is_active FROM users WHERE username = ?");
    $check->execute([$username]);
    $existingUser = $check->fetch();

    if ($existingUser) {
        if (empty($platform_ids) || $duration_in_days <= 0) {
            $pdo->rollBack();
            jsonResponse(['success' => false, 'message' => 'Username already exists. To add subscriptions to this user, select platforms and duration.'], 409);
        }

        $emailOther = $pdo->prepare("SELECT id FROM users WHERE email = ? AND id != ?");
        $emailOther->execute([$email, $existingUser['id']]);
        if ($emailOther->fetch()) {
            $pdo->rollBack();
            jsonResponse(['success' => false, 'message' => 'Email is already in use by another user.'], 409);
        }

        $userId = (int)$existingUser['id'];
        $userUpdated = true;

        $pdo->prepare("UPDATE users SET email = ?, is_active = 1 WHERE id = ?")
            ->execute([$email, $userId]);
    } else {
        $emailCheck = $pdo->prepare("SELECT id FROM users WHERE email = ?");
        $emailCheck->execute([$email]);
        if ($emailCheck->fetch()) {
            $pdo->rollBack();
            jsonResponse(['success' => false, 'message' => 'Email already in use.'], 409);
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        $pdo->prepare("INSERT INTO users (username, password_hash, email, role, is_active) VALUES (?, ?, ?, 'user', 1)")
            ->execute([$username, $hash, $email]);
        $userId = (int)$pdo->lastInsertId();
        $userCreated = true;
    }

    if ($duration_in_days > 0 && !empty($platform_ids)) {
        $startDate = new DateTime();
        $endDate   = new DateTime();
        $endDate->modify("+{$duration_in_days} days");
        $startStr = $startDate->format('Y-m-d');
        $endStr   = $endDate->format('Y-m-d');

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

            $existCheck->execute([$userId, $pid]);
            $existing = $existCheck->fetch();

            if ($existing) {
                $existingEnd = new DateTime($existing['end_date']);
                if ($existingEnd > $startDate) {
                    $newEnd = clone $existingEnd;
                    $newEnd->modify("+{$duration_in_days} days");
                    $pdo->prepare("UPDATE user_subscriptions SET end_date = ? WHERE id = ?")
                        ->execute([$newEnd->format('Y-m-d'), $existing['id']]);
                    $extended[] = $plat['name'];
                    continue;
                }
            }

            $deact->execute([$userId, $pid]);
            $insert->execute([$userId, $pid, $startStr, $endStr]);
            $assigned[] = $plat['name'];
        }
    }

    syncUserExpiryDate($pdo, $userId);

    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    jsonResponse(['success' => false, 'message' => 'Operation failed. Please try again.'], 500);
}

$userStatus = $userCreated ? 'created' : ($userUpdated ? 'updated' : 'unchanged');
$totalPlatforms = count($assigned) + count($extended);

$parts = [];
if ($userCreated) $parts[] = "User '{$username}' created";
if ($userUpdated) $parts[] = "User '{$username}' updated";
if (count($assigned) > 0) $parts[] = count($assigned) . " platform(s) assigned";
if (count($extended) > 0) $parts[] = count($extended) . " platform(s) extended";
if ($duration_in_days > 0 && !empty($platform_ids)) $parts[] = "for {$duration_in_days} day(s)";
$msg = implode(', ', $parts) . '.';

if ($userCreated && $totalPlatforms > 0) {
    $msg = "User '{$username}' created and subscription activated successfully.";
}

logActivity($_SESSION['user_id'], "auto_user_setup: user={$username} status={$userStatus} platforms=" . count($platform_ids) . " days={$duration_in_days}", getClientIP());

jsonResponse([
    'success' => true,
    'message' => $msg,
    'user_id' => $userId,
    'username' => $username,
    'user_status' => $userStatus,
    'duration_days' => $duration_in_days,
    'platforms_assigned' => $assigned,
    'platforms_extended' => $extended,
    'platforms_skipped' => $skipped,
    'total_platforms' => $totalPlatforms,
]);
