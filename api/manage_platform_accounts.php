<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

$pdo = getPDO();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $platformId = (int)($_GET['platform_id'] ?? 0);

    cleanupStaleSessions($pdo);
    autoValidateCookieStatuses($pdo);

    $now = date('Y-m-d H:i:s');
    $activeCutoff = date('Y-m-d H:i:s', strtotime('-5 minutes'));

    $where = $platformId > 0 ? "WHERE pa.platform_id = ?" : "";
    $params = $platformId > 0 ? [$activeCutoff, $platformId] : [$activeCutoff];

    $sql = "
        SELECT pa.id, pa.platform_id, pa.slot_name, pa.max_users, pa.cookie_count,
               pa.expires_at, pa.is_active, pa.created_at, pa.updated_at,
               pa.success_count, pa.fail_count, pa.health_status, pa.last_success_at, pa.last_failed_at, pa.cooldown_until,
               pa.cookie_status, pa.login_status, pa.last_verified_at,
               pa.intelligence_score, pa.stability_status, pa.last_intelligence_run,
               pa.cookie_id,
               ((pa.success_count * 2) - (pa.fail_count * 3)) AS slot_score,
               p.name AS platform_name,
               (SELECT COUNT(*) FROM account_sessions acs
                WHERE acs.account_id = pa.id AND acs.status = 'active' AND acs.last_active >= ?) AS active_users
        FROM platform_accounts pa
        INNER JOIN platforms p ON p.id = pa.platform_id
        {$where}
        ORDER BY pa.platform_id ASC, pa.id ASC
    ";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $accounts = $stmt->fetchAll();

    foreach ($accounts as &$acct) {
        $acct['active_users'] = (int)$acct['active_users'];
        $acct['available_slots'] = max(0, (int)$acct['max_users'] - $acct['active_users']);
        $acct['success_count'] = (int)($acct['success_count'] ?? 0);
        $acct['fail_count'] = (int)($acct['fail_count'] ?? 0);
        $acct['slot_score'] = (int)($acct['slot_score'] ?? 0);
        $acct['health_status'] = $acct['health_status'] ?? 'healthy';
        $acct['cookie_status'] = $acct['cookie_status'] ?? 'VALID';
        $acct['intelligence_score'] = (int)($acct['intelligence_score'] ?? 0);
        $acct['stability_status'] = $acct['stability_status'] ?? 'UNKNOWN';
        $expired = false;
        $daysRemaining = null;
        $expiryStatus = 'ACTIVE';
        if ($acct['expires_at']) {
            try {
                $expDt = new DateTime($acct['expires_at']);
                $nowDt = new DateTime($now);
                $expired = $expDt < $nowDt;
                if ($expired) {
                    $daysRemaining = 0;
                    $expiryStatus = 'EXPIRED';
                } else {
                    $diff = $nowDt->diff($expDt);
                    $daysRemaining = $diff->days;
                    $expiryStatus = $daysRemaining <= 3 ? 'EXPIRING_SOON' : 'ACTIVE';
                }
            } catch (Exception $e) {}
        }
        $acct['is_expired'] = $expired;
        $acct['days_remaining'] = $daysRemaining;
        $acct['expiry_status'] = $expiryStatus;
    }
    unset($acct);

    jsonResponse(['success' => true, 'accounts' => $accounts]);
}

