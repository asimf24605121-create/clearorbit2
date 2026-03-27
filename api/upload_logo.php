<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

$csrfToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? $_POST['csrf_token'] ?? '';
if (session_status() !== PHP_SESSION_ACTIVE) {
    session_start();
}
if (empty($_SESSION['csrf_token']) || !hash_equals($_SESSION['csrf_token'], $csrfToken)) {
    jsonResponse(['success' => false, 'message' => 'Invalid or missing CSRF token.'], 403);
}

if (!isset($_FILES['logo']) || $_FILES['logo']['error'] !== UPLOAD_ERR_OK) {
    jsonResponse(['success' => false, 'message' => 'No file uploaded or upload error.'], 400);
}

$file = $_FILES['logo'];
$allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp', 'image/gif'];
$finfo = finfo_open(FILEINFO_MIME_TYPE);
$mimeType = finfo_file($finfo, $file['tmp_name']);
finfo_close($finfo);

if (!in_array($mimeType, $allowed, true)) {
    jsonResponse(['success' => false, 'message' => 'Invalid file type. Allowed: PNG, JPG, SVG, WebP, GIF.'], 400);
}

if ($file['size'] > 2 * 1024 * 1024) {
    jsonResponse(['success' => false, 'message' => 'File too large. Max 2MB.'], 400);
}

$ext = match ($mimeType) {
    'image/png' => 'png',
    'image/jpeg', 'image/jpg' => 'jpg',
    'image/svg+xml' => 'svg',
    'image/webp' => 'webp',
    'image/gif' => 'gif',
    default => 'png',
};

$uploadDir = __DIR__ . '/../uploads/';
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

$filename = 'logo_' . bin2hex(random_bytes(8)) . '.' . $ext;
$destPath = $uploadDir . $filename;

if (!move_uploaded_file($file['tmp_name'], $destPath)) {
    jsonResponse(['success' => false, 'message' => 'Failed to save file.'], 500);
}

$relativePath = 'uploads/' . $filename;

logActivity($_SESSION['user_id'], "logo_uploaded: {$filename}", getClientIP());

jsonResponse([
    'success'  => true,
    'message'  => 'Logo uploaded successfully.',
    'logo_url' => $relativePath,
]);
