<?php
require_once __DIR__ . '/../db.php';

$pdo = getPDO();
$platforms = $pdo->query("SELECT id, name, logo_url, bg_color_hex, is_active FROM platforms WHERE is_active = 1 ORDER BY name ASC")->fetchAll();

$pricing = $pdo->query("SELECT platform_id, duration_key, shared_price, private_price FROM pricing_plans")->fetchAll();
$pricingMap = [];
foreach ($pricing as $p) {
    $pricingMap[$p['platform_id']][$p['duration_key']] = [
        'shared' => (float)$p['shared_price'],
        'private' => (float)$p['private_price'],
    ];
}

$whatsapp = $pdo->query("SELECT platform_id, shared_number AS number FROM whatsapp_config")->fetchAll();
$waMap = [];
foreach ($whatsapp as $w) {
    $waMap[$w['platform_id']] = $w['number'];
}

foreach ($platforms as &$plat) {
    $plat['pricing'] = $pricingMap[$plat['id']] ?? null;
    $plat['whatsapp'] = $waMap[$plat['id']] ?? null;
}
unset($plat);

jsonResponse([
    'success'   => true,
    'platforms' => $platforms,
]);
