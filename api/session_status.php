<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

$userId = (int)$_SESSION['user_id'];
$sessionToken = $_SESSION['session_token'] ?? null;
$pdo = getPDO();

autoExpireSubscriptions();

$allPlatforms = $pdo->query("SELECT id, name, logo_url, bg_color_hex FROM platforms WHERE is_active = 1 ORDER BY name ASC")->fetchAll();

$stmt = $pdo->prepare("
    SELECT
        us.id           AS sub_id,
        us.start_date,
        us.end_date,
        us.is_active    AS sub_active,
        us.platform_id
    FROM user_subscriptions us
    WHERE us.user_id = ?
      AND us.is_active = 1
    ORDER BY us.end_date DESC
");
$stmt->execute([$userId]);
$userSubs = $stmt->fetchAll();

$subMap = [];
foreach ($userSubs as $sub) {
    $pid = (int)$sub['platform_id'];
    if (!isset($subMap[$pid])) {
        $subMap[$pid] = $sub;
    }
}

$now = new DateTime();
$cards = [];
foreach ($allPlatforms as $p) {
    $pid = (int)$p['id'];
    $sub = $subMap[$pid] ?? null;

    if ($sub) {
        $endDate  = new DateTime($sub['end_date'] . ' 23:59:59');
        $diff     = $now->diff($endDate);
        $isExpired = ($now > $endDate);

        $cards[] = [
            'sub_id'        => (int)$sub['sub_id'],
            'platform_id'   => $pid,
            'platform_name' => $p['name'],
            'logo_url'      => $p['logo_url'],
            'bg_color_hex'  => $p['bg_color_hex'],
            'start_date'    => $sub['start_date'],
            'end_date'      => $sub['end_date'],
            'remaining'     => $isExpired
                ? ['days' => 0, 'hours' => 0, 'minutes' => 0, 'expired' => true]
                : ['days' => $diff->days, 'hours' => $diff->h, 'minutes' => $diff->i, 'expired' => false],
            'subscribed'    => true,
        ];
    } else {
        $cards[] = [
            'sub_id'        => null,
            'platform_id'   => $pid,
            'platform_name' => $p['name'],
            'logo_url'      => $p['logo_url'],
            'bg_color_hex'  => $p['bg_color_hex'],
            'start_date'    => null,
            'end_date'      => null,
            'remaining'     => null,
            'subscribed'    => false,
        ];
    }
}

usort($cards, function($a, $b) {
    if ($a['subscribed'] && !$b['subscribed']) return -1;
    if (!$a['subscribed'] && $b['subscribed']) return 1;
    return strcmp($a['platform_name'], $b['platform_name']);
});

$activeDevices = getActiveSessionCount($userId);

$currentSession = null;
if ($sessionToken) {
    $cs = $pdo->prepare("SELECT device_type, browser, os, ip_address, created_at FROM user_sessions WHERE session_token = ? AND status = 'active'");
    $cs->execute([$sessionToken]);
    $currentSession = $cs->fetch() ?: null;
}

jsonResponse([
    'success'         => true,
    'cards'           => $cards,
    'active_devices'  => $activeDevices,
    'device_limit'    => 2,
    'current_session' => $currentSession,
    'server_time'     => date('Y-m-d H:i:s'),
    'session_timeout_minutes' => SESSION_INACTIVITY_TIMEOUT_MINUTES,
]);
