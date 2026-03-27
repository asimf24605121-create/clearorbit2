<?php
/**
 * ClearOrbit — Production Configuration
 * 
 * For Hostinger: Update with your MySQL credentials
 * found in hPanel → Databases → MySQL Databases
 *
 * For Replit/dev: Leave DB_DRIVER as 'sqlite'
 */

date_default_timezone_set('UTC');

$env = getenv('APP_ENV') ?: 'production';

if ($env === 'production') {
    define('DB_DRIVER', 'mysql');
    define('DB_HOST',   'localhost');
    define('DB_NAME',   'u123456789_clearorbit');
    define('DB_USER',   'u123456789_admin');
    define('DB_PASS',   'YOUR_DATABASE_PASSWORD_HERE');
} else {
    define('DB_DRIVER', 'sqlite');
    define('DB_HOST',   'localhost');
    define('DB_NAME',   '');
    define('DB_USER',   '');
    define('DB_PASS',   '');
}

putenv('DB_DRIVER=' . DB_DRIVER);
putenv('DB_HOST='   . DB_HOST);
putenv('DB_NAME='   . DB_NAME);
putenv('DB_USER='   . DB_USER);
putenv('DB_PASS='   . DB_PASS);

define('SITE_URL', $env === 'production' ? 'https://yourdomain.com' : 'http://localhost:5000');

define('ALLOWED_ORIGINS_LIST', SITE_URL);
putenv('ALLOWED_ORIGINS=' . ALLOWED_ORIGINS_LIST);

ini_set('display_errors', $env === 'production' ? '0' : '1');
ini_set('log_errors', '1');
error_reporting(E_ALL);
