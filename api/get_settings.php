<?php
require_once __DIR__ . '/../db.php';

$pdo = getPDO();

$whatsappNumber = getSiteSetting('whatsapp_number', '');
$whatsappMessage = getSiteSetting('whatsapp_message', 'Hi, I need help with my ClearOrbit account.');
$resellerCostPerUser = getSiteSetting('reseller_cost_per_user', '100');
$resellerAutoApprove = getSiteSetting('reseller_auto_approve', '0');

jsonResponse([
    'success' => true,
    'whatsapp_number' => $whatsappNumber,
    'whatsapp_message' => $whatsappMessage,
    'reseller_cost_per_user' => $resellerCostPerUser,
    'reseller_auto_approve' => $resellerAutoApprove,
]);
