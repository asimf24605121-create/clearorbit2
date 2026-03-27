<?php
/**
 * ClearOrbit — MySQL Database Initializer
 * 
 * Run once after creating your MySQL database on Hostinger:
 *   php config/init_mysql.php
 *
 * This will:
 *   1. Import the schema (all tables + indexes)
 *   2. Create the default admin account
 *   3. Seed default platforms and pricing
 */

require_once __DIR__ . '/config.php';

if (DB_DRIVER !== 'mysql') {
    die("ERROR: DB_DRIVER must be 'mysql' in config.php\n");
}

echo "Connecting to MySQL...\n";
try {
    $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4";
    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (PDOException $e) {
    die("Connection failed: " . $e->getMessage() . "\n");
}

echo "Importing schema...\n";
$sql = file_get_contents(__DIR__ . '/mysql_schema.sql');
$statements = array_filter(array_map('trim', explode(';', $sql)));
foreach ($statements as $stmt) {
    if (empty($stmt) || strpos($stmt, '--') === 0) continue;
    try {
        $pdo->exec($stmt);
    } catch (PDOException $e) {
        echo "  Warning: " . $e->getMessage() . "\n";
    }
}
echo "Schema imported.\n";

$count = (int)$pdo->query("SELECT COUNT(*) FROM users")->fetchColumn();
if ($count === 0) {
    echo "Seeding default data...\n";

    $adminHash = password_hash('CHANGE_THIS_PASSWORD', PASSWORD_BCRYPT);
    $stmt = $pdo->prepare("INSERT INTO users (username, password_hash, role, is_active, admin_level, name, email) VALUES (?, ?, 'admin', 1, 'super_admin', ?, ?)");
    $stmt->execute(['admin@clearorbit.com', $adminHash, 'Admin', 'admin@clearorbit.com']);
    echo "  Admin user created (username: admin@clearorbit.com)\n";
    echo "  IMPORTANT: Change the admin password immediately!\n";

    $platforms = [
        ['Netflix',    'https://upload.wikimedia.org/wikipedia/commons/0/08/Netflix_2015_logo.svg', '#e50914', '.netflix.com',    'https://www.netflix.com/'],
        ['Spotify',    'https://upload.wikimedia.org/wikipedia/commons/2/26/Spotify_logo_with_text.svg', '#1db954', '.spotify.com',    'https://open.spotify.com/'],
        ['Disney+',    'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg', '#0063e5', '.disneyplus.com', 'https://www.disneyplus.com/'],
        ['ChatGPT',    'https://upload.wikimedia.org/wikipedia/commons/0/04/ChatGPT_logo.svg', '#10a37f', '.openai.com',     'https://chat.openai.com/'],
        ['Canva',      'https://upload.wikimedia.org/wikipedia/commons/0/08/Canva_icon_2021.svg', '#7d2ae8', '.canva.com',      'https://www.canva.com/'],
        ['Udemy',      'https://upload.wikimedia.org/wikipedia/commons/e/e3/Udemy_logo.svg', '#a435f0', '.udemy.com',      'https://www.udemy.com/'],
        ['Coursera',   'https://upload.wikimedia.org/wikipedia/commons/9/97/Coursera-Logo_600x600.svg', '#0056d2', '.coursera.org',   'https://www.coursera.org/'],
        ['Skillshare', 'https://upload.wikimedia.org/wikipedia/commons/2/2e/Skillshare_logo.svg', '#00ff84', '.skillshare.com', 'https://www.skillshare.com/'],
        ['Grammarly',  'https://upload.wikimedia.org/wikipedia/commons/a/a0/Grammarly_Logo.svg', '#15c39a', '.grammarly.com',  'https://app.grammarly.com/'],
    ];
    $pStmt = $pdo->prepare("INSERT INTO platforms (name, logo_url, bg_color_hex, is_active, cookie_domain, login_url) VALUES (?, ?, ?, 1, ?, ?)");
    foreach ($platforms as $p) {
        $pStmt->execute($p);
    }
    echo "  " . count($platforms) . " platforms created.\n";

    $pricing = [
        [1, '1_week', 1.79, 2.99], [1, '1_month', 4.79, 7.99], [1, '6_months', 20.99, 34.99], [1, '1_year', 35.99, 59.99],
        [2, '1_week', 1.19, 1.99], [2, '1_month', 2.99, 4.99], [2, '6_months', 14.99, 24.99], [2, '1_year', 26.99, 44.99],
        [3, '1_week', 1.49, 2.49], [3, '1_month', 4.19, 6.99], [3, '6_months', 17.99, 29.99], [3, '1_year', 29.99, 49.99],
        [4, '1_week', 2.39, 3.99], [4, '1_month', 5.99, 9.99], [4, '6_months', 26.99, 44.99], [4, '1_year', 47.99, 79.99],
        [5, '1_week', 1.19, 1.99], [5, '1_month', 3.59, 5.99], [5, '6_months', 17.99, 29.99], [5, '1_year', 29.99, 49.99],
        [6, '1_week', 1.49, 2.49], [6, '1_month', 3.99, 6.99], [6, '6_months', 18.99, 31.99], [6, '1_year', 32.99, 54.99],
        [7, '1_week', 1.49, 2.49], [7, '1_month', 3.99, 6.99], [7, '6_months', 18.99, 31.99], [7, '1_year', 32.99, 54.99],
        [8, '1_week', 1.19, 1.99], [8, '1_month', 2.99, 4.99], [8, '6_months', 14.99, 24.99], [8, '1_year', 26.99, 44.99],
        [9, '1_week', 1.79, 2.99], [9, '1_month', 4.79, 7.99], [9, '6_months', 22.99, 37.99], [9, '1_year', 39.99, 66.99],
    ];
    $prStmt = $pdo->prepare("INSERT IGNORE INTO pricing_plans (platform_id, duration_key, shared_price, private_price) VALUES (?, ?, ?, ?)");
    foreach ($pricing as $pr) {
        $prStmt->execute($pr);
    }

    $waStmt = $pdo->prepare("INSERT IGNORE INTO whatsapp_config (platform_id, shared_number, private_number) VALUES (?, ?, ?)");
    for ($pid = 1; $pid <= 9; $pid++) {
        $waStmt->execute([$pid, '1234567890', '1234567890']);
    }

    echo "  Pricing and WhatsApp config seeded.\n";
} else {
    echo "Database already has data ($count users). Skipping seed.\n";
}

echo "\nDone! Your ClearOrbit database is ready.\n";
