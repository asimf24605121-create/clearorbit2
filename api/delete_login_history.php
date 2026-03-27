<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();
validateCsrfToken();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized. Please log in.', 'session_expired' => true], 401);
}

$userId = (int)$_SESSION['user_id'];
$pdo = getPDO();

$stmt = $pdo->prepare("DELETE FROM login_history WHERE user_id = ?");
$stmt->execute([$userId]);
$deleted = $stmt->rowCount();

jsonResponse([
    'success' => true,
    'message' => 'Login history cleared successfully.',
    'deleted' => $deleted,
]);
