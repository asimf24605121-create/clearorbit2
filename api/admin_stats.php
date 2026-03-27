<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

if (!isset($_SESSION['role']) || $_SESSION['role'] !== 'admin') {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$pdo = getPDO();
$adminLevel = $_SESSION['admin_level'] ?? 'manager';

if ($adminLevel === 'manager') {
    $recentUsers = $pdo->query("SELECT id, username, name, email, phone, country, city, gender, profile_image, profile_completed, expiry_date, role, is_active, device_id, last_login_ip, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC")->fetchAll();
    $totalUsers = count($recentUsers);
    $today = date('Y-m-d');
    $mgrSubsStmt = $pdo->prepare("
        SELECT us.user_id, p.name AS platform_name, us.end_date
        FROM user_subscriptions us
        INNER JOIN platforms p ON p.id = us.platform_id
        WHERE us.is_active = 1 AND us.end_date >= ?
        ORDER BY p.name
    ");
    $mgrSubsStmt->execute([$today]);
    $mgrSubMap = [];
    $mgrExpiryMap = [];
    foreach ($mgrSubsStmt->fetchAll() as $row) {
        $uid = (int)$row['user_id'];
        if (!isset($mgrSubMap[$uid])) $mgrSubMap[$uid] = [];
        $mgrSubMap[$uid][] = $row['platform_name'];
        if (!isset($mgrExpiryMap[$uid]) || $row['end_date'] > $mgrExpiryMap[$uid]) {
            $mgrExpiryMap[$uid] = $row['end_date'];
        }
    }
    foreach ($recentUsers as &$u) {
        $uid = (int)$u['id'];
        $u['active_platforms'] = $mgrSubMap[$uid] ?? [];
        if (empty($u['expiry_date']) && isset($mgrExpiryMap[$uid])) {
            $u['expiry_date'] = $mgrExpiryMap[$uid];
        }
    }
    unset($u);
    $mgrPlatforms = $pdo->query("SELECT id, name, logo_url, bg_color_hex, is_active, cookie_domain, login_url FROM platforms ORDER BY name")->fetchAll();
    jsonResponse([
        'success'        => true,
        'total_users'    => $totalUsers,
        'active_subs'    => 0,
        'total_platforms' => count($mgrPlatforms),
        'expiring_cookies' => 0,
        'recent_users'   => $recentUsers,
        'platforms'      => $mgrPlatforms,
        'cookies'        => [],
        'recent_logs'    => [],
        'pending_payments' => 0,
        'admin_level'    => $adminLevel,
        'csrf_token'     => generateCsrfToken(),
    ]);
}

autoExpireSubscriptions();

$today = date('Y-m-d');

$totalUsers = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role = 'user'")->fetchColumn();

$stmt = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND end_date >= ?");
$stmt->execute([$today]);
$activeSubs = (int)$stmt->fetchColumn();

$totalPlatforms = (int)$pdo->query("SELECT COUNT(*) FROM platforms")->fetchColumn();

$fortyEightHoursLater = date('Y-m-d H:i:s', strtotime('+48 hours'));
$stmt2 = $pdo->prepare("SELECT COUNT(*) FROM cookie_vault WHERE expires_at IS NOT NULL AND expires_at <= ?");
$stmt2->execute([$fortyEightHoursLater]);
$expiringCookies = (int)$stmt2->fetchColumn();

$recentUsers = $pdo->query("SELECT id, username, name, email, phone, country, city, gender, profile_image, profile_completed, expiry_date, role, is_active, device_id, last_login_ip, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC")->fetchAll();

$userSubsStmt = $pdo->prepare("
    SELECT us.user_id, p.name AS platform_name, us.end_date
    FROM user_subscriptions us
    INNER JOIN platforms p ON p.id = us.platform_id
    WHERE us.is_active = 1 AND us.end_date >= ?
    ORDER BY p.name
");
$userSubsStmt->execute([$today]);
$allUserSubs = $userSubsStmt->fetchAll();
$userSubMap = [];
$userExpiryMap = [];
foreach ($allUserSubs as $row) {
    $uid = (int)$row['user_id'];
    if (!isset($userSubMap[$uid])) $userSubMap[$uid] = [];
    $userSubMap[$uid][] = $row['platform_name'];
    if (!isset($userExpiryMap[$uid]) || $row['end_date'] > $userExpiryMap[$uid]) {
        $userExpiryMap[$uid] = $row['end_date'];
    }
}
foreach ($recentUsers as &$u) {
    $uid = (int)$u['id'];
    $u['active_platforms'] = $userSubMap[$uid] ?? [];
    if (empty($u['expiry_date']) && isset($userExpiryMap[$uid])) {
        $u['expiry_date'] = $userExpiryMap[$uid];
    }
}
unset($u);

$platforms = $pdo->query("SELECT id, name, logo_url, bg_color_hex, is_active, cookie_domain, login_url FROM platforms ORDER BY name")->fetchAll();

$cookies = $pdo->query("
    SELECT cv.id, cv.platform_id, cv.expires_at, cv.updated_at, COALESCE(cv.cookie_count, 0) AS cookie_count, COALESCE(cv.slot, 1) AS slot, p.name AS platform_name
    FROM cookie_vault cv
    INNER JOIN platforms p ON p.id = cv.platform_id
    ORDER BY cv.platform_id, cv.slot
")->fetchAll();

$pendingPayments = (int)$pdo->query("SELECT COUNT(*) FROM payments WHERE status = 'pending'")->fetchColumn();

$recentLogs = $pdo->query("
    SELECT al.id, al.action, al.ip_address, al.created_at, u.username
    FROM activity_logs al
    LEFT JOIN users u ON u.id = al.user_id
    ORDER BY al.created_at DESC
    LIMIT 20
")->fetchAll();

jsonResponse([
    'success'          => true,
    'total_users'      => $totalUsers,
    'active_subs'      => $activeSubs,
    'total_platforms'   => $totalPlatforms,
    'expiring_cookies' => $expiringCookies,
    'recent_users'     => $recentUsers,
    'platforms'        => $platforms,
    'cookies'          => $cookies,
    'recent_logs'      => $recentLogs,
    'pending_payments' => $pendingPayments,
    'admin_level'      => $adminLevel,
    'csrf_token'       => generateCsrfToken(),
]);
