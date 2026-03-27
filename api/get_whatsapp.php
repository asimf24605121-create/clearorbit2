<?php
require __DIR__ . '/../db.php';
session_start();

$pdo = getPDO();

$stmt = $pdo->query("
    SELECT wc.platform_id, p.name AS platform_name, wc.shared_number AS number
    FROM whatsapp_config wc
    JOIN platforms p ON p.id = wc.platform_id
    WHERE p.is_active = 1
    ORDER BY wc.platform_id
");
$rows = $stmt->fetchAll();

$config = [];
foreach ($rows as $r) {
    $config[] = [
        'platform_id' => (int)$r['platform_id'],
        'platform_name' => $r['platform_name'],
        'number' => $r['number'],
    ];
}

jsonResponse(['success' => true, 'whatsapp' => $config]);
