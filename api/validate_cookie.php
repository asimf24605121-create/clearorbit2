<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

$pdo = getPDO();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    validateCsrfToken();

    $input = json_decode(file_get_contents('php://input'), true);
    $action = $input['action'] ?? 'validate';

    if ($action === 'validate_raw') {
        $cookieData = trim($input['cookie_data'] ?? '');
        $expiresAt = trim($input['expires_at'] ?? '');
        $platformId = (int)($input['platform_id'] ?? 0);

        if ($cookieData === '') {
            jsonResponse(['success' => true, 'cookie_status' => 'DEAD', 'reason' => 'Cookie data is empty.']);
        }

        $result = performCookieValidation($cookieData, $expiresAt, $platformId, $pdo);
        jsonResponse(['success' => true] + $result);
    }

    if ($action === 'recheck') {
        $accountId = (int)($input['account_id'] ?? 0);
        if ($accountId < 1) {
            jsonResponse(['success' => false, 'message' => 'Account ID is required.'], 400);
        }

        $acct = $pdo->prepare("
            SELECT pa.*, p.name AS platform_name, p.cookie_domain,
                   cv.cookie_string AS vault_cookie_string
            FROM platform_accounts pa
            JOIN platforms p ON p.id = pa.platform_id
            LEFT JOIN cookie_vault cv ON cv.id = pa.cookie_id
            WHERE pa.id = ?
        ");
        $acct->execute([$accountId]);
        $acct = $acct->fetch();
        if (!$acct) {
            jsonResponse(['success' => false, 'message' => 'Account not found.'], 404);
        }

        $effectiveCookie = resolveAccountCookieData($acct);
        $result = performCookieValidation($effectiveCookie, $acct['expires_at'], (int)$acct['platform_id'], $pdo);
        $newStatus = $result['cookie_status'];
        $loginStatus = $result['checks']['login_status'] ?? null;
        $verifiedAt = $loginStatus ? date('Y-m-d H:i:s') : null;

        $now = date('Y-m-d H:i:s');
        $cascadeCount = 0;

        if (!empty($acct['cookie_id'])) {
            updateVaultStatus($pdo, (int)$acct['cookie_id'], $newStatus, $loginStatus);
            $cascadeCount = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE cookie_id = ?");
            $cascadeCount->execute([$acct['cookie_id']]);
            $cascadeCount = (int)$cascadeCount->fetchColumn();
        } else {
            if ($newStatus === 'EXPIRED' || $newStatus === 'DEAD') {
                $pdo->prepare("UPDATE platform_accounts SET cookie_status = ?, is_active = 0, login_status = COALESCE(?, login_status), last_verified_at = COALESCE(?, last_verified_at), updated_at = ? WHERE id = ?")
                    ->execute([$newStatus, $loginStatus, $verifiedAt, $now, $accountId]);
                $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")
                    ->execute([$accountId]);
            } else {
                $pdo->prepare("UPDATE platform_accounts SET cookie_status = ?, is_active = 1, login_status = COALESCE(?, login_status), last_verified_at = COALESCE(?, last_verified_at), updated_at = ? WHERE id = ?")
                    ->execute([$newStatus, $loginStatus, $verifiedAt, $now, $accountId]);
            }
            $cascadeCount = 1;
        }

        logActivity($_SESSION['user_id'], "cookie_recheck: account_id={$accountId} platform={$acct['platform_name']} status={$newStatus} cascaded={$cascadeCount}" . ($loginStatus ? " login={$loginStatus}" : ''), getClientIP());

        jsonResponse([
            'success' => true,
            'account_id' => $accountId,
            'cookie_status' => $newStatus,
            'login_status' => $loginStatus,
            'reason' => $result['reason'],
            'checks' => $result['checks'] ?? [],
            'cascaded_slots' => $cascadeCount,
            'message' => "Cookie status updated to {$newStatus}." . ($cascadeCount > 1 ? " Cascaded to {$cascadeCount} slots." : '') . ($loginStatus ? " Login: {$loginStatus}." : ''),
        ]);
    }

    if ($action === 'recheck_all') {
        $platformId = (int)($input['platform_id'] ?? 0);
        $where = $platformId > 0 ? "WHERE pa.platform_id = ?" : "";
        $params = $platformId > 0 ? [$platformId] : [];

        $stmt = $pdo->prepare("
            SELECT pa.id, pa.cookie_data, pa.expires_at, pa.platform_id, pa.cookie_status, pa.cookie_id,
                   cv.cookie_string AS vault_cookie_string,
                   p.name AS platform_name, p.cookie_domain
            FROM platform_accounts pa
            JOIN platforms p ON p.id = pa.platform_id
            LEFT JOIN cookie_vault cv ON cv.id = pa.cookie_id
            {$where}
        ");
        $stmt->execute($params);
        $accounts = $stmt->fetchAll();

        $results = ['total' => count($accounts), 'updated' => 0, 'cascaded' => 0, 'statuses' => ['VALID' => 0, 'EXPIRED' => 0, 'DEAD' => 0, 'RISKY' => 0]];
        $now = date('Y-m-d H:i:s');
        $processedVaultIds = [];

        foreach ($accounts as $acct) {
            if (!empty($acct['cookie_id']) && in_array((int)$acct['cookie_id'], $processedVaultIds)) {
                continue;
            }

            $effectiveCookie = resolveAccountCookieData($acct);
            $result = performCookieValidation($effectiveCookie, $acct['expires_at'], (int)$acct['platform_id'], $pdo);
            $newStatus = $result['cookie_status'];
            $loginStatus = $result['checks']['login_status'] ?? null;
            $verifiedAt = $loginStatus ? $now : null;
            $results['statuses'][$newStatus] = ($results['statuses'][$newStatus] ?? 0) + 1;

            if ($newStatus !== ($acct['cookie_status'] ?? 'VALID')) {
                if (!empty($acct['cookie_id'])) {
                    updateVaultStatus($pdo, (int)$acct['cookie_id'], $newStatus, $loginStatus);
                    $processedVaultIds[] = (int)$acct['cookie_id'];
                    $cascadeStmt = $pdo->prepare("SELECT COUNT(*) FROM platform_accounts WHERE cookie_id = ?");
                    $cascadeStmt->execute([$acct['cookie_id']]);
                    $results['cascaded'] += (int)$cascadeStmt->fetchColumn();
                } else {
                    if ($newStatus === 'EXPIRED' || $newStatus === 'DEAD') {
                        $pdo->prepare("UPDATE platform_accounts SET cookie_status = ?, is_active = 0, login_status = COALESCE(?, login_status), last_verified_at = COALESCE(?, last_verified_at), updated_at = ? WHERE id = ?")
                            ->execute([$newStatus, $loginStatus, $verifiedAt, $now, $acct['id']]);
                        $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")
                            ->execute([$acct['id']]);
                    } else {
                        $pdo->prepare("UPDATE platform_accounts SET cookie_status = ?, is_active = 1, login_status = COALESCE(?, login_status), last_verified_at = COALESCE(?, last_verified_at), updated_at = ? WHERE id = ?")
                            ->execute([$newStatus, $loginStatus, $verifiedAt, $now, $acct['id']]);
                    }
                }
                $results['updated']++;
            } elseif ($loginStatus) {
                if (!empty($acct['cookie_id'])) {
                    updateVaultStatus($pdo, (int)$acct['cookie_id'], $newStatus, $loginStatus);
                    $processedVaultIds[] = (int)$acct['cookie_id'];
                } else {
                    $pdo->prepare("UPDATE platform_accounts SET login_status = ?, last_verified_at = ?, updated_at = ? WHERE id = ?")
                        ->execute([$loginStatus, $verifiedAt, $now, $acct['id']]);
                }
            }
        }

        logActivity($_SESSION['user_id'], "cookie_recheck_all: total={$results['total']} updated={$results['updated']} cascaded={$results['cascaded']}" . ($platformId > 0 ? " platform_id={$platformId}" : ''), getClientIP());

        jsonResponse(['success' => true, 'message' => "Rechecked {$results['total']} slots. {$results['updated']} status(es) changed." . ($results['cascaded'] > 0 ? " {$results['cascaded']} slots cascaded." : ''), 'results' => $results]);
    }

    jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);
}

jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);

function performCookieValidation(string $cookieData, ?string $expiresAt, int $platformId, PDO $pdo): array {
    $checks = [];
    $status = 'VALID';
    $reason = '';

    $cookieData = trim($cookieData);
    if ($cookieData === '' || $cookieData === '[]' || $cookieData === 'null') {
        return ['cookie_status' => 'DEAD', 'reason' => 'Cookie data is empty or null.', 'checks' => ['empty' => true]];
    }

    $raw = $cookieData;
    $decoded = @base64_decode($raw, true);
    if ($decoded !== false && strlen($decoded) > 2) {
        $raw = $decoded;
    }

    $json = @json_decode($raw, true);
    $cookies = [];

    if (is_array($json) && !empty($json)) {
        if (isset($json[0]) && is_array($json[0])) {
            $cookies = $json;
        } elseif (isset($json['name'])) {
            $cookies = [$json];
        }
    }

    if (!empty($cookies)) {
        $validCookies = array_filter($cookies, function($c) {
            return !empty($c['name']) && isset($c['value']) && trim($c['value']) !== '';
        });

        if (empty($validCookies)) {
            return ['cookie_status' => 'DEAD', 'reason' => 'All cookies have empty values.', 'checks' => ['structure' => false, 'empty_values' => true]];
        }

        $checks['structure'] = true;
        $checks['cookie_count'] = count($validCookies);
        $checks['total_parsed'] = count($cookies);

        $sessionTokens = getSessionTokenKeys();
        $hasSessionToken = false;
        $foundTokens = [];

        foreach ($validCookies as $c) {
            $name = strtolower($c['name'] ?? '');
            if (in_array($name, $sessionTokens, true)) {
                $hasSessionToken = true;
                $foundTokens[] = $c['name'];
            }
        }

        $checks['has_session_token'] = $hasSessionToken;
        $checks['found_tokens'] = $foundTokens;

        if (!$hasSessionToken) {
            $status = 'RISKY';
            $reason = 'No recognized session token found (e.g., NetflixId, sp_dc). Cookie may not authenticate.';
        }

        $hasExpiredCookie = false;
        $allExpired = true;
        $now = time();

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
            $checks['all_cookies_expired'] = true;
            return ['cookie_status' => 'EXPIRED', 'reason' => 'All cookies have expired based on expirationDate.', 'checks' => $checks];
        }

        if ($hasExpiredCookie) {
            $checks['some_cookies_expired'] = true;
            if ($status !== 'RISKY') {
                $status = 'RISKY';
                $reason = 'Some cookies have expired expirationDate values.';
            }
        }

        if ($platformId > 0) {
            $platStmt = $pdo->prepare("SELECT cookie_domain FROM platforms WHERE id = ?");
            $platStmt->execute([$platformId]);
            $platRow = $platStmt->fetch();

            if ($platRow && !empty($platRow['cookie_domain'])) {
                $platDomain = ltrim($platRow['cookie_domain'], '.');
                $domainMatch = false;

                foreach ($validCookies as $c) {
                    if (!empty($c['domain'])) {
                        $cookieDom = ltrim($c['domain'], '.');
                        if ($cookieDom === $platDomain || str_ends_with($cookieDom, '.' . $platDomain) || str_ends_with($platDomain, '.' . $cookieDom)) {
                            $domainMatch = true;
                            break;
                        }
                    }
                }

                $checks['domain_match'] = $domainMatch;
                if (!$domainMatch) {
                    $hasDomains = !empty(array_filter(array_column($validCookies, 'domain')));
                    if ($hasDomains) {
                        $status = 'RISKY';
                        $reason = "Cookie domains don't match platform domain ({$platRow['cookie_domain']}).";
                    }
                }
            }
        }
    } elseif (strlen($raw) > 3 && strpos($raw, '=') !== false) {
        $checks['structure'] = true;
        $checks['format'] = 'plain_string';
        $pairs = array_filter(array_map('trim', explode(';', $raw)));
        $skipKeys = ['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'];
        $validPairs = [];
        foreach ($pairs as $pair) {
            $eqPos = strpos($pair, '=');
            if ($eqPos === false || $eqPos < 1) continue;
            $name = trim(substr($pair, 0, $eqPos));
            if (in_array(strtolower($name), $skipKeys, true)) continue;
            $validPairs[] = $name;
        }
        $checks['cookie_count'] = count($validPairs);

        if (empty($validPairs)) {
            return ['cookie_status' => 'DEAD', 'reason' => 'No valid cookie pairs found in plain string.', 'checks' => $checks];
        }

        $sessionTokens = getSessionTokenKeys();
        $hasSessionToken = false;
        foreach ($validPairs as $name) {
            if (in_array(strtolower($name), $sessionTokens, true)) {
                $hasSessionToken = true;
                break;
            }
        }
        $checks['has_session_token'] = $hasSessionToken;
        if (!$hasSessionToken) {
            $status = 'RISKY';
            $reason = 'No recognized session token found in plain cookie string.';
        }
    } else {
        return ['cookie_status' => 'DEAD', 'reason' => 'Cookie data is not valid JSON or cookie string format.', 'checks' => ['structure' => false]];
    }

    if (!empty($expiresAt)) {
        try {
            $expiryDt = new DateTime($expiresAt);
            $nowDt = new DateTime();

            if ($expiryDt < $nowDt) {
                $checks['slot_expired'] = true;
                return ['cookie_status' => 'EXPIRED', 'reason' => 'Slot expiry date has passed (' . $expiresAt . ').', 'checks' => $checks];
            }

            $daysLeft = (int)$nowDt->diff($expiryDt)->days;
            $checks['days_until_expiry'] = $daysLeft;

            if ($daysLeft <= 2 && $status === 'VALID') {
                $status = 'RISKY';
                $reason = "Cookie expires in {$daysLeft} day(s) — consider updating.";
            }
        } catch (Exception $e) {
            $checks['expiry_parse_error'] = true;
        }
    }

    if ($reason === '' && $status === 'VALID') {
        $reason = 'All validation checks passed.';
    }

    if ($status === 'VALID' || $status === 'RISKY') {
        if ($platformId > 0) {
            $domStmt = $pdo->prepare("SELECT cookie_domain FROM platforms WHERE id = ?");
            $domStmt->execute([$platformId]);
            $domRow = $domStmt->fetch();
            $platformDomain = $domRow['cookie_domain'] ?? '';

            if (!empty($platformDomain) && strtolower(trim($platformDomain, '.')) === 'netflix.com') {
                require_once __DIR__ . '/../lib/LoginVerifier.php';
                $loginResult = LoginVerifier::verify($cookieData, $platformDomain);
                $checks['login_status'] = $loginResult['login_status'];
                $checks['login_reason'] = $loginResult['reason'];
                $checks['login_checks'] = $loginResult['checks'];

                if ($loginResult['login_status'] === 'INVALID') {
                    $status = 'DEAD';
                    $reason = 'Login verification failed: ' . $loginResult['reason'];
                } elseif ($loginResult['login_status'] === 'PARTIAL' && $status === 'VALID') {
                    $status = 'RISKY';
                    $reason = 'Login partially verified: ' . $loginResult['reason'];
                }
            }
        }
    }

    return ['cookie_status' => $status, 'reason' => $reason, 'checks' => $checks];
}

function getSessionTokenKeys(): array {
    return [
        'netflixid', 'securenetflixid',
        'sp_dc', 'sp_key',
        'disney_token', 'dss_id',
        '__secure-next-auth.session-token', 'session_token', 'sessionid',
        'auth_token', 'access_token',
        'user_id', 'uid', 'account_id',
        'login_token', 'cf_clearance',
        'csrftoken', 'csrf_token',
        'connect.sid',
        'laravel_session', 'phpsessid',
        '_ga_session', 'jsessionid',
        'sb-access-token', 'sb-refresh-token',
        'canva_session', 'chatgpt_session',
        'li_at', 'li_mc',
        'udemy_session',
        'cauth', 'maestro_login',
    ];
}
