<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/LoginVerifier.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$action = $input['action'] ?? 'auto_setup';

if ($action === 'detect') {
    $cookie_string = trim($input['cookie_string'] ?? '');
    if ($cookie_string === '') {
        jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
    }

    $parsed = parseCookieInput($cookie_string);
    if (!$parsed['valid']) {
        jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
    }

    $pdo = getPDO();
    $detectedDomains = extractDomainsFromCookies($parsed, $cookie_string);
    $platformResult = resolvePlatform($pdo, $detectedDomains);
    $maxStreams = detectMaxStreams($parsed, $cookie_string);
    $accountFingerprint = extractAccountFingerprint($parsed);

    jsonResponse([
        'success' => true,
        'cookie_count' => $parsed['count'],
        'format' => $parsed['format'] ?? 'unknown',
        'domains' => $detectedDomains,
        'platform_detected' => $platformResult['found'],
        'platform_id' => $platformResult['id'],
        'platform_name' => $platformResult['name'],
        'platform_would_create' => $platformResult['would_create'],
        'cookie_domain' => $platformResult['cookie_domain'],
        'login_url' => $platformResult['login_url'],
        'max_streams' => $maxStreams,
        'earliest_expiry' => $parsed['earliest_expiry'] ?? null,
        'account_fingerprint' => $accountFingerprint,
    ]);
}

if ($action === 'auto_setup') {
    $cookie_string = trim($input['cookie_string'] ?? '');
    if ($cookie_string === '') {
        jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
    }

    $parsed = parseCookieInput($cookie_string);
    if (!$parsed['valid']) {
        jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
    }

    $pdo = getPDO();
    $detectedDomains = extractDomainsFromCookies($parsed, $cookie_string);
    $maxStreams = detectMaxStreams($parsed, $cookie_string);
    if ($maxStreams < 1) $maxStreams = 1;
    if (!empty($input['slot_count']) && (int)$input['slot_count'] > 0) {
        $maxStreams = max(1, min(20, (int)$input['slot_count']));
    }
    $slotMaxUsers = (!empty($input['max_users']) && (int)$input['max_users'] > 0)
        ? max(1, min(50, (int)$input['max_users'])) : 1;
    $accountFingerprint = extractAccountFingerprint($parsed);

    $cookieCount = $parsed['count'];
    $normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
    $encodedCookie = base64_encode($normalizedJson);

    $expiresVal = null;
    $expirySource = 'none';
    if (!empty($parsed['earliest_expiry'])) {
        $expiresVal = $parsed['earliest_expiry'];
        $expirySource = 'cookie';
    }

    $now = date('Y-m-d H:i:s');
    $platformCreated = false;
    $platformUpdated = false;
    $slotsCreated = 0;
    $slotsUpdated = 0;
    $accountStatus = 'created';
    $platformName = '';
    $platformId = 0;

    try {
        $pdo->beginTransaction();

        $platformResult = resolvePlatform($pdo, $detectedDomains);

        if ($platformResult['found']) {
            $platformId = $platformResult['id'];
            $platformName = $platformResult['name'];
        } elseif ($platformResult['would_create']) {
            $meta = $platformResult['create_meta'];

            $existCheck = $pdo->prepare("SELECT id, name FROM platforms WHERE cookie_domain = ? OR name = ? LIMIT 1");
            $existCheck->execute([$meta['cookie_domain'], $meta['name']]);
            $existingPlat = $existCheck->fetch();

            if ($existingPlat) {
                $platformId = (int)$existingPlat['id'];
                $platformName = $existingPlat['name'];
            } else {
                    $logoUrl = $meta['logo_url'];
                if (empty($logoUrl)) {
                    $cleanDomain = ltrim($meta['cookie_domain'], '.');
                    $logoUrl = 'https://www.google.com/s2/favicons?domain=' . urlencode($cleanDomain) . '&sz=64';
                }
                $stmt = $pdo->prepare("INSERT INTO platforms (name, logo_url, bg_color_hex, is_active, cookie_domain, login_url, auto_detected, health_score, health_status) VALUES (?, ?, ?, 1, ?, ?, 1, 100, 'active')");
                $stmt->execute([$meta['name'], $logoUrl, $meta['color'], $meta['cookie_domain'], $meta['login_url']]);
                $platformId = (int)$pdo->lastInsertId();
                $platformName = $meta['name'];
                $platformCreated = true;
                logActivity($_SESSION['user_id'], "auto_platform_created: {$meta['name']} (domain: {$meta['cookie_domain']})", getClientIP());
            }
        } else {
            $pdo->rollBack();
            $domainStr = !empty($detectedDomains) ? implode(', ', $detectedDomains) : 'none found';
            jsonResponse([
                'success' => false,
                'message' => "Could not detect platform from cookie domains ({$domainStr}). No known platform pattern matched. Please add the platform manually first, or include cookies with a domain field.",
            ], 400);
        }

        if ($expiresVal === null && !empty($platformName)) {
            $expiresVal = computeFallbackExpiry($platformName);
            $expirySource = 'default';
        }

        if (isExpiryAlreadyPassed($expiresVal)) {
            $pdo->rollBack();
            jsonResponse([
                'success' => false,
                'message' => "Cookie has already expired ({$expiresVal}). Cannot create slot with expired cookie.",
            ], 400);
        }

        $loginVerification = null;
        $loginScore = 0;
        $platformDomain = '';

        if ($platformId > 0) {
            $domStmt = $pdo->prepare("SELECT cookie_domain FROM platforms WHERE id = ?");
            $domStmt->execute([$platformId]);
            $domRow = $domStmt->fetch();
            $platformDomain = $domRow['cookie_domain'] ?? '';
        }

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
            }

            if ($loginVerification['login_status'] === 'INVALID') {
                $pdo->rollBack();
                $reason = $loginVerification['reason'] ?? 'Unknown';
                $failType = 'LOGIN_FAILED';
                if (stripos($reason, 'subscription') !== false || stripos($reason, 'account') !== false) {
                    $failType = 'NO_SUBSCRIPTION';
                }
                logActivity($_SESSION['user_id'], "auto_setup_rejected: platform={$platformName} reason={$failType} detail={$reason}", getClientIP());
                jsonResponse([
                    'success' => false,
                    'message' => "Login verification failed — cookies are not working. {$reason}",
                    'login_status' => 'INVALID',
                    'login_score' => $loginScore,
                    'fail_type' => $failType,
                    'platform_name' => $platformName,
                    'verification_reason' => $reason,
                ], 400);
            }
        }

        $loginStatusVal = $loginVerification ? $loginVerification['login_status'] : 'PENDING';
        $verifiedAt = $loginVerification ? $loginVerification['verified_at'] : null;

        $existingAccount = null;
        if (!empty($accountFingerprint)) {
            $existingAccounts = $pdo->prepare("SELECT id, slot_name, cookie_data, max_users FROM platform_accounts WHERE platform_id = ?");
            $existingAccounts->execute([$platformId]);
            $allAccounts = $existingAccounts->fetchAll();

            foreach ($allAccounts as $acct) {
                $existingCookieData = $acct['cookie_data'];
                $decoded = @base64_decode($existingCookieData, true);
                if ($decoded !== false) {
                    $existingParsed = @json_decode($decoded, true);
                    if (is_array($existingParsed)) {
                        $existingFp = extractFingerprintFromCookieArray($existingParsed);
                        if (!empty($existingFp) && $existingFp === $accountFingerprint) {
                            $existingAccount = $acct;
                            break;
                        }
                    }
                }
            }
        }

        if ($existingAccount) {
            $accountStatus = 'updated';
            $vaultId = upsertVaultCookie($pdo, $platformId, $encodedCookie, $cookieCount, $expiresVal, $accountFingerprint, 1);
            $stmt = $pdo->prepare("UPDATE platform_accounts SET cookie_data = ?, cookie_count = ?, expires_at = ?, updated_at = ?, login_status = ?, last_verified_at = ?, cookie_id = ? WHERE id = ?");
            $stmt->execute([$encodedCookie, $cookieCount, $expiresVal, $now, $loginStatusVal, $verifiedAt, $vaultId, $existingAccount['id']]);
            $slotsUpdated = 1;
        } else {
            $accountStatus = 'created';

            $existingSlotCount = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE platform_id = ?");
            $existingSlotCount->execute([$platformId]);
            $currentSlots = (int)$existingSlotCount->fetchColumn();

            for ($i = 1; $i <= $maxStreams; $i++) {
                $vaultId = upsertVaultCookie($pdo, $platformId, $encodedCookie, $cookieCount, $expiresVal, $accountFingerprint, $currentSlots + $i);
                $slotName = "Slot " . ($currentSlots + $i);
                $stmt = $pdo->prepare("INSERT INTO platform_accounts (platform_id, slot_name, cookie_data, max_users, cookie_count, expires_at, created_at, updated_at, login_status, last_verified_at, cookie_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                $stmt->execute([$platformId, $slotName, $encodedCookie, $slotMaxUsers, $cookieCount, $expiresVal, $now, $now, $loginStatusVal, $verifiedAt, $vaultId]);
                $slotsCreated++;
            }
        }

        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        jsonResponse(['success' => false, 'message' => 'Auto setup failed. Please try again.'], 500);
    }

    $statusLabel = $accountStatus === 'updated' ? 'Updated' : 'Created';
    $summary = "{$platformName}: {$statusLabel}";
    if ($slotsCreated > 0) $summary .= " — {$slotsCreated} slot(s) created";
    if ($slotsUpdated > 0) $summary .= " — cookies refreshed";

    logActivity($_SESSION['user_id'], "auto_setup: platform={$platformName} status={$accountStatus} slots_created={$slotsCreated} slots_updated={$slotsUpdated} streams={$maxStreams}", getClientIP());

    $expiryDays = null;
    if ($expiresVal) {
        try {
            $diff = (new DateTime())->diff(new DateTime($expiresVal));
            $expiryDays = $diff->invert ? 0 : $diff->days;
        } catch (Exception $e) {}
    }

    $loginLabel = $loginStatusVal;
    if ($loginVerification) {
        if ($loginStatusVal === 'VALID') $loginLabel = 'Verified Working';
        elseif ($loginStatusVal === 'PARTIAL') $loginLabel = 'Partially Verified';
    } else {
        $loginLabel = 'Not Verified';
    }

    jsonResponse([
        'success' => true,
        'message' => $summary,
        'platform_name' => $platformName,
        'platform_id' => $platformId,
        'platform_created' => $platformCreated,
        'account_status' => $accountStatus,
        'max_streams' => $maxStreams,
        'slots_created' => $slotsCreated,
        'slots_updated' => $slotsUpdated,
        'cookie_count' => $cookieCount,
        'expires_at' => $expiresVal,
        'expiry_source' => $expirySource,
        'expiry_days_remaining' => $expiryDays,
        'fingerprint' => $accountFingerprint ? substr($accountFingerprint, 0, 12) . '...' : null,
        'login_status' => $loginStatusVal,
        'login_score' => $loginScore,
        'login_label' => $loginLabel,
        'login_verified' => $loginVerification !== null,
        'login_reason' => $loginVerification ? ($loginVerification['reason'] ?? null) : null,
    ]);
}

