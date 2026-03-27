<?php
require_once __DIR__ . '/../db.php';
require_once __DIR__ . '/../lib/UniversalSessionParser.php';

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

jsonResponse([
    'success' => true,
    'data'    => UniversalSessionParser::toAssociative($parsed),
]);
