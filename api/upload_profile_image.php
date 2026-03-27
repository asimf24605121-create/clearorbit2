<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

$csrfToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? $_POST['csrf_token'] ?? '';
if (!$csrfToken || !isset($_SESSION['csrf_token']) || !hash_equals($_SESSION['csrf_token'], $csrfToken)) {
    jsonResponse(['success' => false, 'message' => 'Invalid CSRF token.'], 403);
}

if (!isset($_FILES['profile_image']) || $_FILES['profile_image']['error'] !== UPLOAD_ERR_OK) {
    $errorMsg = 'No file uploaded.';
    if (isset($_FILES['profile_image'])) {
        $errMap = [
            UPLOAD_ERR_INI_SIZE   => 'File exceeds server limit.',
            UPLOAD_ERR_FORM_SIZE  => 'File exceeds form limit.',
            UPLOAD_ERR_PARTIAL    => 'File was only partially uploaded.',
            UPLOAD_ERR_NO_FILE    => 'No file was uploaded.',
        ];
        $errorMsg = $errMap[$_FILES['profile_image']['error']] ?? 'Upload error.';
    }
    jsonResponse(['success' => false, 'message' => $errorMsg], 400);
}

$file = $_FILES['profile_image'];
$maxSize = 2 * 1024 * 1024;
if ($file['size'] > $maxSize) {
    jsonResponse(['success' => false, 'message' => 'File size must be under 2MB.'], 400);
}

$allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
$finfo = finfo_open(FILEINFO_MIME_TYPE);
$mimeType = finfo_file($finfo, $file['tmp_name']);
finfo_close($finfo);

if (!in_array($mimeType, $allowedTypes, true)) {
    jsonResponse(['success' => false, 'message' => 'Only JPG, PNG, and WebP images are allowed.'], 400);
}

$extMap = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
$ext = $extMap[$mimeType];
$userId = (int)$_SESSION['user_id'];
$filename = 'user_' . $userId . '_' . time() . '.' . $ext;
$uploadDir = __DIR__ . '/../uploads/profile/';

if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

$destination = $uploadDir . $filename;
if (!move_uploaded_file($file['tmp_name'], $destination)) {
    jsonResponse(['success' => false, 'message' => 'Failed to save file.'], 500);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT profile_image FROM users WHERE id = ?");
$stmt->execute([$userId]);
$oldImage = $stmt->fetchColumn();
if ($oldImage) {
    $oldPath = $uploadDir . basename($oldImage);
    if (file_exists($oldPath)) {
        @unlink($oldPath);
    }
}

$relativePath = 'uploads/profile/' . $filename;
$pdo->prepare("UPDATE users SET profile_image = ? WHERE id = ?")->execute([$relativePath, $userId]);

logActivity($userId, "profile_image_updated", getClientIP());

jsonResponse(['success' => true, 'message' => 'Profile image uploaded.', 'image_path' => $relativePath]);
