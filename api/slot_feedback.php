<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

$contentType = $_SERVER['CONTENT_TYPE'] ?? '';
$isBeacon = stripos($contentType, 'text/plain') !== false;
if (!$isBeacon) {
    validateCsrfToken();
}

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];
$input = json_decode(file_get_contents('php://input'), true);

$accountId = (int)($input['account_id'] ?? 0);
$platformId = (int)($input['platform_id'] ?? 0);
$status = ($input['status'] ?? '');

if ($accountId < 1 || $platformId < 1) {
    jsonResponse(['success' => false, 'message' => 'Missing account_id or platform_id.'], 400);
}

if (!in_array($status, ['success', 'fail'])) {
    jsonResponse(['success' => false, 'message' => 'Status must be "success" or "fail".'], 400);
}

$sessionStmt = $pdo->prepare("
    SELECT id FROM account_sessions
    WHERE user_id = ? AND account_id = ? AND platform_id = ?
    ORDER BY created_at DESC LIMIT 1
");
$sessionStmt->execute([$userId, $accountId, $platformId]);
if (!$sessionStmt->fetch()) {
    jsonResponse(['success' => false, 'message' => 'No session found for this slot.'], 403);
}

$now = date('Y-m-d H:i:s');

define('COOLDOWN_MINUTES', 10);

try {
    $pdo->beginTransaction();

    if ($status === 'success') {
        $pdo->prepare("
            UPDATE platform_accounts
            SET success_count = success_count + 1,
                last_success_at = ?,
                health_status = 'healthy',
                cooldown_until = NULL,
                updated_at = ?
            WHERE id = ?
        ")->execute([$now, $now, $accountId]);
    } else {
        $cooldownUntil = date('Y-m-d H:i:s', strtotime('+' . COOLDOWN_MINUTES . ' minutes'));

        $pdo->prepare("
            UPDATE platform_accounts
            SET fail_count = fail_count + 1,
                last_failed_at = ?,
                cooldown_until = ?,
                updated_at = ?
            WHERE id = ?
        ")->execute([$now, $cooldownUntil, $now, $accountId]);
    }

    $statsStmt = $pdo->prepare("SELECT success_count, fail_count, cookie_id FROM platform_accounts WHERE id = ?");
    $statsStmt->execute([$accountId]);
    $stats = $statsStmt->fetch();

    if ($stats && $status !== 'success') {
        $total = $stats['success_count'] + $stats['fail_count'];
        $failRate = $total > 0 ? $stats['fail_count'] / $total : 0;

        if ($failRate >= 0.7 && $total >= 5) {
            $newHealth = 'unhealthy';
        } elseif ($failRate >= 0.4 && $total >= 3) {
            $newHealth = 'degraded';
        } else {
            $newHealth = 'healthy';
        }

        $cookieStatus = ($newHealth === 'unhealthy') ? 'DEAD' : (($newHealth === 'degraded') ? 'RISKY' : 'VALID');
        $deactivate = ($cookieStatus === 'DEAD') ? ', is_active = 0' : '';
        $pdo->prepare("UPDATE platform_accounts SET health_status = ?, cookie_status = ?{$deactivate}, updated_at = ? WHERE id = ?")->execute([$newHealth, $cookieStatus, $now, $accountId]);

        if (!empty($stats['cookie_id'])) {
            updateVaultStatus($pdo, (int)$stats['cookie_id'], $cookieStatus, null);
        }

        $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND user_id = ? AND status = 'active'")->execute([$accountId, $userId]);

        error_log("slot_feedback: Slot#{$accountId} marked as {$newHealth} (fail_rate=" . round($failRate * 100) . "%, total={$total})");
    }

    $alieStmt = $pdo->prepare("SELECT success_count, fail_count, expires_at, cookie_status, login_status, intelligence_score, stability_status, platform_id, cookie_id FROM platform_accounts WHERE id = ?");
    $alieStmt->execute([$accountId]);
    $alieData = $alieStmt->fetch();
    if ($alieData) {
        $oldScore = (int)($alieData['intelligence_score'] ?? 0);
        $oldStab = $alieData['stability_status'] ?? 'UNKNOWN';
        $alie = computeIntelligenceScore(
            (int)$alieData['success_count'], (int)$alieData['fail_count'],
            $alieData['expires_at'], $alieData['cookie_status'], $alieData['login_status']
        );
        $pdo->prepare("UPDATE platform_accounts SET intelligence_score = ?, stability_status = ?, last_intelligence_run = ? WHERE id = ?")
            ->execute([$alie['score'], $alie['stability'], $now, $accountId]);

        if ($oldScore !== $alie['score'] || $oldStab !== $alie['stability']) {
            logIntelligenceEvent($pdo, $accountId, (int)$alieData['platform_id'], 'feedback_' . $status,
                $oldScore, $alie['score'], $oldStab, $alie['stability'],
                "User #{$userId} reported {$status}. Score: {$oldScore} → {$alie['score']}, Stability: {$oldStab} → {$alie['stability']}");
        }

        if ($alie['stability'] === 'DEAD') {
            $pdo->prepare("UPDATE platform_accounts SET is_active = 0, cookie_status = 'DEAD' WHERE id = ?")
                ->execute([$accountId]);
            $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")
                ->execute([$accountId]);
            if (!empty($alieData['cookie_id'])) {
                updateVaultStatus($pdo, (int)$alieData['cookie_id'], 'DEAD', null);
            }
            $claimSql = "UPDATE cookie_vault SET pool_type = 'active' WHERE id = (SELECT id FROM (SELECT cv2.id FROM cookie_vault cv2 WHERE cv2.platform_id = ? AND cv2.pool_type = 'reserve' AND cv2.cookie_status = 'VALID' ORDER BY cv2.updated_at DESC LIMIT 1) AS t)";
            $claimStmt = $pdo->prepare($claimSql);
            $claimStmt->execute([(int)$alieData['platform_id']]);
            if ($claimStmt->rowCount() > 0) {
                $reserveStmt = $pdo->prepare("SELECT id, cookie_string FROM cookie_vault WHERE platform_id = ? AND pool_type = 'active' AND cookie_status = 'VALID' ORDER BY updated_at DESC LIMIT 1");
                $reserveStmt->execute([(int)$alieData['platform_id']]);
                $reserve = $reserveStmt->fetch();
                if ($reserve) {
                    $pdo->prepare("UPDATE platform_accounts SET cookie_id = ?, cookie_data = ?, is_active = 1, cookie_status = 'VALID', health_status = 'healthy', success_count = 0, fail_count = 0, intelligence_score = 50, stability_status = 'UNKNOWN', cooldown_until = NULL WHERE id = ?")
                        ->execute([$reserve['id'], $reserve['cookie_string'], $accountId]);
                    error_log("slot_feedback: AUTO-FAILOVER Slot#{$accountId} replaced with reserve vault#{$reserve['id']}");
                }
            }
        }
    }

    $pdo->commit();
} catch (Exception $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("slot_feedback error: " . $e->getMessage());
    jsonResponse(['success' => false, 'message' => 'Failed to record feedback.'], 500);
}

error_log("slot_feedback: user#{$userId} reported {$status} for Slot#{$accountId} platform#{$platformId}");

jsonResponse([
    'success' => true,
    'message' => 'Feedback recorded.',
    'status' => $status,
]);
