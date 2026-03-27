<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

$pdo = getPDO();

autoExpireSubscriptions();

$subs = $pdo->query("
    SELECT
        us.id,
        us.user_id,
        us.platform_id,
        us.start_date,
        us.end_date,
        us.is_active,
        u.username,
        p.name AS platform_name
    FROM user_subscriptions us
    INNER JOIN users u ON u.id = us.user_id
    INNER JOIN platforms p ON p.id = us.platform_id
    WHERE us.is_active = 1
    ORDER BY us.end_date ASC
")->fetchAll();

jsonResponse([
    'success'       => true,
    'subscriptions' => $subs,
]);
