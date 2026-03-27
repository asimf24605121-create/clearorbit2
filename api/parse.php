<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/UniversalSessionParser.php';
require_once __DIR__ . '/../lib/FieldClassifier.php';
require_once __DIR__ . '/../lib/CookieEngine.php';
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

$raw = $input['raw_data'] ?? '';

if (trim($raw) === '') {
    jsonResponse(['success' => false, 'message' => 'No session data provided.'], 400);
}

$parsed = UniversalSessionParser::parse($raw);

if ($parsed === null) {
    jsonResponse([
        'success' => false,
        'message' => 'No key-value pairs detected. Check the format of your input.',
    ], 422);
}

$format     = UniversalSessionParser::detectFormat($raw);
$classified = FieldClassifier::classify($parsed);
$summary    = FieldClassifier::generateSummary($classified);
$structured = FieldClassifier::buildStructuredOutput($classified);
$cookies    = CookieEngine::detectCookies($parsed);
$domain     = CookieEngine::detectDomainFromData($parsed);
$validation = CookieEngine::validateCookies($cookies);
$netscape   = CookieEngine::generateNetscape($cookies, $domain);

$accountCountry = $summary['country'];
$userCountry    = is_string($input['user_country'] ?? null) ? $input['user_country'] : null;
$risk           = RiskEngine::calculateRisk($cookies, $accountCountry, $userCountry);

jsonResponse([
    'success'    => true,
    'format'     => $format,
    'fields'     => $classified,
    'summary'    => $summary,
    'structured' => $structured,
    'cookies'    => [
        'detected'   => $cookies,
        'validation' => $validation,
        'domain'     => $domain,
        'netscape'   => $netscape,
    ],
    'risk'       => $risk,
]);
