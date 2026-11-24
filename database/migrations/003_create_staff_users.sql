CREATE TABLE IF NOT EXISTS staff_users (
  staff_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- 1. Identity and access
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('support', 'admin') NOT NULL DEFAULT 'support',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',

  -- Raise this number to end every session and support token of this user.
  session_version INT UNSIGNED NOT NULL DEFAULT 1,

  -- 2. Two-step login (TOTP). The staff user sets it up at the first login.
  totp_secret_encrypted TEXT NULL,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last_used_step BIGINT UNSIGNED NULL, -- blocks using the same code twice

  -- 3. Login protection
  failed_login_count INT UNSIGNED NOT NULL DEFAULT 0,
  -- wrong passwords lock the account for 15 minutes. If you lock yourself, run this in MySQL: UPDATE staff_users SET locked_until = NULL, failed_login_count = 0;
  locked_until DATETIME NULL,

  -- 4. Database audit
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (staff_id),

  UNIQUE KEY uq_staff_users_username (username)

) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE=utf8mb4_unicode_ci;