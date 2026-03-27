<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/LoginVerifier.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$pdo = getPDO();
$input = json_decode(file_get_contents('php://input'), true);
$action = $input['action'] ?? 'verify_single';

if ($action === 'verify_raw') {
    $cookieData = trim($input['cookie_data'] ?? '');
    $domain = trim($input['domain'] ?? '.netflix.com');

    if ($cookieData === '') {
        jsonResponse(['success' => true, 'login_status' => 'INVALID', 'reason' => 'No cookie data provided.']);
    }

    $result = LoginVerifier::verify($cookieData, $domain);
    jsonResponse(['success' => true] + $result);
}

if ($action === 'verify_single') {
    $accountId = (int)($input['account_id'] ?? 0);
    if ($accountId < 1) {
        jsonResponse(['success' => false, 'message' => 'account_id is required.'], 400);
    }

    $acct = $pdo->prepare("SELECT pa.*, p.name AS platform_name, p.cookie_domain FROM platform_accounts pa JOIN platforms p ON p.id = pa.platform_id WHERE pa.id = ?");
    $acct->execute([$accountId]);
    $account = $acct->fetch();

    if (!$account) {
        jsonResponse(['success' => false, 'message' => 'Account not found.'], 404);
    }

    $domain = $account['cookie_domain'] ?? '';
    if (empty($domain) || strtolower(trim($domain, '.')) !== 'netflix.com') {
        jsonResponse(['success' => true, 'account_id' => $accountId, 'login_status' => 'PENDING', 'reason' => 'Login verification is only supported for Netflix accounts.', 'checks' => [], 'message' => 'Platform not supported for login verification.']);
    }
    $result = LoginVerifier::verify($account['cookie_data'], $domain);
    $now = date('Y-m-d H:i:s');
    $loginStatus = $result['login_status'];

    if ($loginStatus === 'INVALID') {
        $pdo->prepare("UPDATE platform_accounts SET login_status = ?, last_verified_at = ?, is_active = 0, cookie_status = 'DEAD', updated_at = ? WHERE id = ?")
            ->execute([$loginStatus, $now, $now, $accountId]);
        $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")
            ->execute([$accountId]);
    } else {
        $pdo->prepare("UPDATE platform_accounts SET login_status = ?, last_verified_at = ?, updated_at = ? WHERE id = ?")
            ->execute([$loginStatus, $now, $now, $accountId]);
    }

    logActivity($_SESSION['user_id'], "login_verify: account_id={$accountId} platform={$account['platform_name']} status={$loginStatus}", getClientIP());

    jsonResponse([
        'success' => true,
        'account_id' => $accountId,
        'platform_name' => $account['platform_name'],
        'login_status' => $loginStatus,
        'reason' => $result['reason'],
        'checks' => $result['checks'],
        'message' => "Login verification: {$loginStatus}",
    ]);
}

if ($action === 'verify_all') {
    $platformId = (int)($input['platform_id'] ?? 0);
    if ($platformId > 0) {
        $where = "WHERE pa.platform_id = ? AND LOWER(TRIM(p.cookie_domain, '.')) = 'netflix.com'";
        $params = [$platformId];
    } else {
        $where = "WHERE LOWER(TRIM(p.cookie_domain, '.')) = 'netflix.com'";
        $params = [];
    }

    $stmt = $pdo->prepare("SELECT pa.id, pa.cookie_data, pa.login_status, p.name AS platform_name, p.cookie_domain FROM platform_accounts pa JOIN platforms p ON p.id = pa.platform_id {$where}");
    $stmt->execute($params);
    $accounts = $stmt->fetchAll();

    $results = ['total' => count($accounts), 'verified' => 0, 'statuses' => ['VALID' => 0, 'PARTIAL' => 0, 'INVALID' => 0]];
    $now = date('Y-m-d H:i:s');

    foreach ($accounts as $acct) {
        $domain = $acct['cookie_domain'] ?? '.netflix.com';
        $result = LoginVerifier::verify($acct['cookie_data'], $domain);
        $loginStatus = $result['login_status'];
        $results['statuses'][$loginStatus] = ($results['statuses'][$loginStatus] ?? 0) + 1;

        if ($loginStatus === 'INVALID') {
            $pdo->prepare("UPDATE platform_accounts SET login_status = ?, last_verified_at = ?, is_active = 0, cookie_status = 'DEAD', updated_at = ? WHERE id = ?")
                ->execute([$loginStatus, $now, $now, $acct['id']]);
            $pdo->prepare("UPDATE account_sessions SET status = 'inactive' WHERE account_id = ? AND status = 'active'")
                ->execute([$acct['id']]);
        } else {
            $pdo->prepare("UPDATE platform_accounts SET login_status = ?, last_verified_at = ?, updated_at = ? WHERE id = ?")
                ->execute([$loginStatus, $now, $now, $acct['id']]);
        }
        $results['verified']++;
    }

    logActivity($_SESSION['user_id'], "login_verify_all: total={$results['total']} VALID={$results['statuses']['VALID']} PARTIAL={$results['statuses']['PARTIAL']} INVALID={$results['statuses']['INVALID']}" . ($platformId > 0 ? " platform_id={$platformId}" : ''), getClientIP());

    jsonResponse([
        'success' => true,
        'message' => "Verified {$results['total']} accounts. VALID: {$results['statuses']['VALID']}, PARTIAL: {$results['statuses']['PARTIAL']}, INVALID: {$results['statuses']['INVALID']}.",
        'results' => $results,
    ]);
}

jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);
