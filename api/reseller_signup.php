<?php
require_once __DIR__ . '/../db.php';

session_start();

if (empty($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Please log in first.'], 401);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];

$user = $pdo->prepare("SELECT id, role, username FROM users WHERE id = ?");
$user->execute([$userId]);
$user = $user->fetch();

if (!$user) {
    jsonResponse(['success' => false, 'message' => 'User not found.'], 404);
}

if ($user['role'] === 'admin') {
    jsonResponse(['success' => false, 'message' => 'Admins cannot become resellers.'], 400);
}

if ($user['role'] === 'reseller') {
    jsonResponse(['success' => false, 'message' => 'You are already a reseller.'], 400);
}

$existing = $pdo->prepare("SELECT id FROM resellers WHERE user_id = ?");
$existing->execute([$userId]);
if ($existing->fetch()) {
    jsonResponse(['success' => false, 'message' => 'Reseller application already exists.'], 409);
}

$autoApprove = getSiteSetting('reseller_auto_approve', '0') === '1';
$status = $autoApprove ? 'active' : 'pending';

$pdo->beginTransaction();
try {
    $pdo->prepare("INSERT INTO resellers (user_id, balance, commission_rate, status) VALUES (?, 0, 20, ?)")
        ->execute([$userId, $status]);

    if ($autoApprove) {
        $pdo->prepare("UPDATE users SET role = 'reseller' WHERE id = ?")->execute([$userId]);
        $_SESSION['role'] = 'reseller';
    }

    $pdo->commit();

    logActivity($userId, "reseller_signup: status={$status}", getClientIP());

    $message = $autoApprove
        ? 'You are now a reseller! Your dashboard is ready.'
        : 'Your reseller application has been submitted. An admin will review it shortly.';

    jsonResponse([
        'success' => true,
        'message' => $message,
        'status' => $status,
        'auto_approved' => $autoApprove,
    ]);
} catch (Exception $e) {
    $pdo->rollBack();
    jsonResponse(['success' => false, 'message' => 'Failed to process signup.'], 500);
}
