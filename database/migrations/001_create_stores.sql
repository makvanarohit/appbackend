CREATE TABLE IF NOT EXISTS stores (
  -- 1. Internal store identity
  store_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  shopify_shop_id BIGINT UNSIGNED NULL,
  shop_domain VARCHAR(255) NOT NULL,

  shop_name VARCHAR(255) NULL,
  shop_email VARCHAR(255) NULL,
  contact_email VARCHAR(255) NULL,
  primary_domain VARCHAR(255) NULL,

  country_code CHAR(2) NULL,
  currency_code CHAR(3) NULL,
  timezone VARCHAR(64) NULL,
  locale VARCHAR(20) NULL,

  shopify_plan_type VARCHAR(64) NULL,
  shopify_plan_name VARCHAR(128) NULL,
  is_shopify_plus BOOLEAN NOT NULL DEFAULT FALSE,

  -- 2. App installation / lifecycle
  installation_status ENUM('pending', 'installed', 'reinstalled', 'uninstalled')
    NOT NULL DEFAULT 'pending',
  app_status ENUM('enabled', 'disabled') NOT NULL DEFAULT 'enabled',

  installed_at DATETIME NULL,
  first_installed_at DATETIME NULL,
  last_installed_at DATETIME NULL,
  uninstalled_at DATETIME NULL,
  last_seen_at DATETIME NULL,

  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_completed_at DATETIME NULL,

  -- 3. Shopify authentication

  access_token_encrypted TEXT NULL,
  access_token_issued_at DATETIME NULL,
  access_token_expires_at DATETIME NULL,

  refresh_token_encrypted TEXT NULL,
  refresh_token_expires_at DATETIME NULL,

  token_encryption_key_id VARCHAR(64) NULL,
  standalone_token_version INT UNSIGNED NOT NULL DEFAULT 1,

  last_token_exchange_at DATETIME NULL,
  last_token_exchange_status ENUM('success', 'failed') NULL,
  last_token_exchange_error TEXT NULL,

  -- 4. Storefront / app extension settings
  storefront_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings_json JSON NULL,

  -- 5. Your app's plan
  app_plan ENUM('free', 'starter', 'pro', 'enterprise')
    NOT NULL DEFAULT 'free',
  app_plan_status ENUM('active', 'trialing', 'past_due', 'cancelled', 'expired')
    NOT NULL DEFAULT 'active',
  app_plan_started_at DATETIME NULL,
  app_plan_renews_at DATETIME NULL,
  requires_plan_selection BOOLEAN NOT NULL DEFAULT TRUE,
  plan_selection_url TEXT NULL,

  -- 6. Shopify app subscription / billing
  shopify_subscription_id VARCHAR(128) NULL,
  shopify_subscription_name VARCHAR(255) NULL,
  billing_status ENUM('free', 'trialing', 'pending', 'active', 'paused', 'cancelled', 'expired')
    NOT NULL DEFAULT 'free',
  billing_currency CHAR(3) NULL,
  billing_price_amount DECIMAL(10,2) NULL,
  billing_interval ENUM('none', 'monthly', 'annual') NOT NULL DEFAULT 'none',
  trial_days INT UNSIGNED NOT NULL DEFAULT 0,
  trial_started_at DATETIME NULL,
  trial_ends_at DATETIME NULL,
  current_billing_period_start DATETIME NULL,
  current_billing_period_end DATETIME NULL,
  subscription_activated_at DATETIME NULL,
  subscription_cancelled_at DATETIME NULL,

  -- 7. Shopify shop metadata snapshot
  shop_created_at DATETIME NULL,
  shop_updated_at DATETIME NULL,

  -- 8. Database audit
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (store_id),
  
  UNIQUE KEY uq_stores_shopify_shop_id (shopify_shop_id),
  UNIQUE KEY uq_stores_shop_domain (shop_domain),
  UNIQUE KEY uq_stores_subscription_id (shopify_subscription_id)
  
) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE=utf8mb4_unicode_ci;