<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];
$method = $_SERVER['REQUEST_METHOD'];

$profileCheck = $pdo->prepare("SELECT profile_completed FROM users WHERE id = ?");
$profileCheck->execute([$userId]);
if (!(int)$profileCheck->fetchColumn()) {
    jsonResponse(['success' => false, 'message' => 'Please complete your profile before accessing platforms.'], 403);
}

define('SESSION_ACTIVE_WINDOW_MINUTES', 5);
define('SESSION_STALE_MINUTES', 10);

if ($method === 'POST') {
    validateCsrfToken();

    $input = json_decode(file_get_contents('php://input'), true);
    $platformId = (int)($input['platform_id'] ?? 0);
    $deviceType = in_array($input['device_type'] ?? '', ['desktop', 'mobile', 'tablet']) ? $input['device_type'] : 'desktop';

    if ($platformId < 1) {
        jsonResponse(['success' => false, 'message' => 'Missing platform ID.'], 400);
    }

    $today = date('Y-m-d');
    $subStmt = $pdo->prepare("
        SELECT id FROM user_subscriptions
        WHERE user_id = ? AND platform_id = ? AND is_active = 1 AND end_date >= ?
    ");
    $subStmt->execute([$userId, $platformId, $today]);
    if (!$subStmt->fetch()) {
        jsonResponse(['success' => false, 'message' => 'No active subscription for this platform.'], 403);
    }

    cleanupStaleSessions($pdo);

    $now = date('Y-m-d H:i:s');
    $activeCutoff = date('Y-m-d H:i:s', strtotime('-' . SESSION_ACTIVE_WINDOW_MINUTES . ' minutes'));

    $existingStmt = $pdo->prepare("
        SELECT acs.id, acs.account_id, pa.cookie_data, pa.cookie_count, pa.expires_at,
               pa.is_active, pa.cooldown_until, pa.cookie_id,
               cv.cookie_string AS vault_cookie_string,
               p.name AS platform_name, p.cookie_domain, p.login_url
        FROM account_sessions acs
        INNER JOIN platform_accounts pa ON pa.id = acs.account_id
        INNER JOIN platforms p ON p.id = pa.platform_id
        LEFT JOIN cookie_vault cv ON cv.id = pa.cookie_id
        WHERE acs.user_id = ? AND acs.platform_id = ? AND acs.status = 'active'
              AND acs.last_active >= ?
        ORDER BY acs.last_active DESC
        LIMIT 1
    ");
    $existingStmt->execute([$userId, $platformId, $activeCutoff]);
    $existing = $existingStmt->fetch();

    if ($existing) {
        $effectiveCookie = resolveAccountCookieData($existing);
        $validatedCookies = validateCookieData($effectiveCookie);
        $slotExpired = false;
        if ($existing['expires_at']) {
            try { $slotExpired = new DateTime($existing['expires_at']) < new DateTime($now); } catch (Exception $e) {}
        }
        $inCooldown = $existing['cooldown_until'] && $existing['cooldown_until'] > $now;

        if ($validatedCookies === false || !$existing['is_active'] || $slotExpired || $inCooldown) {
            $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE id = ?")->execute([$existing['id']]);
            $reason = $validatedCookies === false ? 'invalid cookies' : ($inCooldown ? 'slot in cooldown' : ($slotExpired ? 'slot expired' : 'slot disabled'));
            error_log("access_platform: Existing session {$existing['id']} released ({$reason}), re-assigning");
        } else {
            $pdo->prepare("UPDATE account_sessions SET last_active = ?, device_type = ? WHERE id = ?")->execute([$now, $deviceType, $existing['id']]);
            error_log("access_platform: Returning existing session for user#{$userId} platform#{$platformId} slot#{$existing['account_id']}");
            jsonResponse(buildCookieResponse($effectiveCookie, $existing['cookie_domain'], $existing['login_url'], $existing['platform_name'], $platformId, $existing['account_id']));
        }
    }

    $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE user_id = ? AND platform_id = ? AND status = 'active'")->execute([$userId, $platformId]);

    $isSQLite = ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite');

    $txnBegin = function() use ($pdo, $isSQLite) {
        if ($isSQLite) { $pdo->exec('BEGIN IMMEDIATE'); } else { $pdo->beginTransaction(); }
    };
    $txnCommit = function() use ($pdo, $isSQLite) {
        if ($isSQLite) { $pdo->exec('COMMIT'); } else { $pdo->commit(); }
    };
    $txnRollback = function() use ($pdo, $isSQLite) {
        try { if ($isSQLite) { $pdo->exec('ROLLBACK'); } else { $pdo->rollBack(); } } catch (Exception $ignore) {}
    };

    $txnBegin();
    try {
        $forUpdate = $isSQLite ? '' : 'FOR UPDATE';
        $accountsStmt = $pdo->prepare("
            SELECT pa.id, pa.cookie_data, pa.cookie_count, pa.max_users, pa.expires_at, pa.slot_name,
                   pa.success_count, pa.fail_count, pa.health_status, pa.last_success_at, pa.last_failed_at,
                   pa.cookie_status, pa.cookie_id, pa.intelligence_score, pa.stability_status,
                   cv.cookie_string AS vault_cookie_string,
                   p.name AS platform_name, p.cookie_domain, p.login_url,
                   COALESCE(pa.intelligence_score, ((pa.success_count * 2) - (pa.fail_count * 3))) AS slot_score
            FROM platform_accounts pa
            INNER JOIN platforms p ON p.id = pa.platform_id
            LEFT JOIN cookie_vault cv ON cv.id = pa.cookie_id
            WHERE pa.platform_id = ? AND pa.is_active = 1
                  AND (
                      (pa.cookie_id IS NOT NULL AND cv.cookie_string IS NOT NULL AND cv.cookie_string != '')
                      OR (pa.cookie_id IS NULL AND pa.cookie_data IS NOT NULL AND pa.cookie_data != '' AND pa.cookie_data != '[]')
                  )
                  AND (pa.cookie_status IS NULL OR pa.cookie_status IN ('VALID', 'RISKY'))
                  AND (pa.cooldown_until IS NULL OR pa.cooldown_until <= ?)
            ORDER BY
                CASE pa.health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END ASC,
                CASE pa.stability_status WHEN 'STABLE' THEN 0 WHEN 'UNKNOWN' THEN 1 WHEN 'RISKY' THEN 2 ELSE 3 END ASC,
                COALESCE(pa.intelligence_score, ((pa.success_count * 2) - (pa.fail_count * 3))) DESC,
                pa.last_success_at DESC,
                pa.id ASC
            {$forUpdate}
        ");
        $accountsStmt->execute([$platformId, $now]);
        $accounts = $accountsStmt->fetchAll();

        if (empty($accounts)) {
            $txnRollback();

            $cooldownCheck = $pdo->prepare("
                SELECT COUNT(*) FROM platform_accounts
                WHERE platform_id = ? AND is_active = 1 AND cooldown_until > ?
            ");
            $cooldownCheck->execute([$platformId, $now]);
            $inCooldown = (int)$cooldownCheck->fetchColumn();

            if ($inCooldown > 0) {
                jsonResponse(['success' => false, 'message' => 'All slots are temporarily cooling down after login failures. Please try again in a few minutes.', 'all_full' => true], 429);
            }

            jsonResponse(['success' => false, 'message' => 'No account slots configured for this platform. Please contact admin.'], 404);
        }

        $selectedAccount = null;
        $skippedReasons = [];
        foreach ($accounts as $acct) {
            if ($acct['expires_at']) {
                try {
                    if (new DateTime($acct['expires_at']) < new DateTime($now)) {
                        $skippedReasons[] = "Slot#{$acct['id']}({$acct['slot_name']}): expired";
                        continue;
                    }
                } catch (Exception $e) {
                    $skippedReasons[] = "Slot#{$acct['id']}({$acct['slot_name']}): invalid expiry date";
                    continue;
                }
            }

            $effectiveCookie = resolveAccountCookieData($acct);
            $validatedCookies = validateCookieData($effectiveCookie);
            if ($validatedCookies === false) {
                error_log("access_platform: Slot#{$acct['id']}({$acct['slot_name']}) has invalid/empty cookie_data, skipping");
                $skippedReasons[] = "Slot#{$acct['id']}({$acct['slot_name']}): invalid cookies";
                continue;
            }

            if ($acct['cookie_domain']) {
                $cookieDomainMatch = checkCookieDomainMatch($validatedCookies, $acct['cookie_domain']);
                if (!$cookieDomainMatch) {
                    error_log("access_platform: Slot#{$acct['id']}({$acct['slot_name']}) cookie domain mismatch with platform domain {$acct['cookie_domain']}");
                }
            }

            $cntStmt = $pdo->prepare("
                SELECT COUNT(*) FROM account_sessions
                WHERE account_id = ? AND status = 'active' AND last_active >= ?
            ");
            $cntStmt->execute([$acct['id'], $activeCutoff]);
            $activeCount = (int)$cntStmt->fetchColumn();

            if ($activeCount >= (int)$acct['max_users']) {
                $skippedReasons[] = "Slot#{$acct['id']}({$acct['slot_name']}): full ({$activeCount}/{$acct['max_users']})";
                continue;
            }

            $selectedAccount = $acct;
            $selectedAccount['active_count'] = $activeCount;
            $selectedAccount['effective_cookie'] = $effectiveCookie;

            $score = (int)($acct['slot_score'] ?? 0);
            error_log("access_platform: ASSIGNED Slot#{$acct['id']}({$acct['slot_name']}) to user#{$userId} | active={$activeCount}/{$acct['max_users']} | score={$score} | health={$acct['health_status']} | vault=" . ($acct['cookie_id'] ? 'yes' : 'legacy'));
            break;
        }

        if (!$selectedAccount) {
            $txnRollback();

            $hasExpired = false;
            $hasInvalidCookies = false;
            $allFull = true;
            foreach ($skippedReasons as $r) {
                if (strpos($r, 'expired') !== false) $hasExpired = true;
                if (strpos($r, 'invalid cookies') !== false) $hasInvalidCookies = true;
                if (strpos($r, 'full') === false && strpos($r, 'expired') === false && strpos($r, 'invalid') === false) $allFull = false;
            }

            if ($hasInvalidCookies && !$hasExpired) {
                $message = 'No valid cookies found in available slots. Please contact admin.';
            } elseif ($hasExpired) {
                $message = 'All account slots have expired. Please contact admin.';
            } else {
                $message = 'All slots are currently in use. Please try again later.';
            }

            error_log("access_platform: No slot available for user#{$userId} platform#{$platformId} | reasons: " . implode(', ', $skippedReasons));

            jsonResponse([
                'success' => false,
                'message' => $message,
                'all_full' => true,
            ], 429);
        }

        $pdo->prepare("DELETE FROM account_sessions WHERE user_id = ? AND platform_id = ? AND status = 'inactive'")->execute([$userId, $platformId]);

        $insertStmt = $pdo->prepare("
            INSERT INTO account_sessions (account_id, user_id, platform_id, status, device_type, last_active, created_at)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
        ");
        $insertStmt->execute([$selectedAccount['id'], $userId, $platformId, $deviceType, $now, $now]);

        $verifyStmt = $pdo->prepare("
            SELECT COUNT(*) FROM account_sessions
            WHERE account_id = ? AND status = 'active' AND last_active >= ?
        ");
        $verifyStmt->execute([$selectedAccount['id'], $activeCutoff]);
        $postInsertCount = (int)$verifyStmt->fetchColumn();

        if ($postInsertCount > (int)$selectedAccount['max_users']) {
            $txnRollback();
            error_log("access_platform: Race condition caught — post-insert count {$postInsertCount} > max {$selectedAccount['max_users']} for Slot#{$selectedAccount['id']}");
            jsonResponse([
                'success' => false,
                'message' => 'Slot capacity exceeded during assignment. Please try again.',
                'all_full' => true,
            ], 429);
        }

        $txnCommit();

        logActivity($userId, "platform_access: platform={$selectedAccount['platform_name']} account={$selectedAccount['slot_name']}", getClientIP());

        $response = buildCookieResponse(
            $selectedAccount['effective_cookie'],
            $selectedAccount['cookie_domain'],
            $selectedAccount['login_url'],
            $selectedAccount['platform_name'],
            $platformId,
            $selectedAccount['id']
        );

        if (!($response['success'] ?? false)) {
            error_log("access_platform: Slot#{$selectedAccount['id']} assigned but cookie response failed: " . ($response['message'] ?? 'unknown'));
            $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE user_id = ? AND platform_id = ? AND status = 'active'")->execute([$userId, $platformId]);
        }

        jsonResponse($response);

    } catch (Exception $e) {
        $txnRollback();
        error_log("access_platform SLOT_ERROR: " . $e->getMessage() . " in " . $e->getFile() . ":" . $e->getLine());
        jsonResponse(['success' => false, 'message' => 'Database transaction failed. Please try again shortly.'], 500);
    }
}

if ($method === 'GET') {
    $platformId = (int)($_GET['platform_id'] ?? 0);

    if ($platformId < 1) {
        jsonResponse(['success' => false, 'message' => 'Missing platform_id.'], 400);
    }

    cleanupStaleSessions($pdo);

    $now = date('Y-m-d H:i:s');
    $activeCutoff = date('Y-m-d H:i:s', strtotime('-' . SESSION_ACTIVE_WINDOW_MINUTES . ' minutes'));

    $stmt = $pdo->prepare("
        SELECT pa.id, pa.max_users, pa.expires_at, pa.is_active, pa.cookie_data,
               (SELECT COUNT(*) FROM account_sessions acs
                WHERE acs.account_id = pa.id AND acs.status = 'active' AND acs.last_active >= ?) AS active_count
        FROM platform_accounts pa
        WHERE pa.platform_id = ? AND pa.is_active = 1
    ");
    $stmt->execute([$activeCutoff, $platformId]);
    $accounts = $stmt->fetchAll();

    $totalCapacity = 0;
    $totalActive = 0;
    $hasValidAccount = false;
    foreach ($accounts as $a) {
        $hasCookie = !empty($a['cookie_data']) && $a['cookie_data'] !== '[]';
        $expired = false;
        if ($a['expires_at']) {
            try { $expired = new DateTime($a['expires_at']) < new DateTime($now); } catch (Exception $e) {}
        }
        if ($hasCookie && !$expired && validateCookieData($a['cookie_data']) !== false) {
            $hasValidAccount = true;
            $totalCapacity += (int)$a['max_users'];
            $totalActive += (int)$a['active_count'];
        }
    }

    jsonResponse([
        'success' => true,
        'platform_id' => $platformId,
        'total_capacity' => $totalCapacity,
        'total_active' => $totalActive,
        'available' => max(0, $totalCapacity - $totalActive),
        'has_accounts' => $hasValidAccount,
        'all_full' => $hasValidAccount && ($totalCapacity - $totalActive <= 0),
    ]);
}

jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);

function cleanupStaleSessions(PDO $pdo): void {
    $lockFile = sys_get_temp_dir() . '/clearorbit_cleanup_sessions.lock';
    if (file_exists($lockFile) && (time() - filemtime($lockFile)) < 60) return;
    @touch($lockFile);
    $cutoff = date('Y-m-d H:i:s', strtotime('-' . SESSION_STALE_MINUTES . ' minutes'));
    $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE status = 'active' AND last_active < ?")->execute([$cutoff]);
}

function validateCookieData(string $cookieData): mixed {
    $raw = trim($cookieData);
    if ($raw === '' || $raw === '[]' || $raw === 'null') {
        return false;
    }

    $decoded = @base64_decode($raw, true);
    if ($decoded !== false && strlen($decoded) > 2) {
        $raw = $decoded;
    }

    $json = @json_decode($raw, true);

    if (is_array($json) && !empty($json) && isset($json[0]['name'])) {
        $validCookies = array_filter($json, function($c) {
            return !empty($c['name']) && isset($c['value']);
        });
        return !empty($validCookies) ? $validCookies : false;
    }

    if (strlen($raw) > 3 && strpos($raw, '=') !== false) {
        return $raw;
    }

    return false;
}

function checkCookieDomainMatch(mixed $cookies, string $platformDomain): bool {
    if (!is_array($cookies)) return true;

    foreach ($cookies as $c) {
        if (!empty($c['domain'])) {
            $cookieDom = ltrim($c['domain'], '.');
            $platDom = ltrim($platformDomain, '.');
            if (str_ends_with($cookieDom, $platDom) || str_ends_with($platDom, $cookieDom)) {
                return true;
            }
        }
    }
    return false;
}

function buildCookieResponse(string $cookieData, ?string $domain, ?string $redirectUrl, string $platformName, int $platformId, int $accountId): array {
    if (!$domain || !$redirectUrl) {
        return ['success' => false, 'message' => 'Platform routing not configured. Contact admin.'];
    }

    $validated = validateCookieData($cookieData);
    if ($validated === false) {
        return ['success' => false, 'message' => 'No valid cookies configured for this slot. Contact admin.'];
    }

    $rawStored = $cookieData;
    $decoded = @base64_decode($rawStored, true);
    if ($decoded !== false && strlen($decoded) > 2) {
        $rawStored = $decoded;
    }

    $jsonCookies = @json_decode($rawStored, true);

    $responseBase = [
        'success' => true,
        'platform_id' => $platformId,
        'platform_name' => $platformName,
        'domain' => $domain,
        'redirect_url' => $redirectUrl,
        'account_id' => $accountId,
    ];

    if (is_array($jsonCookies) && !empty($jsonCookies) && isset($jsonCookies[0]['name'])) {
        $validCookies = [];
        foreach ($jsonCookies as $c) {
            if (empty($c['name']) || !isset($c['value'])) continue;
            if (empty($c['domain'])) $c['domain'] = $domain;
            $validCookies[] = $c;
        }

        if (empty($validCookies)) {
            return ['success' => false, 'message' => 'No valid cookies in this slot. Contact admin.'];
        }

        $flatParts = [];
        foreach ($validCookies as $c) {
            $flatParts[] = $c['name'] . '=' . $c['value'];
        }

        return array_merge($responseBase, [
            'cookie_string' => implode('; ', $flatParts),
            'cookies' => $validCookies,
            'format' => 'json',
            'count' => count($validCookies),
        ]);
    }

    return array_merge($responseBase, [
        'cookie_string' => $rawStored,
        'cookies' => null,
        'format' => 'plain',
        'count' => count(array_filter(array_map('trim', explode(';', $rawStored)))),
    ]);
}
