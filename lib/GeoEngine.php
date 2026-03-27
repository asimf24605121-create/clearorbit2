<?php

class GeoEngine
{
    private const COUNTRY_CODES = [
        'india' => 'IN', 'brazil' => 'BR', 'united states' => 'US', 'usa' => 'US',
        'united kingdom' => 'GB', 'uk' => 'GB', 'canada' => 'CA', 'australia' => 'AU',
        'germany' => 'DE', 'france' => 'FR', 'japan' => 'JP', 'south korea' => 'KR',
        'mexico' => 'MX', 'spain' => 'ES', 'italy' => 'IT', 'turkey' => 'TR',
        'argentina' => 'AR', 'colombia' => 'CO', 'thailand' => 'TH', 'indonesia' => 'ID',
        'philippines' => 'PH', 'pakistan' => 'PK', 'bangladesh' => 'BD', 'nigeria' => 'NG',
        'egypt' => 'EG', 'south africa' => 'ZA', 'poland' => 'PL', 'netherlands' => 'NL',
        'belgium' => 'BE', 'sweden' => 'SE', 'norway' => 'NO', 'denmark' => 'DK',
        'finland' => 'FI', 'singapore' => 'SG', 'malaysia' => 'MY', 'vietnam' => 'VN',
        'chile' => 'CL', 'peru' => 'PE', 'israel' => 'IL', 'uae' => 'AE',
        'saudi arabia' => 'SA', 'russia' => 'RU', 'ukraine' => 'UA', 'romania' => 'RO',
        'czech republic' => 'CZ', 'portugal' => 'PT', 'new zealand' => 'NZ',
        'in' => 'IN', 'br' => 'BR', 'us' => 'US', 'gb' => 'GB', 'ca' => 'CA',
        'au' => 'AU', 'de' => 'DE', 'fr' => 'FR', 'jp' => 'JP', 'kr' => 'KR',
        'mx' => 'MX', 'es' => 'ES', 'it' => 'IT', 'tr' => 'TR', 'ar' => 'AR',
    ];

    private const REGION_MAP = [
        'IN' => 'Asia', 'BR' => 'South America', 'US' => 'North America',
        'GB' => 'Europe', 'CA' => 'North America', 'AU' => 'Oceania',
        'DE' => 'Europe', 'FR' => 'Europe', 'JP' => 'Asia', 'KR' => 'Asia',
        'MX' => 'North America', 'ES' => 'Europe', 'IT' => 'Europe',
        'TR' => 'Europe', 'AR' => 'South America', 'CO' => 'South America',
        'TH' => 'Asia', 'ID' => 'Asia', 'PH' => 'Asia', 'PK' => 'Asia',
        'NG' => 'Africa', 'EG' => 'Africa', 'ZA' => 'Africa',
        'PL' => 'Europe', 'NL' => 'Europe', 'SE' => 'Europe',
        'SG' => 'Asia', 'MY' => 'Asia', 'VN' => 'Asia',
        'CL' => 'South America', 'PE' => 'South America',
        'IL' => 'Middle East', 'AE' => 'Middle East', 'SA' => 'Middle East',
        'RU' => 'Europe', 'UA' => 'Europe', 'NZ' => 'Oceania',
    ];

    public static function analyze(?string $accountCountry, ?string $userCountry): array
    {
        $acCode = $accountCountry ? self::toCountryCode($accountCountry) : null;
        $usCode = $userCountry ? self::toCountryCode($userCountry) : null;

        $acRegion = $acCode ? (self::REGION_MAP[$acCode] ?? 'Unknown') : 'Unknown';
        $usRegion = $usCode ? (self::REGION_MAP[$usCode] ?? 'Unknown') : 'Unknown';

        $exactMatch  = ($acCode && $usCode) ? ($acCode === $usCode) : null;
        $regionMatch = ($acRegion !== 'Unknown' && $usRegion !== 'Unknown') ? ($acRegion === $usRegion) : null;

        $geoRisk = self::calculateGeoRisk($acCode, $usCode, $acRegion, $usRegion);

        $recommendation = self::buildRecommendation($exactMatch, $regionMatch, $acCode, $usCode);

        return [
            'account' => [
                'country'      => $accountCountry,
                'country_code' => $acCode,
                'region'       => $acRegion,
            ],
            'user' => [
                'country'      => $userCountry,
                'country_code' => $usCode,
                'region'       => $usRegion,
            ],
            'match' => [
                'exact_country' => $exactMatch,
                'same_region'   => $regionMatch,
            ],
            'geo_risk'       => $geoRisk,
            'recommendation' => $recommendation,
        ];
    }

    public static function toCountryCode(string $country): ?string
    {
        $country = preg_replace('/[\x{1F000}-\x{1FFFF}]|[\x{2600}-\x{27BF}]|[\x{FE00}-\x{FEFF}]|[\x{1F900}-\x{1F9FF}]|[\x{200D}\x{20E3}\x{FE0F}]|[\x{2702}-\x{27B0}]|[\x{E0020}-\x{E007F}]|[\x{2300}-\x{23FF}]|[\x{1F1E0}-\x{1F1FF}]/u', '', $country);
        $lower = strtolower(trim($country));

        if (isset(self::COUNTRY_CODES[$lower])) {
            return self::COUNTRY_CODES[$lower];
        }

        if (strlen($lower) === 2) {
            $upper = strtoupper($lower);
            if (isset(self::REGION_MAP[$upper])) {
                return $upper;
            }
        }

        foreach (self::COUNTRY_CODES as $name => $code) {
            if (str_contains($lower, $name) || str_contains($name, $lower)) {
                return $code;
            }
        }

        return null;
    }

    private static function calculateGeoRisk(?string $acCode, ?string $usCode, string $acRegion, string $usRegion): array
    {
        if (!$acCode || !$usCode) {
            return ['level' => 'unknown', 'score' => 0, 'message' => 'Insufficient geo data for analysis'];
        }

        if ($acCode === $usCode) {
            return ['level' => 'none', 'score' => 0, 'message' => 'Same country — optimal connection'];
        }

        if ($acRegion === $usRegion) {
            return ['level' => 'low', 'score' => 15, 'message' => "Same region ({$acRegion}) — low risk with regional IP"];
        }

        return ['level' => 'high', 'score' => 40, 'message' => "Cross-region: {$acRegion} vs {$usRegion} — VPN strongly recommended"];
    }

    private static function buildRecommendation(?bool $exactMatch, ?bool $regionMatch, ?string $acCode, ?string $usCode): array
    {
        $rec = [
            'action'      => 'none',
            'vpn_needed'  => false,
            'suggested_ip' => null,
            'message'     => '',
        ];

        if ($exactMatch === true) {
            $rec['action']  = 'direct';
            $rec['message'] = 'Direct connection is safe — no VPN needed';
            return $rec;
        }

        if ($exactMatch === false) {
            $rec['action']      = 'vpn';
            $rec['vpn_needed']  = true;
            $rec['suggested_ip'] = $acCode;
            $rec['message']     = "Use a {$acCode} IP address for best stability";
            return $rec;
        }

        $rec['action']  = 'unknown';
        $rec['message'] = 'Country data unavailable — use caution';
        return $rec;
    }
}
