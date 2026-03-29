-- ============================================================
-- ClearOrbit — MySQL Database Schema
-- Run this once on your Hostinger MySQL database
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE IF NOT EXISTS users (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    username       VARCHAR(255) NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,
    role           ENUM('admin','user','reseller') NOT NULL DEFAULT 'user',
    is_active      TINYINT(1) NOT NULL DEFAULT 1,
    device_id      VARCHAR(255) NULL DEFAULT NULL,
    last_login_ip  VARCHAR(45) NULL DEFAULT NULL,
    admin_level    VARCHAR(50) NULL DEFAULT NULL,
    name           VARCHAR(255) NULL DEFAULT NULL,
    email          VARCHAR(255) NULL DEFAULT NULL,
    phone          VARCHAR(50) NULL DEFAULT NULL,
    expiry_date    VARCHAR(20) NULL DEFAULT NULL,
    country        VARCHAR(100) NULL DEFAULT NULL,
    city           VARCHAR(100) NULL DEFAULT NULL,
    gender         VARCHAR(20) NULL DEFAULT NULL,
    profile_image  VARCHAR(500) NULL DEFAULT NULL,
    profile_completed TINYINT(1) NOT NULL DEFAULT 0,
    ip_country     VARCHAR(100) NULL DEFAULT NULL,
    ip_region      VARCHAR(100) NULL DEFAULT NULL,
    ip_city        VARCHAR(100) NULL DEFAULT NULL,
    ip_isp         VARCHAR(255) NULL DEFAULT NULL,
    ip_timezone    VARCHAR(100) NULL DEFAULT NULL,
    ip_lat         DECIMAL(10,6) NULL DEFAULT NULL,
    ip_lon         DECIMAL(10,6) NULL DEFAULT NULL,
    ip_lookup_status VARCHAR(20) NULL DEFAULT NULL,
    device_lat     DECIMAL(10,6) NULL DEFAULT NULL,
    device_lon     DECIMAL(10,6) NULL DEFAULT NULL,
    device_accuracy DECIMAL(10,2) NULL DEFAULT NULL,
    device_address TEXT NULL DEFAULT NULL,
    device_city    VARCHAR(100) NULL DEFAULT NULL,
    device_region  VARCHAR(100) NULL DEFAULT NULL,
    device_country VARCHAR(100) NULL DEFAULT NULL,
    device_location_at DATETIME NULL DEFAULT NULL,
    reseller_id    INT NULL DEFAULT NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_users_role (role),
    INDEX idx_users_created (created_at),
    INDEX idx_users_reseller (reseller_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platforms (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    name             VARCHAR(255) NOT NULL,
    logo_url         VARCHAR(500) NULL DEFAULT NULL,
    bg_color_hex     VARCHAR(10) NOT NULL DEFAULT '#1e293b',
    is_active        TINYINT(1) NOT NULL DEFAULT 1,
    max_slots_per_cookie INT NOT NULL DEFAULT 5,
    cookie_domain    VARCHAR(255) NULL DEFAULT NULL,
    login_url        VARCHAR(500) NULL DEFAULT NULL,
    health_score     INT NOT NULL DEFAULT 100,
    health_status    VARCHAR(20) NOT NULL DEFAULT 'active',
    auto_detected    TINYINT(1) NOT NULL DEFAULT 0,
    last_health_check DATETIME NULL DEFAULT NULL,
    total_accounts   INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cookie_vault (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    platform_id         INT NOT NULL,
    cookie_string       LONGTEXT NOT NULL,
    expires_at          DATETIME NULL DEFAULT NULL,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    cookie_count        INT NOT NULL DEFAULT 0,
    slot                INT NOT NULL DEFAULT 1,
    cookie_status       VARCHAR(20) NOT NULL DEFAULT 'VALID',
    login_status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    score               INT NOT NULL DEFAULT 0,
    last_checked        DATETIME NULL DEFAULT NULL,
    fingerprint         VARCHAR(255) NULL DEFAULT NULL,
    pool_type           VARCHAR(20) NOT NULL DEFAULT 'active',
    verified_at         DATETIME NULL DEFAULT NULL,
    verify_proof        TEXT NULL DEFAULT NULL,
    verification_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE,
    INDEX idx_cv_platform (platform_id),
    INDEX idx_cv_fingerprint (fingerprint),
    INDEX idx_cv_status (cookie_status),
    INDEX idx_cv_pool (platform_id, pool_type, cookie_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_subscriptions (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    platform_id INT NOT NULL,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    is_active   TINYINT(1) NOT NULL DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE,
    INDEX idx_us_user (user_id, is_active),
    INDEX idx_us_platform (platform_id, is_active),
    INDEX idx_us_enddate (end_date, is_active),
    INDEX idx_us_active (is_active, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activity_logs (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NULL,
    action     VARCHAR(500) NOT NULL,
    ip_address VARCHAR(45) NULL DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_al_created (created_at),
    INDEX idx_al_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    ip_address   VARCHAR(45) NOT NULL,
    attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_la_ip (ip_address, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sessions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NOT NULL,
    session_token   VARCHAR(128) NOT NULL,
    device_id       VARCHAR(255) NOT NULL,
    ip_address      VARCHAR(45) NULL DEFAULT NULL,
    user_agent      TEXT NULL DEFAULT NULL,
    device_type     VARCHAR(20) NOT NULL DEFAULT 'desktop',
    browser         VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    os              VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
    last_activity   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    logout_reason   VARCHAR(255) NULL DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_us_token (session_token),
    INDEX idx_us_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_history (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    ip_address  VARCHAR(45) NULL DEFAULT NULL,
    user_agent  TEXT NULL DEFAULT NULL,
    device_type VARCHAR(20) NOT NULL DEFAULT 'desktop',
    browser     VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    os          VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    action      ENUM('login','logout','force_logout','blocked') NOT NULL DEFAULT 'login',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_lh_user (user_id, created_at),
    INDEX idx_lh_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pricing_plans (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    platform_id   INT NOT NULL,
    duration_key  ENUM('1_week','1_month','6_months','1_year') NOT NULL,
    shared_price  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    private_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    UNIQUE KEY uk_platform_duration (platform_id, duration_key),
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS whatsapp_config (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    platform_id    INT NOT NULL,
    shared_number  VARCHAR(30) NOT NULL DEFAULT '',
    private_number VARCHAR(30) NOT NULL DEFAULT '',
    UNIQUE KEY uk_wc_platform (platform_id),
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT NULL,
    platform_id  INT NOT NULL,
    username     VARCHAR(255) NOT NULL DEFAULT '',
    duration_key VARCHAR(20) NOT NULL,
    account_type ENUM('shared','private') NOT NULL DEFAULT 'shared',
    price        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    whatsapp_msg TEXT NULL DEFAULT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    screenshot   TEXT NULL DEFAULT NULL,
    payment_method VARCHAR(50) NULL DEFAULT NULL,
    reseller_id  INT NULL DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE,
    INDEX idx_pay_status (status, created_at),
    INDEX idx_pay_user (user_id),
    INDEX idx_pay_reseller (reseller_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_tickets (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    user_id       INT NOT NULL,
    platform_name VARCHAR(255) NOT NULL,
    message       TEXT NOT NULL,
    status        ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_st_status (status, created_at),
    INDEX idx_st_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcements (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    title      VARCHAR(255) NOT NULL,
    message    TEXT NOT NULL,
    type       VARCHAR(20) NOT NULL DEFAULT 'popup',
    status     ENUM('active','inactive') NOT NULL DEFAULT 'active',
    start_time DATETIME DEFAULT NULL,
    end_time   DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_notifications (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NULL,
    title      VARCHAR(255) NOT NULL,
    message    TEXT NOT NULL,
    type       ENUM('info','success','warning') NOT NULL DEFAULT 'info',
    is_read    TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_un_user (user_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_accounts (
    id                    INT AUTO_INCREMENT PRIMARY KEY,
    platform_id           INT NOT NULL,
    slot_name             VARCHAR(100) NOT NULL DEFAULT 'Login 1',
    cookie_data           LONGTEXT NOT NULL DEFAULT '',
    max_users             INT NOT NULL DEFAULT 5,
    cookie_count          INT NOT NULL DEFAULT 0,
    expires_at            DATETIME NULL DEFAULT NULL,
    is_active             TINYINT(1) NOT NULL DEFAULT 1,
    success_count         INT NOT NULL DEFAULT 0,
    fail_count            INT NOT NULL DEFAULT 0,
    last_success_at       DATETIME NULL DEFAULT NULL,
    last_failed_at        DATETIME NULL DEFAULT NULL,
    health_status         VARCHAR(20) NOT NULL DEFAULT 'healthy',
    cooldown_until        DATETIME NULL DEFAULT NULL,
    cookie_status         VARCHAR(20) NOT NULL DEFAULT 'VALID',
    login_status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    last_verified_at      DATETIME NULL DEFAULT NULL,
    intelligence_score    INT NOT NULL DEFAULT 0,
    stability_status      VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    last_intelligence_run DATETIME NULL DEFAULT NULL,
    cookie_id             INT NULL DEFAULT NULL,
    profile_index         INT NOT NULL DEFAULT 1,
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE,
    INDEX idx_pa_cookie (cookie_id),
    INDEX idx_pa_platform (platform_id, is_active),
    INDEX idx_pa_scoring (platform_id, is_active, health_status, success_count, fail_count),
    INDEX idx_pa_intelligence (intelligence_score, stability_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_intelligence_log (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    account_id      INT NOT NULL,
    platform_id     INT NOT NULL,
    event_type      VARCHAR(50) NOT NULL,
    old_score       INT NOT NULL DEFAULT 0,
    new_score       INT NOT NULL DEFAULT 0,
    old_stability   VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    new_stability   VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
    reason          TEXT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE,
    INDEX idx_ail_account (account_id, created_at),
    INDEX idx_ail_type (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_sessions (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    account_id    INT NOT NULL,
    user_id       INT NOT NULL,
    platform_id   INT NOT NULL,
    status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
    device_type   VARCHAR(20) NOT NULL DEFAULT 'desktop',
    last_active   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES platform_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE,
    INDEX idx_as_account (account_id, status),
    INDEX idx_as_user (user_id, platform_id),
    INDEX idx_as_status (status),
    INDEX idx_as_last_active (last_active),
    INDEX idx_as_active_lookup (account_id, status, last_active),
    INDEX idx_as_user_status (user_id, platform_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contact_messages (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(255) NOT NULL,
    message    TEXT NOT NULL,
    is_read    TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cm_read (is_read, created_at),
    INDEX idx_cm_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS site_settings (
    setting_key   VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO site_settings (setting_key, setting_value) VALUES ('default_expiry_days', '30');
INSERT IGNORE INTO site_settings (setting_key, setting_value) VALUES ('whatsapp_number', '');
INSERT IGNORE INTO site_settings (setting_key, setting_value) VALUES ('whatsapp_message', 'Hi, I need help with my ClearOrbit account.');
INSERT IGNORE INTO site_settings (setting_key, setting_value) VALUES ('reseller_cost_per_user', '100');
INSERT IGNORE INTO site_settings (setting_key, setting_value) VALUES ('reseller_auto_approve', '0');

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NOT NULL,
    token      VARCHAR(128) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used       TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempt_logs (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    username     VARCHAR(255) NOT NULL DEFAULT '',
    ip_address   VARCHAR(45) NOT NULL DEFAULT '',
    user_agent   TEXT NULL DEFAULT NULL,
    device_type  VARCHAR(20) NOT NULL DEFAULT 'desktop',
    browser      VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    os           VARCHAR(50) NOT NULL DEFAULT 'Unknown',
    status       ENUM('success','failed','blocked','disabled') NOT NULL DEFAULT 'failed',
    reason       VARCHAR(255) NULL DEFAULT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lal_status (status, created_at),
    INDEX idx_lal_ip (ip_address, created_at),
    INDEX idx_lal_username (username, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS resellers (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NOT NULL UNIQUE,
    balance         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    commission_rate DECIMAL(5,2) NOT NULL DEFAULT 20.00,
    total_earnings  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    total_users     INT NOT NULL DEFAULT 0,
    status          ENUM('active','suspended','pending') NOT NULL DEFAULT 'active',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reseller_transactions (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    reseller_id   INT NOT NULL,
    type          ENUM('recharge','deduction','commission','refund') NOT NULL,
    amount        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    balance_after DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    description   TEXT NULL DEFAULT NULL,
    status        ENUM('pending','completed','rejected') NOT NULL DEFAULT 'completed',
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
    INDEX idx_rt_reseller (reseller_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recharge_requests (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    reseller_id INT NOT NULL,
    amount      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    method      VARCHAR(50) NOT NULL DEFAULT 'manual',
    screenshot  TEXT NULL DEFAULT NULL,
    status      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    admin_note  TEXT NULL DEFAULT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
    INDEX idx_rr_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_pool (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    netflix_id         VARCHAR(512) NOT NULL,
    secure_netflix_id  VARCHAR(512) NULL,
    domain             VARCHAR(255) NOT NULL DEFAULT '.netflix.com',
    account_country    VARCHAR(10) NULL,
    health_score       INT NOT NULL DEFAULT 100,
    status             ENUM('active','cooldown','dead','locked') NOT NULL DEFAULT 'active',
    locked_by          VARCHAR(255) NULL,
    lock_time          DATETIME NULL,
    usage_count        INT NOT NULL DEFAULT 0,
    last_used          DATETIME NULL,
    cooldown_until     DATETIME NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_sp_status (status),
    INDEX idx_sp_health (status, health_score),
    INDEX idx_sp_cooldown (status, cooldown_until),
    INDEX idx_sp_last_used (last_used)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session_analytics (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    pool_id    INT NULL,
    event      VARCHAR(100) NOT NULL,
    detail     TEXT NULL,
    ip_address VARCHAR(45) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pool_id) REFERENCES session_pool(id) ON DELETE SET NULL,
    INDEX idx_sa_pool (pool_id, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ip_geo_cache (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    ip_address   VARCHAR(45) NOT NULL,
    country      VARCHAR(100) NOT NULL DEFAULT 'Unknown',
    country_code VARCHAR(10) NOT NULL DEFAULT '--',
    region       VARCHAR(100) NOT NULL DEFAULT 'Unknown',
    city         VARCHAR(100) NOT NULL DEFAULT 'Unknown',
    isp          VARCHAR(255) NOT NULL DEFAULT 'Unknown',
    lat          DECIMAL(10,6) NOT NULL DEFAULT 0,
    lon          DECIMAL(10,6) NOT NULL DEFAULT 0,
    timezone     VARCHAR(100) NOT NULL DEFAULT '',
    looked_up_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_ip (ip_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS security_events (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    event_type  VARCHAR(100) NOT NULL,
    severity    ENUM('low','medium','high','critical') NOT NULL DEFAULT 'low',
    ip_address  VARCHAR(45) NULL DEFAULT NULL,
    details     TEXT NULL DEFAULT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_se_user (user_id),
    INDEX idx_se_type (event_type, created_at),
    INDEX idx_se_severity (severity, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
