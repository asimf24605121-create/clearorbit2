<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/LoginVerifier.php';

session_start();

checkAdminAccess('super_admin');

$pdo = getPDO();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $action = $_GET['action'] ?? 'dashboard';

    if ($action === 'dashboard') {
        $accounts = $pdo->query("
            SELECT pa.id, pa.platform_id, pa.slot_name, pa.success_count, pa.fail_count,
                   pa.expires_at, pa.cookie_status, pa.login_status, pa.health_status,
                   pa.intelligence_score, pa.stability_status, pa.is_active,
                   pa.last_intelligence_run, pa.last_verified_at, pa.last_success_at, pa.last_failed_at,
                   p.name AS platform_name
            FROM platform_accounts pa
            INNER JOIN platforms p ON p.id = pa.platform_id
            ORDER BY pa.intelligence_score DESC, pa.success_count DESC
        ")->fetchAll();

        $totalAccounts = count($accounts);
        $activeCount = 0;
        $stableCount = 0;
        $riskyCount = 0;
        $deadCount = 0;
        $unknownCount = 0;
        $totalScore = 0;
        $totalSuccess = 0;
        $totalFail = 0;
        $topAccounts = [];
        $bottomAccounts = [];
        $platformStats = [];

        foreach ($accounts as $acct) {
            $score = (int)($acct['intelligence_score'] ?? 0);
            $totalScore += $score;
            $totalSuccess += (int)$acct['success_count'];
            $totalFail += (int)$acct['fail_count'];
            if ($acct['is_active']) $activeCount++;

            $stab = $acct['stability_status'] ?? 'UNKNOWN';
            if ($stab === 'STABLE') $stableCount++;
            elseif ($stab === 'RISKY') $riskyCount++;
            elseif ($stab === 'DEAD') $deadCount++;
            else $unknownCount++;

            $pName = $acct['platform_name'];
            if (!isset($platformStats[$pName])) {
                $platformStats[$pName] = ['total' => 0, 'stable' => 0, 'risky' => 0, 'dead' => 0, 'avg_score' => 0, 'total_score' => 0];
            }
            $platformStats[$pName]['total']++;
            $platformStats[$pName]['total_score'] += $score;
            if ($stab === 'STABLE') $platformStats[$pName]['stable']++;
            elseif ($stab === 'RISKY') $platformStats[$pName]['risky']++;
            elseif ($stab === 'DEAD') $platformStats[$pName]['dead']++;
        }

        foreach ($platformStats as &$ps) {
            $ps['avg_score'] = $ps['total'] > 0 ? round($ps['total_score'] / $ps['total']) : 0;
        }
        unset($ps);

        $topAccounts = array_slice($accounts, 0, 5);
        $sorted = $accounts;
        usort($sorted, function($a, $b) { return ($a['intelligence_score'] ?? 0) - ($b['intelligence_score'] ?? 0); });
        $bottomAccounts = array_slice($sorted, 0, 5);

        $recentLogs = $pdo->query("
            SELECT ail.*, p.name AS platform_name, pa.slot_name
            FROM account_intelligence_log ail
            LEFT JOIN platforms p ON p.id = ail.platform_id
            LEFT JOIN platform_accounts pa ON pa.id = ail.account_id
            ORDER BY ail.created_at DESC
            LIMIT 20
        ")->fetchAll();

        $avgScore = $totalAccounts > 0 ? round($totalScore / $totalAccounts) : 0;
        $overallFailRate = ($totalSuccess + $totalFail) > 0 ? round(($totalFail / ($totalSuccess + $totalFail)) * 100, 1) : 0;
        $overallSuccessRate = 100 - $overallFailRate;

        jsonResponse([
            'success' => true,
            'summary' => [
                'total_accounts' => $totalAccounts,
                'active_accounts' => $activeCount,
                'avg_score' => $avgScore,
                'success_rate' => $overallSuccessRate,
                'fail_rate' => $overallFailRate,
                'total_successes' => $totalSuccess,
                'total_failures' => $totalFail,
                'stable_count' => $stableCount,
                'risky_count' => $riskyCount,
                'dead_count' => $deadCount,
                'unknown_count' => $unknownCount,
            ],
            'platform_stats' => $platformStats,
            'top_accounts' => $topAccounts,
            'bottom_accounts' => $bottomAccounts,
            'recent_events' => $recentLogs,
        ]);
    }

    if ($action === 'account_history') {
        $accountId = (int)($_GET['account_id'] ?? 0);
        if ($accountId < 1) jsonResponse(['success' => false, 'message' => 'account_id required.'], 400);

        $logs = $pdo->prepare("
            SELECT * FROM account_intelligence_log
            WHERE account_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        ");
        $logs->execute([$accountId]);

        jsonResponse(['success' => true, 'history' => $logs->fetchAll()]);
    }

    jsonResponse(['success' => false, 'message' => 'Unknown action.'], 400);
}

if ($method === 'POST') {
    validateCsrfToken();

    $input = json_decode(file_get_contents('php://input'), true);
    $action = $input['action'] ?? '';

    if ($action === 'run_intelligence') {
        $now = date('Y-m-d H:i:s');
        $accounts = $pdo->query("
            SELECT id, platform_id, success_count, fail_count, expires_at,
                   cookie_status, login_status, intelligence_score, stability_status, is_active
            FROM platform_accounts
        ")->fetchAll();

        $updated = 0;
        $deactivated = 0;
        $reactivated = 0;

        foreach ($accounts as $acct) {
            $oldScore = (int)($acct['intelligence_score'] ?? 0);
            $oldStab = $acct['stability_status'] ?? 'UNKNOWN';

            $alie = computeIntelligenceScore(
                (int)$acct['success_count'], (int)$acct['fail_count'],
                $acct['expires_at'], $acct['cookie_status'], $acct['login_status']
            );

            if ($alie['score'] !== $oldScore || $alie['stability'] !== $oldStab) {
                $pdo->prepare("UPDATE platform_accounts SET intelligence_score = ?, stability_status = ?, last_intelligence_run = ? WHERE id = ?")
                    ->execute([$alie['score'], $alie['stability'], $now, $acct['id']]);

                logIntelligenceEvent($pdo, (int)$acct['id'], (int)$acct['platform_id'], 'intelligence_run',
                    $oldScore, $alie['score'], $oldStab, $alie['stability'],
                    "Scheduled run. Score: {$oldScore} → {$alie['score']}");
                $updated++;
            }

            if ($alie['stability'] === 'DEAD' && $acct['is_active']) {
                $pdo->prepare("UPDATE platform_accounts SET is_active = 0 WHERE id = ?")
                    ->execute([$acct['id']]);
                $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")
                    ->execute([$acct['id']]);
                $deactivated++;
            }

            if ($alie['stability'] === 'STABLE' && !$acct['is_active'] && $acct['cookie_status'] === 'VALID') {
                $pdo->prepare("UPDATE platform_accounts SET is_active = 1 WHERE id = ?")
                    ->execute([$acct['id']]);
                $reactivated++;
            }
        }

        logActivity($_SESSION['user_id'], "intelligence_run: total={$updated} deactivated={$deactivated} reactivated={$reactivated}", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => "Intelligence run complete. {$updated} account(s) updated, {$deactivated} deactivated, {$reactivated} reactivated.",
            'updated' => $updated,
            'deactivated' => $deactivated,
            'reactivated' => $reactivated,
            'total_processed' => count($accounts),
        ]);
    }

    if ($action === 'auto_clean') {
        $now = date('Y-m-d H:i:s');
        $deadAccounts = $pdo->query("
            SELECT id, platform_id, slot_name, fail_count, intelligence_score, stability_status
            FROM platform_accounts
            WHERE (stability_status = 'DEAD' OR cookie_status = 'DEAD'
                   OR (fail_count > 0 AND (fail_count * 1.0 / (success_count + fail_count)) >= 0.7 AND (success_count + fail_count) >= 5))
              AND is_active = 1
        ")->fetchAll();

        $cleaned = 0;
        $freedSessions = 0;

        foreach ($deadAccounts as $acct) {
            $pdo->prepare("UPDATE platform_accounts SET is_active = 0, cookie_status = 'DEAD', stability_status = 'DEAD', updated_at = ? WHERE id = ?")
                ->execute([$now, $acct['id']]);

            $sessStmt = $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'");
            $sessStmt->execute([$acct['id']]);
            $freedSessions += $sessStmt->rowCount();

            logIntelligenceEvent($pdo, (int)$acct['id'], (int)$acct['platform_id'], 'auto_clean',
                (int)$acct['intelligence_score'], (int)$acct['intelligence_score'],
                $acct['stability_status'], 'DEAD',
                "Auto-cleaned: fail_count={$acct['fail_count']}, slot={$acct['slot_name']}");
            $cleaned++;
        }

        $expiredAccounts = $pdo->query("
            SELECT id, platform_id, slot_name, intelligence_score, stability_status
            FROM platform_accounts
            WHERE expires_at IS NOT NULL AND expires_at < '{$now}' AND is_active = 1
        ")->fetchAll();

        foreach ($expiredAccounts as $acct) {
            $pdo->prepare("UPDATE platform_accounts SET is_active = 0, cookie_status = 'EXPIRED', stability_status = 'DEAD', updated_at = ? WHERE id = ?")
                ->execute([$now, $acct['id']]);
            $sessStmt = $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'");
            $sessStmt->execute([$acct['id']]);
            $freedSessions += $sessStmt->rowCount();
            $cleaned++;
        }

        logActivity($_SESSION['user_id'], "auto_clean: cleaned={$cleaned} sessions_freed={$freedSessions}", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => "{$cleaned} account(s) cleaned, {$freedSessions} session(s) freed.",
            'cleaned' => $cleaned,
            'sessions_freed' => $freedSessions,
        ]);
    }

    if ($action === 'verify_and_score') {
        $accountId = (int)($input['account_id'] ?? 0);
        if ($accountId < 1) jsonResponse(['success' => false, 'message' => 'account_id required.'], 400);

        $stmt = $pdo->prepare("
            SELECT pa.*, p.cookie_domain, p.name AS platform_name
            FROM platform_accounts pa
            INNER JOIN platforms p ON p.id = pa.platform_id
            WHERE pa.id = ?
        ");
        $stmt->execute([$accountId]);
        $acct = $stmt->fetch();
        if (!$acct) jsonResponse(['success' => false, 'message' => 'Account not found.'], 404);

        $now = date('Y-m-d H:i:s');
        $domain = $acct['cookie_domain'] ?? '';
        $normalizedDomain = strtolower(trim($domain, '.'));
        $supportedDomains = ['netflix.com'];
        $loginResult = null;

        if (!empty($domain) && in_array($normalizedDomain, $supportedDomains)) {
            $loginResult = LoginVerifier::verify($acct['cookie_data'], $domain);
            $pdo->prepare("UPDATE platform_accounts SET login_status = ?, last_verified_at = ? WHERE id = ?")
                ->execute([$loginResult['login_status'], $loginResult['verified_at'], $accountId]);

            if ($loginResult['login_status'] === 'INVALID') {
                $pdo->prepare("UPDATE platform_accounts SET is_active = 0, cookie_status = 'DEAD' WHERE id = ?")
                    ->execute([$accountId]);
                $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")
                    ->execute([$accountId]);
            }
        }

        $refreshed = $pdo->prepare("SELECT success_count, fail_count, expires_at, cookie_status, login_status, intelligence_score, stability_status FROM platform_accounts WHERE id = ?");
        $refreshed->execute([$accountId]);
        $fresh = $refreshed->fetch();

        $oldScore = (int)($fresh['intelligence_score'] ?? 0);
        $oldStab = $fresh['stability_status'] ?? 'UNKNOWN';
        $alie = computeIntelligenceScore(
            (int)$fresh['success_count'], (int)$fresh['fail_count'],
            $fresh['expires_at'], $fresh['cookie_status'], $fresh['login_status']
        );

        $pdo->prepare("UPDATE platform_accounts SET intelligence_score = ?, stability_status = ?, last_intelligence_run = ? WHERE id = ?")
            ->execute([$alie['score'], $alie['stability'], $now, $accountId]);

        if ($oldScore !== $alie['score'] || $oldStab !== $alie['stability']) {
            logIntelligenceEvent($pdo, $accountId, (int)$acct['platform_id'], 'verify_and_score',
                $oldScore, $alie['score'], $oldStab, $alie['stability'],
                "Manual verify+score for {$acct['slot_name']}");
        }

        jsonResponse([
            'success' => true,
            'message' => "Verified and scored: {$acct['slot_name']}",
            'intelligence_score' => $alie['score'],
            'stability_status' => $alie['stability'],
            'login_result' => $loginResult,
            'fail_rate' => $alie['fail_rate'],
        ]);
    }

    jsonResponse(['success' => false, 'message' => 'Unknown action.'], 400);
}

jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