if ($action === 'save') {
    $platform_id   = (int)($input['platform_id'] ?? 0);
    $cookie_string = trim($input['cookie_string'] ?? '');
    $expires_at    = trim($input['expires_at'] ?? '');
    $max_streams   = max(1, min(20, (int)($input['max_streams'] ?? 1)));
    $slots         = $input['slots'] ?? [];

    if ($platform_id < 1) {
        jsonResponse(['success' => false, 'message' => 'Platform is required.'], 400);
    }
    if ($cookie_string === '') {
        jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
    }
    if (empty($slots) || !is_array($slots)) {
        jsonResponse(['success' => false, 'message' => 'At least one slot is required.'], 400);
    }
    if (count($slots) > 20) {
        jsonResponse(['success' => false, 'message' => 'Maximum 20 slots allowed.'], 400);
    }

    $pdo = getPDO();

    $stmt = $pdo->prepare("SELECT id, name, cookie_domain, login_url FROM platforms WHERE id = ?");
    $stmt->execute([$platform_id]);
    $platform = $stmt->fetch();
    if (!$platform) {
        jsonResponse(['success' => false, 'message' => 'Platform not found.'], 404);
    }

    $parsed = parseCookieInput($cookie_string);
    if (!$parsed['valid']) {
        jsonResponse(['success' => false, 'message' => $parsed['error']], 400);
    }

    $cookieCount = $parsed['count'];
    $normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
    $encodedCookie = base64_encode($normalizedJson);

    $expiresVal = null;
    if ($expires_at !== '') {
        try { $dt = new DateTime($expires_at); $expiresVal = $dt->format('Y-m-d H:i:s'); } catch (Exception $e) {}
    } elseif (!empty($parsed['earliest_expiry'])) {
        $expiresVal = $parsed['earliest_expiry'];
    }

    if ($expiresVal === null) {
        $platName = $platform['name'] ?? '';
        $expiresVal = computeFallbackExpiry($platName);
    }

    if (isExpiryAlreadyPassed($expiresVal)) {
        jsonResponse([
            'success' => false,
            'message' => "Cookie has already expired ({$expiresVal}). Cannot create slot with expired cookie.",
        ], 400);
    }

    $now = date('Y-m-d H:i:s');
    $createdSlots = [];

    $saveLoginVerification = null;
    $saveLoginScore = 0;
    $savePlatformDomain = $platform['cookie_domain'] ?? '';
    $saveNormalizedDomain = strtolower(trim($savePlatformDomain, '.'));
    $saveSupportedDomains = ['netflix.com'];

    if (!empty($savePlatformDomain) && in_array($saveNormalizedDomain, $saveSupportedDomains)) {
        $saveLoginVerification = LoginVerifier::verify($encodedCookie, $savePlatformDomain);

        if ($saveLoginVerification['login_status'] === 'VALID') {
            $saveLoginScore = 100;
        } elseif ($saveLoginVerification['login_status'] === 'PARTIAL') {
            $saveLoginScore = 50;
        } else {
            $saveLoginScore = -100;
        }

        if ($saveLoginVerification['login_status'] === 'INVALID') {
            $reason = $saveLoginVerification['reason'] ?? 'Unknown';
            logActivity($_SESSION['user_id'], "save_rejected: platform={$platform['name']} reason=LOGIN_FAILED detail={$reason}", getClientIP());
            jsonResponse([
                'success' => false,
                'message' => "Login verification failed — cookies are not working. {$reason}",
                'login_status' => 'INVALID',
                'login_score' => $saveLoginScore,
                'platform_name' => $platform['name'],
            ], 400);
        }
    }

    $saveLoginStatusVal = $saveLoginVerification ? $saveLoginVerification['login_status'] : 'PENDING';
    $saveVerifiedAt = $saveLoginVerification ? $saveLoginVerification['verified_at'] : null;

    $accountFingerprint = extractAccountFingerprint($parsed);

    try {
        $pdo->beginTransaction();

        foreach ($slots as $slotData) {
            $slotNum = (int)($slotData['slot_number'] ?? 0);
            $maxUsers = max(1, min(50, (int)($slotData['max_users'] ?? 1)));
            $slotName = trim($slotData['slot_name'] ?? "Slot {$slotNum}");
            if ($slotNum < 1) continue;

            $vaultId = upsertVaultCookie($pdo, $platform_id, $encodedCookie, $cookieCount, $expiresVal, $accountFingerprint, $slotNum);
            $pdo->prepare("INSERT INTO platform_accounts (platform_id, slot_name, cookie_data, max_users, cookie_count, expires_at, created_at, updated_at, login_status, last_verified_at, cookie_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                ->execute([$platform_id, $slotName, $encodedCookie, $maxUsers, $cookieCount, $expiresVal, $now, $now, $saveLoginStatusVal, $saveVerifiedAt, $vaultId]);
            $createdSlots[] = ['id' => (int)$pdo->lastInsertId(), 'slot_name' => $slotName, 'max_users' => $maxUsers];
        }

        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        jsonResponse(['success' => false, 'message' => 'Failed to save. Please try again.'], 500);
    }

    $totalUsers = array_sum(array_column($createdSlots, 'max_users'));
    logActivity($_SESSION['user_id'], "unified_account_added: platform={$platform['name']} slots=" . count($createdSlots) . " total_capacity={$totalUsers} login={$saveLoginStatusVal}", getClientIP());

    jsonResponse([
        'success' => true,
        'message' => count($createdSlots) . " slot(s) created for '{$platform['name']}' with total capacity of {$totalUsers} user(s).",
        'platform_name' => $platform['name'],
        'slots_created' => count($createdSlots),
        'total_capacity' => $totalUsers,
        'slots' => $createdSlots,
        'login_status' => $saveLoginStatusVal,
        'login_score' => $saveLoginScore,
        'login_verified' => $saveLoginVerification !== null,
    ]);
}

if ($action === 'bulk_import') {
    $cookie_string = trim($input['cookie_string'] ?? '');
    if ($cookie_string === '') {
        jsonResponse(['success' => false, 'message' => 'Cookie data is required.'], 400);
    }

    $pdo = getPDO();
    $blocks = splitBulkInput($cookie_string);

    if (empty($blocks)) {
        jsonResponse(['success' => false, 'message' => 'Could not detect any accounts in the pasted data.'], 400);
    }

    $results = [];
    $successCount = 0;
    $failCount = 0;

    foreach ($blocks as $idx => $block) {
        try {
            $pdo->beginTransaction();
            $result = processOneAccountBlock($pdo, $block);
            if ($result['success']) {
                $pdo->commit();
                $successCount++;
            } else {
                $pdo->rollBack();
                $failCount++;
            }
            $results[] = $result;
        } catch (Exception $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            $failCount++;
            $results[] = ['success' => false, 'error' => 'Processing error'];
        }
    }

    $summary = "{$successCount} account(s) imported successfully";
    if ($failCount > 0) $summary .= ", {$failCount} failed";

    logActivity($_SESSION['user_id'], "bulk_import: total=" . count($blocks) . " success={$successCount} failed={$failCount}", getClientIP());

    jsonResponse([
        'success' => $successCount > 0,
        'message' => $summary,
        'total' => count($blocks),
        'success_count' => $successCount,
        'fail_count' => $failCount,
        'results' => $results,
    ]);
}

jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);


