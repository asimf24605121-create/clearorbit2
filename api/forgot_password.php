<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../vendor/autoload.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\SMTP;
use PHPMailer\PHPMailer\Exception;

session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$email = trim($input['email'] ?? '');

if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    jsonResponse(['success' => false, 'message' => 'Please enter a valid email address.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, username, name, email FROM users WHERE email = ? AND is_active = 1");
$stmt->execute([$email]);
$user = $stmt->fetch();

if (!$user) {
    jsonResponse(['success' => true, 'message' => 'If an account with that email exists, a reset link has been sent.']);
}

$pdo->prepare("UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0")->execute([$user['id']]);

$token = bin2hex(random_bytes(32));
$expiresAt = date('Y-m-d H:i:s', strtotime('+15 minutes'));

$pdo->prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)")
    ->execute([$user['id'], $token, $expiresAt]);

$baseUrl = getenv('APP_BASE_URL') ?: (getenv('REPLIT_DEV_DOMAIN') ? 'https://' . getenv('REPLIT_DEV_DOMAIN') : null);
if (!$baseUrl) {
    $allowedHosts = ['localhost', '127.0.0.1'];
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $hostWithoutPort = explode(':', $host)[0];
    if (!in_array($hostWithoutPort, $allowedHosts, true) && !preg_match('/\.replit\.dev$/', $hostWithoutPort)) {
        $host = 'localhost';
    }
    $scheme = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http';
    $baseUrl = $scheme . '://' . $host;
}
$resetUrl = rtrim($baseUrl, '/') . '/reset_password.html?token=' . $token;

$smtpHost = getenv('SMTP_HOST');
$smtpUser = getenv('SMTP_USER');
$smtpPass = getenv('SMTP_PASS');
$smtpConfigured = $smtpHost && $smtpUser && $smtpPass;

$isDev = getenv('REPLIT_DEV_DOMAIN') || getenv('APP_DEBUG');

if ($smtpConfigured) {
    try {
        $mail = new PHPMailer(true);
        $mail->isSMTP();
        $mail->Host       = $smtpHost;
        $mail->SMTPAuth   = true;
        $mail->Username   = $smtpUser;
        $mail->Password   = $smtpPass;
        $mail->SMTPSecure = getenv('SMTP_SECURE') ?: PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Port       = (int)(getenv('SMTP_PORT') ?: 587);

        $mail->setFrom(getenv('SMTP_FROM') ?: $smtpUser, 'ClearOrbit');
        $mail->addAddress($user['email'], $user['name'] ?: $user['username']);

        $mail->isHTML(true);
        $mail->Subject = 'Reset Your Password';
        $mail->Body    = '
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:20px">
                <h2 style="color:#4F46E5">ClearOrbit Password Reset</h2>
                <p>Hi ' . htmlspecialchars($user['name'] ?: $user['username']) . ',</p>
                <p>Click the link below to reset your password:</p>
                <p style="text-align:center;margin:24px 0">
                    <a href="' . $resetUrl . '" style="background:#4F46E5;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">Reset Password</a>
                </p>
                <p style="color:#666;font-size:13px">This link expires in 15 minutes. If you didn\'t request this, you can safely ignore this email.</p>
                <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
                <p style="color:#999;font-size:12px">&copy; ClearOrbit. All rights reserved.</p>
            </div>';
        $mail->AltBody = "Reset your password: {$resetUrl}\nThis link expires in 15 minutes.";
        $mail->send();

        logActivity($user['id'], 'password_reset_requested', getClientIP());

        jsonResponse([
            'success' => true,
            'message' => 'If an account with that email exists, a reset link has been sent.',
        ]);

    } catch (Exception $e) {
        error_log("PHPMailer error: " . $e->getMessage());

        $pdo->prepare("UPDATE password_reset_tokens SET used = 1 WHERE token = ?")->execute([$token]);

        jsonResponse([
            'success' => false,
            'message' => 'Failed to send reset email. Please try again later or contact support.',
        ], 500);
    }
} else {
    logActivity($user['id'], 'password_reset_requested', getClientIP());

    if ($isDev) {
        jsonResponse([
            'success' => true,
            'message' => 'SMTP not configured. In development mode, use the reset link below.',
            'debug_reset_url' => $resetUrl,
        ]);
    } else {
        $pdo->prepare("UPDATE password_reset_tokens SET used = 1 WHERE token = ?")->execute([$token]);

        jsonResponse([
            'success' => false,
            'message' => 'Email service is not configured. Please contact the administrator.',
        ], 500);
    }
}
