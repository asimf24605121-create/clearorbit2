<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('manager');

$pdo = getPDO();
$adminLevel = $_SESSION['admin_level'] ?? 'manager';
$userId = (int)$_SESSION['user_id'];
$csrf = generateCsrfToken();

autoExpireSubscriptions();

$now    = date('Y-m-d H:i:s');
$today  = date('Y-m-d');
$fiveMinAgo         = date('Y-m-d H:i:s', strtotime('-5 minutes'));
$twentyFourHoursAgo = date('Y-m-d H:i:s', strtotime('-24 hours'));
$fortyEightHours    = date('Y-m-d H:i:s', strtotime('+48 hours'));
$twentyFourFromNow  = date('Y-m-d H:i:s', strtotime('+24 hours'));
$sevenDaysFromNow   = date('Y-m-d', strtotime('+7 days'));
$oneHourAgo         = date('Y-m-d H:i:s', strtotime('-1 hour'));

$platforms = $pdo->query("SELECT id, name, logo_url, bg_color_hex, is_active, cookie_domain, login_url FROM platforms ORDER BY name")->fetchAll();

$recentUsers = $pdo->query("SELECT id, username, name, email, phone, country, city, gender, profile_image, profile_completed, expiry_date, role, is_active, device_id, last_login_ip, created_at FROM users WHERE role = 'user' ORDER BY created_at DESC")->fetchAll();

$userSubsStmt = $pdo->prepare("SELECT us.user_id, p.name AS platform_name, us.end_date FROM user_subscriptions us INNER JOIN platforms p ON p.id = us.platform_id WHERE us.is_active = 1 AND us.end_date >= ? ORDER BY p.name");
$userSubsStmt->execute([$today]);
$userSubMap = []; $userExpiryMap = [];
foreach ($userSubsStmt->fetchAll() as $row) {
    $uid = (int)$row['user_id'];
    $userSubMap[$uid][] = $row['platform_name'];
    if (!isset($userExpiryMap[$uid]) || $row['end_date'] > $userExpiryMap[$uid]) $userExpiryMap[$uid] = $row['end_date'];
}
foreach ($recentUsers as &$u) {
    $uid = (int)$u['id'];
    $u['active_platforms'] = $userSubMap[$uid] ?? [];
    if (empty($u['expiry_date']) && isset($userExpiryMap[$uid])) $u['expiry_date'] = $userExpiryMap[$uid];
}
unset($u);

$totalUsers     = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role = 'user'")->fetchColumn();
$stmtAS = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND end_date >= ?");
$stmtAS->execute([$today]);
$activeSubs     = (int)$stmtAS->fetchColumn();
$totalPlatforms = (int)$pdo->query("SELECT COUNT(*) FROM platforms")->fetchColumn();

$stmtEC = $pdo->prepare("SELECT COUNT(*) FROM cookie_vault WHERE expires_at IS NOT NULL AND expires_at <= ?");
$stmtEC->execute([$fortyEightHours]);
$expiringCookies = (int)$stmtEC->fetchColumn();

$pendingPayments = (int)$pdo->query("SELECT COUNT(*) FROM payments WHERE status = 'pending'")->fetchColumn();

$cookies = $pdo->query("SELECT cv.id, cv.platform_id, cv.expires_at, cv.updated_at, COALESCE(cv.cookie_count, 0) AS cookie_count, COALESCE(cv.slot, 1) AS slot, p.name AS platform_name FROM cookie_vault cv INNER JOIN platforms p ON p.id = cv.platform_id ORDER BY cv.platform_id, cv.slot")->fetchAll();

$recentLogs = $pdo->query("SELECT al.id, al.action, al.ip_address, al.created_at, u.username FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id ORDER BY al.created_at DESC LIMIT 20")->fetchAll();

if ($adminLevel === 'manager') {
    jsonResponse([
        'success'         => true,
        'user_id'         => $userId,
        'role'            => 'admin',
        'admin_level'     => $adminLevel,
        'csrf_token'      => $csrf,
        'total_users'     => $totalUsers,
        'active_subs'     => 0,
        'total_platforms' => count($platforms),
        'expiring_cookies'=> 0,
        'recent_users'    => $recentUsers,
        'platforms'       => $platforms,
        'cookies'         => [],
        'recent_logs'     => [],
        'pending_payments'=> 0,
        'kpi'             => null,
        'whatsapp_number' => getSiteSetting('whatsapp_number', ''),
        'whatsapp_message'=> getSiteSetting('whatsapp_message', 'Hi, I need help with my ClearOrbit account.'),
        'default_expiry_days' => (int)getSiteSetting('default_expiry_days', '30'),
    ]);
}

$stmtNewUsers = $pdo->prepare("SELECT COUNT(*) FROM users WHERE role = 'user' AND created_at >= ?");
$stmtNewUsers->execute([$twentyFourHoursAgo]);
$newUsersToday = (int)$stmtNewUsers->fetchColumn();

$stmtActiveUsers = $pdo->prepare("SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE status = 'active' AND last_activity >= ?");
$stmtActiveUsers->execute([$fiveMinAgo]);
$activeUsers = (int)$stmtActiveUsers->fetchColumn();

