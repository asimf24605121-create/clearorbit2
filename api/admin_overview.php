<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/GeoIPService.php';

session_start();
checkAdminAccess('admin');

$pdo = getPDO();
autoExpireSubscriptions();

$now = date('Y-m-d H:i:s');
$today = date('Y-m-d');
$yesterday = date('Y-m-d', strtotime('-1 day'));
$oneHourAgo = date('Y-m-d H:i:s', strtotime('-1 hour'));
$twentyFourHoursAgo = date('Y-m-d H:i:s', strtotime('-24 hours'));
$fiveMinAgo = date('Y-m-d H:i:s', strtotime('-5 minutes'));
$fortyEightHours = date('Y-m-d H:i:s', strtotime('+48 hours'));
$twentyFourHoursFromNow = date('Y-m-d H:i:s', strtotime('+24 hours'));
$sevenDaysFromNow = date('Y-m-d', strtotime('+7 days'));

$totalUsers = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role = 'user'")->fetchColumn();

$stmtNewUsers = $pdo->prepare("SELECT COUNT(*) FROM users WHERE role = 'user' AND created_at >= ?");
$stmtNewUsers->execute([$twentyFourHoursAgo]);
$newUsersToday = (int)$stmtNewUsers->fetchColumn();

$stmtActiveUsers = $pdo->prepare("SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE status = 'active' AND last_activity >= ?");
$stmtActiveUsers->execute([$fiveMinAgo]);
$activeUsers = (int)$stmtActiveUsers->fetchColumn();

$stmtLiveSessions = $pdo->prepare("SELECT COUNT(*) FROM account_sessions WHERE status = 'active' AND last_active >= ?");
$stmtLiveSessions->execute([$fiveMinAgo]);
$liveSessions = (int)$stmtLiveSessions->fetchColumn();

$stmtActiveSubs = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND end_date >= ?");
$stmtActiveSubs->execute([$today]);
$activeSubs = (int)$stmtActiveSubs->fetchColumn();

$stmtNewSubs = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND start_date >= ?");
$stmtNewSubs->execute([$twentyFourHoursAgo]);
$newSubsToday = (int)$stmtNewSubs->fetchColumn();

$totalSlots = (int)$pdo->query("SELECT COUNT(*) FROM platform_accounts WHERE is_active = 1")->fetchColumn();
$stmtUsedSlots = $pdo->prepare("SELECT COUNT(DISTINCT account_id) FROM account_sessions WHERE status = 'active' AND last_active >= ?");
$stmtUsedSlots->execute([$fiveMinAgo]);
$usedSlots = (int)$stmtUsedSlots->fetchColumn();
$slotUtilization = $totalSlots > 0 ? round(($usedSlots / $totalSlots) * 100) : 0;

$stmtExpiringSubs = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND end_date BETWEEN ? AND ?");
$stmtExpiringSubs->execute([$today, $twentyFourHoursFromNow]);
$expiringSubs24h = (int)$stmtExpiringSubs->fetchColumn();

$stmtExpiring7d = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE is_active = 1 AND end_date BETWEEN ? AND ?");
$stmtExpiring7d->execute([$today, $sevenDaysFromNow]);
$expiringSubs7d = (int)$stmtExpiring7d->fetchColumn();

$expiringCookies = (int)$pdo->prepare("SELECT COUNT(*) FROM cookie_vault WHERE expires_at IS NOT NULL AND expires_at <= ?")->execute([$fortyEightHours]) ? $pdo->prepare("SELECT COUNT(*) FROM cookie_vault WHERE expires_at IS NOT NULL AND expires_at <= ?") : null;
$stmtEC = $pdo->prepare("SELECT COUNT(*) FROM cookie_vault WHERE expires_at IS NOT NULL AND expires_at <= ?");
$stmtEC->execute([$fortyEightHours]);
$expiringCookies = (int)$stmtEC->fetchColumn();

$stmtErrors = $pdo->prepare("SELECT COUNT(*) FROM login_attempt_logs WHERE status IN ('failed','blocked') AND created_at >= ?");
$stmtErrors->execute([$oneHourAgo]);
$errorsLastHour = (int)$stmtErrors->fetchColumn();

