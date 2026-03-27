<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

$pdo = getPDO();
$platforms = $pdo->query("SELECT id, name, logo_url, bg_color_hex, is_active FROM platforms ORDER BY name ASC")->fetchAll();

jsonResponse([
    'success' => true,
    'data'    => $platforms,
]);