if ($method === 'POST') {
    validateCsrfToken();

    $input = json_decode(file_get_contents('php://input'), true);
    $action = $input['action'] ?? 'create';

    if ($action === 'create') {
        $platformId = (int)($input['platform_id'] ?? 0);
        $slotName = trim($input['slot_name'] ?? '');
        $cookieData = trim($input['cookie_data'] ?? '');
        $maxUsers = max(1, min(50, (int)($input['max_users'] ?? 5)));
        $expiresAt = trim($input['expires_at'] ?? '');

        if ($platformId < 1) {
            jsonResponse(['success' => false, 'message' => 'Platform is required.'], 400);
        }

        $platform = $pdo->prepare("SELECT id, name, cookie_domain FROM platforms WHERE id = ?");
        $platform->execute([$platformId]);
        $platform = $platform->fetch();
        if (!$platform) {
            jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
        }

        if ($slotName === '') {
            $countStmt = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE platform_id = ?");
            $countStmt->execute([$platformId]);
            $num = (int)$countStmt->fetchColumn() + 1;
            $slotName = "Login {$num}";
        }

        $cookieCount = 0;
        $encodedCookie = '';
        if ($cookieData !== '') {
            $parsed = parseCookieInput($cookieData);
            if (!$parsed['valid']) {
                jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
            }
            $cookieCount = $parsed['count'];
            $normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
            $encodedCookie = base64_encode($normalizedJson);
        }

        $expiresVal = null;
        if ($expiresAt !== '') {
            try {
                $dt = new DateTime($expiresAt);
                $expiresVal = $dt->format('Y-m-d H:i:s');
            } catch (Exception $e) {
                jsonResponse(['success' => false, 'message' => 'Invalid expiry date format.'], 400);
            }
        }

        if ($expiresVal === null && $cookieData !== '' && isset($parsed) && !empty($parsed['earliest_expiry'])) {
            $expiresVal = $parsed['earliest_expiry'];
        }
        if ($expiresVal === null) {
            $platName = $platform['name'] ?? '';
            $expiresVal = computeFallbackExpiryForPlatform($platName);
        }

        $cookieStatus = 'VALID';
        if ($encodedCookie !== '') {
            $valResult = quickCookieValidation($encodedCookie, $expiresVal, $platformId);
            $cookieStatus = $valResult['cookie_status'];
        } else {
            $cookieStatus = 'DEAD';
        }

        $isActive = ($cookieStatus === 'EXPIRED' || $cookieStatus === 'DEAD') ? 0 : 1;

        $now = date('Y-m-d H:i:s');
        $vaultId = null;
        if ($encodedCookie !== '') {
            $accountFingerprint = isset($parsed) ? extractAccountFingerprint($parsed) : null;
            $countStmt2 = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE platform_id = ?");
            $countStmt2->execute([$platformId]);
            $slotNum = (int)$countStmt2->fetchColumn() + 1;
            $vaultId = upsertVaultCookie($pdo, $platformId, $encodedCookie, $cookieCount, $expiresVal, $accountFingerprint, $slotNum);
        }
        $stmt = $pdo->prepare("
            INSERT INTO platform_accounts (platform_id, slot_name, cookie_data, max_users, cookie_count, expires_at, is_active, cookie_status, created_at, updated_at, cookie_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([$platformId, $slotName, $encodedCookie, $maxUsers, $cookieCount, $expiresVal, $isActive, $cookieStatus, $now, $now, $vaultId]);
        $newId = $pdo->lastInsertId();

        logActivity($_SESSION['user_id'], "account_created: platform={$platform['name']} slot={$slotName} max_users={$maxUsers} cookie_status={$cookieStatus}", getClientIP());

        $warningMsg = '';
        if ($cookieStatus === 'DEAD') {
            $warningMsg = ' Warning: Cookie is invalid — slot created as disabled.';
        } elseif ($cookieStatus === 'EXPIRED') {
            $warningMsg = ' Warning: Cookie has expired — slot created as disabled.';
        } elseif ($cookieStatus === 'RISKY') {
            $warningMsg = ' Warning: Cookie flagged as risky — no recognized session token found.';
        }

        jsonResponse([
            'success' => true,
            'message' => "Account slot '{$slotName}' created for {$platform['name']}.{$warningMsg}",
            'account_id' => (int)$newId,
            'cookie_status' => $cookieStatus,
        ]);
    }

    if ($action === 'update') {
        $accountId = (int)($input['account_id'] ?? 0);
        if ($accountId < 1) {
            jsonResponse(['success' => false, 'message' => 'Account ID is required.'], 400);
        }

        $acct = $pdo->prepare("SELECT pa.*, p.name AS platform_name FROM platform_accounts pa JOIN platforms p ON p.id = pa.platform_id WHERE pa.id = ?");
        $acct->execute([$accountId]);
        $acct = $acct->fetch();
        if (!$acct) {
            jsonResponse(['success' => false, 'message' => 'Account not found.'], 404);
        }

        $slotName = trim($input['slot_name'] ?? $acct['slot_name']);
        $maxUsers = isset($input['max_users']) ? max(1, min(50, (int)$input['max_users'])) : (int)$acct['max_users'];
        $isActive = isset($input['is_active']) ? (int)(bool)$input['is_active'] : (int)$acct['is_active'];
        $cookieData = $input['cookie_data'] ?? null;
        $expiresAt = $input['expires_at'] ?? null;

        $cookieCount = (int)$acct['cookie_count'];
        $encodedCookie = $acct['cookie_data'];

        if ($cookieData !== null && trim($cookieData) !== '') {
            $parsed = parseCookieInput(trim($cookieData));
            if (!$parsed['valid']) {
                jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
            }
            $cookieCount = $parsed['count'];
            $normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
            $encodedCookie = base64_encode($normalizedJson);
        }

        $expiresVal = $acct['expires_at'];
        if ($expiresAt !== null && trim($expiresAt) !== '') {
            try {
                $dt = new DateTime(trim($expiresAt));
                $expiresVal = $dt->format('Y-m-d H:i:s');
            } catch (Exception $e) {}
        }

        $cookieStatus = $acct['cookie_status'] ?? 'VALID';
        if ($cookieData !== null && trim($cookieData) !== '') {
            $valResult = quickCookieValidation($encodedCookie, $expiresVal, (int)$acct['platform_id']);
            $cookieStatus = $valResult['cookie_status'];
        } elseif ($expiresAt !== null) {
            $valResult = quickCookieValidation($encodedCookie, $expiresVal, (int)$acct['platform_id']);
            $cookieStatus = $valResult['cookie_status'];
        }

        if ($cookieStatus === 'EXPIRED' || $cookieStatus === 'DEAD') {
            $isActive = 0;
        }

        $now = date('Y-m-d H:i:s');
        $vaultId = $acct['cookie_id'] ?? null;
        if ($cookieData !== null && trim($cookieData) !== '') {
            $accountFingerprint = isset($parsed) ? extractAccountFingerprint($parsed) : null;
            $slotNum = 1;
            if (!empty($acct['cookie_id'])) {
                $vaultSlot = $pdo->prepare("SELECT slot FROM cookie_vault WHERE id = ?");
                $vaultSlot->execute([$acct['cookie_id']]);
                $slotNum = (int)($vaultSlot->fetchColumn() ?: 1);
            }
            $vaultId = upsertVaultCookie($pdo, (int)$acct['platform_id'], $encodedCookie, $cookieCount, $expiresVal, $accountFingerprint, $slotNum);
        }

        $stmt = $pdo->prepare("
            UPDATE platform_accounts
            SET slot_name = ?, cookie_data = ?, max_users = ?, cookie_count = ?, expires_at = ?, is_active = ?, cookie_status = ?, updated_at = ?, cookie_id = ?
            WHERE id = ?
        ");
        $stmt->execute([$slotName, $encodedCookie, $maxUsers, $cookieCount, $expiresVal, $isActive, $cookieStatus, $now, $vaultId, $accountId]);

        if ($cookieStatus === 'EXPIRED' || $cookieStatus === 'DEAD') {
            $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")->execute([$accountId]);
        }

        if ($vaultId && ($cookieData !== null || $expiresAt !== null)) {
            updateVaultStatus($pdo, (int)$vaultId, $cookieStatus, null);
        }

        logActivity($_SESSION['user_id'], "account_updated: id={$accountId} platform={$acct['platform_name']} slot={$slotName} cookie_status={$cookieStatus}", getClientIP());

        $warningMsg = '';
        if ($cookieStatus === 'DEAD') {
            $warningMsg = ' Cookie is invalid — slot has been disabled.';
        } elseif ($cookieStatus === 'EXPIRED') {
            $warningMsg = ' Cookie has expired — slot has been disabled.';
        } elseif ($cookieStatus === 'RISKY') {
            $warningMsg = ' Cookie flagged as risky.';
        }

        jsonResponse([
            'success' => true,
            'message' => "Account slot '{$slotName}' updated.{$warningMsg}",
            'cookie_status' => $cookieStatus,
        ]);
    }

    if ($action === 'delete') {
        $accountId = (int)($input['account_id'] ?? 0);
        if ($accountId < 1) {
            jsonResponse(['success' => false, 'message' => 'Account ID is required.'], 400);
        }

        $acct = $pdo->prepare("SELECT pa.*, p.name AS platform_name FROM platform_accounts pa JOIN platforms p ON p.id = pa.platform_id WHERE pa.id = ?");
        $acct->execute([$accountId]);
        $acct = $acct->fetch();
        if (!$acct) {
            jsonResponse(['success' => false, 'message' => 'Account not found.'], 404);
        }

        $pdo->prepare("DELETE FROM account_sessions WHERE account_id = ?")->execute([$accountId]);
        $pdo->prepare("DELETE FROM platform_accounts WHERE id = ?")->execute([$accountId]);

        logActivity($_SESSION['user_id'], "account_deleted: id={$accountId} platform={$acct['platform_name']} slot={$acct['slot_name']}", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => "Account slot '{$acct['slot_name']}' deleted from {$acct['platform_name']}.",
        ]);
    }

    if ($action === 'delete_multiple') {
        $ids = $input['ids'] ?? [];
        if (!is_array($ids) || empty($ids)) {
            jsonResponse(['success' => false, 'message' => 'No slot IDs provided.'], 400);
        }
        $ids = array_map('intval', $ids);
        $ids = array_filter($ids, fn($id) => $id > 0);
        if (empty($ids)) {
            jsonResponse(['success' => false, 'message' => 'No valid slot IDs.'], 400);
        }

        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $pdo->prepare("DELETE FROM account_sessions WHERE account_id IN ({$placeholders})")->execute($ids);
        $pdo->prepare("DELETE FROM platform_accounts WHERE id IN ({$placeholders})")->execute($ids);

        $count = count($ids);
        logActivity($_SESSION['user_id'], "bulk_delete: {$count} slots deleted (ids: " . implode(',', $ids) . ")", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => "{$count} account slot(s) deleted.",
            'deleted_count' => $count,
        ]);
    }

    if ($action === 'delete_by_platform') {
        $platformId = (int)($input['platform_id'] ?? 0);
        if ($platformId < 1) {
            jsonResponse(['success' => false, 'message' => 'Platform ID is required.'], 400);
        }

        $plat = $pdo->prepare("SELECT name FROM platforms WHERE id = ?");
        $plat->execute([$platformId]);
        $platRow = $plat->fetch();
        if (!$platRow) {
            jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
        }

        $countStmt = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE platform_id = ?");
        $countStmt->execute([$platformId]);
        $slotCount = (int)$countStmt->fetchColumn();

        $pdo->prepare("DELETE FROM account_sessions WHERE account_id IN (SELECT id FROM platform_accounts WHERE platform_id = ?)")->execute([$platformId]);
        $pdo->prepare("DELETE FROM platform_accounts WHERE platform_id = ?")->execute([$platformId]);

        logActivity($_SESSION['user_id'], "delete_all_platform: platform={$platRow['name']} platform_id={$platformId} slots_deleted={$slotCount}", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => "All {$slotCount} slots deleted from {$platRow['name']}.",
            'deleted_count' => $slotCount,
            'platform_name' => $platRow['name'],
        ]);
    }

    if ($action === 'reset_stats') {
        $accountId = (int)($input['account_id'] ?? 0);
        if ($accountId < 1) {
            jsonResponse(['success' => false, 'message' => 'Account ID is required.'], 400);
        }

        $now = date('Y-m-d H:i:s');
        $pdo->prepare("
            UPDATE platform_accounts
            SET success_count = 0, fail_count = 0, health_status = 'healthy',
                last_success_at = NULL, last_failed_at = NULL, cooldown_until = NULL,
                cookie_status = 'VALID', is_active = 1, updated_at = ?
            WHERE id = ?
        ")->execute([$now, $accountId]);

        logActivity($_SESSION['user_id'], "slot_stats_reset: account_id={$accountId}", getClientIP());

        jsonResponse(['success' => true, 'message' => 'Slot statistics reset successfully.']);
    }

    if ($action === 'extend') {
        $accountId = (int)($input['account_id'] ?? 0);
        $days = (int)($input['days'] ?? 0);
        if ($accountId < 1) {
            jsonResponse(['success' => false, 'message' => 'Account ID is required.'], 400);
        }
        if ($days < 1 || $days > 365) {
            jsonResponse(['success' => false, 'message' => 'Days must be between 1 and 365.'], 400);
        }

        $acct = $pdo->prepare("SELECT pa.*, p.name AS platform_name FROM platform_accounts pa JOIN platforms p ON p.id = pa.platform_id WHERE pa.id = ?");
        $acct->execute([$accountId]);
        $acct = $acct->fetch();
        if (!$acct) {
            jsonResponse(['success' => false, 'message' => 'Account not found.'], 404);
        }

        $now = date('Y-m-d H:i:s');
        $baseDate = $acct['expires_at'] ?? $now;
        try {
            $base = new DateTime($baseDate);
            if ($base < new DateTime($now)) $base = new DateTime($now);
        } catch (Exception $e) {
            $base = new DateTime($now);
        }
        $base->modify("+{$days} days");
        $newExpiry = $base->format('Y-m-d H:i:s');

        $pdo->prepare("UPDATE platform_accounts SET expires_at = ?, is_active = 1, cookie_status = CASE WHEN cookie_status = 'EXPIRED' THEN 'VALID' ELSE cookie_status END, updated_at = ? WHERE id = ?")
            ->execute([$newExpiry, $now, $accountId]);

        syncCookieVaultExpiry($pdo, $accountId, $newExpiry, $now);

        logActivity($_SESSION['user_id'], "slot_extended: account_id={$accountId} platform={$acct['platform_name']} +{$days}d new_expiry={$newExpiry}", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => "Slot '{$acct['slot_name']}' extended by {$days} days. New expiry: {$newExpiry}",
            'new_expires_at' => $newExpiry,
        ]);
    }

    if ($action === 'extend_multiple') {
        $ids = $input['ids'] ?? [];
        $days = (int)($input['days'] ?? 0);
        if (!is_array($ids) || empty($ids)) {
            jsonResponse(['success' => false, 'message' => 'No slot IDs provided.'], 400);
        }
        if ($days < 1 || $days > 365) {
            jsonResponse(['success' => false, 'message' => 'Days must be between 1 and 365.'], 400);
        }

        $ids = array_map('intval', $ids);
        $ids = array_filter($ids, fn($id) => $id > 0);
        if (empty($ids)) {
            jsonResponse(['success' => false, 'message' => 'No valid slot IDs.'], 400);
        }

        $now = date('Y-m-d H:i:s');
        $extended = 0;

        foreach ($ids as $id) {
            $acct = $pdo->prepare("SELECT id, expires_at, platform_id, slot_name FROM platform_accounts WHERE id = ?");
            $acct->execute([$id]);
            $acct = $acct->fetch();
            if (!$acct) continue;

            $baseDate = $acct['expires_at'] ?? $now;
            try {
                $base = new DateTime($baseDate);
                if ($base < new DateTime($now)) $base = new DateTime($now);
            } catch (Exception $e) {
                $base = new DateTime($now);
            }
            $base->modify("+{$days} days");
            $newExpiry = $base->format('Y-m-d H:i:s');

            $pdo->prepare("UPDATE platform_accounts SET expires_at = ?, is_active = 1, cookie_status = CASE WHEN cookie_status = 'EXPIRED' THEN 'VALID' ELSE cookie_status END, updated_at = ? WHERE id = ?")
                ->execute([$newExpiry, $now, $id]);
            syncCookieVaultExpiry($pdo, $id, $newExpiry, $now);
            $extended++;
        }

        logActivity($_SESSION['user_id'], "bulk_extend: {$extended} slots +{$days}d (ids: " . implode(',', $ids) . ")", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => "{$extended} slot(s) extended by {$days} days.",
            'extended_count' => $extended,
        ]);
    }

    if ($action === 'get_settings') {
        jsonResponse([
            'success' => true,
            'default_expiry_days' => getDefaultExpiryDays(),
        ]);
    }

    if ($action === 'update_settings') {
        $defaultDays = (int)($input['default_expiry_days'] ?? 0);
        if ($defaultDays < 1 || $defaultDays > 365) {
            jsonResponse(['success' => false, 'message' => 'Default expiry must be between 1 and 365 days.'], 400);
        }
        setSiteSetting('default_expiry_days', (string)$defaultDays);
        logActivity($_SESSION['user_id'], "settings_updated: default_expiry_days={$defaultDays}", getClientIP());
        jsonResponse([
            'success' => true,
            'message' => "Default expiry updated to {$defaultDays} days.",
            'default_expiry_days' => $defaultDays,
        ]);
    }

    jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);
}

jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);

function cleanupStaleSessions(PDO $pdo): void {
    $lockFile = sys_get_temp_dir() . '/clearorbit_cleanup_sessions.lock';
    if (file_exists($lockFile) && (time() - filemtime($lockFile)) < 60) return;
    @touch($lockFile);
    $cutoff = date('Y-m-d H:i:s', strtotime('-10 minutes'));
    $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE status = 'active' AND last_active < ?")->execute([$cutoff]);
}

function parseCookieInput(string $raw): array {
    $raw = trim($raw);
    $jsonData = json_decode($raw, true);
    if (is_array($jsonData) && !empty($jsonData)) {
        if (isset($jsonData[0]) && is_array($jsonData[0])) {
            return validateJsonCookies($jsonData);
        }
        if (isset($jsonData['name']) && isset($jsonData['value'])) {
            return validateJsonCookies([$jsonData]);
        }
    }
    return parsePlainCookieString($raw);
}

function validateJsonCookies(array $cookies): array {
    $valid = [];
    $errors = [];
    $earliestExpiry = null;

    foreach ($cookies as $i => $cookie) {
        if (!is_array($cookie)) { $errors[] = "Cookie #" . ($i + 1) . ": not an object"; continue; }
        $name = trim($cookie['name'] ?? '');
        if ($name === '') { $errors[] = "Cookie #" . ($i + 1) . ": missing 'name'"; continue; }

        $rawSameSite = $cookie['sameSite'] ?? 'lax';
        $sameSite = 'lax';
        if ($rawSameSite !== null) {
            $v = strtolower(trim((string)$rawSameSite));
            if ($v === 'no_restriction' || $v === 'none') $sameSite = 'none';
            elseif (in_array($v, ['strict', 'lax', 'unspecified'], true)) $sameSite = $v;
        }

        $normalized = [
            'name' => $name, 'value' => (string)($cookie['value'] ?? ''),
            'domain' => $cookie['domain'] ?? null, 'path' => $cookie['path'] ?? '/',
            'secure' => (bool)($cookie['secure'] ?? true), 'httpOnly' => (bool)($cookie['httpOnly'] ?? true),
            'sameSite' => $sameSite,
        ];
        if (isset($cookie['expirationDate']) && is_numeric($cookie['expirationDate'])) {
            $normalized['expirationDate'] = (int)$cookie['expirationDate'];
            $expDt = date('Y-m-d H:i:s', (int)$cookie['expirationDate']);
            if ($earliestExpiry === null || $expDt < $earliestExpiry) $earliestExpiry = $expDt;
        }
        $valid[] = $normalized;
    }
    if (empty($valid)) return ['valid' => false, 'error' => 'No valid cookies found. ' . implode('; ', $errors)];
    return ['valid' => true, 'cookies' => $valid, 'count' => count($valid), 'earliest_expiry' => $earliestExpiry];
}

