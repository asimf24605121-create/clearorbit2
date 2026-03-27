<?php
require_once __DIR__ . '/../db.php';
session_start();
checkAdminAccess('super_admin');

$pdo = getPDO();
$action = $_GET['action'] ?? ($_POST['action'] ?? 'status');

if ($action === 'status') {
    $platforms = $pdo->query("
        SELECT p.id, p.name, p.logo_url, p.bg_color_hex, p.cookie_domain, p.login_url,
               p.is_active, p.health_score, p.health_status, p.auto_detected,
               p.last_health_check, p.total_accounts,
               COUNT(DISTINCT cv.id) AS vault_count,
               COUNT(DISTINCT pa.id) AS slot_count,
               COUNT(DISTINCT us.user_id) AS active_users
        FROM platforms p
        LEFT JOIN cookie_vault cv ON cv.platform_id = p.id
        LEFT JOIN platform_accounts pa ON pa.platform_id = p.id
        LEFT JOIN user_subscriptions us ON us.platform_id = p.id AND us.is_active = 1
        GROUP BY p.id
        ORDER BY p.name
    ")->fetchAll();

    $totalActive = 0;
    $totalWarning = 0;
    $totalDead = 0;
    foreach ($platforms as &$p) {
        $p['vault_count'] = (int)$p['vault_count'];
        $p['slot_count'] = (int)$p['slot_count'];
        $p['active_users'] = (int)$p['active_users'];
        $p['health_score'] = (int)$p['health_score'];
        $p['auto_detected'] = (int)$p['auto_detected'];
        $status = $p['health_status'] ?? 'active';
        if ($status === 'active') $totalActive++;
        elseif ($status === 'warning') $totalWarning++;
        else $totalDead++;
    }
    unset($p);

    jsonResponse([
        'success' => true,
        'platforms' => $platforms,
        'summary' => [
            'total' => count($platforms),
            'active' => $totalActive,
            'warning' => $totalWarning,
            'dead' => $totalDead,
        ],
    ]);
}

if ($action === 'refresh_health') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['success' => false, 'message' => 'POST required.'], 405);
    }
    validateCsrfToken();

    $platforms = $pdo->query("
        SELECT p.id, p.name, p.cookie_domain,
               COUNT(DISTINCT cv.id) AS vault_count,
               COUNT(DISTINCT CASE WHEN cv.expires_at IS NOT NULL AND cv.expires_at > datetime('now') THEN cv.id END) AS valid_vaults,
               COUNT(DISTINCT CASE WHEN cv.expires_at IS NOT NULL AND cv.expires_at <= datetime('now') THEN cv.id END) AS expired_vaults,
               COUNT(DISTINCT pa.id) AS slot_count
        FROM platforms p
        LEFT JOIN cookie_vault cv ON cv.platform_id = p.id
        LEFT JOIN platform_accounts pa ON pa.platform_id = p.id
        GROUP BY p.id
    ")->fetchAll();

    $updated = 0;
    $now = date('Y-m-d H:i:s');
    $updateStmt = $pdo->prepare("UPDATE platforms SET health_score = ?, health_status = ?, last_health_check = ?, total_accounts = ? WHERE id = ?");

    foreach ($platforms as $p) {
        $vaultCount = (int)$p['vault_count'];
        $validVaults = (int)$p['valid_vaults'];
        $expiredVaults = (int)$p['expired_vaults'];
        $slotCount = (int)$p['slot_count'];

        if ($vaultCount === 0) {
            $score = 50;
            $status = 'warning';
        } elseif ($validVaults === 0 && $expiredVaults > 0) {
            $score = 10;
            $status = 'dead';
        } elseif ($expiredVaults > 0 && $validVaults > 0) {
            $ratio = $validVaults / $vaultCount;
            $score = max(20, (int)round($ratio * 100));
            $status = $score >= 60 ? 'active' : 'warning';
        } else {
            $score = 100;
            $status = 'active';
        }

        $updateStmt->execute([$score, $status, $now, $slotCount, (int)$p['id']]);
        $updated++;
    }

    logActivity($_SESSION['user_id'], "platform_health_refresh: {$updated} platforms checked", getClientIP());

    jsonResponse([
        'success' => true,
        'message' => "Health check completed for {$updated} platforms.",
        'updated' => $updated,
    ]);
}

if ($action === 'toggle') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['success' => false, 'message' => 'POST required.'], 405);
    }
    validateCsrfToken();

    $input = json_decode(file_get_contents('php://input'), true);
    $platformId = (int)($input['platform_id'] ?? 0);
    if (!$platformId) {
        jsonResponse(['success' => false, 'message' => 'Platform ID required.'], 400);
    }

    $stmt = $pdo->prepare("SELECT id, name, is_active FROM platforms WHERE id = ?");
    $stmt->execute([$platformId]);
    $plat = $stmt->fetch();
    if (!$plat) {
        jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
    }

    $newState = $plat['is_active'] ? 0 : 1;
    $pdo->prepare("UPDATE platforms SET is_active = ? WHERE id = ?")->execute([$newState, $platformId]);
    $action_label = $newState ? 'enabled' : 'disabled';
    logActivity($_SESSION['user_id'], "platform_{$action_label}: {$plat['name']}", getClientIP());

    jsonResponse(['success' => true, 'message' => "Platform '{$plat['name']}' {$action_label}."]);
}

jsonResponse(['success' => false, 'message' => 'Unknown action.'], 400);
