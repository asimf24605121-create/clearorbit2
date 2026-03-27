<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$ticketId = (int)($input['ticket_id'] ?? 0);
$action = $input['action'] ?? '';

if ($ticketId <= 0) {
    jsonResponse(['success' => false, 'message' => 'ticket_id is required.'], 400);
}

if (!in_array($action, ['resolve', 'delete'], true)) {
    jsonResponse(['success' => false, 'message' => 'Invalid action. Use "resolve" or "delete".'], 400);
}

$pdo = getPDO();

$stmt = $pdo->prepare("SELECT id, platform_name FROM support_tickets WHERE id = ?");
$stmt->execute([$ticketId]);
$ticket = $stmt->fetch();

if (!$ticket) {
    jsonResponse(['success' => false, 'message' => 'Ticket not found.'], 404);
}

if ($action === 'resolve') {
    $pdo->prepare("UPDATE support_tickets SET status = 'resolved' WHERE id = ?")->execute([$ticketId]);
    logActivity($_SESSION['user_id'], "ticket_resolved: id={$ticketId} platform={$ticket['platform_name']}", getClientIP());
    jsonResponse(['success' => true, 'message' => 'Ticket marked as resolved.']);
} else {
    $pdo->prepare("DELETE FROM support_tickets WHERE id = ?")->execute([$ticketId]);
    logActivity($_SESSION['user_id'], "ticket_deleted: id={$ticketId} platform={$ticket['platform_name']}", getClientIP());
    jsonResponse(['success' => true, 'message' => 'Ticket deleted.']);
}
