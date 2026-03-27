<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/UniversalSessionParser.php';
require_once __DIR__ . '/../lib/FieldClassifier.php';
require_once __DIR__ . '/../lib/CookieEngine.php';
require_once __DIR__ . '/../lib/GeoEngine.php';
require_once __DIR__ . '/../lib/SessionManager.php';
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

$raw = $input['raw_data'] ?? '';

if (trim($raw) === '') {
    jsonResponse(['success' => false, 'message' => 'No session data provided.'], 400);
}

try {
    $parsed = UniversalSessionParser::parse($raw);

    if ($parsed === null) {
        jsonResponse([
            'success' => false,
            'message' => 'No key-value pairs detected.',
        ], 422);
    }

    $classified = FieldClassifier::classify($parsed);
    $cookies    = CookieEngine::detectCookies($parsed);
    $domain     = CookieEngine::detectDomainFromData($parsed);

    $summary    = FieldClassifier::generateSummary($classified);
    $acCountry  = $summary['country'];
    $userCountry = is_string($input['user_country'] ?? null) ? $input['user_country'] : null;

    $geoAnalysis  = GeoEngine::analyze($acCountry, $userCountry);
    $health       = SessionManager::analyzeHealth($cookies, $classified, $geoAnalysis);
    $hasSecureId  = isset($cookies['SecureNetflixId']) && !empty(trim($cookies['SecureNetflixId']));
    $geoMatch     = $geoAnalysis['match']['exact_country'];
    $lifetime     = SessionManager::estimateLifetime($health['health_score'], $hasSecureId, $geoMatch);
    $stability    = SessionManager::getStabilityAdvice($health['health_score'], $geoAnalysis);
    $keepAlive    = SessionManager::getKeepAliveConfig($health['health_score']);
    $cookieScore  = CookieSelector::analyzeFromParsed($cookies, $classified, $userCountry);

    jsonResponse([
        'success'      => true,
        'health'       => $health,
        'lifetime'     => $lifetime,
        'geo'          => $geoAnalysis,
        'stability'    => $stability,
        'keep_alive'   => $keepAlive,
        'cookie_score' => $cookieScore,
        'domain'       => $domain,
    ]);

} catch (Throwable $e) {
    error_log('session_health error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'message' => 'Analysis failed. Please try again.',
    ], 500);
}
