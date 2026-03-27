<?php
require_once __DIR__ . '/../db.php';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $token = $_GET['token'] ?? '';
    if ($token === '') {
        jsonResponse(['success' => false, 'message' => 'Token is required.'], 400);
    }

    $pdo = getPDO();
    $stmt = $pdo->prepare("SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.username, u.name
                           FROM password_reset_tokens prt
                           INNER JOIN users u ON u.id = prt.user_id
                           WHERE prt.token = ?");
    $stmt->execute([$token]);
    $record = $stmt->fetch();

    if (!$record) {
        jsonResponse(['success' => false, 'message' => 'Invalid reset token.'], 404);
    }
    if ($record['used']) {
        jsonResponse(['success' => false, 'message' => 'This reset link has already been used.'], 400);
    }
    if (strtotime($record['expires_at']) < time()) {
        jsonResponse(['success' => false, 'message' => 'This reset link has expired. Please request a new one.'], 400);
    }

    jsonResponse([
        'success'  => true,
        'username' => $record['username'],
        'name'     => $record['name'],
    ]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    $token    = trim($input['token'] ?? '');
    $password = $input['password'] ?? '';

    if ($token === '' || $password === '') {
        jsonResponse(['success' => false, 'message' => 'Token and new password are required.'], 400);
    }

    if (strlen($password) < 6) {
        jsonResponse(['success' => false, 'message' => 'Password must be at least 6 characters.'], 400);
    }

    $pdo = getPDO();
    $stmt = $pdo->prepare("SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.username
                           FROM password_reset_tokens prt
                           INNER JOIN users u ON u.id = prt.user_id
                           WHERE prt.token = ?");
    $stmt->execute([$token]);
    $record = $stmt->fetch();

    if (!$record) {
        jsonResponse(['success' => false, 'message' => 'Invalid reset token.'], 404);
    }
    if ($record['used']) {
        jsonResponse(['success' => false, 'message' => 'This reset link has already been used.'], 400);
    }
    if (strtotime($record['expires_at']) < time()) {
        jsonResponse(['success' => false, 'message' => 'This reset link has expired.'], 400);
    }

    $hash = password_hash($password, PASSWORD_BCRYPT);
    $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ?")->execute([$hash, $record['user_id']]);
    $pdo->prepare("UPDATE password_reset_tokens SET used = 1 WHERE id = ?")->execute([$record['id']]);

    $pdo->prepare("UPDATE user_sessions SET status = 'inactive', logout_reason = 'Password was reset' WHERE user_id = ? AND status = 'active'")
        ->execute([$record['user_id']]);

    logActivity($record['user_id'], 'password_reset_completed', getClientIP());

    jsonResponse([
        'success' => true,
        'message' => 'Password has been reset successfully. You can now log in with your new password.',
    ]);
}

jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
