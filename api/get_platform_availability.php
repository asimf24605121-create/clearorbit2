<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];

$today = date('Y-m-d');
$now = date('Y-m-d H:i:s');
$activeCutoff = date('Y-m-d H:i:s', strtotime('-5 minutes'));

$platformIdParam = (int)($_GET['platform_id'] ?? 0);

$subWhere = $platformIdParam > 0 ? 'AND us.platform_id = ?' : '';
$subParams = [$userId, $today];
if ($platformIdParam > 0) $subParams[] = $platformIdParam;

$subStmt = $pdo->prepare("
    SELECT us.platform_id FROM user_subscriptions us
    WHERE us.user_id = ? AND us.is_active = 1 AND us.end_date >= ?
    {$subWhere}
");
$subStmt->execute($subParams);
$subscribedPlatforms = $subStmt->fetchAll(PDO::FETCH_COLUMN, 0);

if (empty($subscribedPlatforms)) {
    jsonResponse(['success' => true, 'availability' => []]);
}

$placeholders = implode(',', array_fill(0, count($subscribedPlatforms), '?'));

$slotStmt = $pdo->prepare("
    SELECT
        pa.platform_id,
        COUNT(pa.id) AS total_slots,
        SUM(CASE WHEN pa.is_active = 1 AND pa.cookie_status IN ('VALID','RISKY') THEN 1 ELSE 0 END) AS active_slots,
        SUM(pa.max_users) AS total_capacity,
        (
            SELECT COUNT(*) FROM account_sessions acs2
            INNER JOIN platform_accounts pa2 ON pa2.id = acs2.account_id
            WHERE pa2.platform_id = pa.platform_id
              AND acs2.status = 'active'
              AND acs2.last_active >= ?
        ) AS active_sessions
    FROM platform_accounts pa
    WHERE pa.platform_id IN ({$placeholders})
    GROUP BY pa.platform_id
");
$slotStmt->execute(array_merge([$activeCutoff], $subscribedPlatforms));
$slotData = $slotStmt->fetchAll();

$availability = [];
foreach ($slotData as $row) {
    $pid = (int)$row['platform_id'];
    $activeSlots = (int)$row['active_slots'];
    $totalCapacity = (int)$row['total_capacity'];
    $activeSessions = (int)$row['active_sessions'];
    $availableCapacity = max(0, $totalCapacity - $activeSessions);

    if ($activeSlots === 0) {
        $status = 'unavailable';
        $label = 'Temporarily Unavailable';
    } elseif ($availableCapacity === 0) {
        $status = 'full';
        $label = 'High Demand';
    } elseif ($totalCapacity > 0 && ($activeSessions / $totalCapacity) >= 0.8) {
        $status = 'high_demand';
        $label = 'High Demand';
    } else {
        $status = 'available';
        $label = 'Available';
    }

    $availability[$pid] = [
        'status' => $status,
        'label' => $label,
        'active_slots' => $activeSlots,
        'total_capacity' => $totalCapacity,
        'active_sessions' => $activeSessions,
        'available_capacity' => $availableCapacity,
    ];
}

foreach ($subscribedPlatforms as $pid) {
    $pid = (int)$pid;
    if (!isset($availability[$pid])) {
        $availability[$pid] = [
            'status' => 'unavailable',
            'label' => 'Temporarily Unavailable',
            'active_slots' => 0,
            'total_capacity' => 0,
            'active_sessions' => 0,
            'available_capacity' => 0,
        ];
    }
}

jsonResponse(['success' => true, 'availability' => $availability]);
