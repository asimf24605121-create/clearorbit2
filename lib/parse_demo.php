<?php
require_once __DIR__ . '/NetflixSessionParser.php';

$samples = [
    '7005506031:Manish@1 | Country = India 🇮🇳 | memberPlan = Basic | NetflixId = v%3D3%26m%3Dabc123 | SecureNetflixId = v%3D3%26s%3Dxyz789 | MaxStreams = 2 | hasAds = false | isPrimary = true | NextPaymentDate = 15-April-2026',
    '9001234567:User@2 | Country = USA 🇺🇸 | memberPlan = Premium | NetflixId = v%3D4%26m%3Ddef456 | SecureNetflixId = v%3D4%26s%3Duvw012 | MaxStreams = 4 | hasAds = false | isPrimary = true | NextPaymentDate = 02-May-2026 | hdAvailable = true',
    '1112223334:TestUser | Country = Germany 🇩🇪 | memberPlan = Standard',
];

echo str_repeat('=', 72) . "\n";
echo "  Netflix Session Metadata Parser — Demo\n";
echo str_repeat('=', 72) . "\n\n";

foreach ($samples as $i => $raw) {
    $num = $i + 1;
    echo "--- Sample #{$num} ---\n";
    echo "Input : " . mb_substr($raw, 0, 80) . (mb_strlen($raw) > 80 ? '...' : '') . "\n\n";

    $result = NetflixSessionParser::parse($raw);

    if ($result === null) {
        echo "Result: NULL (validation failed — NetflixId missing or input malformed)\n";
    } else {
        echo NetflixSessionParser::prettyPrint($result) . "\n";
    }

    echo "\n";
}

echo str_repeat('=', 72) . "\n";
echo "  Parsing complete. " . count($samples) . " sample(s) processed.\n";
echo str_repeat('=', 72) . "\n";
