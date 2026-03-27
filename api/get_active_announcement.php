<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

$pdo = getPDO();
$now = date('Y-m-d H:i:s');

$stmt = $pdo->prepare("
    SELECT id, title, message, type, start_time, end_time, created_at
    FROM announcements
    WHERE status != 'inactive'
      AND start_time IS NOT NULL
      AND end_time IS NOT NULL
      AND start_time <= ?
      AND end_time >= ?
    ORDER BY
        CASE WHEN type = 'popup' THEN 0 ELSE 1 END,
        created_at DESC
");
$stmt->execute([$now, $now]);
$announcements = $stmt->fetchAll();

$popup = null;
$notifications = [];

foreach ($announcements as $a) {
    if ($a['type'] === 'popup' && $popup === null) {
        $popup = $a;
    } elseif ($a['type'] === 'notification') {
        $notifications[] = $a;
    }
}

jsonResponse([
    'success' => true,
    'announcement' => $popup,
    'notifications' => $notifications,
]);
