<?php
require_once __DIR__ . '/../db.php';

session_start();

if (!isset($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 401);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
if (!$input) {
    jsonResponse(['success' => false, 'message' => 'Invalid request body.'], 400);
}

unset($input['subscription_expiry'], $input['expiry_date'], $input['role'], $input['admin_level'],
      $input['is_active'], $input['device_id'], $input['password_hash'], $input['id'],
      $input['created_at'], $input['last_login_ip'], $input['profile_completed']);

$pdo = getPDO();
$userId = (int)$_SESSION['user_id'];
$updates = [];
$params = [];

if (isset($input['username'])) {
    $username = trim($input['username']);
    if ($username === '') {
        jsonResponse(['success' => false, 'message' => 'Username is required.'], 400);
    }
    if (!preg_match('/^[a-zA-Z0-9_]{3,50}$/', $username)) {
        jsonResponse(['success' => false, 'message' => 'Username must be 3-50 characters: letters, numbers, underscores only.'], 400);
    }
    $dup = $pdo->prepare("SELECT id FROM users WHERE username = ? AND id != ?");
    $dup->execute([$username, $userId]);
    if ($dup->fetch()) {
        jsonResponse(['success' => false, 'message' => 'Username already taken.'], 409);
    }
    $updates[] = "username = ?";
    $params[] = $username;
}

if (isset($input['name'])) {
    $name = trim($input['name']);
    if ($name === '') {
        jsonResponse(['success' => false, 'message' => 'Full name is required.'], 400);
    }
    if (strlen($name) > 100) {
        jsonResponse(['success' => false, 'message' => 'Name must be 100 characters or less.'], 400);
    }
    $updates[] = "name = ?";
    $params[] = $name;
}

if (isset($input['email'])) {
    $email = trim($input['email']);
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        jsonResponse(['success' => false, 'message' => 'Invalid email address.'], 400);
    }
    if ($email !== '') {
        $dup = $pdo->prepare("SELECT id FROM users WHERE email = ? AND id != ?");
        $dup->execute([$email, $userId]);
        if ($dup->fetch()) {
            jsonResponse(['success' => false, 'message' => 'Email already in use.'], 409);
        }
    }
    $updates[] = "email = ?";
    $params[] = $email ?: null;
}

if (isset($input['phone'])) {
    $phone = trim($input['phone']);
    if ($phone === '') {
        jsonResponse(['success' => false, 'message' => 'Phone number is required.'], 400);
    }
    if (!preg_match('/^[\+\d\s\-\(\)]{5,20}$/', $phone)) {
        jsonResponse(['success' => false, 'message' => 'Invalid phone number format.'], 400);
    }
    $updates[] = "phone = ?";
    $params[] = $phone;
}

if (isset($input['country'])) {
    $country = trim($input['country']);
    if ($country === '') {
        jsonResponse(['success' => false, 'message' => 'Country is required.'], 400);
    }
    if (strlen($country) > 100) {
        jsonResponse(['success' => false, 'message' => 'Country must be 100 characters or less.'], 400);
    }
    $updates[] = "country = ?";
    $params[] = $country;
}

if (isset($input['city'])) {
    $city = trim($input['city']);
    if (strlen($city) > 100) {
        jsonResponse(['success' => false, 'message' => 'City must be 100 characters or less.'], 400);
    }
    $updates[] = "city = ?";
    $params[] = $city ?: null;
}

if (isset($input['gender'])) {
    $gender = trim($input['gender']);
    $validGenders = ['male', 'female', 'other', ''];
    if (!in_array(strtolower($gender), $validGenders, true)) {
        jsonResponse(['success' => false, 'message' => 'Invalid gender value.'], 400);
    }
    $updates[] = "gender = ?";
    $params[] = $gender ?: null;
}

if (empty($updates)) {
    jsonResponse(['success' => false, 'message' => 'No fields to update.'], 400);
}

$requiredFilled = true;
$checkStmt = $pdo->prepare("SELECT name, phone, country FROM users WHERE id = ?");
$checkStmt->execute([$userId]);
$current = $checkStmt->fetch();

$finalName = isset($input['name']) ? trim($input['name']) : ($current['name'] ?? '');
$finalPhone = isset($input['phone']) ? trim($input['phone']) : ($current['phone'] ?? '');
$finalCountry = isset($input['country']) ? trim($input['country']) : ($current['country'] ?? '');

if ($finalName !== '' && $finalPhone !== '' && $finalCountry !== '') {
    $updates[] = "profile_completed = 1";
}

$params[] = $userId;
$sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = ?";
$pdo->prepare($sql)->execute($params);

logActivity($userId, "profile_updated", getClientIP());

jsonResponse(['success' => true, 'message' => 'Profile updated successfully.']);
