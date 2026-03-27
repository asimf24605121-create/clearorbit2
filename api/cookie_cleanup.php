<?php
require_once __DIR__ . '/../db.php';

session_start();
checkAdminAccess('super_admin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'message' => 'Method not allowed.'], 405);
}

validateCsrfToken();

$input = json_decode(file_get_contents('php://input'), true);
$mode = $input['mode'] ?? 'scan';

$pdo = getPDO();

$stmt = $pdo->query("
    SELECT cv.id, cv.platform_id, cv.cookie_string, cv.slot, cv.cookie_count, cv.updated_at,
           p.name AS platform_name, p.cookie_domain, p.login_url
    FROM cookie_vault cv
    INNER JOIN platforms p ON p.id = cv.platform_id
    ORDER BY cv.platform_id, cv.slot
");
$records = $stmt->fetchAll();

$issues = [];
$cleaned = 0;

foreach ($records as $r) {
    $cookieDomains = [];
    $rawStored = $r['cookie_string'];
    $decoded = @base64_decode($rawStored, true);
    if ($decoded !== false && strlen($decoded) > 2) {
        $rawStored = $decoded;
    }
    $jsonCookies = @json_decode($rawStored, true);
    if (is_array($jsonCookies)) {
        foreach ($jsonCookies as $c) {
            if (!empty($c['domain'])) {
                $d = strtolower(trim($c['domain']));
                if (!in_array($d, $cookieDomains, true)) {
                    $cookieDomains[] = $d;
                }
            }
        }
    }

    $issue = null;

    if (empty($r['cookie_domain'])) {
        $issue = 'Platform has no cookie_domain configured';
    } elseif (!empty($cookieDomains)) {
        $platDomain = ltrim(strtolower($r['cookie_domain']), '.');
        $anyMatch = false;
        foreach ($cookieDomains as $cd) {
            $cd = ltrim($cd, '.');
            if ($cd === $platDomain || str_ends_with($cd, '.' . $platDomain) || str_ends_with($platDomain, '.' . $cd)) {
                $anyMatch = true;
                break;
            }
        }
        if (!$anyMatch) {
            $issue = "Domain mismatch: cookie domains [" . implode(', ', $cookieDomains) . "] vs platform domain [{$r['cookie_domain']}]";
        }
    }

    if (empty($r['login_url'])) {
        $issue = ($issue ? $issue . '; ' : '') . 'Platform has no login_url configured';
    }

    if ($issue) {
        $issues[] = [
            'id'            => $r['id'],
            'platform_name' => $r['platform_name'],
            'slot'          => $r['slot'],
            'issue'         => $issue,
            'cookie_domains' => $cookieDomains,
            'platform_domain' => $r['cookie_domain'],
        ];

        if ($mode === 'clean') {
            $pdo->prepare("DELETE FROM cookie_vault WHERE id = ?")->execute([$r['id']]);
            $cleaned++;
            logActivity($_SESSION['user_id'], "cookie_cleanup: deleted #{$r['id']} ({$r['platform_name']} Slot {$r['slot']}) - {$issue}", getClientIP());
        }
    }
}

$msg = $mode === 'scan'
    ? (count($issues) . ' issue(s) found.')
    : ("{$cleaned} record(s) cleaned up.");

jsonResponse([
    'success' => true,
    'mode'    => $mode,
    'message' => $msg,
    'issues'  => $issues,
    'cleaned' => $cleaned,
    'total_scanned' => count($records),
]);