function getKnownPlatformRegistry(): array {
    return [
        'netflix.com' => ['name' => 'Netflix', 'color' => '#e50914', 'login_url' => 'https://www.netflix.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/0/08/Netflix_2015_logo.svg'],
        'spotify.com' => ['name' => 'Spotify', 'color' => '#1db954', 'login_url' => 'https://open.spotify.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/2/26/Spotify_logo_with_text.svg'],
        'disneyplus.com' => ['name' => 'Disney+', 'color' => '#0063e5', 'login_url' => 'https://www.disneyplus.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg'],
        'openai.com' => ['name' => 'ChatGPT', 'color' => '#10a37f', 'login_url' => 'https://chat.openai.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/0/04/ChatGPT_logo.svg'],
        'canva.com' => ['name' => 'Canva', 'color' => '#7d2ae8', 'login_url' => 'https://www.canva.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/0/08/Canva_icon_2021.svg'],
        'udemy.com' => ['name' => 'Udemy', 'color' => '#a435f0', 'login_url' => 'https://www.udemy.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/e/e3/Udemy_logo.svg'],
        'coursera.org' => ['name' => 'Coursera', 'color' => '#0056d2', 'login_url' => 'https://www.coursera.org/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/9/97/Coursera-Logo_600x600.svg'],
        'skillshare.com' => ['name' => 'Skillshare', 'color' => '#00ff84', 'login_url' => 'https://www.skillshare.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/2/2e/Skillshare_logo.svg'],
        'grammarly.com' => ['name' => 'Grammarly', 'color' => '#15c39a', 'login_url' => 'https://app.grammarly.com/', 'logo_url' => 'https://upload.wikimedia.org/wikipedia/commons/a/a0/Grammarly_Logo.svg'],
        'amazon.com' => ['name' => 'Amazon Prime', 'color' => '#00a8e1', 'login_url' => 'https://www.amazon.com/', 'logo_url' => null],
        'primevideo.com' => ['name' => 'Prime Video', 'color' => '#00a8e1', 'login_url' => 'https://www.primevideo.com/', 'logo_url' => null],
        'hulu.com' => ['name' => 'Hulu', 'color' => '#1ce783', 'login_url' => 'https://www.hulu.com/', 'logo_url' => null],
        'hbomax.com' => ['name' => 'HBO Max', 'color' => '#5822b4', 'login_url' => 'https://www.max.com/', 'logo_url' => null],
        'max.com' => ['name' => 'Max', 'color' => '#0028f5', 'login_url' => 'https://www.max.com/', 'logo_url' => null],
        'crunchyroll.com' => ['name' => 'Crunchyroll', 'color' => '#f47521', 'login_url' => 'https://www.crunchyroll.com/', 'logo_url' => null],
        'apple.com' => ['name' => 'Apple TV+', 'color' => '#000000', 'login_url' => 'https://tv.apple.com/', 'logo_url' => null],
        'youtube.com' => ['name' => 'YouTube Premium', 'color' => '#ff0000', 'login_url' => 'https://www.youtube.com/', 'logo_url' => null],
        'google.com' => ['name' => 'Google', 'color' => '#4285f4', 'login_url' => 'https://accounts.google.com/', 'logo_url' => null],
        'linkedin.com' => ['name' => 'LinkedIn Premium', 'color' => '#0077b5', 'login_url' => 'https://www.linkedin.com/', 'logo_url' => null],
        'adobe.com' => ['name' => 'Adobe', 'color' => '#ff0000', 'login_url' => 'https://account.adobe.com/', 'logo_url' => null],
        'figma.com' => ['name' => 'Figma', 'color' => '#0acf83', 'login_url' => 'https://www.figma.com/', 'logo_url' => null],
        'notion.so' => ['name' => 'Notion', 'color' => '#000000', 'login_url' => 'https://www.notion.so/', 'logo_url' => null],
        'duolingo.com' => ['name' => 'Duolingo', 'color' => '#58cc02', 'login_url' => 'https://www.duolingo.com/', 'logo_url' => null],
        'codecademy.com' => ['name' => 'Codecademy', 'color' => '#1f4056', 'login_url' => 'https://www.codecademy.com/', 'logo_url' => null],
        'nordvpn.com' => ['name' => 'NordVPN', 'color' => '#4687ff', 'login_url' => 'https://my.nordaccount.com/', 'logo_url' => null],
        'expressvpn.com' => ['name' => 'ExpressVPN', 'color' => '#da3940', 'login_url' => 'https://www.expressvpn.com/', 'logo_url' => null],
        'surfshark.com' => ['name' => 'Surfshark', 'color' => '#178de5', 'login_url' => 'https://my.surfshark.com/', 'logo_url' => null],
        'chatgpt.com' => ['name' => 'ChatGPT', 'color' => '#10a37f', 'login_url' => 'https://chatgpt.com/', 'logo_url' => null],
        'claude.ai' => ['name' => 'Claude', 'color' => '#cc785c', 'login_url' => 'https://claude.ai/', 'logo_url' => null],
        'midjourney.com' => ['name' => 'Midjourney', 'color' => '#000000', 'login_url' => 'https://www.midjourney.com/', 'logo_url' => null],
        'paramount.com' => ['name' => 'Paramount+', 'color' => '#0064ff', 'login_url' => 'https://www.paramountplus.com/', 'logo_url' => null],
        'peacocktv.com' => ['name' => 'Peacock', 'color' => '#000000', 'login_url' => 'https://www.peacocktv.com/', 'logo_url' => null],
        'dazn.com' => ['name' => 'DAZN', 'color' => '#f1f514', 'login_url' => 'https://www.dazn.com/', 'logo_url' => null],
    ];
}

