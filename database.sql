-- ============================================================
-- ClearOrbit SaaS Platform - MySQL Schema
-- For deployment on Hostinger (or any MySQL 5.7+ / 8.0+ host)
-- ============================================================

CREATE DATABASE IF NOT EXISTS shared_access_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE shared_access_db;

-- -----------------------------------------------------------
-- Table: users
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
    `id`            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `username`      VARCHAR(100)    NOT NULL UNIQUE,
    `password_hash` VARCHAR(255)    NOT NULL,
    `role`          ENUM('admin','user') NOT NULL DEFAULT 'user',
    `is_active`     TINYINT(1)      NOT NULL DEFAULT 1,
    `device_id`     VARCHAR(255)    NULL DEFAULT NULL,
    `last_login_ip` VARCHAR(45)     NULL DEFAULT NULL,
    `admin_level`   VARCHAR(20)     NULL DEFAULT NULL COMMENT 'super_admin or manager for admin users, NULL for regular users',
    `name`          VARCHAR(100)    NULL DEFAULT NULL,
    `email`         VARCHAR(255)    NULL DEFAULT NULL,
    `phone`         VARCHAR(20)     NULL DEFAULT NULL,
    `expiry_date`   DATE            NULL DEFAULT NULL,
    `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: platforms
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `platforms` (
    `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name`          VARCHAR(150) NOT NULL,
    `logo_url`      VARCHAR(500) NULL DEFAULT NULL,
    `bg_color_hex`  VARCHAR(7)   NOT NULL DEFAULT '#1e293b',
    `is_active`     TINYINT(1)   NOT NULL DEFAULT 1,
    `cookie_domain` VARCHAR(255) NULL DEFAULT NULL COMMENT 'e.g. .netflix.com',
    `login_url`     VARCHAR(500) NULL DEFAULT NULL COMMENT 'e.g. https://www.netflix.com/',
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: cookie_vault
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `cookie_vault` (
    `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `platform_id`   INT UNSIGNED NOT NULL,
    `cookie_string` LONGTEXT     NOT NULL,
    `expires_at`    DATETIME     NULL DEFAULT NULL,
    `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_platform` (`platform_id`),
    CONSTRAINT `fk_cv_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: user_subscriptions
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_subscriptions` (
    `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id`     INT UNSIGNED NOT NULL,
    `platform_id` INT UNSIGNED NOT NULL,
    `start_date`  DATE         NOT NULL,
    `end_date`    DATE         NOT NULL,
    `is_active`   TINYINT(1)   NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`),
    INDEX `idx_user`     (`user_id`),
    INDEX `idx_platform` (`platform_id`),
    CONSTRAINT `fk_us_user`     FOREIGN KEY (`user_id`)     REFERENCES `users`     (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_us_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: activity_logs
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `activity_logs` (
    `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id`    INT UNSIGNED NULL,
    `action`     VARCHAR(255) NOT NULL,
    `ip_address` VARCHAR(45)  NULL DEFAULT NULL,
    `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_user` (`user_id`),
    INDEX `idx_created` (`created_at`),
    CONSTRAINT `fk_al_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: login_attempts (rate limiting)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `login_attempts` (
    `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ip_address`   VARCHAR(45)  NOT NULL,
    `attempted_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_ip` (`ip_address`),
    INDEX `idx_time` (`attempted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: pricing_plans
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `pricing_plans` (
    `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `platform_id`   INT UNSIGNED NOT NULL,
    `duration_key`  ENUM('1_week','1_month','6_months','1_year') NOT NULL,
    `shared_price`  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `private_price` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_platform_duration` (`platform_id`, `duration_key`),
    CONSTRAINT `fk_pp_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: whatsapp_config
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `whatsapp_config` (
    `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `platform_id`    INT UNSIGNED NOT NULL,
    `shared_number`  VARCHAR(20) NOT NULL DEFAULT '',
    `private_number` VARCHAR(20) NOT NULL DEFAULT '',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_wa_platform` (`platform_id`),
    CONSTRAINT `fk_wa_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: payments
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `payments` (
    `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id`      INT UNSIGNED NULL,
    `platform_id`  INT UNSIGNED NOT NULL,
    `username`     VARCHAR(100) NOT NULL DEFAULT '',
    `duration_key` VARCHAR(20) NOT NULL,
    `account_type` ENUM('shared','private') NOT NULL DEFAULT 'shared',
    `price`        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `status`       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    `whatsapp_msg` TEXT NULL DEFAULT NULL,
    `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_status` (`status`),
    CONSTRAINT `fk_pay_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
    CONSTRAINT `fk_pay_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Add slot column to cookie_vault
-- -----------------------------------------------------------
ALTER TABLE `cookie_vault` ADD COLUMN `slot` TINYINT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE `cookie_vault` ADD COLUMN `cookie_count` INT UNSIGNED NOT NULL DEFAULT 0;

-- -----------------------------------------------------------
-- Table: user_sessions (device-based login control)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_sessions` (
    `id`              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `user_id`         INT UNSIGNED    NOT NULL,
    `session_token`   VARCHAR(128)    NOT NULL,
    `device_id`       VARCHAR(255)    NOT NULL,
    `ip_address`      VARCHAR(45)     NULL DEFAULT NULL,
    `user_agent`      TEXT            NULL DEFAULT NULL,
    `device_type`     ENUM('desktop','mobile','tablet') NOT NULL DEFAULT 'desktop',
    `browser`         VARCHAR(50)     NOT NULL DEFAULT 'Unknown',
    `os`              VARCHAR(50)     NOT NULL DEFAULT 'Unknown',
    `status`          ENUM('active','inactive') NOT NULL DEFAULT 'active',
    `last_activity`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `logout_reason`   VARCHAR(255)    NULL DEFAULT NULL,
    `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_user_status` (`user_id`, `status`),
    INDEX `idx_token` (`session_token`),
    CONSTRAINT `fk_sess_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: login_history (login tracking)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `login_history` (
    `id`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `user_id`     INT UNSIGNED    NOT NULL,
    `ip_address`  VARCHAR(45)     NULL DEFAULT NULL,
    `user_agent`  TEXT            NULL DEFAULT NULL,
    `device_type` ENUM('desktop','mobile','tablet') NOT NULL DEFAULT 'desktop',
    `browser`     VARCHAR(50)     NOT NULL DEFAULT 'Unknown',
    `os`          VARCHAR(50)     NOT NULL DEFAULT 'Unknown',
    `action`      ENUM('login','logout','force_logout','blocked') NOT NULL DEFAULT 'login',
    `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_user_action` (`user_id`, `action`),
    INDEX `idx_created` (`created_at`),
    CONSTRAINT `fk_lh_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: password_reset_tokens
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `password_reset_tokens` (
    `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `user_id`    INT UNSIGNED    NOT NULL,
    `token`      VARCHAR(128)    NOT NULL UNIQUE,
    `expires_at` DATETIME        NOT NULL,
    `used`       TINYINT(1)      NOT NULL DEFAULT 0,
    `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_token` (`token`),
    CONSTRAINT `fk_prt_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: support_tickets
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `support_tickets` (
    `id`            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `user_id`       INT UNSIGNED    NOT NULL,
    `platform_name` VARCHAR(100)    NOT NULL,
    `message`       TEXT            NOT NULL,
    `status`        ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
    `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_st_status` (`status`),
    CONSTRAINT `fk_st_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: announcements
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `announcements` (
    `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `title`      VARCHAR(255)    NOT NULL,
    `message`    TEXT            NOT NULL,
    `type`       ENUM('popup','notification') NOT NULL DEFAULT 'popup',
    `status`     ENUM('active','inactive') NOT NULL DEFAULT 'active',
    `start_time` DATETIME        DEFAULT NULL,
    `end_time`   DATETIME        DEFAULT NULL,
    `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_ann_status` (`status`),
    INDEX `idx_ann_time` (`start_time`, `end_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: user_notifications
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_notifications` (
    `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `user_id`    INT UNSIGNED    NULL,
    `title`      VARCHAR(255)    NOT NULL,
    `message`    TEXT            NOT NULL,
    `type`       ENUM('info','success','warning') NOT NULL DEFAULT 'info',
    `is_read`    TINYINT(1)      NOT NULL DEFAULT 0,
    `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_un_user` (`user_id`, `is_read`),
    CONSTRAINT `fk_un_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: contact_messages
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `contact_messages` (
    `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `name`       VARCHAR(100)    NOT NULL,
    `email`      VARCHAR(255)    NOT NULL,
    `message`    TEXT            NOT NULL,
    `is_read`    TINYINT(1)      NOT NULL DEFAULT 0,
    `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_cm_read` (`is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: login_attempt_logs (detailed login attempt tracking)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `login_attempt_logs` (
    `id`           INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `username`     VARCHAR(255)    NOT NULL DEFAULT '',
    `ip_address`   VARCHAR(45)     NOT NULL DEFAULT '',
    `user_agent`   TEXT            NULL DEFAULT NULL,
    `device_type`  ENUM('desktop','mobile','tablet') NOT NULL DEFAULT 'desktop',
    `browser`      VARCHAR(50)     NOT NULL DEFAULT 'Unknown',
    `os`           VARCHAR(50)     NOT NULL DEFAULT 'Unknown',
    `status`       ENUM('success','failed','blocked','disabled') NOT NULL DEFAULT 'failed',
    `reason`       VARCHAR(255)    NULL DEFAULT NULL,
    `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_lat_status` (`status`),
    INDEX `idx_lat_created` (`created_at`),
    INDEX `idx_lat_ip` (`ip_address`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: platform_accounts (multi-account slot system)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `platform_accounts` (
    `id`              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `platform_id`     INT UNSIGNED    NOT NULL,
    `slot_name`       VARCHAR(100)    NOT NULL DEFAULT 'Login 1',
    `cookie_data`     LONGTEXT        NOT NULL,
    `max_users`       TINYINT UNSIGNED NOT NULL DEFAULT 5,
    `cookie_count`    INT UNSIGNED    NOT NULL DEFAULT 0,
    `expires_at`      DATETIME        NULL DEFAULT NULL,
    `is_active`       TINYINT(1)      NOT NULL DEFAULT 1,
    `success_count`   INT UNSIGNED    NOT NULL DEFAULT 0,
    `fail_count`      INT UNSIGNED    NOT NULL DEFAULT 0,
    `last_success_at` DATETIME        NULL DEFAULT NULL,
    `last_failed_at`  DATETIME        NULL DEFAULT NULL,
    `health_status`   ENUM('healthy','degraded','unhealthy') NOT NULL DEFAULT 'healthy',
    `cooldown_until`  DATETIME        NULL DEFAULT NULL,
    `cookie_status`   ENUM('VALID','EXPIRED','DEAD','RISKY') NOT NULL DEFAULT 'VALID',
    `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_pa_platform` (`platform_id`, `is_active`),
    INDEX `idx_pa_health` (`platform_id`, `is_active`, `health_status`),
    CONSTRAINT `fk_pa_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Table: account_sessions (tracks active users per account)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `account_sessions` (
    `id`            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    `account_id`    INT UNSIGNED    NOT NULL,
    `user_id`       INT UNSIGNED    NOT NULL,
    `platform_id`   INT UNSIGNED    NOT NULL,
    `status`        ENUM('active','inactive') NOT NULL DEFAULT 'active',
    `device_type`   VARCHAR(20)     NOT NULL DEFAULT 'desktop',
    `last_active`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_as_user_platform` (`user_id`, `platform_id`),
    INDEX `idx_as_account` (`account_id`, `status`),
    INDEX `idx_as_user` (`user_id`, `platform_id`),
    INDEX `idx_as_status` (`status`),
    INDEX `idx_as_last_active` (`last_active`),
    INDEX `idx_as_active_lookup` (`account_id`, `status`, `last_active`),
    INDEX `idx_as_user_status` (`user_id`, `platform_id`, `status`),
    CONSTRAINT `fk_as_account` FOREIGN KEY (`account_id`) REFERENCES `platform_accounts` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_as_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_as_platform` FOREIGN KEY (`platform_id`) REFERENCES `platforms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- Dummy Data
-- -----------------------------------------------------------
-- NOTE: Do not commit real admin credentials here.
-- After running this schema, insert the admin user manually with a bcrypt hash
-- generated from your chosen password. Example (run in your app or a script):
--   INSERT INTO `users` (`username`, `password_hash`, `role`, `is_active`, `admin_level`, `name`, `email`, `phone`)
--   VALUES ('admin', '<bcrypt_hash_of_your_password>', 'admin', 1, 'super_admin', 'Your Name', 'your@email.com', '');
-- INSERT INTO `users` (`username`, `password_hash`, `role`, `is_active`, `admin_level`, `name`, `email`, `phone`) VALUES
-- ('john_doe', '<bcrypt_hash_of_your_password>', 'user', 1, NULL, 'John Doe', 'john@example.com', '+1234567890');

INSERT INTO `platforms` (`name`, `logo_url`, `bg_color_hex`, `is_active`, `cookie_domain`, `login_url`) VALUES
('Netflix',    'https://upload.wikimedia.org/wikipedia/commons/0/08/Netflix_2015_logo.svg', '#e50914', 1, '.netflix.com',    'https://www.netflix.com/'),
('Spotify',    'https://upload.wikimedia.org/wikipedia/commons/2/26/Spotify_logo_with_text.svg', '#1db954', 1, '.spotify.com',    'https://open.spotify.com/'),
('Disney+',    'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg', '#0063e5', 1, '.disneyplus.com', 'https://www.disneyplus.com/'),
('ChatGPT',    'https://upload.wikimedia.org/wikipedia/commons/0/04/ChatGPT_logo.svg', '#10a37f', 1, '.openai.com',     'https://chat.openai.com/'),
('Canva',      'https://upload.wikimedia.org/wikipedia/commons/0/08/Canva_icon_2021.svg', '#7d2ae8', 1, '.canva.com',      'https://www.canva.com/'),
('Udemy',      'https://upload.wikimedia.org/wikipedia/commons/e/e3/Udemy_logo.svg', '#a435f0', 1, '.udemy.com',      'https://www.udemy.com/'),
('Coursera',   'https://upload.wikimedia.org/wikipedia/commons/9/97/Coursera-Logo_600x600.svg', '#0056d2', 1, '.coursera.org',   'https://www.coursera.org/'),
('Skillshare', 'https://upload.wikimedia.org/wikipedia/commons/2/2e/Skillshare_logo.svg', '#00ff84', 1, '.skillshare.com', 'https://www.skillshare.com/'),
('Grammarly',  'https://upload.wikimedia.org/wikipedia/commons/a/a0/Grammarly_Logo.svg', '#15c39a', 1, '.grammarly.com',  'https://app.grammarly.com/');

INSERT INTO `cookie_vault` (`platform_id`, `cookie_string`, `expires_at`) VALUES
(1, TO_BASE64('NetflixId=sample_cookie_value_here; nfvdid=sample_device_id;'), DATE_ADD(NOW(), INTERVAL 30 DAY)),
(2, TO_BASE64('sp_dc=sample_spotify_cookie_here; sp_key=sample_key;'), DATE_ADD(NOW(), INTERVAL 30 DAY)),
(3, TO_BASE64('disney_token=sample_disney_cookie; dss_id=sample_dss;'), DATE_ADD(NOW(), INTERVAL 30 DAY)),
(4, TO_BASE64('chatgpt_session=sample_chatgpt_cookie; cf_clearance=sample;'), DATE_ADD(NOW(), INTERVAL 30 DAY)),
(5, TO_BASE64('canva_session=sample_canva_cookie; csrf=sample_token;'), DATE_ADD(NOW(), INTERVAL 30 DAY));

INSERT INTO `user_subscriptions` (`user_id`, `platform_id`, `start_date`, `end_date`, `is_active`) VALUES
(2, 1, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 30 DAY), 1),
(2, 2, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 15 DAY), 1),
(2, 3, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 22 DAY), 1),
(2, 4, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 45 DAY), 1),
(2, 5, CURDATE(), DATE_ADD(CURDATE(), INTERVAL  7 DAY), 1);
