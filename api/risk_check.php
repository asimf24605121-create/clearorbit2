<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/RiskEngine.php';

session_start();
validateSession();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$body  = file_get_contents('php://input');
$input = json_decode($body, true);

if (!is_array($input)) {
    jsonResponse(['success' => false, 'message' => 'Invalid JSON payload.'], 400);
}

$cookies        = is_array($input['cookies'] ?? null) ? $input['cookies'] : [];
$accountCountry = is_string($input['account_country'] ?? null) ? $input['account_country'] : null;
$userCountry    = is_string($input['user_country'] ?? null) ? $input['user_country'] : null;

$risk = RiskEngine::calculateRisk($cookies, $accountCountry, $userCountry);

jsonResponse([
    'success' => true,
    'risk'    => $risk,
]);