function resolvePlatform(PDO $pdo, array $detectedDomains): array {
    $result = ['found' => false, 'id' => null, 'name' => null, 'cookie_domain' => null, 'login_url' => null, 'would_create' => false, 'create_meta' => null];

    if (empty($detectedDomains)) return $result;

    $allPlatforms = $pdo->query("SELECT id, name, cookie_domain, login_url FROM platforms WHERE cookie_domain IS NOT NULL AND cookie_domain != ''")->fetchAll();
    foreach ($allPlatforms as $p) {
        $platDomain = ltrim($p['cookie_domain'], '.');
        if (strlen($platDomain) < 4) continue;
        foreach ($detectedDomains as $cookieDomain) {
            $cd = ltrim($cookieDomain, '.');
            if ($cd === $platDomain || str_ends_with($cd, '.' . $platDomain)) {
                $result['found'] = true;
                $result['id'] = (int)$p['id'];
                $result['name'] = $p['name'];
                $result['cookie_domain'] = $p['cookie_domain'];
                $result['login_url'] = $p['login_url'];
                return $result;
            }
        }
    }

    $registry = getKnownPlatformRegistry();
    foreach ($detectedDomains as $cookieDomain) {
        $cd = ltrim(strtolower($cookieDomain), '.');
        foreach ($registry as $regDomain => $meta) {
            if ($cd === $regDomain || str_ends_with($cd, '.' . $regDomain)) {
                $result['would_create'] = true;
                $result['create_meta'] = [
                    'name' => $meta['name'],
                    'color' => $meta['color'],
                    'login_url' => $meta['login_url'],
                    'logo_url' => $meta['logo_url'],
                    'cookie_domain' => '.' . $regDomain,
                ];
                return $result;
            }
        }
    }

    $primaryDomain = ltrim($detectedDomains[0], '.');
    $parts = explode('.', $primaryDomain);
    if (count($parts) >= 2) {
        $baseDomain = $parts[count($parts) - 2] . '.' . $parts[count($parts) - 1];
        $platformName = ucfirst($parts[count($parts) - 2]);

        $result['would_create'] = true;
        $result['create_meta'] = [
            'name' => $platformName,
            'color' => '#4F46E5',
            'login_url' => 'https://www.' . $baseDomain . '/',
            'logo_url' => 'https://www.google.com/s2/favicons?domain=' . urlencode($baseDomain) . '&sz=64',
            'cookie_domain' => '.' . $baseDomain,
        ];
    }

    return $result;
}

