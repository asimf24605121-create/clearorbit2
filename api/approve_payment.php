<?php
require __DIR__ . '/../db.php';
session_start();
validateCsrfToken();

checkAdminAccess('super_admin');

$input = json_decode(file_get_contents('php://input'), true);
$paymentId = (int)($input['payment_id'] ?? 0);
$action = $input['action'] ?? '';

if (!$paymentId || !in_array($action, ['approve', 'reject'])) {
    jsonResponse(['success' => false, 'message' => 'Payment ID and valid action (approve/reject) required.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, user_id, platform_id, username, duration_key, account_type, price, status, created_at FROM payments WHERE id = ?");
$stmt->execute([$paymentId]);
$payment = $stmt->fetch();

if (!$payment) {
    jsonResponse(['success' => false, 'message' => 'Payment not found.'], 404);
}

if ($payment['status'] !== 'pending') {
    jsonResponse(['success' => false, 'message' => 'Payment already processed.'], 400);
}

$newStatus = $action === 'approve' ? 'approved' : 'rejected';
$now = date('Y-m-d H:i:s');
$pdo->prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?")->execute([$newStatus, $now, $paymentId]);

if ($action === 'approve') {
    $durationMap = [
        '1_week' => 7,
        '1_month' => 30,
        '6_months' => 180,
        '1_year' => 365,
    ];
    $days = $durationMap[$payment['duration_key']] ?? 30;

    $userId = $payment['user_id'];
    if (!$userId && $payment['username']) {
        $uStmt = $pdo->prepare("SELECT id FROM users WHERE username = ?");
        $uStmt->execute([$payment['username']]);
        $found = $uStmt->fetch();
        if ($found) $userId = $found['id'];
    }

    if ($userId) {
        $endDate = date('Y-m-d', strtotime("+{$days} days"));
        $startDate = date('Y-m-d');
        $sub = $pdo->prepare("INSERT INTO user_subscriptions (user_id, platform_id, start_date, end_date, is_active) VALUES (?, ?, ?, ?, 1)");
        $sub->execute([$userId, $payment['platform_id'], $startDate, $endDate]);

        logActivity($_SESSION['user_id'], "Approved payment #{$paymentId} → subscription created for user #{$userId}", getClientIP());
        jsonResponse(['success' => true, 'message' => "Payment approved. Subscription granted for {$days} days."]);
    } else {
        logActivity($_SESSION['user_id'], "Approved payment #{$paymentId} (user not found, subscription not auto-created)", getClientIP());
        jsonResponse(['success' => true, 'message' => 'Payment approved but user account not found. Create the user first, then grant subscription manually.']);
    }
} else {
    logActivity($_SESSION['user_id'], "Rejected payment #{$paymentId}", getClientIP());
    jsonResponse(['success' => true, 'message' => 'Payment rejected.']);
}