$stmtLiveSessions = $pdo->prepare("SELECT COUNT(*) FROM account_sessions WHERE status = 'active' AND last_active >= ?");
$stmtLiveSessions->execute([$fiveMinAgo]);
$liveSessions = (int)$stmtLiveSessions->fetchColumn();

$stmtNewSubs = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND start_date >= ?");
$stmtNewSubs->execute([$twentyFourHoursAgo]);
$newSubsToday = (int)$stmtNewSubs->fetchColumn();

$totalSlots = (int)$pdo->query("SELECT COUNT(*) FROM platform_accounts WHERE is_active = 1")->fetchColumn();
$stmtUsedSlots = $pdo->prepare("SELECT COUNT(DISTINCT account_id) FROM account_sessions WHERE status = 'active' AND last_active >= ?");
$stmtUsedSlots->execute([$fiveMinAgo]);
$usedSlots = (int)$stmtUsedSlots->fetchColumn();
$slotUtilization = $totalSlots > 0 ? round(($usedSlots / $totalSlots) * 100) : 0;

$stmtExp24 = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND end_date BETWEEN ? AND ?");
$stmtExp24->execute([$today, $twentyFourFromNow]);
$expiringSubs24h = (int)$stmtExp24->fetchColumn();

$stmtExp7d = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND end_date BETWEEN ? AND ?");
$stmtExp7d->execute([$today, $sevenDaysFromNow]);
$expiringSubs7d = (int)$stmtExp7d->fetchColumn();

$stmtErrors = $pdo->prepare("SELECT COUNT(*) FROM login_attempt_logs WHERE status IN ('failed','blocked') AND created_at >= ?");
$stmtErrors->execute([$oneHourAgo]);
$errorsLastHour = (int)$stmtErrors->fetchColumn();

$plStmt = $pdo->prepare("
    SELECT p.id, p.name, p.logo_url,
        (SELECT COUNT(*) FROM platform_accounts pa WHERE pa.platform_id = p.id AND pa.is_active = 1) AS total_slots,
        (SELECT COUNT(DISTINCT acs.account_id) FROM account_sessions acs JOIN platform_accounts pa2 ON pa2.id = acs.account_id WHERE pa2.platform_id = p.id AND acs.status = 'active' AND acs.last_active >= ?) AS active_slots,
        (SELECT COUNT(*) FROM user_subscriptions us WHERE us.platform_id = p.id AND us.is_active = 1 AND us.end_date >= ?) AS active_subs
    FROM platforms p WHERE p.is_active = 1 ORDER BY p.name
");
$plStmt->execute([$fiveMinAgo, $today]);
$platformLoad = $plStmt->fetchAll();
foreach ($platformLoad as &$pl) {
    $pl['total_slots'] = (int)$pl['total_slots'];
    $pl['active_slots'] = (int)$pl['active_slots'];
    $pl['active_subs'] = (int)$pl['active_subs'];
    $pl['usage_pct'] = $pl['total_slots'] > 0 ? round(($pl['active_slots'] / $pl['total_slots']) * 100) : 0;
    $pl['pressure'] = $pl['usage_pct'] >= 85 ? 'overloaded' : ($pl['usage_pct'] >= 50 ? 'moderate' : ($pl['active_slots'] > 0 ? 'stable' : 'idle'));
}
unset($pl);

$platformHealth = [];
foreach ($platformLoad as $pl) {
    $phStmt = $pdo->prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN health_status='healthy' THEN 1 ELSE 0 END) AS healthy, SUM(CASE WHEN health_status='unhealthy' THEN 1 ELSE 0 END) AS unhealthy, SUM(CASE WHEN cookie_status='VALID' THEN 1 ELSE 0 END) AS valid_cookies, SUM(CASE WHEN cookie_status IN ('EXPIRED','DEAD') THEN 1 ELSE 0 END) AS bad_cookies FROM platform_accounts WHERE platform_id = ? AND is_active = 1");
    $phStmt->execute([$pl['id']]);
    $ph = $phStmt->fetch();
    $platformHealth[] = ['platform_id' => (int)$pl['id'], 'name' => $pl['name'], 'total' => (int)$ph['total'], 'healthy' => (int)$ph['healthy'], 'unhealthy' => (int)$ph['unhealthy'], 'valid_cookies' => (int)$ph['valid_cookies'], 'bad_cookies' => (int)$ph['bad_cookies'], 'health_pct' => (int)$ph['total'] > 0 ? round(((int)$ph['healthy'] / (int)$ph['total']) * 100) : 100];
}

$totalRevenue  = (float)$pdo->query("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status = 'approved'")->fetchColumn();
$monthStart    = date('Y-m-01 00:00:00');
$nextMonth     = date('Y-m-01 00:00:00', strtotime('first day of next month'));
$tomorrow      = date('Y-m-d 00:00:00', strtotime('+1 day'));
$stmtMR = $pdo->prepare("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status = 'approved' AND created_at >= ? AND created_at < ?");
$stmtMR->execute([$monthStart, $nextMonth]);
$monthlyRevenue = (float)$stmtMR->fetchColumn();
$stmtDR = $pdo->prepare("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status = 'approved' AND created_at >= ? AND created_at < ?");
$stmtDR->execute([$today, $tomorrow]);
$dailyRevenue = (float)$stmtDR->fetchColumn();