function extractAccountFingerprint(array $parsed): ?string {
    if (!$parsed['valid'] || empty($parsed['cookies'])) return null;

    $identityKeys = ['netflixid', 'securenetflixid', 'sp_dc', 'sp_key', 'disney_token', 'dss_id',
        '__Secure-next-auth.session-token', 'session_token', 'sessionid', 'auth_token',
        'access_token', 'user_id', 'uid', 'account_id', 'login_token', 'cf_clearance'];

    $fingerprint = '';
    foreach ($parsed['cookies'] as $cookie) {
        $name = strtolower($cookie['name'] ?? '');
        if (in_array($name, $identityKeys, true)) {
            $fingerprint .= $name . '=' . ($cookie['value'] ?? '') . '|';
        }
    }

    if ($fingerprint === '') return null;
    return md5($fingerprint);
}

function extractFingerprintFromCookieArray(array $cookies): ?string {
    $identityKeys = ['netflixid', 'securenetflixid', 'sp_dc', 'sp_key', 'disney_token', 'dss_id',
        '__Secure-next-auth.session-token', 'session_token', 'sessionid', 'auth_token',
        'access_token', 'user_id', 'uid', 'account_id', 'login_token', 'cf_clearance'];

    $fingerprint = '';
    foreach ($cookies as $cookie) {
        $name = strtolower($cookie['name'] ?? '');
        if (in_array($name, $identityKeys, true)) {
            $fingerprint .= $name . '=' . ($cookie['value'] ?? '') . '|';
        }
    }

    if ($fingerprint === '') return null;
    return md5($fingerprint);
}

function detectMaxStreams(array $parsed, string $rawInput): int {
    $streamPatterns = [
        'maxstreams', 'max_streams', 'maxscreens', 'max_screens',
        'screens', 'streams', 'profiles', 'max_profiles',
        'concurrent_streams', 'allowed_streams',
    ];

    if ($parsed['valid'] && !empty($parsed['cookies'])) {
        foreach ($parsed['cookies'] as $cookie) {
            $name = strtolower($cookie['name'] ?? '');
            foreach ($streamPatterns as $pattern) {
                if (str_contains($name, $pattern)) {
                    $val = (int)$cookie['value'];
                    if ($val >= 1 && $val <= 20) return $val;
                }
            }
        }

        foreach ($parsed['cookies'] as $cookie) {
            $value = urldecode($cookie['value'] ?? '');
            foreach ($streamPatterns as $pattern) {
                if (preg_match('/' . preg_quote($pattern, '/') . '[=:"\s]+(\d+)/i', $value, $m)) {
                    $val = (int)$m[1];
                    if ($val >= 1 && $val <= 20) return $val;
                }
            }
            if (preg_match('/plantype[=:"\s]+(premium|standard|basic|uhd|4k)/i', $value, $m)) {
                $plan = strtolower($m[1]);
                $planMap = ['premium' => 4, 'uhd' => 4, '4k' => 4, 'standard' => 2, 'basic' => 1];
                if (isset($planMap[$plan])) return $planMap[$plan];
            }
        }
    }

    $jsonData = @json_decode($rawInput, true);
    if (is_array($jsonData)) {
        $items = isset($jsonData[0]) ? $jsonData : [$jsonData];
        foreach ($items as $item) {
            if (!is_array($item)) continue;
            foreach ($item as $key => $value) {
                foreach ($streamPatterns as $pattern) {
                    if (strtolower($key) === $pattern && is_numeric($value)) {
                        $val = (int)$value;
                        if ($val >= 1 && $val <= 20) return $val;
                    }
                }
            }
        }
    }

    return 0;
}

function getCookieNameToDomainMap(): array {
    return [
        'netflixid' => '.netflix.com',
        'securenetflixid' => '.netflix.com',
        'nfvdid' => '.netflix.com',
        'flwssn' => '.netflix.com',
        'profilesgate' => '.netflix.com',
        'memclid' => '.netflix.com',
        'sp_dc' => '.spotify.com',
        'sp_key' => '.spotify.com',
        'sp_t' => '.spotify.com',
        'sp_landing' => '.spotify.com',
        'disney_token' => '.disneyplus.com',
        'dss_id' => '.disneyplus.com',
        'disney_sub' => '.disneyplus.com',
        '__cf_bm' => null,
        'cf_clearance' => null,
        'sid' => null,
        'hsid' => '.google.com',
        'ssid' => '.google.com',
        'apisid' => '.google.com',
        'sapisid' => '.google.com',
        '__secure-1psid' => '.google.com',
        '__secure-3psid' => '.google.com',
        '__secure-1psidts' => '.google.com',
        'login_info' => '.youtube.com',
        'pref' => null,
        'li_at' => '.linkedin.com',
        'jsessionid' => '.linkedin.com',
        'li_mc' => '.linkedin.com',
        'bcookie' => '.linkedin.com',
        'bscookie' => '.linkedin.com',
        '__stripe_mid' => null,
        '__stripe_sid' => null,
        '__secure-next-auth.session-token' => '.openai.com',
        '_puid' => '.openai.com',
        'oai-did' => '.openai.com',
        'canvaauth' => '.canva.com',
        'cauth' => '.coursera.org',
        'csrf3-token' => '.coursera.org',
        'ud_firstvisit' => '.udemy.com',
        'ud_cache_user' => '.udemy.com',
        'ud_credit' => '.udemy.com',
        'grauth' => '.grammarly.com',
        'gnar_containerid' => '.grammarly.com',
        'redirect_location' => '.grammarly.com',
        'ubid-main' => '.amazon.com',
        'at-main' => '.amazon.com',
        'x-ms-cpim-sso' => '.microsoft.com',
        'muid' => '.microsoft.com',
        'figs' => '.figma.com',
        'figma.authn' => '.figma.com',
        'token_v2' => '.notion.so',
        'adobeid' => '.adobe.com',
        'ss_id' => '.skillshare.com',
        'hbo_profile_id' => '.max.com',
        'hub_token' => '.hulu.com',
    ];
}

function inferDomainFromCookieNames(array $cookies): ?string {
    $map = getCookieNameToDomainMap();
    $domainVotes = [];
    foreach ($cookies as $cookie) {
        $name = strtolower($cookie['name'] ?? '');
        if (isset($map[$name]) && $map[$name] !== null) {
            $d = $map[$name];
            $domainVotes[$d] = ($domainVotes[$d] ?? 0) + 1;
        }
    }
    if (empty($domainVotes)) return null;
    arsort($domainVotes);
    return array_key_first($domainVotes);
}

