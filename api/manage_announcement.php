<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

$pdo = getPDO();
$now = date('Y-m-d H:i:s');

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $announcements = $pdo->query("SELECT id, title, message, type, status, start_time, end_time, created_at FROM announcements ORDER BY created_at DESC")->fetchAll();

    foreach ($announcements as &$a) {
        $a['computed_status'] = computeAnnouncementStatus($a, $now);
    }
    unset($a);

    jsonResponse([
        'success' => true,
        'announcements' => $announcements,
        'csrf_token' => generateCsrfToken(),
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$action = $input['action'] ?? 'create';

if ($action === 'create') {
    $title   = trim($input['title'] ?? '');
    $message = trim($input['message'] ?? '');
    $type    = in_array($input['type'] ?? '', ['popup', 'notification']) ? $input['type'] : 'popup';
    $startTime = trim($input['start_time'] ?? '');
    $endTime   = trim($input['end_time'] ?? '');

    if ($title === '' || $message === '') {
        jsonResponse(['success' => false, 'message' => 'Title and message are required.'], 400);
    }

    if ($startTime === '' || $endTime === '') {
        jsonResponse(['success' => false, 'message' => 'Start time and end time are required.'], 400);
    }

    $startDt = DateTime::createFromFormat('Y-m-d\TH:i', $startTime) ?: DateTime::createFromFormat('Y-m-d H:i:s', $startTime) ?: DateTime::createFromFormat('Y-m-d H:i', $startTime);
    $endDt   = DateTime::createFromFormat('Y-m-d\TH:i', $endTime) ?: DateTime::createFromFormat('Y-m-d H:i:s', $endTime) ?: DateTime::createFromFormat('Y-m-d H:i', $endTime);

    if (!$startDt || !$endDt) {
        jsonResponse(['success' => false, 'message' => 'Invalid date format.'], 400);
    }

    if ($endDt <= $startDt) {
        jsonResponse(['success' => false, 'message' => 'End time must be after start time.'], 400);
    }

    $startFormatted = $startDt->format('Y-m-d H:i:s');
    $endFormatted   = $endDt->format('Y-m-d H:i:s');

    $stmt = $pdo->prepare("INSERT INTO announcements (title, message, type, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'active')");
    $stmt->execute([$title, $message, $type, $startFormatted, $endFormatted]);

    if ($type === 'notification') {
        $notifType = in_array($input['notif_type'] ?? '', ['info', 'success', 'warning']) ? $input['notif_type'] : 'info';
        $users = $pdo->query("SELECT id FROM users WHERE role = 'user' AND is_active = 1")->fetchAll();
        $ins = $pdo->prepare("INSERT INTO user_notifications (user_id, title, message, type, created_at) VALUES (?, ?, ?, ?, ?)");
        foreach ($users as $u) {
            $ins->execute([$u['id'], $title, $message, $notifType, $now]);
        }
    }

    logActivity($_SESSION['user_id'], "announcement_created: {$title} ({$type})", getClientIP());
    jsonResponse(['success' => true, 'message' => 'Announcement created successfully.']);
}

if ($action === 'toggle') {
    $id = (int)($input['id'] ?? 0);
    if ($id <= 0) { jsonResponse(['success' => false, 'message' => 'Invalid ID.'], 400); }

    $stmt = $pdo->prepare("SELECT id, status FROM announcements WHERE id = ?");
    $stmt->execute([$id]);
    $ann = $stmt->fetch();
    if (!$ann) { jsonResponse(['success' => false, 'message' => 'Announcement not found.'], 404); }

    $newStatus = $ann['status'] === 'active' ? 'inactive' : 'active';
    $pdo->prepare("UPDATE announcements SET status = ? WHERE id = ?")->execute([$newStatus, $id]);
    logActivity($_SESSION['user_id'], "announcement_{$newStatus}: id={$id}", getClientIP());
    jsonResponse(['success' => true, 'message' => "Announcement set to {$newStatus}."]);
}

if ($action === 'update') {
    $id      = (int)($input['id'] ?? 0);
    $title   = trim($input['title'] ?? '');
    $message = trim($input['message'] ?? '');
    $type    = in_array($input['type'] ?? '', ['popup', 'notification']) ? $input['type'] : 'popup';
    $startTime = trim($input['start_time'] ?? '');
    $endTime   = trim($input['end_time'] ?? '');

    if ($id <= 0) { jsonResponse(['success' => false, 'message' => 'Invalid ID.'], 400); }
    if ($title === '' || $message === '') {
        jsonResponse(['success' => false, 'message' => 'Title and message are required.'], 400);
    }
    if ($startTime === '' || $endTime === '') {
        jsonResponse(['success' => false, 'message' => 'Start time and end time are required.'], 400);
    }

    $startDt = DateTime::createFromFormat('Y-m-d\TH:i', $startTime) ?: DateTime::createFromFormat('Y-m-d H:i:s', $startTime) ?: DateTime::createFromFormat('Y-m-d H:i', $startTime);
    $endDt   = DateTime::createFromFormat('Y-m-d\TH:i', $endTime) ?: DateTime::createFromFormat('Y-m-d H:i:s', $endTime) ?: DateTime::createFromFormat('Y-m-d H:i', $endTime);

    if (!$startDt || !$endDt) {
        jsonResponse(['success' => false, 'message' => 'Invalid date format.'], 400);
    }
    if ($endDt <= $startDt) {
        jsonResponse(['success' => false, 'message' => 'End time must be after start time.'], 400);
    }

    $startFormatted = $startDt->format('Y-m-d H:i:s');
    $endFormatted   = $endDt->format('Y-m-d H:i:s');

    $stmt = $pdo->prepare("UPDATE announcements SET title = ?, message = ?, type = ?, start_time = ?, end_time = ? WHERE id = ?");
    $stmt->execute([$title, $message, $type, $startFormatted, $endFormatted, $id]);

    logActivity($_SESSION['user_id'], "announcement_updated: id={$id}", getClientIP());
    jsonResponse(['success' => true, 'message' => 'Announcement updated successfully.']);
}

if ($action === 'delete') {
    $id = (int)($input['id'] ?? 0);
    if ($id <= 0) { jsonResponse(['success' => false, 'message' => 'Invalid ID.'], 400); }

    $pdo->prepare("DELETE FROM announcements WHERE id = ?")->execute([$id]);
    logActivity($_SESSION['user_id'], "announcement_deleted: id={$id}", getClientIP());
    jsonResponse(['success' => true, 'message' => 'Announcement deleted.']);
}

jsonResponse(['success' => false, 'message' => 'Invalid action.'], 400);

function computeAnnouncementStatus(array $ann, string $now): string {
    if ($ann['start_time'] && $ann['end_time']) {
        if ($now < $ann['start_time']) return 'scheduled';
        if ($now > $ann['end_time']) return 'expired';
        return 'active';
    }
    return $ann['status'];
}
