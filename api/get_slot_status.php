<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$platformId = (int)($_GET['platform_id'] ?? 0);
if ($platformId < 1) {
    jsonResponse(['success' => false, 'message' => 'Missing platform_id.'], 400);
}

$pdo = getPDO();

$now = date('Y-m-d H:i:s');
$stmt = $pdo->prepare("
    SELECT cv.slot,
           CASE WHEN cv.expires_at IS NOT NULL AND cv.expires_at < ? THEN 0 ELSE 1 END AS is_valid
    FROM cookie_vault cv
    WHERE cv.platform_id = ?
      AND cv.cookie_string IS NOT NULL
      AND cv.cookie_string != ''
    ORDER BY cv.slot ASC
");
$stmt->execute([$now, $platformId]);
$rows = $stmt->fetchAll();

$slots = [];
for ($i = 1; $i <= 4; $i++) {
    $slots[$i] = ['slot' => $i, 'has_cookie' => false, 'is_valid' => false];
}
foreach ($rows as $r) {
    $s = (int)$r['slot'];
    if ($s >= 1 && $s <= 4) {
        $slots[$s]['has_cookie'] = true;
        $slots[$s]['is_valid'] = (bool)$r['is_valid'];
    }
}

jsonResponse(['success' => true, 'slots' => array_values($slots)]);
