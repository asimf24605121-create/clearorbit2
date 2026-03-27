<?php
/**
 * ClearOrbit — Expire Subscriptions Cron Job
 * 
 * Deactivates subscriptions past their end date and releases
 * associated platform sessions for affected users.
 *
 * Cron setup (daily at midnight):
 *   0 0 * * * /usr/bin/php /home/user/public_html/scripts/expire_subscriptions.php >> /home/user/logs/cron.log 2>&1
 */

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}

require_once __DIR__ . '/../db.php';

$start = microtime(true);
$today = date('Y-m-d');

try {
    $pdo = getPDO();

    $expiredStmt = $pdo->prepare("SELECT DISTINCT user_id FROM user_subscriptions WHERE is_active = 1 AND end_date < ?");
    $expiredStmt->execute([$today]);
    $expiredUserIds = $expiredStmt->fetchAll(PDO::FETCH_COLUMN);

    $stmt = $pdo->prepare("UPDATE user_subscriptions SET is_active = 0 WHERE is_active = 1 AND end_date < ?");
    $stmt->execute([$today]);
    $expired = $stmt->rowCount();

    $sessionsReleased = 0;
    if (!empty($expiredUserIds)) {
        foreach ($expiredUserIds as $uid) {
            $hasActive = $pdo->prepare("SELECT COUNT(*) FROM user_subscriptions WHERE user_id = ? AND is_active = 1");
            $hasActive->execute([$uid]);
            if ((int)$hasActive->fetchColumn() === 0) {
                $rel = $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE user_id = ? AND status = 'active'");
                $rel->execute([$uid]);
                $sessionsReleased += $rel->rowCount();
            }
        }
    }

    $elapsed = round(microtime(true) - $start, 3);
    echo date('Y-m-d H:i:s') . " [expire_subscriptions] Expired: {$expired}, Sessions released: {$sessionsReleased}, Time: {$elapsed}s\n";
} catch (Exception $e) {
    echo date('Y-m-d H:i:s') . " [expire_subscriptions] ERROR: " . $e->getMessage() . "\n";
    exit(1);
}