$userGrowth = []; $revenueHistory = [];
for ($i = 6; $i >= 0; $i--) {
    $label = date('M d', strtotime("-{$i} days"));
    $dStart = date('Y-m-d 00:00:00', strtotime("-{$i} days"));
    $dEnd   = date('Y-m-d 23:59:59', strtotime("-{$i} days"));
    $sUG = $pdo->prepare("SELECT COUNT(*) FROM users WHERE role='user' AND created_at BETWEEN ? AND ?");
    $sUG->execute([$dStart, $dEnd]);
    $userGrowth[] = ['day' => $label, 'count' => (int)$sUG->fetchColumn()];
    $sRH = $pdo->prepare("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status='approved' AND created_at BETWEEN ? AND ?");
    $sRH->execute([$dStart, $dEnd]);
    $revenueHistory[] = ['day' => $label, 'amount' => (float)$sRH->fetchColumn()];
}

$alerts = [];
if ($expiringSubs24h > 0) $alerts[] = ['type' => 'danger', 'message' => "$expiringSubs24h subscription(s) expiring in 24 hours"];
if ($expiringSubs7d > 3)  $alerts[] = ['type' => 'warning', 'message' => "$expiringSubs7d subscription(s) expiring within 7 days"];
foreach ($platformLoad as $pl) {
    if ($pl['pressure'] === 'overloaded') $alerts[] = ['type' => 'danger', 'message' => "{$pl['name']} slots are overloaded ({$pl['usage_pct']}% used)"];
    if ($pl['total_slots'] > 0 && ($pl['total_slots'] - $pl['active_slots']) <= 1) $alerts[] = ['type' => 'warning', 'message' => "{$pl['name']} will be full soon"];
}
if ($expiringCookies > 0) $alerts[] = ['type' => 'warning', 'message' => "$expiringCookies cookie(s) expiring within 48 hours"];
if ($errorsLastHour > 10) $alerts[] = ['type' => 'danger', 'message' => "High error rate: $errorsLastHour failed attempts in the last hour"];

$systemHealth = 'healthy';
foreach ($alerts as $a) {
    if ($a['type'] === 'danger') { $systemHealth = 'critical'; break; }
    if ($a['type'] === 'warning') $systemHealth = 'warning';
}

$whatsappNumber  = getSiteSetting('whatsapp_number', '');
$whatsappMessage = getSiteSetting('whatsapp_message', 'Hi, I need help with my ClearOrbit account.');
$defaultExpiry   = (int)getSiteSetting('default_expiry_days', '30');

jsonResponse([
    'success'          => true,
    'user_id'          => $userId,
    'role'             => 'admin',
    'admin_level'      => $adminLevel,
    'csrf_token'       => $csrf,
    'total_users'      => $totalUsers,
    'active_subs'      => $activeSubs,
    'total_platforms'  => $totalPlatforms,
    'expiring_cookies' => $expiringCookies,
    'recent_users'     => $recentUsers,
    'platforms'        => $platforms,
    'cookies'          => $cookies,
    'recent_logs'      => $recentLogs,
    'pending_payments' => $pendingPayments,
    'kpi' => [
        'total_users'       => $totalUsers,
        'new_users_today'   => $newUsersToday,
        'active_users'      => $activeUsers,
        'live_sessions'     => $liveSessions,
        'active_subs'       => $activeSubs,
        'new_subs_today'    => $newSubsToday,
        'slot_utilization'  => $slotUtilization,
        'total_slots'       => $totalSlots,
        'used_slots'        => $usedSlots,
        'total_platforms'   => $totalPlatforms,
        'expiring_subs_24h' => $expiringSubs24h,
        'expiring_subs_7d'  => $expiringSubs7d,
        'expiring_cookies'  => $expiringCookies,
        'errors_last_hour'  => $errorsLastHour,
        'failed_logins_24h' => 0,
        'inactive_users_7d' => 0,
        'pending_payments'  => $pendingPayments,
    ],
    'system_health'    => $systemHealth,
    'alerts'           => $alerts,
    'platform_load'    => $platformLoad,
    'platform_health'  => $platformHealth,
    'revenue' => [
        'total'   => $totalRevenue,
        'monthly' => $monthlyRevenue,
        'daily'   => $dailyRevenue,
        'pending' => $pendingPayments,
        'history' => $revenueHistory,
    ],
    'user_growth'          => $userGrowth,
    'slot_intelligence'    => ['slots' => [], 'best_slot' => null, 'worst_slot' => null, 'unhealthy_count' => 0],
    'recent_events'        => $recentLogs,
    'whatsapp_number'      => $whatsappNumber,
    'whatsapp_message'     => $whatsappMessage,
    'default_expiry_days'  => $defaultExpiry,
]);
