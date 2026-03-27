<?php
require __DIR__ . '/../db.php';
session_start();
validateCsrfToken();

checkAdminAccess('super_admin');

$input = json_decode(file_get_contents('php://input'), true);
$platformId = (int)($input['platform_id'] ?? 0);
$plans = $input['plans'] ?? [];

if (!$platformId || empty($plans)) {
    jsonResponse(['success' => false, 'message' => 'Platform and plans are required.'], 400);
}

$pdo = getPDO();

$plat = $pdo->prepare("SELECT id FROM platforms WHERE id = ?");
$plat->execute([$platformId]);
if (!$plat->fetch()) {
    jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
}

$validKeys = ['1_week', '1_month', '6_months', '1_year'];
$driver = getenv('DB_DRIVER') ?: 'sqlite';

foreach ($plans as $key => $prices) {
    if (!in_array($key, $validKeys)) continue;
    $shared = max(0, (float)($prices['shared'] ?? 0));
    $private = max(0, (float)($prices['private'] ?? 0));

    if ($driver === 'mysql') {
        $stmt = $pdo->prepare("INSERT INTO pricing_plans (platform_id, duration_key, shared_price, private_price)
            VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE shared_price = VALUES(shared_price), private_price = VALUES(private_price)");
    } else {
        $stmt = $pdo->prepare("INSERT INTO pricing_plans (platform_id, duration_key, shared_price, private_price)
            VALUES (?, ?, ?, ?) ON CONFLICT(platform_id, duration_key) DO UPDATE SET shared_price = excluded.shared_price, private_price = excluded.private_price");
    }
    $stmt->execute([$platformId, $key, $shared, $private]);
}

logActivity($_SESSION['user_id'], "Updated pricing for platform #$platformId", getClientIP());
jsonResponse(['success' => true, 'message' => 'Pricing updated successfully.']);