function splitBulkInput(string $raw): array {
    $raw = trim($raw);
    if ($raw === '') return [];

    if (str_starts_with($raw, '[')) {
        $json = @json_decode($raw, true);
        if (is_array($json) && !empty($json)) {
            return [$raw];
        }
    }

    $blocks = preg_split('/\n\s*\n/', $raw);
    $blocks = array_values(array_filter(array_map('trim', $blocks)));
    if (count($blocks) > 1) return $blocks;

    $lines = preg_split('/\r?\n/', $raw);
    $lineBlocks = [];
    $currentBlock = '';
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') {
            if ($currentBlock !== '') { $lineBlocks[] = $currentBlock; $currentBlock = ''; }
            continue;
        }
        if ($currentBlock !== '' && preg_match('/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/', $line)) {
            $lineBlocks[] = $currentBlock;
            $currentBlock = $line;
        } else {
            $currentBlock .= ($currentBlock !== '' ? "\n" : '') . $line;
        }
    }
    if ($currentBlock !== '') $lineBlocks[] = $currentBlock;
    if (count($lineBlocks) > 1) return array_values(array_filter(array_map('trim', $lineBlocks)));

    $identityTokens = [
        'NetflixId', 'SecureNetflixId', 'sp_dc', 'sp_key', 'disney_token',
        'dss_id', 'li_at', 'session_token', 'sessionid', 'auth_token',
        'access_token', '__Secure-next-auth.session-token',
    ];

    $identityCounts = [];
    foreach ($identityTokens as $token) {
        $count = substr_count($raw, $token . '=');
        if ($count > 0) $identityCounts[$token] = $count;
    }

    $maxRepeats = !empty($identityCounts) ? max($identityCounts) : 0;

    if ($maxRepeats > 1) {
        $mostRepeated = array_search($maxRepeats, $identityCounts);
        $splitBlocks = preg_split('/(?=(?:^|[\s;|])' . preg_quote($mostRepeated, '/') . '\s*=)/m', $raw);
        $splitBlocks = array_values(array_filter(array_map('trim', $splitBlocks)));
        if (count($splitBlocks) > 1) {
            $merged = [];
            foreach ($splitBlocks as $b) {
                if (preg_match('/[a-zA-Z0-9_-]+=/', $b)) {
                    $merged[] = $b;
                } elseif (!empty($merged)) {
                    $merged[count($merged) - 1] .= "\n" . $b;
                }
            }
            return array_values(array_filter(array_map('trim', $merged)));
        }
    }

    return [$raw];
}

