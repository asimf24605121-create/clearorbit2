<?php
require_once __DIR__ . '/../db.php';

session_start();

if (empty($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 403);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

if (!isset($_FILES['screenshot'])) {
    jsonResponse(['success' => false, 'message' => 'No file uploaded.'], 400);
}

$file = $_FILES['screenshot'];
$paymentId = isset($_POST['payment_id']) ? (int)$_POST['payment_id'] : 0;

if ($file['error'] !== UPLOAD_ERR_OK) {
    jsonResponse(['success' => false, 'message' => 'Upload error.'], 400);
}

$maxSize = 5 * 1024 * 1024;
if ($file['size'] > $maxSize) {
    jsonResponse(['success' => false, 'message' => 'File too large. Max 5MB.'], 400);
}

$allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime = $finfo->file($file['tmp_name']);
if (!in_array($mime, $allowed)) {
    jsonResponse(['success' => false, 'message' => 'Only images are allowed (JPEG, PNG, WebP, GIF).'], 400);
}

$ext = match($mime) {
    'image/jpeg' => 'jpg',
    'image/png' => 'png',
    'image/webp' => 'webp',
    'image/gif' => 'gif',
    default => 'jpg',
};

$uploadDir = __DIR__ . '/../uploads/screenshots/';
if (!is_dir($uploadDir)) {
    mkdir($uploadDir, 0755, true);
}

$filename = 'ss_' . time() . '_' . bin2hex(random_bytes(4)) . '.' . $ext;
$destination = $uploadDir . $filename;

if (!move_uploaded_file($file['tmp_name'], $destination)) {
    jsonResponse(['success' => false, 'message' => 'Failed to save file.'], 500);
}

$relativePath = 'uploads/screenshots/' . $filename;

if ($paymentId > 0) {
    $pdo = getPDO();
    $pdo->prepare("UPDATE payments SET screenshot = ? WHERE id = ?")
        ->execute([$relativePath, $paymentId]);
}

jsonResponse([
    'success' => true,
    'message' => 'Screenshot uploaded successfully.',
    'path' => $relativePath,
]);
