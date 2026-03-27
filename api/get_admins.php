<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

$pdo = getPDO();

$admins = $pdo->query("SELECT id, username, name, email, admin_level, is_active, last_login_ip, created_at FROM users WHERE role = 'admin' ORDER BY created_at DESC")->fetchAll();

foreach ($admins as &$admin) {
    $admin['is_permanent'] = ($admin['email'] === PERMANENT_SUPER_ADMIN_EMAIL && $admin['admin_level'] === 'super_admin') ? 1 : 0;
}
unset($admin);

jsonResponse([
    'success' => true,
    'admins'  => $admins,
    'csrf_token' => generateCsrfToken(),
]);