function processOneAccountBlock(PDO $pdo, string $block): array {
    $block = trim($block);
    if ($block === '') return ['success' => false, 'error' => 'Empty block'];

    $emailMatch = null;
    if (preg_match('/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/', $block, $m)) {
        $emailMatch = $m[0];
    }

    $cleanBlock = preg_replace('/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\s*/m', '', $block);
    $cleanBlock = preg_replace('/^(Email|Account|User|Password|Pass|Pwd|Plan|Country|Status|Subscription)\s*[:=]\s*[^\n;|]*/mi', '', $cleanBlock);
    $cleanBlock = trim($cleanBlock);

    if ($cleanBlock === '') return ['success' => false, 'error' => 'No cookie data found in block'];

    $parsed = parseCookieInput($cleanBlock);
    if (!$parsed['valid']) return ['success' => false, 'error' => $parsed['error']];

    $hasDomains = false;
    foreach ($parsed['cookies'] as $c) {
        if (!empty($c['domain'])) { $hasDomains = true; break; }
    }

    if (!$hasDomains) {
        $inferredDomain = inferDomainFromCookieNames($parsed['cookies']);
        if ($inferredDomain) {
            foreach ($parsed['cookies'] as &$c) {
                if (empty($c['domain'])) $c['domain'] = $inferredDomain;
            }
            unset($c);
        }
    }

    $detectedDomains = [];
    foreach ($parsed['cookies'] as $c) {
        if (!empty($c['domain'])) {
            $d = strtolower(trim($c['domain']));
            if (!in_array($d, $detectedDomains, true)) $detectedDomains[] = $d;
        }
    }

    $maxStreams = detectMaxStreams($parsed, $cleanBlock);
    if ($maxStreams < 1) $maxStreams = 1;
    $accountFingerprint = extractAccountFingerprint($parsed);

    $cookieCount = $parsed['count'];
    $normalizedJson = json_encode($parsed['cookies'], JSON_UNESCAPED_SLASHES);
    $encodedCookie = base64_encode($normalizedJson);

    $expiresVal = null;
    $expirySource = 'none';
    if (!empty($parsed['earliest_expiry'])) {
        $expiresVal = $parsed['earliest_expiry'];
        $expirySource = 'cookie';
    }

    $now = date('Y-m-d H:i:s');
    $platformCreated = false;
    $slotsCreated = 0;
    $slotsUpdated = 0;
    $accountStatus = 'created';
    $platformName = '';
    $platformId = 0;

    $platformResult = resolvePlatform($pdo, $detectedDomains);

    if ($platformResult['found']) {
        $platformId = $platformResult['id'];
        $platformName = $platformResult['name'];
    } elseif ($platformResult['would_create']) {
        $meta = $platformResult['create_meta'];
        $existCheck = $pdo->prepare("SELECT id, name FROM platforms WHERE cookie_domain = ? OR name = ? LIMIT 1");
        $existCheck->execute([$meta['cookie_domain'], $meta['name']]);
        $existingPlat = $existCheck->fetch();

        if ($existingPlat) {
            $platformId = (int)$existingPlat['id'];
            $platformName = $existingPlat['name'];
        } else {
            $logoUrl = $meta['logo_url'];
            if (empty($logoUrl) && !empty($meta['cookie_domain'])) {
                $cleanDomain = ltrim($meta['cookie_domain'], '.');
                $logoUrl = "https://www.google.com/s2/favicons?domain={$cleanDomain}&sz=64";
            }
            $stmt = $pdo->prepare("INSERT INTO platforms (name, logo_url, bg_color_hex, is_active, cookie_domain, login_url, auto_detected, health_score, health_status) VALUES (?, ?, ?, 1, ?, ?, 1, 100, 'active')");
            $stmt->execute([$meta['name'], $logoUrl, $meta['color'], $meta['cookie_domain'], $meta['login_url']]);
            $platformId = (int)$pdo->lastInsertId();
            $platformName = $meta['name'];
            $platformCreated = true;
            logActivity($_SESSION['user_id'], "auto_platform_created: {$meta['name']} (domain: {$meta['cookie_domain']})", getClientIP());
        }
    } else {
        $domainStr = !empty($detectedDomains) ? implode(', ', $detectedDomains) : 'none found';
        return ['success' => false, 'error' => "Could not detect platform (domains: {$domainStr})"];
    }

    if ($expiresVal === null && !empty($platformName)) {
        $expiresVal = computeFallbackExpiry($platformName);
        $expirySource = 'default';
    }

    if (isExpiryAlreadyPassed($expiresVal)) {
        return [
            'success' => false,
            'error' => "Cookie already expired ({$expiresVal}). Skipped.",
            'platform_name' => $platformName,
        ];
    }

    $existingAccount = null;
    if (!empty($accountFingerprint)) {
        $existingAccounts = $pdo->prepare("SELECT id, slot_name, cookie_data, max_users FROM platform_accounts WHERE platform_id = ?");
        $existingAccounts->execute([$platformId]);
        $allAccounts = $existingAccounts->fetchAll();
        foreach ($allAccounts as $acct) {
            $existingCookieData = $acct['cookie_data'];
            $decoded = @base64_decode($existingCookieData, true);
            if ($decoded !== false) {
                $existingParsed = @json_decode($decoded, true);
                if (is_array($existingParsed)) {
                    $existingFp = extractFingerprintFromCookieArray($existingParsed);
                    if (!empty($existingFp) && $existingFp === $accountFingerprint) {
                        $existingAccount = $acct;
                        break;
                    }
                }
            }
        }
    }

    $loginVerification = null;
    $platformDomain = '';
    if ($platformId > 0) {
        $domStmt = $pdo->prepare("SELECT cookie_domain FROM platforms WHERE id = ?");
        $domStmt->execute([$platformId]);
        $domRow = $domStmt->fetch();
        $platformDomain = $domRow['cookie_domain'] ?? '';
    }

    if (!empty($platformDomain) && strtolower(trim($platformDomain, '.')) === 'netflix.com') {
        $loginVerification = LoginVerifier::verify($encodedCookie, $platformDomain);

        if ($loginVerification['login_status'] === 'INVALID') {
            return [
                'success' => false,
                'error' => 'Login verification failed: ' . $loginVerification['reason'],
                'login_status' => 'INVALID',
                'platform_name' => $platformName,
                'verification' => $loginVerification,
            ];
        }
    }

    if ($existingAccount) {
        $accountStatus = 'updated';
        $loginStatusVal = $loginVerification ? $loginVerification['login_status'] : 'PENDING';
        $verifiedAt = $loginVerification ? $loginVerification['verified_at'] : null;
        $vaultId = upsertVaultCookie($pdo, $platformId, $encodedCookie, $cookieCount, $expiresVal, $accountFingerprint, 1);
        $stmt = $pdo->prepare("UPDATE platform_accounts SET cookie_data = ?, cookie_count = ?, expires_at = ?, updated_at = ?, login_status = ?, last_verified_at = ?, cookie_id = ? WHERE id = ?");
        $stmt->execute([$encodedCookie, $cookieCount, $expiresVal, $now, $loginStatusVal, $verifiedAt, $vaultId, $existingAccount['id']]);
        $slotsUpdated = 1;
    } else {
        $accountStatus = 'created';

        $existingSlotCount = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE platform_id = ?");
        $existingSlotCount->execute([$platformId]);
        $currentSlots = (int)$existingSlotCount->fetchColumn();

        $loginStatusVal = $loginVerification ? $loginVerification['login_status'] : 'PENDING';
        $verifiedAt = $loginVerification ? $loginVerification['verified_at'] : null;

        for ($i = 1; $i <= $maxStreams; $i++) {
            $vaultId = upsertVaultCookie($pdo, $platformId, $encodedCookie, $cookieCount, $expiresVal, $accountFingerprint, $currentSlots + $i);
            $slotName = "Slot " . ($currentSlots + $i);
            $stmt = $pdo->prepare("INSERT INTO platform_accounts (platform_id, slot_name, cookie_data, max_users, cookie_count, expires_at, login_status, last_verified_at, created_at, updated_at, cookie_id) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([$platformId, $slotName, $encodedCookie, $cookieCount, $expiresVal, $loginStatusVal, $verifiedAt, $now, $now, $vaultId]);
            $slotsCreated++;
        }
    }

    $loginStatusForLog = $loginVerification ? $loginVerification['login_status'] : 'PENDING';
    logActivity($_SESSION['user_id'], "bulk_account: platform={$platformName} status={$accountStatus} slots_created={$slotsCreated} slots_updated={$slotsUpdated} login_status={$loginStatusForLog}", getClientIP());

    $result = [
        'success' => true,
        'platform_name' => $platformName,
        'platform_id' => $platformId,
        'platform_created' => $platformCreated,
        'account_status' => $accountStatus,
        'slots_created' => $slotsCreated,
        'slots_updated' => $slotsUpdated,
        'cookie_count' => $cookieCount,
        'max_streams' => $maxStreams,
        'email' => $emailMatch,
    ];

    if ($loginVerification) {
        $result['login_status'] = $loginVerification['login_status'];
        $result['login_reason'] = $loginVerification['reason'];
    }

    return $result;
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

    $netscapeResult = parseNetscapeCookies($raw);
    if ($netscapeResult['valid']) {
        return $netscapeResult;
    }

    return parsePlainCookieString($raw);
}

function parseNetscapeCookies(string $raw): array {
    $lines = preg_split('/\r?\n/', $raw);
    $cookies = [];
    $netscapeLines = 0;
    $totalNonEmpty = 0;
    $earliestExpiry = null;
    $domainMap = getCookieNameToDomainMap();

    $shortLivedCookies = ['__cf_bm', '__stripe_sid', 'ud_country_code', 'eventing_session_id',
        '_gat', '_ga', '__cfduid', 'cf_clearance', '__cfuvid', '_uetsid', '_uetvid'];
    $skipNames = ['path', 'expires', 'max-age', 'samesite', 'httponly',
        'email', 'password', 'pass', 'pwd', 'plan', 'country', 'status', 'subscription', 'account', 'user'];

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') continue;
        if (strpos($line, '#HttpOnly_') === 0) {
            $line = substr($line, 10);
        } elseif (strpos($line, '#') === 0) {
            continue;
        }
        $totalNonEmpty++;

        $fields = preg_split('/\t+/', $line);
        if (count($fields) >= 7) {
            $netscapeLines++;
            $domain = trim($fields[0]);
            $path = trim($fields[2]);
            $secure = strtoupper(trim($fields[3])) === 'TRUE';
            $expiryTs = (int)trim($fields[4]);
            $name = trim($fields[5]);
            $value = trim($fields[6]);

            if ($name === '' || in_array(strtolower($name), $skipNames, true)) continue;

            $domain = ltrim($domain, '.');
            $domain = '.' . $domain;

            $normalized = [
                'name' => $name,
                'value' => $value,
                'domain' => $domain,
                'path' => $path ?: '/',
                'secure' => $secure,
                'httpOnly' => true,
                'sameSite' => 'lax',
            ];

            if ($expiryTs > 0) {
                if ($expiryTs > 9999999999) $expiryTs = (int)($expiryTs / 1000);
                $normalized['expirationDate'] = $expiryTs;

                $hoursUntilExpiry = ($expiryTs - time()) / 3600;
                $isShortLived = in_array($name, $shortLivedCookies, true)
                    || strpos($name, 'ud_cache_') === 0
                    || $hoursUntilExpiry < 24;
                if (!$isShortLived) {
                    $expDt = date('Y-m-d H:i:s', $expiryTs);
                    if ($earliestExpiry === null || $expDt < $earliestExpiry) $earliestExpiry = $expDt;
                }
            }

            $cookies[] = $normalized;
        }
    }

    if ($totalNonEmpty > 0 && $netscapeLines >= ($totalNonEmpty * 0.5) && count($cookies) > 0) {
        return [
            'valid' => true,
            'cookies' => $cookies,
            'count' => count($cookies),
            'format' => 'netscape',
            'earliest_expiry' => $earliestExpiry,
        ];
    }

    return ['valid' => false, 'error' => 'Not Netscape format'];
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
        $shortLivedCookies = ['__cf_bm', '__stripe_sid', 'ud_country_code', 'eventing_session_id',
            '_gat', '_ga', '__cfduid', 'cf_clearance', '__cfuvid', '_uetsid', '_uetvid'];
        $expFields = ['expirationDate', 'expiry', 'expires_at', 'Expires', 'expires'];
        $foundExp = false;
        foreach ($expFields as $ef) {
            if (isset($cookie[$ef]) && !$foundExp) {
                $rawExp = $cookie[$ef];
                $ts = null;
                if (is_numeric($rawExp)) {
                    $ts = (int)$rawExp;
                    if ($ts > 9999999999) $ts = (int)($ts / 1000);
                    $normalized['expirationDate'] = $ts;
                    $foundExp = true;
                } elseif (is_string($rawExp) && !empty(trim($rawExp))) {
                    try {
                        $dt = new DateTime(trim($rawExp));
                        $ts = $dt->getTimestamp();
                        $normalized['expirationDate'] = $ts;
                        $foundExp = true;
                    } catch (Exception $e) {}
                }
                if ($ts !== null) {
                    $hoursUntilExpiry = ($ts - time()) / 3600;
                    $isShortLived = in_array($name, $shortLivedCookies, true)
                        || strpos($name, 'ud_cache_') === 0
                        || $hoursUntilExpiry < 24;
                    if (!$isShortLived) {
                        $expDt = date('Y-m-d H:i:s', $ts);
                        if ($earliestExpiry === null || $expDt < $earliestExpiry) $earliestExpiry = $expDt;
                    }
                }
            }
        }
        $valid[] = $normalized;
    }
    if (empty($valid)) return ['valid' => false, 'error' => 'No valid cookies found. ' . implode('; ', $errors)];
    return ['valid' => true, 'cookies' => $valid, 'count' => count($valid), 'format' => 'json_array', 'earliest_expiry' => $earliestExpiry];
}

