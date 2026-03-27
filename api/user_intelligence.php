<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/GeoIPService.php';

session_start();
checkAdminAccess('super_admin');

$pdo = getPDO();
$action = $_GET['action'] ?? 'live_sessions';
$now = date('Y-m-d H:i:s');
$fiveMinAgo = date('Y-m-d H:i:s', strtotime('-5 minutes'));

if ($action === 'live_sessions') {
    $stmt = $pdo->prepare("
        SELECT 
            us.id AS session_id,
            us.user_id,
            u.username,
            u.name,
            u.profile_image,
            us.ip_address,
            us.device_type,
            us.browser,
            us.os,
            us.status,
            us.last_activity,
            us.created_at AS login_time,
            us.session_token
        FROM user_sessions us
        JOIN users u ON u.id = us.user_id
        WHERE us.status = 'active'
        ORDER BY us.last_activity DESC
    ");
    $stmt->execute();
    $sessions = $stmt->fetchAll();

    $result = [];
    foreach ($sessions as $s) {
        $loginTime = strtotime($s['login_time']);
        $lastAct = strtotime($s['last_activity']);
        $duration = time() - $loginTime;
        $isActive = (time() - $lastAct) < 300;

        $hours = floor($duration / 3600);
        $mins = floor(($duration % 3600) / 60);
        $durationStr = '';
        if ($hours > 0) $durationStr .= "{$hours}h ";
        $durationStr .= "{$mins}m";

        $geo = GeoIPService::lookup($s['ip_address'] ?? '127.0.0.1', $pdo);
        $risk = GeoIPService::assessRisk($pdo, (int)$s['user_id'], $s['ip_address'] ?? '127.0.0.1');

        $result[] = [
            'session_id' => (int)$s['session_id'],
            'user_id' => (int)$s['user_id'],
            'username' => $s['username'],
            'name' => $s['name'] ?? $s['username'],
            'profile_image' => $s['profile_image'],
            'ip' => $s['ip_address'],
            'device_type' => $s['device_type'],
            'browser' => $s['browser'],
            'os' => $s['os'],
            'is_active' => $isActive,
            'last_activity' => $s['last_activity'],
            'login_time' => $s['login_time'],
            'duration' => trim($durationStr),
            'duration_seconds' => $duration,
            'geo' => [
                'country' => $geo['country'],
                'country_code' => $geo['country_code'],
                'city' => $geo['city'],
                'region' => $geo['region'],
                'isp' => $geo['isp'],
            ],
            'risk' => [
                'level' => $risk['risk_level'],
                'reasons' => $risk['reasons'],
                'flags' => $risk['flags'],
                'concurrent_ips' => $risk['concurrent_ips'],
                'is_new_ip' => $risk['is_new_ip'],
            ],
        ];
    }

    jsonResponse([
        'success' => true,
        'sessions' => $result,
        'total_active' => count($result),
        'total_online' => count(array_filter($result, fn($s) => $s['is_active'])),
        'server_time' => $now,
    ]);
}

elseif ($action === 'security_events') {
    $limit = min((int)($_GET['limit'] ?? 50), 100);
    $severity = $_GET['severity'] ?? null;

    $sql = "SELECT se.*, u.username FROM security_events se LEFT JOIN users u ON u.id = se.user_id";
    $params = [];

    if ($severity) {
        $sql .= " WHERE se.severity = ?";
        $params[] = $severity;
    }

    $sql .= " ORDER BY se.created_at DESC LIMIT ?";
    $params[] = $limit;

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $events = $stmt->fetchAll();

    foreach ($events as &$ev) {
        $ev['details'] = json_decode($ev['details'] ?? '{}', true);
    }
    unset($ev);

    jsonResponse(['success' => true, 'events' => $events]);
}

elseif ($action === 'force_logout') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['success' => false, 'message' => 'POST required'], 405);
    }
    validateCsrfToken();

    $input = json_decode(file_get_contents('php://input'), true);
    $targetUserId = (int)($input['user_id'] ?? 0);
    $reason = trim($input['reason'] ?? 'Admin forced logout');

    if ($targetUserId <= 0) {
        jsonResponse(['success' => false, 'message' => 'Invalid user ID'], 400);
    }

    $count = deactivateAllUserSessions($targetUserId, null, $reason);

    GeoIPService::logSecurityEvent($pdo, $targetUserId, 'admin_force_logout', 'high', getClientIP(), [
        'admin_id' => $_SESSION['user_id'],
        'reason' => $reason,
        'sessions_terminated' => $count,
    ]);

    logActivity((int)$_SESSION['user_id'], 'admin_force_logout_user_' . $targetUserId, getClientIP());

    jsonResponse(['success' => true, 'message' => "Terminated $count session(s)", 'count' => $count]);
}

elseif ($action === 'user_history') {
    $targetUserId = (int)($_GET['user_id'] ?? 0);
    if ($targetUserId <= 0) {
        jsonResponse(['success' => false, 'message' => 'Invalid user ID'], 400);
    }

    $loginStmt = $pdo->prepare("
        SELECT ip_address, user_agent, device_type, browser, os, action, created_at 
        FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
    ");
    $loginStmt->execute([$targetUserId]);
    $logins = $loginStmt->fetchAll();

    foreach ($logins as &$l) {
        $geo = GeoIPService::lookup($l['ip_address'] ?? '127.0.0.1', $pdo);
        $l['geo'] = [
            'country' => $geo['country'],
            'city' => $geo['city'],
            'isp' => $geo['isp'],
        ];
    }
    unset($l);

    $ipStmt = $pdo->prepare("SELECT DISTINCT ip_address FROM login_history WHERE user_id = ?");
    $ipStmt->execute([$targetUserId]);
    $uniqueIPs = $ipStmt->fetchAll(PDO::FETCH_COLUMN);

    $secStmt = $pdo->prepare("SELECT * FROM security_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 20");
    $secStmt->execute([$targetUserId]);
    $secEvents = $secStmt->fetchAll();
    foreach ($secEvents as &$se) {
        $se['details'] = json_decode($se['details'] ?? '{}', true);
    }
    unset($se);

    jsonResponse([
        'success' => true,
        'logins' => $logins,
        'unique_ips' => count($uniqueIPs),
        'ip_list' => $uniqueIPs,
        'security_events' => $secEvents,
    ]);
}

else {
    jsonResponse(['success' => false, 'message' => 'Unknown action'], 400);
}
