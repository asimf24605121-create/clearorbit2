<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/CookieSelector.php';

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

$cookies = is_array($input['cookies'] ?? null) ? $input['cookies'] : [];
$classifiedFields = is_array($input['classified_fields'] ?? null) ? $input['classified_fields'] : [];
$userCountry = is_string($input['user_country'] ?? null) ? $input['user_country'] : null;

try {
    $result = CookieSelector::analyzeFromParsed($cookies, $classifiedFields, $userCountry);

    jsonResponse([
        'success' => true,
        'score'   => $result,
    ]);
} catch (Throwable $e) {
    error_log('cookie_score error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'message' => 'Scoring failed. Please try again.',
    ], 500);
}