function parsePlainCookieString(string $raw): array {
    $cookies = [];
    $skip = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly',
             'email', 'password', 'pass', 'pwd', 'plan', 'country', 'status', 'subscription', 'account', 'user'];
    $domainMap = getCookieNameToDomainMap();

    $delimiters = [';', '|'];
    $bestDelim = ';';
    $bestCount = 0;
    foreach ($delimiters as $d) {
        $c = substr_count($raw, $d);
        if ($c > $bestCount) { $bestCount = $c; $bestDelim = $d; }
    }

    $lines = preg_split('/\r?\n/', $raw);
    $allPairs = [];
    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') continue;
        if (preg_match('/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/', $line)) continue;
        $parts = array_filter(array_map('trim', explode($bestDelim, $line)));
        foreach ($parts as $part) {
            $allPairs[] = $part;
        }
    }

    foreach ($allPairs as $pair) {
        $eqPos = strpos($pair, '=');
        if ($eqPos === false || $eqPos < 1) continue;
        $name = trim(substr($pair, 0, $eqPos));
        $value = trim(substr($pair, $eqPos + 1));
        if (in_array(strtolower($name), $skip, true)) continue;

        $domain = $domainMap[strtolower($name)] ?? null;
        $cookies[] = ['name' => $name, 'value' => $value, 'domain' => $domain, 'path' => '/', 'secure' => true, 'httpOnly' => true, 'sameSite' => 'lax'];
    }

    if (empty($cookies)) return ['valid' => false, 'error' => 'No valid cookie pairs found.'];
    return ['valid' => true, 'cookies' => $cookies, 'count' => count($cookies), 'format' => 'plain_string', 'earliest_expiry' => null];
}

function extractDomainsFromCookies(array $parsed, string $rawInput): array {
    $domains = [];
    if ($parsed['valid'] && !empty($parsed['cookies'])) {
        foreach ($parsed['cookies'] as $cookie) {
            if (!empty($cookie['domain'])) {
                $d = strtolower(trim($cookie['domain']));
                if ($d !== '' && !in_array($d, $domains, true)) $domains[] = $d;
            }
        }
    }
    if (empty($domains)) {
        $jsonData = @json_decode($rawInput, true);
        if (is_array($jsonData)) {
            $items = isset($jsonData[0]) ? $jsonData : [$jsonData];
            foreach ($items as $item) {
                if (is_array($item) && !empty($item['domain'])) {
                    $d = strtolower(trim($item['domain']));
                    if ($d !== '' && !in_array($d, $domains, true)) $domains[] = $d;
                }
            }
        }
    }
    return $domains;
}

function getPlatformDefaultExpiryDays(string $platformName): int {
    $platformDefaults = [
        'netflix' => 30,
        'chatgpt' => 30,
        'openai' => 30,
        'coursera' => 30,
        'spotify' => 30,
        'disney' => 30,
        'disneyplus' => 30,
        'hbo' => 30,
        'hulu' => 30,
        'amazon' => 30,
        'prime' => 30,
        'youtube' => 30,
        'linkedin' => 30,
        'canva' => 30,
        'grammarly' => 30,
    ];
    $lower = strtolower(trim($platformName));
    foreach ($platformDefaults as $key => $days) {
        if (str_contains($lower, $key)) return $days;
    }
    return getDefaultExpiryDays();
}

function computeFallbackExpiry(string $platformName): string {
    $days = getPlatformDefaultExpiryDays($platformName);
    return date('Y-m-d H:i:s', strtotime("+{$days} days"));
}

function isExpiryAlreadyPassed(?string $expiresAt): bool {
    if (empty($expiresAt)) return false;
    try {
        return new DateTime($expiresAt) < new DateTime();
    } catch (Exception $e) {
        return false;
    }
}
