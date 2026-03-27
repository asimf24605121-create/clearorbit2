<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');
session_write_close();

$pdo = getPDO();

$limit = min(100, max(1, (int)($_GET['limit'] ?? 50)));
$offset = max(0, (int)($_GET['offset'] ?? 0));
$search = trim($_GET['search'] ?? '');
$type = trim($_GET['type'] ?? '');
$timeRange = trim($_GET['time_range'] ?? '');

$where = [];
$params = [];

if ($search !== '') {
    $where[] = "(u.username LIKE ? OR al.action LIKE ? OR al.ip_address LIKE ?)";
    $params[] = "%{$search}%";
    $params[] = "%{$search}%";
    $params[] = "%{$search}%";
}

if ($type !== '' && $type !== 'all') {
    $typeMap = [
        'login'  => ['login'],
        'logout' => ['logout'],
        'error'  => ['failed', 'block', 'error'],
        'update' => ['update', 'edit', 'change', 'create', 'delete', 'purge', 'assign', 'remove'],
        'system' => ['system', 'cron', 'cleanup', 'migration'],
    ];
    if (isset($typeMap[$type])) {
        $conditions = array_map(fn($k) => "al.action LIKE ?", $typeMap[$type]);
        $where[] = '(' . implode(' OR ', $conditions) . ')';
        foreach ($typeMap[$type] as $k) {
            $params[] = "%{$k}%";
        }
    }
}

if ($timeRange !== '' && $timeRange !== 'all') {
    $now = date('Y-m-d H:i:s');
    switch ($timeRange) {
        case '5min':
            $since = date('Y-m-d H:i:s', strtotime('-5 minutes'));
            break;
        case '1hour':
            $since = date('Y-m-d H:i:s', strtotime('-1 hour'));
            break;
        case 'today':
            $since = date('Y-m-d 00:00:00');
            break;
        case '24h':
            $since = date('Y-m-d H:i:s', strtotime('-24 hours'));
            break;
        case '7d':
            $since = date('Y-m-d H:i:s', strtotime('-7 days'));
            break;
        default:
            $since = null;
    }
    if ($since) {
        $where[] = "al.created_at >= ?";
        $params[] = $since;
    }
}

$whereClause = !empty($where) ? 'WHERE ' . implode(' AND ', $where) : '';

$countSql = "SELECT COUNT(*) FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id {$whereClause}";
$countStmt = $pdo->prepare($countSql);
$countStmt->execute($params);
$total = (int)$countStmt->fetchColumn();

$sql = "
    SELECT al.id, al.action, al.ip_address, al.created_at, u.username
    FROM activity_logs al
    LEFT JOIN users u ON u.id = al.user_id
    {$whereClause}
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
";
$params[] = $limit;
$params[] = $offset;

$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$logs = $stmt->fetchAll();

foreach ($logs as &$log) {
    $log['priority'] = computeEventPriority($log['action']);
    $log['risk_score'] = computeEventRisk($log['action']);
    $log['event_type'] = classifyEventType($log['action']);
}

jsonResponse([
    'success' => true,
    'logs'    => $logs,
    'total'   => $total,
    'limit'   => $limit,
    'offset'  => $offset,
]);

function computeEventPriority(string $action): string {
    $a = strtolower($action);
    if (str_contains($a, 'failed') && str_contains($a, 'login')) return 'CRITICAL';
    if (str_contains($a, 'block') || str_contains($a, 'suspicious')) return 'CRITICAL';
    if (str_contains($a, 'purge') || str_contains($a, 'delete')) return 'HIGH';
    if (str_contains($a, 'password') || str_contains($a, 'change')) return 'HIGH';
    if (str_contains($a, 'login') || str_contains($a, 'logout')) return 'MEDIUM';
    if (str_contains($a, 'update') || str_contains($a, 'create') || str_contains($a, 'assign')) return 'MEDIUM';
    return 'LOW';
}

function computeEventRisk(string $action): int {
    $a = strtolower($action);
    $score = 10;
    if (str_contains($a, 'failed')) $score += 40;
    if (str_contains($a, 'block')) $score += 50;
    if (str_contains($a, 'suspicious')) $score += 60;
    if (str_contains($a, 'purge') || str_contains($a, 'delete')) $score += 20;
    if (str_contains($a, 'password')) $score += 15;
    return min(100, $score);
}

function classifyEventType(string $action): string {
    $a = strtolower($action);
    if (str_contains($a, 'login')) return 'login';
    if (str_contains($a, 'logout')) return 'logout';
    if (str_contains($a, 'failed') || str_contains($a, 'error') || str_contains($a, 'block')) return 'error';
    if (str_contains($a, 'update') || str_contains($a, 'edit') || str_contains($a, 'create') || str_contains($a, 'delete') || str_contains($a, 'assign') || str_contains($a, 'purge') || str_contains($a, 'change')) return 'update';
    return 'system';
}
