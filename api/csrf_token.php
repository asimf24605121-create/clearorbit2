<?php
require_once __DIR__ . '/../db.php';

session_start();

$token = generateCsrfToken();

jsonResponse([
    'success'    => true,
    'csrf_token' => $token,
]);
