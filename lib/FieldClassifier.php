<?php

class FieldClassifier
{
    private const CATEGORY_RULES = [
        'identity' => ['name', 'email', 'phone', 'profile', 'user', 'owner', 'member'],
        'account'  => ['plan', 'country', 'since', 'status', 'region', 'signup', 'account', 'subscription', 'tier', 'type'],
        'billing'  => ['price', 'payment', 'billing', 'card', 'renew', 'cost', 'invoice', 'charge', 'expir'],
        'session'  => ['netflixid', 'securenetflixid', 'cookie', 'token', 'session', 'nftoken', 'auth', 'login'],
        'metadata' => ['source', 'label', 'note', 'tag', 'icon', 'screen', 'stream', 'quality', 'download', 'ads', 'hd', 'verified', 'adult', 'episode', 'primary', 'max'],
    ];

    private const PRIORITY_HIGH   = ['netflixid', 'securenetflixid', 'cookie', 'token', 'nftoken', 'session', 'auth', 'directloginurl', 'loginurl'];
    private const PRIORITY_MEDIUM = ['plan', 'country', 'email', 'phone', 'name', 'profile', 'status', 'account', 'subscription', 'member', 'credentials'];
    private const PRIORITY_LOW    = ['label', 'source', 'icon', 'tag', 'note', 'screen', 'stream', 'ads', 'download'];

    private const FUZZY_MAP = [
        'streams'      => 'max_streams',
        'maxstreams'   => 'max_streams',
        'quality'      => 'video_quality',
        'hdavailable'  => 'hd_available',
        'candownload'  => 'can_download',
        'hasads'       => 'has_ads',
        'adsfree'      => 'ads_free',
        'isprimary'    => 'is_primary',
        'isverified'   => 'is_verified',
        'isadultverified' => 'is_adult_verified',
        'showallepisodes' => 'show_all_episodes',
        'memberplan'   => 'subscription_plan',
        'membersince'  => 'member_since',
        'nextpaymentdate' => 'next_payment_date',
        'renewaldate'  => 'renewal_date',
        'billingdate'  => 'billing_date',
        'profilename'  => 'profile_name',
        'countryofsignup' => 'country_of_signup',
        'accountcredentials' => 'account_credentials',
        'directloginurl' => 'direct_login_url',
    ];

    public static function classify(array $fields): array
    {
        $classified = [];

        foreach ($fields as $field) {
            $key   = $field['key'];
            $type  = $field['type'];
            $lower = strtolower($key);

            $category = self::detectCategory($lower, $type, $field['value'] ?? '');
            $priority = self::detectPriority($lower, $type);
            $snakeKey = self::toSnakeCase($key);

            $classified[] = array_merge($field, [
                'category'  => $category,
                'priority'  => $priority,
                'snake_key' => $snakeKey,
            ]);
        }

        usort($classified, function ($a, $b) {
            $order = ['high' => 0, 'medium' => 1, 'low' => 2];
            return ($order[$a['priority']] ?? 3) - ($order[$b['priority']] ?? 3);
        });

        return $classified;
    }

    public static function detectCategory(string $lowerKey, string $type, mixed $value): string
    {
        if ($type === 'cookie' || $type === 'token') {
            return 'session';
        }
        if ($type === 'url') {
            return 'session';
        }
        if ($type === 'header') {
            return 'identity';
        }

        $valStr = is_string($value) ? $value : '';
        if (str_contains($valStr, '@') && str_contains($valStr, '.')) {
            return 'identity';
        }
        if (preg_match('/^\+?\d{8,15}$/', preg_replace('/[\s\-()]/', '', $valStr))) {
            return 'identity';
        }

        foreach (self::CATEGORY_RULES as $cat => $patterns) {
            foreach ($patterns as $p) {
                if (str_contains($lowerKey, $p)) {
                    return $cat;
                }
            }
        }

        return 'unknown';
    }

    public static function detectPriority(string $lowerKey, string $type): string
    {
        if ($type === 'cookie' || $type === 'token') {
            return 'high';
        }
        if ($type === 'url') {
            return 'high';
        }

        foreach (self::PRIORITY_HIGH as $p) {
            if (str_contains($lowerKey, $p)) return 'high';
        }
        foreach (self::PRIORITY_MEDIUM as $p) {
            if (str_contains($lowerKey, $p)) return 'medium';
        }
        foreach (self::PRIORITY_LOW as $p) {
            if (str_contains($lowerKey, $p)) return 'low';
        }

        return 'low';
    }

    public static function toSnakeCase(string $key): string
    {
        $lower = strtolower($key);
        if (isset(self::FUZZY_MAP[$lower])) {
            return self::FUZZY_MAP[$lower];
        }

        $snake = preg_replace('/([a-z])([A-Z])/', '$1_$2', $key);
        $snake = preg_replace('/[\s\-]+/', '_', $snake);
        $snake = strtolower(trim($snake, '_'));
        $snake = preg_replace('/_+/', '_', $snake);

        return $snake;
    }

    public static function buildStructuredOutput(array $classified): array
    {
        $grouped = [
            'identity' => [],
            'account'  => [],
            'billing'  => [],
            'session'  => [],
            'metadata' => [],
            'unknown'  => [],
        ];

        $priority = ['high' => [], 'medium' => [], 'low' => []];

        foreach ($classified as $item) {
            $cat = $item['category'];
            $pri = $item['priority'];
            $sk  = $item['snake_key'];

            if (!isset($grouped[$cat])) $grouped[$cat] = [];
            $grouped[$cat][$sk] = $item['value'];

            $priority[$pri][] = $sk;
        }

        $grouped = array_filter($grouped);

        $raw = [];
        foreach ($classified as $item) {
            $raw[$item['snake_key']] = $item['value'];
        }

        return [
            'classified' => $grouped,
            'priority'   => $priority,
            'raw'        => $raw,
        ];
    }

    public static function generateSummary(array $classified): array
    {
        $summary = [
            'account_name'  => null,
            'country'       => null,
            'plan'          => null,
            'cookie_status' => 'missing',
            'has_login_url' => false,
            'total_fields'  => count($classified),
        ];

        foreach ($classified as $item) {
            $lower = strtolower($item['key']);
            $val   = $item['value'];

            if ($item['type'] === 'header' || str_contains($lower, 'account') || str_contains($lower, 'profile') || str_contains($lower, 'name')) {
                if ($summary['account_name'] === null) {
                    $summary['account_name'] = is_string($val) ? $val : (string)$val;
                }
            }

            if ((str_contains($lower, 'country') && !str_contains($lower, 'signup')) || str_contains($lower, 'region')) {
                if ($summary['country'] === null) {
                    $summary['country'] = is_string($val) ? $val : (string)$val;
                }
            }

            if (str_contains($lower, 'plan') || str_contains($lower, 'subscription') || str_contains($lower, 'tier')) {
                if ($summary['plan'] === null) {
                    $summary['plan'] = is_string($val) ? $val : (string)$val;
                }
            }

            if ($item['key'] === 'NetflixId') {
                $summary['cookie_status'] = 'valid';
            }

            if ($item['type'] === 'url') {
                $summary['has_login_url'] = true;
            }
        }

        return $summary;
    }
}
