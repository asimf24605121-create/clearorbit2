<?php
require_once __DIR__ . '/../db.php';

session_start();

if (empty($_SESSION['user_id']) || $_SESSION['role'] !== 'reseller') {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 403);
}

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];

$reseller = $pdo->prepare("SELECT * FROM resellers WHERE user_id = ?");
$reseller->execute([$userId]);
$reseller = $reseller->fetch();

if (!$reseller) {
    jsonResponse(['success' => false, 'message' => 'Reseller account not found.'], 404);
}

$resellerId = (int)$reseller['id'];

$totalUsers = $pdo->prepare("SELECT COUNT(*) FROM users WHERE reseller_id = ?");
$totalUsers->execute([$resellerId]);
$totalUsers = (int)$totalUsers->fetchColumn();

$activeUsers = $pdo->prepare("SELECT COUNT(*) FROM users WHERE reseller_id = ? AND is_active = 1");
$activeUsers->execute([$resellerId]);
$activeUsers = (int)$activeUsers->fetchColumn();

$activeSubs = $pdo->prepare("
    SELECT COUNT(*) FROM user_subscriptions us
    JOIN users u ON u.id = us.user_id
    WHERE u.reseller_id = ? AND us.status = 'active' AND us.end_date >= ?
");
$now = date('Y-m-d H:i:s');
$activeSubs->execute([$resellerId, $now]);
$activeSubs = (int)$activeSubs->fetchColumn();

$recentTransactions = $pdo->prepare("
    SELECT * FROM reseller_transactions
    WHERE reseller_id = ?
    ORDER BY created_at DESC LIMIT 20
");
$recentTransactions->execute([$resellerId]);
$transactions = $recentTransactions->fetchAll();

$pendingRecharges = $pdo->prepare("SELECT COUNT(*) FROM recharge_requests WHERE reseller_id = ? AND status = 'pending'");
$pendingRecharges->execute([$resellerId]);
$pendingRecharges = (int)$pendingRecharges->fetchColumn();

$costPerUser = (float)getSiteSetting('reseller_cost_per_user', '100');

jsonResponse([
    'success' => true,
    'reseller' => [
        'id' => $resellerId,
        'balance' => (float)$reseller['balance'],
        'commission_rate' => (float)$reseller['commission_rate'],
        'total_earnings' => (float)$reseller['total_earnings'],
        'total_users' => $totalUsers,
        'status' => $reseller['status'],
        'created_at' => $reseller['created_at'],
    ],
    'stats' => [
        'total_users' => $totalUsers,
        'active_users' => $activeUsers,
        'active_subscriptions' => $activeSubs,
        'pending_recharges' => $pendingRecharges,
        'cost_per_user' => $costPerUser,
    ],
    'transactions' => $transactions,
]);