function autoValidateCookieStatuses(PDO $pdo): void {
    $lockFile = sys_get_temp_dir() . '/clearorbit_validate_cookies.lock';
    if (file_exists($lockFile) && (time() - filemtime($lockFile)) < 120) return;
    @touch($lockFile);
    $now = date('Y-m-d H:i:s');

    $expired = $pdo->prepare("
        SELECT id FROM platform_accounts
        WHERE expires_at IS NOT NULL AND expires_at != '' AND expires_at < ? AND cookie_status != 'EXPIRED'
    ");
    $expired->execute([$now]);
    $expiredIds = $expired->fetchAll(PDO::FETCH_COLUMN);

    if (!empty($expiredIds)) {
        $placeholders = implode(',', array_fill(0, count($expiredIds), '?'));
        $pdo->prepare("UPDATE platform_accounts SET cookie_status = 'EXPIRED', is_active = 0, updated_at = ? WHERE id IN ({$placeholders})")
            ->execute(array_merge([$now], $expiredIds));
        $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id IN ({$placeholders}) AND status = 'active'")
            ->execute($expiredIds);
    }

    $emptyCookies = $pdo->prepare("
        SELECT id FROM platform_accounts
        WHERE (cookie_data IS NULL OR cookie_data = '' OR cookie_data = '[]') AND cookie_status != 'DEAD'
    ");
    $emptyCookies->execute();
    $emptyIds = $emptyCookies->fetchAll(PDO::FETCH_COLUMN);

    if (!empty($emptyIds)) {
        $placeholders = implode(',', array_fill(0, count($emptyIds), '?'));
        $pdo->prepare("UPDATE platform_accounts SET cookie_status = 'DEAD', is_active = 0, updated_at = ? WHERE id IN ({$placeholders})")
            ->execute(array_merge([$now], $emptyIds));
    }
}

function quickCookieValidation(string $cookieData, ?string $expiresAt, int $platformId): array {
    $cookieData = trim($cookieData);
    if ($cookieData === '' || $cookieData === '[]' || $cookieData === 'null') {
        return ['cookie_status' => 'DEAD', 'reason' => 'Empty cookie data'];
    }

    $raw = $cookieData;
    $decoded = @base64_decode($raw, true);
    if ($decoded !== false && strlen($decoded) > 2) {
        $raw = $decoded;
    }

    $json = @json_decode($raw, true);

    if (is_array($json) && !empty($json)) {
        $cookies = isset($json[0]) ? $json : [$json];
        $validCookies = array_filter($cookies, function($c) {
            return !empty($c['name']) && isset($c['value']) && trim($c['value']) !== '';
        });
        if (empty($validCookies)) {
            return ['cookie_status' => 'DEAD', 'reason' => 'No valid cookie values'];
        }

        $now = time();
        $hasExpiredCookie = false;
        $allExpired = true;
        foreach ($validCookies as $c) {
            if (isset($c['expirationDate']) && is_numeric($c['expirationDate'])) {
                if ((int)$c['expirationDate'] < $now) {
                    $hasExpiredCookie = true;
                } else {
                    $allExpired = false;
                }
            } else {
                $allExpired = false;
            }
        }
        if ($allExpired && $hasExpiredCookie) {
            return ['cookie_status' => 'EXPIRED', 'reason' => 'All cookies expired'];
        }

        $sessionTokens = ['netflixid', 'securenetflixid', 'sp_dc', 'sp_key', 'disney_token', 'dss_id',
            '__secure-next-auth.session-token', 'session_token', 'sessionid', 'auth_token', 'access_token',
            'user_id', 'uid', 'account_id', 'login_token', 'cf_clearance', 'connect.sid',
            'laravel_session', 'phpsessid', 'canva_session', 'chatgpt_session', 'li_at', 'udemy_session', 'cauth', 'maestro_login'];

        $hasSession = false;
        foreach ($validCookies as $c) {
            if (in_array(strtolower($c['name'] ?? ''), $sessionTokens, true)) {
                $hasSession = true;
                break;
            }
        }

        if (!$hasSession) {
            return ['cookie_status' => 'RISKY', 'reason' => 'No recognized session token'];
        }

        if ($hasExpiredCookie) {
            return ['cookie_status' => 'RISKY', 'reason' => 'Some cookies expired'];
        }
    } elseif (strlen($raw) > 3 && strpos($raw, '=') !== false) {
        $pairs = array_filter(array_map('trim', explode(';', $raw)));
        $skipKeys = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'];
        $validPairs = [];
        foreach ($pairs as $pair) {
            $eqPos = strpos($pair, '=');
            if ($eqPos === false || $eqPos < 1) continue;
            $name = trim(substr($pair, 0, $eqPos));
            if (!in_array(strtolower($name), $skipKeys, true)) {
                $validPairs[] = strtolower($name);
            }
        }
        if (empty($validPairs)) {
            return ['cookie_status' => 'DEAD', 'reason' => 'No valid cookie pairs'];
        }

        $hasSession = false;
        foreach ($validPairs as $name) {
            if (in_array($name, $sessionTokens, true)) {
                $hasSession = true;
                break;
            }
        }
        if (!$hasSession) {
            return ['cookie_status' => 'RISKY', 'reason' => 'No recognized session token in plain string'];
        }
    } else {
        return ['cookie_status' => 'DEAD', 'reason' => 'Invalid format'];
    }

    if (!empty($expiresAt)) {
        try {
            $expiryDt = new DateTime($expiresAt);
            $nowDt = new DateTime();
            if ($expiryDt < $nowDt) {
                return ['cookie_status' => 'EXPIRED', 'reason' => 'Slot expiry date passed'];
            }
            $daysLeft = (int)$nowDt->diff($expiryDt)->days;
            if ($daysLeft <= 2) {
                return ['cookie_status' => 'RISKY', 'reason' => "Expires in {$daysLeft} day(s)"];
            }
        } catch (Exception $e) {}
    }

    return ['cookie_status' => 'VALID', 'reason' => 'All checks passed'];
}

function parsePlainCookieString(string $raw): array {
    $cookies = [];
    $pairs = array_filter(array_map('trim', explode(';', $raw)));
    $skip = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'];
    foreach ($pairs as $pair) {
        $eqPos = strpos($pair, '=');
        if ($eqPos === false || $eqPos < 1) continue;
        $name = trim(substr($pair, 0, $eqPos));
        $value = trim(substr($pair, $eqPos + 1));
        if (in_array(strtolower($name), $skip, true)) continue;
        $cookies[] = ['name' => $name, 'value' => $value, 'domain' => null, 'path' => '/', 'secure' => true, 'httpOnly' => true, 'sameSite' => 'lax'];
    }
    if (empty($cookies)) return ['valid' => false, 'error' => 'No valid cookie pairs found.'];
    return ['valid' => true, 'cookies' => $cookies, 'count' => count($cookies), 'earliest_expiry' => null];
}

function computeFallbackExpiryForPlatform(string $platformName): string {
    $knownPlatforms = [
        'netflix' => 30, 'chatgpt' => 30, 'openai' => 30, 'coursera' => 30,
        'spotify' => 30, 'disney' => 30, 'disneyplus' => 30, 'hbo' => 30,
        'hulu' => 30, 'amazon' => 30, 'prime' => 30, 'youtube' => 30,
        'linkedin' => 30, 'canva' => 30, 'grammarly' => 30,
    ];
    $lower = strtolower(trim($platformName));
    foreach ($knownPlatforms as $key => $days) {
        if (str_contains($lower, $key)) {
            return date('Y-m-d H:i:s', strtotime("+{$days} days"));
        }
    }
    $defaultDays = getDefaultExpiryDays();
    return date('Y-m-d H:i:s', strtotime("+{$defaultDays} days"));
}

function syncCookieVaultExpiry(PDO $pdo, int $accountId, string $newExpiry, string $now): void {
    $acct = $pdo->prepare("SELECT platform_id, cookie_id FROM platform_accounts WHERE id = ?");
    $acct->execute([$accountId]);
    $row = $acct->fetch();
    if (!$row) return;
    if (!empty($row['cookie_id'])) {
        $pdo->prepare("UPDATE cookie_vault SET expires_at = ?, updated_at = ? WHERE id = ?")->execute([$newExpiry, $now, $row['cookie_id']]);
    } else {
        $platformId = (int)$row['platform_id'];
        $pdo->prepare("UPDATE cookie_vault SET expires_at = ?, updated_at = ? WHERE platform_id = ?")->execute([$newExpiry, $now, $platformId]);
    }
}