$stmtFailedLogins24 = $pdo->prepare("SELECT COUNT(*) FROM login_attempt_logs WHERE status = 'failed' AND created_at >= ?");
$stmtFailedLogins24->execute([$twentyFourHoursAgo]);
$failedLogins24h = (int)$stmtFailedLogins24->fetchColumn();

$stmtInactiveUsers = $pdo->prepare("
    SELECT COUNT(*) FROM users u 
    WHERE u.role = 'user' AND u.is_active = 1 
    AND NOT EXISTS (
        SELECT 1 FROM user_sessions us WHERE us.user_id = u.id AND us.last_activity >= ?
    )
");
$stmtInactiveUsers->execute([date('Y-m-d H:i:s', strtotime('-7 days'))]);
$inactiveUsers7d = (int)$stmtInactiveUsers->fetchColumn();

$totalPlatforms = (int)$pdo->query("SELECT COUNT(*) FROM platforms WHERE is_active = 1")->fetchColumn();

$fiveMinAgo = date('Y-m-d H:i:s', strtotime('-5 minutes'));
$today = date('Y-m-d');
$plStmt = $pdo->prepare("
    SELECT 
        p.id,
        p.name,
        p.logo_url,
        (SELECT COUNT(*) FROM platform_accounts pa WHERE pa.platform_id = p.id AND pa.is_active = 1) AS total_slots,
        (SELECT COUNT(DISTINCT acs.account_id) FROM account_sessions acs 
         JOIN platform_accounts pa2 ON pa2.id = acs.account_id 
         WHERE pa2.platform_id = p.id AND acs.status = 'active' AND acs.last_active >= ?) AS active_slots,
        (SELECT COUNT(*) FROM user_subscriptions us WHERE us.platform_id = p.id AND us.is_active = 1 AND us.end_date >= ?) AS active_subs
    FROM platforms p
    WHERE p.is_active = 1
    ORDER BY p.name
");
$plStmt->execute([$fiveMinAgo, $today]);
$platformLoad = $plStmt->fetchAll();

foreach ($platformLoad as &$pl) {
    $pl['total_slots'] = (int)$pl['total_slots'];
    $pl['active_slots'] = (int)$pl['active_slots'];
    $pl['active_subs'] = (int)$pl['active_subs'];
    $pl['usage_pct'] = $pl['total_slots'] > 0 ? round(($pl['active_slots'] / $pl['total_slots']) * 100) : 0;
    if ($pl['usage_pct'] >= 85) $pl['pressure'] = 'overloaded';
    elseif ($pl['usage_pct'] >= 50) $pl['pressure'] = 'moderate';
    elseif ($pl['active_slots'] > 0) $pl['pressure'] = 'stable';
    else $pl['pressure'] = 'idle';
}
unset($pl);

$slotIntelligence = $pdo->query("
    SELECT 
        pa.id,
        p.name AS platform_name,
        pa.slot_name AS label,
        pa.health_status,
        pa.success_count,
        pa.fail_count,
        pa.last_success_at,
        pa.last_failed_at,
        pa.cooldown_until,
        pa.is_active,
        CASE WHEN (pa.success_count + pa.fail_count) > 0 
            THEN ROUND((CAST(pa.success_count AS FLOAT) / (pa.success_count + pa.fail_count)) * 100) 
            ELSE 100 END AS success_rate,
        (pa.success_count * 2) - (pa.fail_count * 3) AS score
    FROM platform_accounts pa
    JOIN platforms p ON p.id = pa.platform_id
    WHERE pa.is_active = 1
    ORDER BY score DESC
")->fetchAll();

$bestSlot = !empty($slotIntelligence) ? $slotIntelligence[0] : null;
$worstSlot = !empty($slotIntelligence) ? end($slotIntelligence) : null;

try {
    $logCount = (int)$pdo->query("SELECT COUNT(*) FROM activity_logs")->fetchColumn();
    if ($logCount > 200) {
        $keepId = $pdo->query("SELECT id FROM activity_logs ORDER BY created_at DESC LIMIT 1 OFFSET 100")->fetchColumn();
        if ($keepId) {
            $pdo->prepare("DELETE FROM activity_logs WHERE id < ?")->execute([$keepId]);
        }
    }
} catch (Exception $e) {}

$recentEvents = $pdo->query("
    SELECT al.id, al.action, al.ip_address, al.created_at, u.username
    FROM activity_logs al
    LEFT JOIN users u ON u.id = al.user_id
    ORDER BY al.created_at DESC
    LIMIT 30
")->fetchAll();

foreach ($recentEvents as &$evt) {
    $a = strtolower($evt['action']);
    if (str_contains($a, 'failed') || str_contains($a, 'block') || str_contains($a, 'suspicious')) {
        $evt['priority'] = (str_contains($a, 'block') || str_contains($a, 'suspicious')) ? 'CRITICAL' : 'HIGH';
        $evt['risk_score'] = (str_contains($a, 'block') || str_contains($a, 'suspicious')) ? 95 : 70;
    } elseif (str_contains($a, 'purge') || str_contains($a, 'delete') || str_contains($a, 'password') || str_contains($a, 'change')) {
        $evt['priority'] = 'HIGH';
        $evt['risk_score'] = 50;
    } elseif (str_contains($a, 'login') || str_contains($a, 'logout') || str_contains($a, 'update') || str_contains($a, 'assign') || str_contains($a, 'create')) {
        $evt['priority'] = 'MEDIUM';
        $evt['risk_score'] = 20;
    } else {
        $evt['priority'] = 'LOW';
        $evt['risk_score'] = 5;
    }
    if (str_contains($a, 'login') && !str_contains($a, 'failed')) $evt['event_type'] = 'login';
    elseif (str_contains($a, 'logout')) $evt['event_type'] = 'logout';
    elseif (str_contains($a, 'failed') || str_contains($a, 'error') || str_contains($a, 'block')) $evt['event_type'] = 'error';
    elseif (str_contains($a, 'update') || str_contains($a, 'edit') || str_contains($a, 'create') || str_contains($a, 'delete') || str_contains($a, 'assign')) $evt['event_type'] = 'update';
    else $evt['event_type'] = 'system';
}
unset($evt);

$alerts = [];

if ($expiringSubs24h > 0) {
    $alerts[] = ['type' => 'danger', 'message' => "$expiringSubs24h subscription(s) expiring in 24 hours"];
}
if ($expiringSubs7d > 3) {
    $alerts[] = ['type' => 'warning', 'message' => "$expiringSubs7d subscription(s) expiring within 7 days"];
}

foreach ($platformLoad as $pl) {
    if ($pl['pressure'] === 'overloaded') {
        $alerts[] = ['type' => 'danger', 'message' => "{$pl['name']} slots are overloaded ({$pl['usage_pct']}% used)"];
    }
    if ($pl['total_slots'] > 0 && ($pl['total_slots'] - $pl['active_slots']) <= 1) {
        $alerts[] = ['type' => 'warning', 'message' => "{$pl['name']} will be full soon — consider adding more slots"];
    }
}

if ($expiringCookies > 0) {
    $alerts[] = ['type' => 'warning', 'message' => "$expiringCookies cookie(s) expiring within 48 hours"];
}

if ($inactiveUsers7d > 5) {
    $alerts[] = ['type' => 'info', 'message' => "$inactiveUsers7d users inactive for 7+ days"];
}

if ($errorsLastHour > 10) {
    $alerts[] = ['type' => 'danger', 'message' => "High error rate: $errorsLastHour failed attempts in the last hour"];
}

$unhealthySlots = 0;
foreach ($slotIntelligence as $s) {
    if ($s['health_status'] === 'unhealthy') $unhealthySlots++;
}
if ($unhealthySlots > 0) {
    $alerts[] = ['type' => 'warning', 'message' => "$unhealthySlots slot(s) in unhealthy state"];
}

$systemHealth = 'healthy';
foreach ($alerts as $a) {
    if ($a['type'] === 'danger') { $systemHealth = 'critical'; break; }
    if ($a['type'] === 'warning') $systemHealth = 'warning';
}

$pendingPayments = (int)$pdo->query("SELECT COUNT(*) FROM payments WHERE status = 'pending'")->fetchColumn();

$totalRevenue = (float)$pdo->query("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status = 'approved'")->fetchColumn();
$monthStart = date('Y-m-01 00:00:00');
$nextMonthStart = date('Y-m-01 00:00:00', strtotime('first day of next month'));
$stmtMonthRev = $pdo->prepare("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status = 'approved' AND created_at >= ? AND created_at < ?");
$stmtMonthRev->execute([$monthStart, $nextMonthStart]);
$monthlyRevenue = (float)$stmtMonthRev->fetchColumn();
$tomorrow = date('Y-m-d 00:00:00', strtotime('+1 day'));
$stmtDailyRev = $pdo->prepare("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status = 'approved' AND created_at >= ? AND created_at < ?");
$stmtDailyRev->execute([$today, $tomorrow]);
$dailyRevenue = (float)$stmtDailyRev->fetchColumn();

$userGrowth = [];
for ($i = 6; $i >= 0; $i--) {
    $dayLabel = date('M d', strtotime("-{$i} days"));
    $dayStart = date('Y-m-d 00:00:00', strtotime("-{$i} days"));
    $dayEnd = date('Y-m-d 23:59:59', strtotime("-{$i} days"));
    $stmtUG = $pdo->prepare("SELECT COUNT(*) FROM users WHERE role='user' AND created_at BETWEEN ? AND ?");
    $stmtUG->execute([$dayStart, $dayEnd]);
    $userGrowth[] = ['day' => $dayLabel, 'count' => (int)$stmtUG->fetchColumn()];
}

$revenueHistory = [];
for ($i = 6; $i >= 0; $i--) {
    $dayLabel = date('M d', strtotime("-{$i} days"));
    $dayStart = date('Y-m-d 00:00:00', strtotime("-{$i} days"));
    $dayEnd = date('Y-m-d 23:59:59', strtotime("-{$i} days"));
    $stmtRH = $pdo->prepare("SELECT COALESCE(SUM(price), 0) FROM payments WHERE status='approved' AND created_at BETWEEN ? AND ?");
    $stmtRH->execute([$dayStart, $dayEnd]);
    $revenueHistory[] = ['day' => $dayLabel, 'amount' => (float)$stmtRH->fetchColumn()];
}

$platformHealth = [];
foreach ($platformLoad as $pl) {
    $phStmt = $pdo->prepare("
        SELECT 
            COUNT(*) AS total,
            SUM(CASE WHEN health_status='healthy' THEN 1 ELSE 0 END) AS healthy,
            SUM(CASE WHEN health_status='unhealthy' THEN 1 ELSE 0 END) AS unhealthy,
            SUM(CASE WHEN cookie_status='VALID' THEN 1 ELSE 0 END) AS valid_cookies,
            SUM(CASE WHEN cookie_status IN ('EXPIRED','DEAD') THEN 1 ELSE 0 END) AS bad_cookies
        FROM platform_accounts WHERE platform_id = ? AND is_active = 1
    ");
    $phStmt->execute([$pl['id']]);
    $ph = $phStmt->fetch();
    $platformHealth[] = [
        'platform_id' => (int)$pl['id'],
        'name' => $pl['name'],
        'total' => (int)$ph['total'],
        'healthy' => (int)$ph['healthy'],
        'unhealthy' => (int)$ph['unhealthy'],
        'valid_cookies' => (int)$ph['valid_cookies'],
        'bad_cookies' => (int)$ph['bad_cookies'],
        'health_pct' => (int)$ph['total'] > 0 ? round(((int)$ph['healthy'] / (int)$ph['total']) * 100) : 100,
    ];
}

$liveSessionsStmt = $pdo->prepare("
    SELECT 
        us.id AS session_id, us.user_id, u.username, u.name, u.profile_image,
        us.ip_address, us.device_type, us.browser, us.os, us.last_activity, us.created_at AS login_time
    FROM user_sessions us
    JOIN users u ON u.id = us.user_id
    WHERE us.status = 'active' AND us.last_activity >= ?
    ORDER BY us.last_activity DESC
    LIMIT 20
");
$liveSessionsStmt->execute([$fiveMinAgo]);
$liveUserSessions = $liveSessionsStmt->fetchAll();

$userTracking = [];
foreach ($liveUserSessions as $ls) {
    $loginTime = strtotime($ls['login_time']);
    $lastAct = strtotime($ls['last_activity']);
    $duration = time() - $loginTime;
    $isOnline = (time() - $lastAct) < 120;

    $hours = floor($duration / 3600);
    $mins = floor(($duration % 3600) / 60);
    $durationStr = ($hours > 0 ? "{$hours}h " : '') . "{$mins}m";

    $userIP = $ls['ip_address'] ?? '127.0.0.1';
    $geo = GeoIPService::lookup($userIP, $pdo);
    $risk = GeoIPService::assessRisk($pdo, (int)$ls['user_id'], $userIP);

    $userTracking[] = [
        'session_id' => (int)$ls['session_id'],
        'user_id' => (int)$ls['user_id'],
        'username' => $ls['username'],
        'name' => $ls['name'] ?? $ls['username'],
        'profile_image' => $ls['profile_image'],
        'ip' => $userIP,
        'device_type' => $ls['device_type'],
        'browser' => $ls['browser'],
        'os' => $ls['os'],
        'is_online' => $isOnline,
        'last_activity' => $ls['last_activity'],
        'login_time' => $ls['login_time'],
        'duration' => trim($durationStr),
        'duration_seconds' => $duration,
        'country' => $geo['country'],
        'country_code' => $geo['country_code'],
        'city' => $geo['city'],
        'isp' => $geo['isp'],
        'risk' => [
            'level' => $risk['risk_level'],
            'reasons' => $risk['reasons'],
            'flags' => $risk['flags'],
            'concurrent_ips' => $risk['concurrent_ips'],
            'is_new_ip' => $risk['is_new_ip'],
        ],
    ];
}

$secEventsStmt = $pdo->prepare("
    SELECT se.event_type, se.severity, se.ip_address, se.details, se.created_at, u.username
    FROM security_events se LEFT JOIN users u ON u.id = se.user_id
    WHERE se.created_at >= ?
    ORDER BY se.created_at DESC LIMIT 10
");
$secEventsStmt->execute([$twentyFourHoursAgo]);
$recentSecurityEvents = $secEventsStmt->fetchAll();
foreach ($recentSecurityEvents as &$rse) {
    $rse['details'] = json_decode($rse['details'] ?? '{}', true);
}
unset($rse);

$highRiskCount = 0;
foreach ($recentSecurityEvents as $se) {
    if ($se['severity'] === 'high' || $se['severity'] === 'critical') $highRiskCount++;
}

if ($highRiskCount > 0) {
    $alerts[] = ['type' => 'danger', 'message' => "$highRiskCount high-risk security event(s) in last 24 hours"];
    if ($systemHealth !== 'critical') $systemHealth = 'warning';
}

jsonResponse([
    'success' => true,
    'system_health' => $systemHealth,
    'server_time' => $now,
    'kpi' => [
        'total_users' => $totalUsers,
        'new_users_today' => $newUsersToday,
        'active_users' => $activeUsers,
        'live_sessions' => $liveSessions,
        'active_subs' => $activeSubs,
        'new_subs_today' => $newSubsToday,
        'slot_utilization' => $slotUtilization,
        'total_slots' => $totalSlots,
        'used_slots' => $usedSlots,
        'total_platforms' => $totalPlatforms,
        'expiring_subs_24h' => $expiringSubs24h,
        'expiring_subs_7d' => $expiringSubs7d,
        'expiring_cookies' => $expiringCookies,
        'errors_last_hour' => $errorsLastHour,
        'failed_logins_24h' => $failedLogins24h,
        'inactive_users_7d' => $inactiveUsers7d,
        'pending_payments' => $pendingPayments,
    ],
    'platform_load' => $platformLoad,
    'slot_intelligence' => [
        'slots' => array_slice($slotIntelligence, 0, 20),
        'best_slot' => $bestSlot,
        'worst_slot' => $worstSlot,
        'unhealthy_count' => $unhealthySlots,
    ],
    'recent_events' => $recentEvents,
    'alerts' => $alerts,
    'revenue' => [
        'total' => $totalRevenue,
        'monthly' => $monthlyRevenue,
        'daily' => $dailyRevenue,
        'pending' => $pendingPayments,
        'history' => $revenueHistory,
    ],
    'user_growth' => $userGrowth,
    'platform_health' => $platformHealth,
    'user_tracking' => $userTracking,
    'security_events' => $recentSecurityEvents,
    'security_stats' => [
        'high_risk_24h' => $highRiskCount,
    ],
]);
