<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];

$stmt = $pdo->prepare("SELECT id, username, name, email, phone, country, city, gender, profile_image, profile_completed, expiry_date, created_at, is_active, last_login_ip FROM users WHERE id = ?");
$stmt->execute([$userId]);
$user = $stmt->fetch();

if (!$user) {
    jsonResponse(['success' => false, 'message' => 'User not found.'], 404);
}

$subStmt = $pdo->prepare("
    SELECT us.start_date, us.end_date, us.is_active AS sub_active, p.name AS platform_name, p.logo_url, p.bg_color_hex
    FROM user_subscriptions us
    INNER JOIN platforms p ON p.id = us.platform_id
    WHERE us.user_id = ? AND us.is_active = 1 AND p.is_active = 1
    ORDER BY us.end_date ASC
");
$subStmt->execute([$userId]);
$subs = $subStmt->fetchAll();

$now = new DateTime();
$accountStatus = 'active';
if (!$user['is_active']) {
    $accountStatus = 'inactive';
} elseif ($user['expiry_date']) {
    $expiry = new DateTime($user['expiry_date']);
    if ($now > $expiry) {
        $accountStatus = 'expired';
    } elseif ($now->diff($expiry)->days <= 3) {
        $accountStatus = 'expiring_soon';
    }
}

jsonResponse([
    'success'        => true,
    'profile'        => [
        'id'                => (int)$user['id'],
        'username'          => $user['username'],
        'name'              => $user['name'] ?? '',
        'email'             => $user['email'] ?? '',
        'phone'             => $user['phone'] ?? '',
        'country'           => $user['country'] ?? '',
        'city'              => $user['city'] ?? '',
        'gender'            => $user['gender'] ?? '',
        'profile_image'     => $user['profile_image'] ?? '',
        'profile_completed' => (int)($user['profile_completed'] ?? 0),
        'expiry_date'       => $user['expiry_date'],
        'created_at'        => $user['created_at'],
        'last_login_ip'     => $user['last_login_ip'],
        'account_status'    => $accountStatus,
    ],
    'subscriptions'  => $subs,
    'csrf_token'     => generateCsrfToken(),
]);
