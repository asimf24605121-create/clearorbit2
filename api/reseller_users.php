<?php
require_once __DIR__ . '/../db.php';

session_start();

if (empty($_SESSION['user_id']) || $_SESSION['role'] !== 'reseller') {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 403);
}

validateCsrfToken();

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];

$reseller = $pdo->prepare("SELECT * FROM resellers WHERE user_id = ?");
$reseller->execute([$userId]);
$reseller = $reseller->fetch();

if (!$reseller || $reseller['status'] !== 'active') {
    jsonResponse(['success' => false, 'message' => 'Reseller account not active.'], 403);
}

$resellerId = (int)$reseller['id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $users = $pdo->prepare("
        SELECT u.id, u.username, u.email, u.name, u.is_active, u.created_at, u.expiry_date
        FROM users u
        WHERE u.reseller_id = ?
        ORDER BY u.created_at DESC
    ");
    $users->execute([$resellerId]);
    $userList = $users->fetchAll();

    foreach ($userList as &$u) {
        $subs = $pdo->prepare("
            SELECT us.*, p.name as platform_name
            FROM user_subscriptions us
            LEFT JOIN platforms p ON p.id = us.platform_id
            WHERE us.user_id = ?
            ORDER BY us.end_date DESC
        ");
        $subs->execute([(int)$u['id']]);
        $u['subscriptions'] = $subs->fetchAll();
    }
    unset($u);

    jsonResponse(['success' => true, 'users' => $userList]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    $action = $input['action'] ?? 'create';

    if ($action === 'create') {
        $username = trim($input['username'] ?? '');
        $email = trim($input['email'] ?? '');
        $password = trim($input['password'] ?? '');
        $platformIds = $input['platform_ids'] ?? [];
        $duration = (int)($input['duration_days'] ?? 30);

        if ($username === '' || $password === '') {
            jsonResponse(['success' => false, 'message' => 'Username and password are required.'], 400);
        }

        if (strlen($password) < 6) {
            jsonResponse(['success' => false, 'message' => 'Password must be at least 6 characters.'], 400);
        }

        $exists = $pdo->prepare("SELECT id FROM users WHERE username = ?");
        $exists->execute([$username]);
        if ($exists->fetch()) {
            jsonResponse(['success' => false, 'message' => 'Username already exists.'], 409);
        }

        if ($email !== '') {
            $emailExists = $pdo->prepare("SELECT id FROM users WHERE email = ?");
            $emailExists->execute([$email]);
            if ($emailExists->fetch()) {
                jsonResponse(['success' => false, 'message' => 'Email already in use.'], 409);
            }
        }

        $costPerUser = (float)getSiteSetting('reseller_cost_per_user', '100');
        $totalCost = $costPerUser;

        if ((float)$reseller['balance'] < $totalCost) {
            jsonResponse(['success' => false, 'message' => "Insufficient balance. Need PKR {$totalCost}, have PKR {$reseller['balance']}."], 400);
        }

        $pdo->beginTransaction();
        try {
            $hash = password_hash($password, PASSWORD_BCRYPT);
            $now = date('Y-m-d H:i:s');
            $stmt = $pdo->prepare("INSERT INTO users (username, password_hash, email, role, is_active, reseller_id, created_at) VALUES (?, ?, ?, 'user', 1, ?, ?)");
            $stmt->execute([$username, $hash, $email ?: null, $resellerId, $now]);
            $newUserId = (int)$pdo->lastInsertId();

            if (!empty($platformIds) && $duration > 0) {
                $endDate = date('Y-m-d H:i:s', strtotime("+{$duration} days"));
                foreach ($platformIds as $pid) {
                    $pid = (int)$pid;
                    $pdo->prepare("INSERT INTO user_subscriptions (user_id, platform_id, start_date, end_date, status) VALUES (?, ?, ?, ?, 'active')")
                        ->execute([$newUserId, $pid, $now, $endDate]);
                }
            }

            $newBalance = (float)$reseller['balance'] - $totalCost;
            $pdo->prepare("UPDATE resellers SET balance = ?, total_users = total_users + 1 WHERE id = ?")
                ->execute([$newBalance, $resellerId]);

            $pdo->prepare("INSERT INTO reseller_transactions (reseller_id, type, amount, balance_after, description) VALUES (?, 'deduction', ?, ?, ?)")
                ->execute([$resellerId, $totalCost, $newBalance, "User created: {$username}"]);

            syncUserExpiryDate($pdo, $newUserId);

            $pdo->commit();

            logActivity($userId, "reseller_create_user: {$username} cost={$totalCost}", getClientIP());

            jsonResponse([
                'success' => true,
                'message' => "User '{$username}' created successfully. PKR {$totalCost} deducted.",
                'user_id' => $newUserId,
                'balance' => $newBalance,
            ]);
        } catch (Exception $e) {
            $pdo->rollBack();
            jsonResponse(['success' => false, 'message' => 'Failed to create user: ' . $e->getMessage()], 500);
        }
    }

    if ($action === 'toggle_active') {
        $targetId = (int)($input['user_id'] ?? 0);
        $check = $pdo->prepare("SELECT id, is_active FROM users WHERE id = ? AND reseller_id = ?");
        $check->execute([$targetId, $resellerId]);
        $target = $check->fetch();
        if (!$target) {
            jsonResponse(['success' => false, 'message' => 'User not found or not yours.'], 404);
        }
        $newStatus = $target['is_active'] ? 0 : 1;
        $pdo->prepare("UPDATE users SET is_active = ? WHERE id = ?")->execute([$newStatus, $targetId]);
        jsonResponse(['success' => true, 'message' => $newStatus ? 'User activated.' : 'User deactivated.']);
    }

    jsonResponse(['success' => false, 'message' => 'Unknown action.'], 400);
}
