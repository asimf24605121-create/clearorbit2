<?php
require_once __DIR__ . '/../db.php';

session_start();

if (empty($_SESSION['user_id'])) {
    jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 403);
}

$pdo = getPDO();

if ($_SESSION['role'] === 'admin') {
    validateCsrfToken();
    $input = json_decode(file_get_contents('php://input'), true);
    $action = $input['action'] ?? '';

    if ($action === 'list_recharges') {
        $status = $input['status'] ?? 'pending';
        $stmt = $pdo->prepare("
            SELECT rr.*, r.balance, u.username, u.email
            FROM recharge_requests rr
            JOIN resellers r ON r.id = rr.reseller_id
            JOIN users u ON u.id = r.user_id
            WHERE rr.status = ?
            ORDER BY rr.created_at DESC
        ");
        $stmt->execute([$status]);
        jsonResponse(['success' => true, 'requests' => $stmt->fetchAll()]);
    }

    if ($action === 'approve_recharge') {
        $requestId = (int)($input['request_id'] ?? 0);
        $req = $pdo->prepare("SELECT * FROM recharge_requests WHERE id = ? AND status = 'pending'");
        $req->execute([$requestId]);
        $req = $req->fetch();
        if (!$req) {
            jsonResponse(['success' => false, 'message' => 'Request not found or already processed.'], 404);
        }

        $pdo->beginTransaction();
        try {
            $reseller = $pdo->prepare("SELECT * FROM resellers WHERE id = ?")->execute([$req['reseller_id']]);
            $reseller = $pdo->prepare("SELECT * FROM resellers WHERE id = ?");
            $reseller->execute([(int)$req['reseller_id']]);
            $reseller = $reseller->fetch();

            $newBalance = (float)$reseller['balance'] + (float)$req['amount'];
            $pdo->prepare("UPDATE resellers SET balance = ? WHERE id = ?")->execute([$newBalance, $req['reseller_id']]);
            $pdo->prepare("UPDATE recharge_requests SET status = 'approved', updated_at = ? WHERE id = ?")->execute([date('Y-m-d H:i:s'), $requestId]);
            $pdo->prepare("INSERT INTO reseller_transactions (reseller_id, type, amount, balance_after, description) VALUES (?, 'recharge', ?, ?, ?)")
                ->execute([$req['reseller_id'], $req['amount'], $newBalance, "Recharge approved (ID: {$requestId})"]);

            $pdo->commit();
            logActivity($_SESSION['user_id'], "approve_recharge: reseller={$req['reseller_id']} amount={$req['amount']}", getClientIP());
            jsonResponse(['success' => true, 'message' => "Recharge of PKR {$req['amount']} approved. New balance: PKR {$newBalance}"]);
        } catch (Exception $e) {
            $pdo->rollBack();
            jsonResponse(['success' => false, 'message' => 'Failed: ' . $e->getMessage()], 500);
        }
    }

    if ($action === 'reject_recharge') {
        $requestId = (int)($input['request_id'] ?? 0);
        $note = trim($input['note'] ?? 'Rejected by admin');
        $pdo->prepare("UPDATE recharge_requests SET status = 'rejected', admin_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
            ->execute([$note, date('Y-m-d H:i:s'), $requestId]);
        jsonResponse(['success' => true, 'message' => 'Recharge request rejected.']);
    }

    if ($action === 'list_resellers') {
        $stmt = $pdo->query("
            SELECT r.*, u.username, u.email,
                (SELECT COUNT(*) FROM users WHERE reseller_id = r.id) as user_count
            FROM resellers r
            JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC
        ");
        jsonResponse(['success' => true, 'resellers' => $stmt->fetchAll()]);
    }

    if ($action === 'update_reseller') {
        $resellerId = (int)($input['reseller_id'] ?? 0);
        $status = $input['status'] ?? null;
        $commissionRate = $input['commission_rate'] ?? null;

        $updates = [];
        $params = [];
        if ($status !== null && in_array($status, ['active', 'suspended', 'pending'])) {
            $updates[] = "status = ?";
            $params[] = $status;
        }
        if ($commissionRate !== null) {
            $updates[] = "commission_rate = ?";
            $params[] = (float)$commissionRate;
        }
        if (empty($updates)) {
            jsonResponse(['success' => false, 'message' => 'Nothing to update.'], 400);
        }
        $params[] = $resellerId;
        $pdo->prepare("UPDATE resellers SET " . implode(', ', $updates) . " WHERE id = ?")->execute($params);
        jsonResponse(['success' => true, 'message' => 'Reseller updated.']);
    }

    if ($action === 'add_balance') {
        $resellerId = (int)($input['reseller_id'] ?? 0);
        $amount = (float)($input['amount'] ?? 0);
        if ($amount <= 0) jsonResponse(['success' => false, 'message' => 'Invalid amount.'], 400);

        $reseller = $pdo->prepare("SELECT * FROM resellers WHERE id = ?");
        $reseller->execute([$resellerId]);
        $reseller = $reseller->fetch();
        if (!$reseller) jsonResponse(['success' => false, 'message' => 'Reseller not found.'], 404);

        $newBalance = (float)$reseller['balance'] + $amount;
        $pdo->prepare("UPDATE resellers SET balance = ? WHERE id = ?")->execute([$newBalance, $resellerId]);
        $pdo->prepare("INSERT INTO reseller_transactions (reseller_id, type, amount, balance_after, description) VALUES (?, 'recharge', ?, ?, ?)")
            ->execute([$resellerId, $amount, $newBalance, "Admin manual recharge"]);
        jsonResponse(['success' => true, 'message' => "PKR {$amount} added. New balance: PKR {$newBalance}"]);
    }

    jsonResponse(['success' => false, 'message' => 'Unknown action.'], 400);
}

if ($_SESSION['role'] === 'reseller') {
    $reseller = $pdo->prepare("SELECT * FROM resellers WHERE user_id = ?");
    $reseller->execute([(int)$_SESSION['user_id']]);
    $reseller = $reseller->fetch();
    if (!$reseller) jsonResponse(['success' => false, 'message' => 'Reseller not found.'], 404);

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $transactions = $pdo->prepare("SELECT * FROM reseller_transactions WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 50");
        $transactions->execute([(int)$reseller['id']]);

        $recharges = $pdo->prepare("SELECT * FROM recharge_requests WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 20");
        $recharges->execute([(int)$reseller['id']]);

        jsonResponse([
            'success' => true,
            'balance' => (float)$reseller['balance'],
            'transactions' => $transactions->fetchAll(),
            'recharge_requests' => $recharges->fetchAll(),
        ]);
    }

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        validateCsrfToken();
        $input = json_decode(file_get_contents('php://input'), true);
        $action = $input['action'] ?? '';

        if ($action === 'request_recharge') {
            $amount = (float)($input['amount'] ?? 0);
            $method = trim($input['method'] ?? 'manual');
            if ($amount < 100) jsonResponse(['success' => false, 'message' => 'Minimum recharge is PKR 100.'], 400);

            $pdo->prepare("INSERT INTO recharge_requests (reseller_id, amount, method, status) VALUES (?, ?, ?, 'pending')")
                ->execute([(int)$reseller['id'], $amount, $method]);

            jsonResponse(['success' => true, 'message' => "Recharge request of PKR {$amount} submitted. Awaiting admin approval."]);
        }
    }
}

jsonResponse(['success' => false, 'message' => 'Unauthorized.'], 403);
