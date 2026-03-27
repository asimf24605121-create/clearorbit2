<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/GeoIPService.php';

session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$username  = trim($input['username']  ?? '');
$password  = trim($input['password']  ?? '');
$device_id = trim($input['device_id'] ?? '');

if ($username === '' || $password === '') {
    jsonResponse(['success' => false, 'message' => 'Username and password are required.'], 400);
}

$ip = getClientIP();
$ua = $_SERVER['HTTP_USER_AGENT'] ?? 'Unknown';
$parsed = parseUserAgent($ua);
$deviceType = $parsed['device_type'];

checkRateLimit($ip);

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, username, password_hash, role, is_active, device_id, admin_level FROM users WHERE username = ?");
$stmt->execute([$username]);
$user = $stmt->fetch();

if (!$user || !password_verify($password, $user['password_hash'])) {
    recordLoginAttempt($ip);
    logLoginAttempt($username, $ip, $ua, 'failed', 'Invalid credentials');
    jsonResponse(['success' => false, 'message' => 'Invalid credentials.'], 401);
}

if (!(int)$user['is_active']) {
    logLoginAttempt($username, $ip, $ua, 'disabled', 'Account disabled');
    jsonResponse(['success' => false, 'message' => 'Your account has been disabled.'], 403);
}

if ($user['role'] === 'user' || $user['role'] === 'reseller') {
    if ($device_id === '') {
        jsonResponse(['success' => false, 'message' => 'Device fingerprint missing.'], 400);
    }

    $existingSession = getActiveSessionByDeviceType((int)$user['id'], $deviceType);

    if ($existingSession) {
        deactivateUserSession($existingSession['session_token'], 'Another device login detected');
        logLoginHistory((int)$user['id'], 'force_logout', $existingSession['ip_address'], 'System: replaced by new ' . $deviceType . ' login');
        logActivity((int)$user['id'], 'session_replaced_' . $deviceType, $ip);
    }

    $otherType = ($deviceType === 'mobile') ? 'desktop' : 'mobile';
    $otherSession = getActiveSessionByDeviceType((int)$user['id'], $otherType);
    $tabletSession = ($deviceType !== 'tablet') ? getActiveSessionByDeviceType((int)$user['id'], 'tablet') : null;

    $activeDeviceTypes = [];
    if ($otherSession) $activeDeviceTypes[] = $otherType;
    if ($tabletSession) $activeDeviceTypes[] = 'tablet';
}

clearLoginAttempts($ip);

$pdo->prepare("UPDATE users SET last_login_ip = ? WHERE id = ?")->execute([$ip, $user['id']]);

autoExpireSubscriptions();

session_regenerate_id(true);
$_SESSION['user_id']     = $user['id'];
$_SESSION['username']    = $user['username'];
$_SESSION['role']        = $user['role'];
$_SESSION['admin_level'] = $user['admin_level'] ?? null;
$_SESSION['csrf_token']  = bin2hex(random_bytes(32));

$sessionToken = createUserSession((int)$user['id'], $device_id ?: 'admin_' . bin2hex(random_bytes(8)), $ip, $ua);
$_SESSION['session_token'] = $sessionToken;

logLoginHistory((int)$user['id'], 'login', $ip, $ua);
logActivity($user['id'], 'login', $ip);
logLoginAttempt($username, $ip, $ua, 'success', null);

$geo = GeoIPService::lookup($ip, $pdo);
$risk = GeoIPService::assessRisk($pdo, (int)$user['id'], $ip);

if ($risk['risk_level'] === 'HIGH') {
    GeoIPService::logSecurityEvent($pdo, (int)$user['id'], 'high_risk_login', 'high', $ip, [
        'reasons' => $risk['reasons'],
        'flags' => $risk['flags'],
        'geo' => $geo,
    ]);
} elseif ($risk['is_new_ip']) {
    GeoIPService::logSecurityEvent($pdo, (int)$user['id'], 'new_ip_login', 'low', $ip, [
        'country' => $geo['country'],
        'city' => $geo['city'],
    ]);
}

jsonResponse([
    'success'       => true,
    'role'          => $user['role'],
    'admin_level'   => $user['admin_level'] ?? null,
    'user_id'       => (int)$user['id'],
    'username'      => $user['username'],
    'csrf_token'    => $_SESSION['csrf_token'],
    'message'       => 'Login successful.',
    'device_info'   => [
        'device_type' => $parsed['device_type'],
        'browser'     => $parsed['browser'],
        'os'          => $parsed['os'],
    ],
    'session_timeout_minutes' => SESSION_INACTIVITY_TIMEOUT_MINUTES,
    'geo' => [
        'country' => $geo['country'],
        'city' => $geo['city'],
        'region' => $geo['region'],
        'isp' => $geo['isp'],
        'country_code' => $geo['country_code'],
    ],
    'risk_level' => $risk['risk_level'],
]);
