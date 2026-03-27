<?php
require_once __DIR__ . '/../db.php';

session_start();

checkAdminAccess('manager');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);

$user_id = (int)($input['user_id'] ?? 0);
if ($user_id <= 0) {
    jsonResponse(['success' => false, 'message' => 'user_id is required.'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, username, role FROM users WHERE id = ?");
$stmt->execute([$user_id]);
$user = $stmt->fetch();

if (!$user) {
    jsonResponse(['success' => false, 'message' => 'User not found.'], 404);
}

if ($user['role'] === 'admin' && getAdminLevel() !== 'super_admin') {
    jsonResponse(['success' => false, 'message' => 'Cannot modify admin accounts.'], 403);
}

if (isPermanentSuperAdmin($user_id)) {
    if (isset($input['email']) && trim($input['email']) !== PERMANENT_SUPER_ADMIN_EMAIL) {
        jsonResponse(['success' => false, 'message' => 'Cannot change the email of the permanent Super Admin.'], 403);
    }
}

$updates = [];
$params = [];

if (isset($input['name'])) {
    $name = trim($input['name']);
    if (strlen($name) > 100) {
        jsonResponse(['success' => false, 'message' => 'Name must be 100 characters or less.'], 400);
    }
    $updates[] = "name = ?";
    $params[] = $name ?: null;
}

if (isset($input['email'])) {
    $email = trim($input['email']);
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        jsonResponse(['success' => false, 'message' => 'Invalid email address.'], 400);
    }
    if ($email !== '') {
        $dup = $pdo->prepare("SELECT id FROM users WHERE email = ? AND id != ?");
        $dup->execute([$email, $user_id]);
        if ($dup->fetch()) {
            jsonResponse(['success' => false, 'message' => 'Email already in use by another user.'], 409);
        }
    }
    $updates[] = "email = ?";
    $params[] = $email ?: null;
}

if (isset($input['phone'])) {
    $phone = trim($input['phone']);
    if ($phone !== '' && !preg_match('/^[\+\d\s\-\(\)]{5,20}$/', $phone)) {
        jsonResponse(['success' => false, 'message' => 'Invalid phone number format.'], 400);
    }
    $updates[] = "phone = ?";
    $params[] = $phone ?: null;
}

if (isset($input['expiry_date'])) {
    $expiry = trim($input['expiry_date']);
    if ($expiry !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $expiry)) {
        jsonResponse(['success' => false, 'message' => 'Expiry date must be YYYY-MM-DD format.'], 400);
    }
    $updates[] = "expiry_date = ?";
    $params[] = $expiry ?: null;
}

if (isset($input['country'])) {
    $country = trim($input['country']);
    if (strlen($country) > 100) {
        jsonResponse(['success' => false, 'message' => 'Country must be 100 characters or less.'], 400);
    }
    $updates[] = "country = ?";
    $params[] = $country ?: null;
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

if (isset($input['password'])) {
    $password = $input['password'];
    if (strlen($password) < 6) {
        jsonResponse(['success' => false, 'message' => 'Password must be at least 6 characters.'], 400);
    }
    $updates[] = "password_hash = ?";
    $params[] = password_hash($password, PASSWORD_BCRYPT);
}

if (empty($updates)) {
    jsonResponse(['success' => false, 'message' => 'No fields to update.'], 400);
}

$params[] = $user_id;
$sql = "UPDATE users SET " . implode(', ', $updates) . " WHERE id = ?";
$pdo->prepare($sql)->execute($params);

$changed = array_keys(array_filter($input, fn($k) => in_array($k, ['name','email','phone','expiry_date','password','country','city','gender']), ARRAY_FILTER_USE_KEY));
logActivity($_SESSION['user_id'], "user_edited: id={$user_id} username={$user['username']} fields=" . implode(',', $changed), getClientIP());

jsonResponse(['success' => true, 'message' => "User '{$user['username']}' updated successfully."]);
