<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/LoginVerifier.php';

session_start();
checkAdminAccess('super_admin');

$pdo = getPDO();
$method = $_SERVER['REQUEST_METHOD'];

if ($method !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$action = $input['action'] ?? '';

if ($action === 'detect') {
    $cookieString = trim($input['cookie_string'] ?? '');
    if ($cookieString === '') {
        jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
    }

    $parsed = parseCookieInput($cookieString);
    if (!$parsed['valid']) {
        jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
    }

    $domains = extractDomainsFromCookies($parsed, $cookieString);
    $platformResult = resolvePlatform($pdo, $domains);
    $fingerprint = extractAccountFingerprint($parsed);
    $maxStreams = detectMaxStreams($parsed, $cookieString);

    $existingSlots = 0;
    if ($platformResult['found'] && !empty($fingerprint)) {
        $chk = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts pa
            JOIN cookie_vault cv ON cv.id = pa.cookie_id
            WHERE pa.platform_id = ? AND cv.fingerprint = ?");
        $chk->execute([$platformResult['id'], $fingerprint]);
        $existingSlots = (int)$chk->fetchColumn();
    }

    jsonResponse([
        'success' => true,
        'cookie_count' => $parsed['count'],
        'format' => $parsed['format'] ?? 'unknown',
        'domains' => $domains,
        'platform_detected' => $platformResult['found'],
        'platform_id' => $platformResult['id'],
        'platform_name' => $platformResult['name'],
        'platform_would_create' => $platformResult['would_create'],
        'max_streams' => $maxStreams,
        'earliest_expiry' => $parsed['earliest_expiry'] ?? null,
        'fingerprint' => $fingerprint ? substr($fingerprint, 0, 12) . '...' : null,
        'existing_slots' => $existingSlots,
    ]);
}

if ($action === 'setup') {
    $cookieString = trim($input['cookie_string'] ?? '');
    $requestedSlots = max(1, min(20, (int)($input['slot_count'] ?? 1)));
    $maxUsersPerSlot = max(1, min(50, (int)($input['max_users'] ?? 1)));

    if ($cookieString === '') {
        jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
    }

    $parsed = parseCookieInput($cookieString);
    if (!$parsed['valid']) {
        jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
    }

    $domains = extractDomainsFromCookies($parsed, $cookieString);
    $fingerprint = extractAccountFingerprint($parsed);
    $cookieCount = $parsed['count'];
    $normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
    $encodedCookie = base64_encode($normalizedJson);

    $expiresVal = $parsed['earliest_expiry'] ?? null;
    $now = date('Y-m-d H:i:s');

    try {
        $pdo->beginTransaction();

        $platformResult = resolvePlatform($pdo, $domains);
        $platformId = 0;
        $platformName = '';
        $platformCreated = false;

        if ($platformResult['found']) {
            $platformId = $platformResult['id'];
            $platformName = $platformResult['name'];
        } elseif ($platformResult['would_create']) {
            $meta = $platformResult['create_meta'];
            $existCheck = $pdo->prepare("SELECT id, name FROM platforms WHERE cookie_domain = ? OR name = ? LIMIT 1");
            $existCheck->execute([$meta['cookie_domain'], $meta['name']]);
            $existing = $existCheck->fetch();
            if ($existing) {
                $platformId = (int)$existing['id'];
                $platformName = $existing['name'];
            } else {
                $stmt = $pdo->prepare("INSERT INTO platforms (name, logo_url, bg_color_hex, is_active, cookie_domain, login_url, max_slots_per_cookie) VALUES (?, ?, ?, 1, ?, ?, 5)");
                $stmt->execute([$meta['name'], $meta['logo_url'], $meta['color'], $meta['cookie_domain'], $meta['login_url']]);
                $platformId = (int)$pdo->lastInsertId();
                $platformName = $meta['name'];
                $platformCreated = true;
            }
        } else {
            $pdo->rollBack();
            jsonResponse(['success' => false, 'message' => 'Could not detect platform. Please add the platform manually first.'], 400);
        }

        if ($expiresVal === null) {
            $expiresVal = computeFallbackExpiry($platformName);
        }

        if (!empty($expiresVal)) {
            try {
                if (new DateTime($expiresVal) < new DateTime($now)) {
                    $pdo->rollBack();
                    jsonResponse(['success' => false, 'message' => "Cookie has already expired ({$expiresVal}). Cannot create slots."], 400);
                }
            } catch (Exception $e) {}
        }

        $platformDomain = '';
        $domStmt = $pdo->prepare("SELECT cookie_domain FROM platforms WHERE id = ?");
        $domStmt->execute([$platformId]);
        $domRow = $domStmt->fetch();
        $platformDomain = $domRow['cookie_domain'] ?? '';

        $loginVerification = null;
        $loginScore = 0;
        $normalizedPlatDomain = strtolower(trim($platformDomain, '.'));
        $supportedVerifyDomains = ['netflix.com'];

        if (!empty($platformDomain) && in_array($normalizedPlatDomain, $supportedVerifyDomains)) {
            $loginVerification = LoginVerifier::verify($encodedCookie, $platformDomain);
            if ($loginVerification['login_status'] === 'VALID') {
                $loginScore = 100;
            } elseif ($loginVerification['login_status'] === 'PARTIAL') {
                $loginScore = 50;
            } else {
                $loginScore = -100;
                $pdo->rollBack();
                $reason = $loginVerification['reason'] ?? 'Unknown';
                logActivity($_SESSION['user_id'], "am_setup_rejected: platform={$platformName} reason={$reason}", getClientIP());
                jsonResponse([
                    'success' => false,
                    'message' => "Login verification failed — cookies are not working. {$reason}",
                    'login_status' => 'INVALID',
                    'login_score' => $loginScore,
                ], 400);
            }
        }

        $loginStatusVal = $loginVerification ? $loginVerification['login_status'] : 'PENDING';
        $verifiedAt = $loginVerification ? $loginVerification['verified_at'] : null;
        $verifyProof = $loginVerification ? json_encode($loginVerification) : null;

        $existingAccount = null;
        if (!empty($fingerprint)) {
            $fpCheck = $pdo->prepare("SELECT pa.id, pa.slot_name, pa.cookie_id FROM platform_accounts pa
                JOIN cookie_vault cv ON cv.id = pa.cookie_id
                WHERE pa.platform_id = ? AND cv.fingerprint = ? LIMIT 1");
            $fpCheck->execute([$platformId, $fingerprint]);
            $existingAccount = $fpCheck->fetch() ?: null;
        }

        $slotsCreated = 0;
        $slotsUpdated = 0;

        if ($existingAccount) {
            $vaultId = upsertVaultCookieV2($pdo, $platformId, $encodedCookie, $cookieCount, $expiresVal, $fingerprint, $loginStatusVal, $verifiedAt, $verifyProof);
            $pdo->prepare("UPDATE platform_accounts SET cookie_count = ?, expires_at = ?, updated_at = ?, login_status = ?, last_verified_at = ?, cookie_id = ? WHERE id = ?")
                ->execute([$cookieCount, $expiresVal, $now, $loginStatusVal, $verifiedAt, $vaultId, $existingAccount['id']]);
            $slotsUpdated = 1;
        } else {
            $vaultId = upsertVaultCookieV2($pdo, $platformId, $encodedCookie, $cookieCount, $expiresVal, $fingerprint, $loginStatusVal, $verifiedAt, $verifyProof);

            $cntS = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE platform_id = ?");
            $cntS->execute([$platformId]);
            $currentSlotCount = (int)$cntS->fetchColumn();

            $platRow = $pdo->prepare("SELECT max_slots_per_cookie FROM platforms WHERE id = ?");
            $platRow->execute([$platformId]);
            $maxSlotsPer = (int)($platRow->fetchColumn() ?: 5);

            $actualSlots = min($requestedSlots, $maxSlotsPer);

            for ($i = 1; $i <= $actualSlots; $i++) {
                $slotNum = $currentSlotCount + $i;
                $slotName = "Slot {$slotNum}";
                $valResult = quickCookieValidation($encodedCookie, $expiresVal, $platformId);
                $cookieStatus = $valResult['cookie_status'];
                $isActive = ($cookieStatus === 'EXPIRED' || $cookieStatus === 'DEAD') ? 0 : 1;

                $ins = $pdo->prepare("INSERT INTO platform_accounts (platform_id, slot_name, cookie_data, max_users, cookie_count, expires_at, is_active, cookie_status, created_at, updated_at, login_status, last_verified_at, cookie_id, profile_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                $ins->execute([$platformId, $slotName, $encodedCookie, $maxUsersPerSlot, $cookieCount, $expiresVal, $isActive, $cookieStatus, $now, $now, $loginStatusVal, $verifiedAt, $vaultId, $i]);
                $slotsCreated++;
            }
        }

        $pdo->commit();

        $expiryDays = null;
        if ($expiresVal) {
            try { $expiryDays = (new DateTime())->diff(new DateTime($expiresVal))->days; } catch (Exception $e) {}
        }

        logActivity($_SESSION['user_id'], "am_setup: platform={$platformName} slots_created={$slotsCreated} slots_updated={$slotsUpdated}", getClientIP());

        jsonResponse([
            'success' => true,
            'message' => $slotsUpdated > 0
                ? "{$platformName}: Cookie refreshed on existing account."
                : "{$platformName}: {$slotsCreated} slot(s) created successfully.",
            'platform_name' => $platformName,
            'platform_id' => $platformId,
            'platform_created' => $platformCreated,
            'slots_created' => $slotsCreated,
            'slots_updated' => $slotsUpdated,
            'cookie_count' => $cookieCount,
            'expires_at' => $expiresVal,
            'expiry_days_remaining' => $expiryDays,
            'login_status' => $loginStatusVal,
            'login_score' => $loginScore,
            'login_verified' => $loginVerification !== null,
        ]);

    } catch (Exception $e) {
        try { $pdo->rollBack(); } catch (Exception $ignored) {}
        error_log("account_manager setup error: " . $e->getMessage());
        jsonResponse(['success' => false, 'message' => 'Setup failed. Please try again.'], 500);
    }
}

if ($action === 'replace_cookie') {
    $accountId = (int)($input['account_id'] ?? 0);
    $cookieString = trim($input['cookie_string'] ?? '');

    if ($accountId < 1) {
        jsonResponse(['success' => false, 'message' => 'Account ID is required.'], 400);
    }
    if ($cookieString === '') {
        jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
    }

    $acct = $pdo->prepare("SELECT pa.*, p.name AS platform_name, p.cookie_domain FROM platform_accounts pa JOIN platforms p ON p.id = pa.platform_id WHERE pa.id = ?");
    $acct->execute([$accountId]);
    $acct = $acct->fetch();
    if (!$acct) {
        jsonResponse(['success' => false, 'message' => 'Slot not found.'], 404);
    }

    $parsed = parseCookieInput($cookieString);
    if (!$parsed['valid']) {
        jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
    }

    $cookieCount = $parsed['count'];
    $normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
    $encodedCookie = base64_encode($normalizedJson);
    $expiresVal = $parsed['earliest_expiry'] ?? $acct['expires_at'];
    $fingerprint = extractAccountFingerprint($parsed);
    $now = date('Y-m-d H:i:s');

    $loginVerification = null;
    $loginScore = 0;
    $platformDomain = $acct['cookie_domain'] ?? '';
    $normalizedPlatDomain = strtolower(trim($platformDomain, '.'));
    $supportedVerifyDomains = ['netflix.com'];

    if (!empty($platformDomain) && in_array($normalizedPlatDomain, $supportedVerifyDomains)) {
        $loginVerification = LoginVerifier::verify($encodedCookie, $platformDomain);
        $loginScore = $loginVerification['login_status'] === 'VALID' ? 100 : ($loginVerification['login_status'] === 'PARTIAL' ? 50 : -100);
        if ($loginVerification['login_status'] === 'INVALID') {
            jsonResponse([
                'success' => false,
                'message' => 'New cookie failed login verification: ' . ($loginVerification['reason'] ?? 'Unknown'),
                'login_status' => 'INVALID',
            ], 400);
        }
    }

    $loginStatusVal = $loginVerification ? $loginVerification['login_status'] : 'PENDING';
    $verifiedAt = $loginVerification ? $loginVerification['verified_at'] : null;
    $verifyProof = $loginVerification ? json_encode($loginVerification) : null;

    $valResult = quickCookieValidation($encodedCookie, $expiresVal, (int)$acct['platform_id']);
    $cookieStatus = $valResult['cookie_status'];
    $isActive = ($cookieStatus === 'EXPIRED' || $cookieStatus === 'DEAD') ? 0 : 1;

    $vaultId = $acct['cookie_id'] ?? null;
    if ($vaultId) {
        $pdo->prepare("UPDATE cookie_vault SET cookie_string = ?, cookie_count = ?, expires_at = ?, updated_at = ?, fingerprint = ?, cookie_status = ?, login_status = ?, verified_at = ?, verify_proof = ?, verification_status = ?, pool_type = 'active' WHERE id = ?")
            ->execute([$encodedCookie, $cookieCount, $expiresVal, $now, $fingerprint, $cookieStatus, $loginStatusVal, $verifiedAt, $verifyProof, $loginStatusVal, $vaultId]);

        $pdo->prepare("UPDATE platform_accounts SET cookie_data = ?, cookie_count = ?, expires_at = ?, updated_at = ?, cookie_status = ?, is_active = ?, login_status = ?, last_verified_at = ? WHERE cookie_id = ?")
            ->execute([$encodedCookie, $cookieCount, $expiresVal, $now, $cookieStatus, $isActive, $loginStatusVal, $verifiedAt, $vaultId]);
    } else {
        $vaultId = upsertVaultCookieV2($pdo, (int)$acct['platform_id'], $encodedCookie, $cookieCount, $expiresVal, $fingerprint, $loginStatusVal, $verifiedAt, $verifyProof);
        $pdo->prepare("UPDATE platform_accounts SET cookie_data = ?, cookie_count = ?, expires_at = ?, updated_at = ?, cookie_status = ?, is_active = ?, login_status = ?, last_verified_at = ?, cookie_id = ? WHERE id = ?")
            ->execute([$encodedCookie, $cookieCount, $expiresVal, $now, $cookieStatus, $isActive, $loginStatusVal, $verifiedAt, $vaultId, $accountId]);
    }

    $cntCasc = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE cookie_id = ?");
    $cntCasc->execute([$vaultId]);
    $cascadeCount = (int)$cntCasc->fetchColumn();

    logActivity($_SESSION['user_id'], "am_replace_cookie: slot_id={$accountId} platform={$acct['platform_name']} cascaded_to={$cascadeCount}_slots", getClientIP());

    jsonResponse([
        'success' => true,
        'message' => "Cookie replaced successfully on {$acct['platform_name']}. Updated {$cascadeCount} linked slot(s). Login: {$loginStatusVal}.",
        'cookie_status' => $cookieStatus,
        'login_status' => $loginStatusVal,
        'cascaded_slots' => $cascadeCount,
        'expires_at' => $expiresVal,
    ]);
}

if ($action === 'verify_slot') {
    $accountId = (int)($input['account_id'] ?? 0);
    if ($accountId < 1) {
        jsonResponse(['success' => false, 'message' => 'Account ID is required.'], 400);
    }

    $acct = $pdo->prepare("SELECT pa.*, p.name AS platform_name, p.cookie_domain FROM platform_accounts pa JOIN platforms p ON p.id = pa.platform_id WHERE pa.id = ?");
    $acct->execute([$accountId]);
    $acct = $acct->fetch();
    if (!$acct) {
        jsonResponse(['success' => false, 'message' => 'Slot not found.'], 404);
    }

    $cookieData = $acct['cookie_data'] ?? '';
    if ($acct['cookie_id']) {
        $vaultRow = $pdo->prepare("SELECT cookie_string FROM cookie_vault WHERE id = ?");
        $vaultRow->execute([$acct['cookie_id']]);
        $vRow = $vaultRow->fetch();
        if ($vRow && $vRow['cookie_string']) {
            $cookieData = $vRow['cookie_string'];
        }
    }

    if (empty($cookieData)) {
        jsonResponse(['success' => false, 'message' => 'No cookie data found for this slot.'], 400);
    }

    $platformDomain = $acct['cookie_domain'] ?? '';
    $normalizedPlatDomain = strtolower(trim($platformDomain, '.'));
    $supportedVerifyDomains = ['netflix.com'];
    $now = date('Y-m-d H:i:s');

    if (empty($platformDomain) || !in_array($normalizedPlatDomain, $supportedVerifyDomains)) {
        $valResult = quickCookieValidation($cookieData, $acct['expires_at'], (int)$acct['platform_id']);
        $cookieStatus = $valResult['cookie_status'];
        $pdo->prepare("UPDATE platform_accounts SET cookie_status = ?, last_verified_at = ?, updated_at = ? WHERE id = ?")
            ->execute([$cookieStatus, $now, $now, $accountId]);
        if ($acct['cookie_id']) {
            $pdo->prepare("UPDATE cookie_vault SET cookie_status = ?, verified_at = ? WHERE id = ?")
                ->execute([$cookieStatus, $now, $acct['cookie_id']]);
        }
        jsonResponse([
            'success' => true,
            'message' => "Static check complete: {$cookieStatus}",
            'cookie_status' => $cookieStatus,
            'login_status' => 'PENDING',
            'reason' => $valResult['reason'] ?? 'Static validation only',
            'verified_via' => 'static',
        ]);
    }

    $loginVerification = LoginVerifier::verify($cookieData, $platformDomain);
    $loginStatus = $loginVerification['login_status'];
    $reason = $loginVerification['reason'] ?? '';
    $verifyProof = json_encode($loginVerification);

    $cookieStatus = $loginStatus === 'VALID' ? 'VALID' : ($loginStatus === 'PARTIAL' ? 'RISKY' : 'DEAD');
    $isActive = $cookieStatus === 'DEAD' ? 0 : 1;

    $pdo->prepare("UPDATE platform_accounts SET cookie_status = ?, login_status = ?, last_verified_at = ?, is_active = ?, updated_at = ? WHERE id = ?")
        ->execute([$cookieStatus, $loginStatus, $now, $isActive, $now, $accountId]);

    if ($acct['cookie_id']) {
        $pdo->prepare("UPDATE cookie_vault SET cookie_status = ?, login_status = ?, verified_at = ?, verify_proof = ?, verification_status = ?, updated_at = ? WHERE id = ?")
            ->execute([$cookieStatus, $loginStatus, $now, $verifyProof, $loginStatus, $now, $acct['cookie_id']]);
    }

    if ($cookieStatus === 'DEAD') {
        $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")->execute([$accountId]);
        tryFailover($pdo, (int)$acct['platform_id']);
    }

    logActivity($_SESSION['user_id'], "am_verify_slot: slot_id={$accountId} platform={$acct['platform_name']} result={$loginStatus}", getClientIP());

    jsonResponse([
        'success' => true,
        'message' => "Verification complete: {$loginStatus} — {$reason}",
        'cookie_status' => $cookieStatus,
        'login_status' => $loginStatus,
        'reason' => $reason,
        'verified_via' => 'live_curl',
    ]);
}

if ($action === 'failover') {
    $platformId = (int)($input['platform_id'] ?? 0);
    if ($platformId < 1) {
        jsonResponse(['success' => false, 'message' => 'Platform ID is required.'], 400);
    }
    $result = tryFailover($pdo, $platformId);
    jsonResponse($result);
}

if ($action === 'list') {
    $platformId = (int)($input['platform_id'] ?? 0);
    $now = date('Y-m-d H:i:s');
    $activeCutoff = date('Y-m-d H:i:s', strtotime('-5 minutes'));

    $where = $platformId > 0 ? 'WHERE pa.platform_id = ?' : '';
    $params = $platformId > 0 ? [$activeCutoff, $platformId] : [$activeCutoff];

    $sql = "SELECT pa.id, pa.platform_id, pa.slot_name, pa.max_users, pa.cookie_count,
               pa.expires_at, pa.is_active, pa.created_at, pa.updated_at,
               pa.success_count, pa.fail_count, pa.health_status, pa.last_success_at,
               pa.cookie_status, pa.login_status, pa.last_verified_at,
               pa.intelligence_score, pa.stability_status, pa.cookie_id, pa.profile_index,
               ((pa.success_count * 2) - (pa.fail_count * 3)) AS slot_score,
               p.name AS platform_name, p.max_slots_per_cookie,
               cv.pool_type, cv.verified_at AS vault_verified_at, cv.verification_status,
               (SELECT COUNT(*) FROM account_sessions acs
                WHERE acs.account_id = pa.id AND acs.status = 'active' AND acs.last_active >= ?) AS active_users
        FROM platform_accounts pa
        INNER JOIN platforms p ON p.id = pa.platform_id
        LEFT JOIN cookie_vault cv ON cv.id = pa.cookie_id
        {$where}
        ORDER BY pa.platform_id ASC, pa.id ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $accounts = $stmt->fetchAll();

    foreach ($accounts as &$a) {
        $a['active_users'] = (int)$a['active_users'];
        $a['available_slots'] = max(0, (int)$a['max_users'] - $a['active_users']);
        $a['slot_score'] = (int)($a['slot_score'] ?? 0);
        $a['is_vault_managed'] = !empty($a['cookie_id']);
        $a['pool_type'] = $a['pool_type'] ?? 'active';
    }
    unset($a);

    jsonResponse(['success' => true, 'accounts' => $accounts]);
}

jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);

function upsertVaultCookieV2(PDO $pdo, int $platformId, string $encodedCookie, int $cookieCount, ?string $expiresAt, ?string $fingerprint, string $loginStatus, ?string $verifiedAt, ?string $verifyProof): int {
    $now = date('Y-m-d H:i:s');
    $cookieStatus = 'VALID';

    if (!empty($fingerprint)) {
        $existing = $pdo->prepare("SELECT id FROM cookie_vault WHERE platform_id = ? AND fingerprint = ? LIMIT 1");
        $existing->execute([$platformId, $fingerprint]);
        $existRow = $existing->fetch();
        if ($existRow) {
            $pdo->prepare("UPDATE cookie_vault SET cookie_string = ?, cookie_count = ?, expires_at = ?, updated_at = ?, cookie_status = ?, login_status = ?, verified_at = ?, verify_proof = ?, verification_status = ?, pool_type = 'active' WHERE id = ?")
                ->execute([$encodedCookie, $cookieCount, $expiresAt, $now, $cookieStatus, $loginStatus, $verifiedAt, $verifyProof, $loginStatus, $existRow['id']]);
            return (int)$existRow['id'];
        }
    }

    $existingByContent = $pdo->prepare("SELECT id FROM cookie_vault WHERE platform_id = ? AND cookie_string = ? LIMIT 1");
    $existingByContent->execute([$platformId, $encodedCookie]);
    $contentRow = $existingByContent->fetch();
    if ($contentRow) {
        $pdo->prepare("UPDATE cookie_vault SET cookie_count = ?, expires_at = ?, updated_at = ?, fingerprint = ?, cookie_status = ?, login_status = ?, verified_at = ?, verify_proof = ?, verification_status = ?, pool_type = 'active' WHERE id = ?")
            ->execute([$cookieCount, $expiresAt, $now, $fingerprint, $cookieStatus, $loginStatus, $verifiedAt, $verifyProof, $loginStatus, $contentRow['id']]);
        return (int)$contentRow['id'];
    }

    $ins = $pdo->prepare("INSERT INTO cookie_vault (platform_id, cookie_string, expires_at, updated_at, cookie_count, fingerprint, cookie_status, login_status, score, verified_at, verify_proof, verification_status, pool_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'active')");
    $ins->execute([$platformId, $encodedCookie, $expiresAt, $now, $cookieCount, $fingerprint, $cookieStatus, $loginStatus, $verifiedAt, $verifyProof, $loginStatus]);
    return (int)$pdo->lastInsertId();
}

function tryFailover(PDO $pdo, int $platformId): array {
    $now = date('Y-m-d H:i:s');

    $deadSlots = $pdo->prepare("SELECT pa.id, pa.cookie_id FROM platform_accounts pa WHERE pa.platform_id = ? AND pa.cookie_status = 'DEAD' AND pa.is_active = 0");
    $deadSlots->execute([$platformId]);
    $deadRows = $deadSlots->fetchAll();

    if (empty($deadRows)) {
        return ['success' => true, 'message' => 'No dead slots found. No failover needed.', 'failover_triggered' => false];
    }

    $reserve = $pdo->prepare("SELECT * FROM cookie_vault WHERE platform_id = ? AND pool_type = 'reserve' AND cookie_status IN ('VALID', 'RISKY') ORDER BY score DESC LIMIT 1");
    $reserve->execute([$platformId]);
    $reserveCookie = $reserve->fetch();

    if (!$reserveCookie) {
        $pdo->prepare("UPDATE platform_accounts SET is_active = 0 WHERE platform_id = ? AND cookie_status = 'DEAD'")->execute([$platformId]);

        $platName = $pdo->prepare("SELECT name FROM platforms WHERE id = ?");
        $platName->execute([$platformId]);
        $platRow = $platName->fetch();
        $pName = $platRow['name'] ?? 'Unknown';

        return [
            'success' => true,
            'message' => "No reserve cookie available for {$pName}. Slots suspended.",
            'failover_triggered' => false,
            'slots_suspended' => count($deadRows),
        ];
    }

    $pdo->prepare("UPDATE cookie_vault SET pool_type = 'active' WHERE id = ?")->execute([$reserveCookie['id']]);

    $recovered = 0;
    foreach ($deadRows as $slot) {
        $pdo->prepare("UPDATE platform_accounts SET cookie_id = ?, cookie_data = ?, cookie_status = 'VALID', is_active = 1, updated_at = ? WHERE id = ?")
            ->execute([$reserveCookie['id'], $reserveCookie['cookie_string'], $now, $slot['id']]);
        $recovered++;
    }

    $pdo->prepare("UPDATE cookie_vault SET cookie_status = 'DEAD', pool_type = 'dead' WHERE id IN (SELECT DISTINCT cookie_id FROM platform_accounts WHERE platform_id = ? AND cookie_id != ? AND cookie_status = 'DEAD')")
        ->execute([$platformId, $reserveCookie['id']]);

    $platName2 = $pdo->prepare("SELECT name FROM platforms WHERE id = ?");
    $platName2->execute([$platformId]);
    $platRow2 = $platName2->fetch();
    $pName2 = $platRow2['name'] ?? 'Unknown';

    return [
        'success' => true,
        'message' => "Failover complete for {$pName2}. Promoted reserve cookie. Recovered {$recovered} slot(s).",
        'failover_triggered' => true,
        'slots_recovered' => $recovered,
        'reserve_vault_id' => $reserveCookie['id'],
    ];
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

        $shortLivedCookies = ['__cf_bm', '__stripe_sid', 'ud_country_code', 'eventing_session_id',
            '_gat', '_ga', '__cfduid', 'cf_clearance', '__cfuvid', '_uetsid', '_uetvid'];
        $expTs = null;
        if (isset($cookie['expirationDate']) && is_numeric($cookie['expirationDate'])) {
            $expTs = (int)$cookie['expirationDate'];
            if ($expTs > 9999999999) $expTs = (int)($expTs / 1000);
            $hoursUntilExpiry = ($expTs - time()) / 3600;
            $isShortLived = in_array($name, $shortLivedCookies, true)
                || strpos($name, 'ud_cache_') === 0
                || $hoursUntilExpiry < 24;
            if (!$isShortLived) {
                $expDate = date('Y-m-d H:i:s', $expTs);
                if ($earliestExpiry === null || $expDate < $earliestExpiry) {
                    $earliestExpiry = $expDate;
                }
            }
        }

        $normalized = [
            'name'           => $name,
            'value'          => $cookie['value'] ?? '',
            'domain'         => $cookie['domain'] ?? '',
            'path'           => $cookie['path'] ?? '/',
            'secure'         => (bool)($cookie['secure'] ?? false),
            'httpOnly'       => (bool)($cookie['httpOnly'] ?? false),
            'sameSite'       => $sameSite,
            'expirationDate' => $expTs,
        ];
        $valid[] = $normalized;
    }

    if (empty($valid)) {
        return ['valid' => false, 'error' => 'No valid cookies found. ' . implode('; ', $errors), 'count' => 0, 'cookies' => [], 'earliest_expiry' => null, 'format' => 'json'];
    }

    return ['valid' => true, 'count' => count($valid), 'cookies' => $valid, 'errors' => $errors, 'earliest_expiry' => $earliestExpiry, 'format' => 'json'];
}

function parsePlainCookieString(string $raw): array {
    $pairs = preg_split('/;\s*/', $raw);
    $cookies = [];
    foreach ($pairs as $pair) {
        $pair = trim($pair);
        if ($pair === '') continue;
        $eqPos = strpos($pair, '=');
        if ($eqPos === false) continue;
        $name = trim(substr($pair, 0, $eqPos));
        $value = trim(substr($pair, $eqPos + 1));
        if ($name === '') continue;
        $cookies[] = [
            'name' => $name, 'value' => $value, 'domain' => '',
            'path' => '/', 'secure' => false, 'httpOnly' => false,
            'sameSite' => 'lax', 'expirationDate' => null,
        ];
    }
    if (empty($cookies)) {
        return ['valid' => false, 'error' => 'No valid cookie pairs found.', 'count' => 0, 'cookies' => [], 'earliest_expiry' => null, 'format' => 'plain'];
    }
    return ['valid' => true, 'count' => count($cookies), 'cookies' => $cookies, 'errors' => [], 'earliest_expiry' => null, 'format' => 'plain'];
}

function extractDomainsFromCookies(array $parsed, string $rawInput): array {
    $domains = [];
    foreach ($parsed['cookies'] as $c) {
        if (!empty($c['domain'])) {
            $d = strtolower(ltrim(trim($c['domain']), '.'));
            if ($d !== '' && !in_array($d, $domains, true)) $domains[] = $d;
        }
    }
    if (empty($domains)) {
        preg_match_all('/[\w.-]+\.(com|org|net|io|co|tv|app)/', $rawInput, $m);
        foreach ($m[0] as $dm) {
            $d = strtolower($dm);
            if (!in_array($d, $domains, true)) $domains[] = $d;
        }
    }
    return $domains;
}

function extractAccountFingerprint(array $parsed): ?string {
    $sessionKeys = ['NetflixId', 'SecureNetflixId', 'sp_dc', 'sp_key', 'disney_token', 'dss_id', 'chatgpt_session', 'canva_session', '__Secure-next-auth.session-token', 'CourseraSession'];
    foreach ($parsed['cookies'] as $c) {
        if (in_array($c['name'], $sessionKeys, true) && !empty($c['value'])) {
            return md5($c['name'] . ':' . substr($c['value'], 0, 32));
        }
    }
    if (!empty($parsed['cookies'])) {
        $firstCookie = $parsed['cookies'][0];
        return md5($firstCookie['name'] . ':' . substr($firstCookie['value'] ?? '', 0, 32));
    }
    return null;
}

function detectMaxStreams(array $parsed, string $rawInput): int {
    foreach ($parsed['cookies'] as $c) {
        if (stripos($c['name'], 'netflix') !== false || stripos($c['value'], 'netflix') !== false) {
            return 1;
        }
    }
    return 1;
}

function resolvePlatform(PDO $pdo, array $domains): array {
    $platformMap = [
        'netflix.com'    => ['name' => 'Netflix',    'logo' => 'https://upload.wikimedia.org/wikipedia/commons/0/08/Netflix_2015_logo.svg', 'color' => '#e50914', 'cookie_domain' => '.netflix.com',    'login_url' => 'https://www.netflix.com/'],
        'spotify.com'    => ['name' => 'Spotify',    'logo' => 'https://upload.wikimedia.org/wikipedia/commons/2/26/Spotify_logo_with_text.svg', 'color' => '#1db954', 'cookie_domain' => '.spotify.com',    'login_url' => 'https://open.spotify.com/'],
        'disneyplus.com' => ['name' => 'Disney+',    'logo' => 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg', 'color' => '#0063e5', 'cookie_domain' => '.disneyplus.com', 'login_url' => 'https://www.disneyplus.com/'],
        'openai.com'     => ['name' => 'ChatGPT',    'logo' => 'https://upload.wikimedia.org/wikipedia/commons/0/04/ChatGPT_logo.svg', 'color' => '#10a37f', 'cookie_domain' => '.openai.com',     'login_url' => 'https://chat.openai.com/'],
        'canva.com'      => ['name' => 'Canva',      'logo' => 'https://upload.wikimedia.org/wikipedia/commons/0/08/Canva_icon_2021.svg', 'color' => '#7d2ae8', 'cookie_domain' => '.canva.com',      'login_url' => 'https://www.canva.com/'],
        'udemy.com'      => ['name' => 'Udemy',      'logo' => 'https://upload.wikimedia.org/wikipedia/commons/e/e3/Udemy_logo.svg', 'color' => '#a435f0', 'cookie_domain' => '.udemy.com',      'login_url' => 'https://www.udemy.com/'],
        'coursera.org'   => ['name' => 'Coursera',   'logo' => 'https://upload.wikimedia.org/wikipedia/commons/9/97/Coursera-Logo_600x600.svg', 'color' => '#0056d2', 'cookie_domain' => '.coursera.org',   'login_url' => 'https://www.coursera.org/'],
        'skillshare.com' => ['name' => 'Skillshare', 'logo' => 'https://upload.wikimedia.org/wikipedia/commons/2/2e/Skillshare_logo.svg', 'color' => '#00ff84', 'cookie_domain' => '.skillshare.com', 'login_url' => 'https://www.skillshare.com/'],
        'grammarly.com'  => ['name' => 'Grammarly',  'logo' => 'https://upload.wikimedia.org/wikipedia/commons/a/a0/Grammarly_Logo.svg', 'color' => '#15c39a', 'cookie_domain' => '.grammarly.com',  'login_url' => 'https://app.grammarly.com/'],
    ];

    foreach ($domains as $domain) {
        $domainNorm = strtolower(ltrim($domain, '.'));
        foreach ($platformMap as $key => $meta) {
            if ($domainNorm === $key || str_ends_with($domainNorm, '.' . $key)) {
                $existing = $pdo->prepare("SELECT id, name FROM platforms WHERE cookie_domain = ? OR name = ? LIMIT 1");
                $existing->execute(['.' . $key, $meta['name']]);
                $row = $existing->fetch();
                if ($row) {
                    return ['found' => true, 'id' => (int)$row['id'], 'name' => $row['name'], 'would_create' => false, 'cookie_domain' => '.' . $key, 'login_url' => $meta['login_url']];
                }
                return ['found' => false, 'id' => 0, 'name' => '', 'would_create' => true, 'create_meta' => ['name' => $meta['name'], 'logo_url' => $meta['logo'], 'color' => $meta['color'], 'cookie_domain' => '.' . $key, 'login_url' => $meta['login_url']]];
            }
        }

        $dbMatch = $pdo->prepare("SELECT id, name, cookie_domain FROM platforms WHERE cookie_domain LIKE ? OR name LIKE ? LIMIT 1");
        $dbMatch->execute(['%' . $domainNorm . '%', '%' . $domainNorm . '%']);
        $dbRow = $dbMatch->fetch();
        if ($dbRow) {
            return ['found' => true, 'id' => (int)$dbRow['id'], 'name' => $dbRow['name'], 'would_create' => false, 'cookie_domain' => $dbRow['cookie_domain'], 'login_url' => ''];
        }
    }

    return ['found' => false, 'id' => 0, 'name' => '', 'would_create' => false, 'create_meta' => []];
}

function computeFallbackExpiry(string $platformName): string {
    return date('Y-m-d H:i:s', strtotime('+30 days'));
}

function quickCookieValidation(string $encodedCookie, ?string $expiresAt, int $platformId): array {
    $now = date('Y-m-d H:i:s');
    if ($expiresAt && $expiresAt < $now) {
        return ['cookie_status' => 'EXPIRED', 'reason' => 'Cookie has expired'];
    }
    $decoded = @base64_decode($encodedCookie, true);
    if ($decoded === false) {
        return ['cookie_status' => 'DEAD', 'reason' => 'Invalid base64'];
    }
    $cookies = @json_decode($decoded, true);
    if (!is_array($cookies) || empty($cookies)) {
        return ['cookie_status' => 'DEAD', 'reason' => 'Invalid cookie JSON'];
    }

    $sessionKeys = ['NetflixId', 'SecureNetflixId', 'sp_dc', 'sp_key', 'disney_token', 'dss_id', 'chatgpt_session', '__Secure-next-auth.session-token', 'CourseraSession', 'canva_session'];
    $hasSessionKey = false;
    foreach ($cookies as $c) {
        if (isset($c['name']) && in_array($c['name'], $sessionKeys, true) && !empty($c['value'])) {
            $hasSessionKey = true;
            break;
        }
    }

    if (!$hasSessionKey) {
        return ['cookie_status' => 'RISKY', 'reason' => 'No recognized session token found'];
    }
    return ['cookie_status' => 'VALID', 'reason' => 'Session token present'];
}
