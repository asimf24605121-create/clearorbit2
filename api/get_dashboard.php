<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized. Please log in.', 'session_expired' => true], 401);
}

$pdo    = getPDO();
$userId = (int)$_SESSION['user_id'];
$sessionToken = $_SESSION['session_token'] ?? null;
$now    = new DateTime();

$profileStmt = $pdo->prepare("SELECT profile_completed, name, profile_image FROM users WHERE id = ?");
$profileStmt->execute([$userId]);
$profileRow = $profileStmt->fetch();
$profileCompleted = (int)($profileRow['profile_completed'] ?? 0);
$profileName = $profileRow['name'] ?? '';
$profileImage = $profileRow['profile_image'] ?? '';

autoExpireSubscriptions();

if ($sessionToken) {
    touchSession($sessionToken);
}

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

$cards = [];
foreach ($allPlatforms as $p) {
    $pid = (int)$p['id'];
    $sub = $subMap[$pid] ?? null;

    if ($sub) {
        $endDate  = new DateTime($sub['end_date'] . ' 23:59:59');
        $diff     = $now->diff($endDate);
        $isExpired = ($now > $endDate);

        $remaining = $isExpired
            ? ['days' => 0, 'hours' => 0, 'minutes' => 0, 'expired' => true]
            : ['days' => $diff->days, 'hours' => $diff->h, 'minutes' => $diff->i, 'expired' => false];

        $cards[] = [
            'sub_id'        => (int)$sub['sub_id'],
            'platform_id'   => $pid,
            'platform_name' => $p['name'],
            'logo_url'      => $p['logo_url'],
            'bg_color_hex'  => $p['bg_color_hex'],
            'start_date'    => $sub['start_date'],
            'end_date'      => $sub['end_date'],
            'remaining'     => $remaining,
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

$currentSession = null;
if ($sessionToken) {
    $cs = $pdo->prepare("SELECT device_type, browser, os, ip_address, created_at FROM user_sessions WHERE session_token = ? AND status = 'active'");
    $cs->execute([$sessionToken]);
    $currentSession = $cs->fetch() ?: null;
}

$activeDevices = getActiveSessionCount($userId);

jsonResponse([
    'success'            => true,
    'username'           => $_SESSION['username'],
    'role'               => $_SESSION['role'] ?? 'user',
    'profile_completed'  => $profileCompleted,
    'name'               => $profileName,
    'profile_image'      => $profileImage,
    'cards'              => $cards,
    'csrf_token'         => generateCsrfToken(),
    'current_session'    => $currentSession,
    'active_devices'     => $activeDevices,
    'device_limit'       => 2,
]);
