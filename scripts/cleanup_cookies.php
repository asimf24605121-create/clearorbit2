<?php
/**
 * ClearOrbit — Cookie Cleanup Cron Job
 * 
 * Removes expired cookies from the vault and deactivates
 * associated platform account slots.
 *
 * Cron setup (every 6 hours):
 *   0 0,6,12,18 * * * /usr/bin/php /home/user/public_html/scripts/cleanup_cookies.php >> /home/user/logs/cron.log 2>&1
 */

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}

require_once __DIR__ . '/../db.php';

$start = microtime(true);
$now = date('Y-m-d H:i:s');

try {
    $pdo = getPDO();

    $expiredStmt = $pdo->prepare("SELECT id, platform_id FROM cookie_vault WHERE expires_at IS NOT NULL AND expires_at < ?");
    $expiredStmt->execute([$now]);
    $expiredCookies = $expiredStmt->fetchAll();

    $slotsDeactivated = 0;
    foreach ($expiredCookies as $cookie) {
        $deact = $pdo->prepare("UPDATE platform_accounts SET is_active = 0, cookie_status = 'EXPIRED' WHERE cookie_id = ? AND is_active = 1");
        $deact->execute([$cookie['id']]);
        $slotsDeactivated += $deact->rowCount();

        $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id IN (SELECT id FROM platform_accounts WHERE cookie_id = ?) AND status = 'active'")
            ->execute([$cookie['id']]);
    }

    $stmt = $pdo->prepare("DELETE FROM cookie_vault WHERE expires_at IS NOT NULL AND expires_at < ?");
    $stmt->execute([$now]);
    $deleted = $stmt->rowCount();

    $staleStmt = $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE status = 'active' AND last_active < ?");
    $staleStmt->execute([date('Y-m-d H:i:s', strtotime('-2 hours'))]);
    $staleSessions = $staleStmt->rowCount();

    $elapsed = round(microtime(true) - $start, 3);
    echo date('Y-m-d H:i:s') . " [cleanup_cookies] Deleted: {$deleted}, Slots deactivated: {$slotsDeactivated}, Stale sessions: {$staleSessions}, Time: {$elapsed}s\n";
} catch (Exception $e) {
    echo date('Y-m-d H:i:s') . " [cleanup_cookies] ERROR: " . $e->getMessage() . "\n";
    exit(1);
}
