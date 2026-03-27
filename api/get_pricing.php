<?php
require __DIR__ . '/../db.php';
session_start();

$pdo = getPDO();

$stmt = $pdo->query("
    SELECT pp.platform_id, p.name AS platform_name, pp.duration_key, pp.shared_price, pp.private_price
    FROM pricing_plans pp
    JOIN platforms p ON p.id = pp.platform_id
    WHERE p.is_active = 1
    ORDER BY pp.platform_id, pp.duration_key
");
$rows = $stmt->fetchAll();

$pricing = [];
foreach ($rows as $r) {
    $pid = $r['platform_id'];
    if (!isset($pricing[$pid])) {
        $pricing[$pid] = ['platform_id' => (int)$pid, 'platform_name' => $r['platform_name'], 'plans' => []];
    }
    $pricing[$pid]['plans'][$r['duration_key']] = [
        'shared' => (float)$r['shared_price'],
        'private' => (float)$r['private_price'],
    ];
}

jsonResponse(['success' => true, 'pricing' => array_values($pricing)]);
