<?php
require_once __DIR__ . '/../db.php';

session_start();
validateSession();

jsonResponse([
    "success" => true,
    "status" => "ok",
    "user_id" => (int)$_SESSION['user_id'],
    "role" => $_SESSION['role'] ?? 'user',
    "admin_level" => $_SESSION['admin_level'] ?? null,
    "csrf_token" => $_SESSION['csrf_token'] ?? null
]);
