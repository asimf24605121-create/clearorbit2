<?php
require_once __DIR__ . '/../db.php';

session_start();

if (empty($_SESSION['user_id']) || $_SESSION['role'] !== 'admin') {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 403);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$settings = $input['settings'] ?? [];

if (empty($settings) || !is_array($settings)) {
    jsonResponse(['success' => false, 'message' => 'No settings provided.'], 400);
}

$allowed = ['whatsapp_number', 'whatsapp_message', 'reseller_cost_per_user', 'reseller_auto_approve'];
$pdo = getPDO();
$count = 0;

foreach ($settings as $key => $value) {
    if (!in_array($key, $allowed)) continue;
    setSiteSetting($key, (string)$value);
    $count++;
}

logActivity($_SESSION['user_id'], "update_settings: {$count} settings changed", getClientIP());

jsonResponse(['success' => true, 'message' => "{$count} setting(s) saved."]);
