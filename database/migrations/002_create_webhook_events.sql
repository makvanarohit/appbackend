CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id BIGINT UNSIGNED NOT NULL,

  shopify_webhook_id VARCHAR(128) NOT NULL,
  topic VARCHAR(128) NOT NULL,
  shop_domain VARCHAR(255) NOT NULL,

  payload JSON NOT NULL,
  triggered_at DATETIME(6) NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,

  status ENUM('received', 'processing', 'completed', 'failed')
    NOT NULL DEFAULT 'received',

  error TEXT NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_events_webhook_id (shopify_webhook_id),
  KEY idx_webhook_events_store_id (store_id),
  KEY idx_webhook_events_topic (topic),
  KEY idx_webhook_events_status_received (status, received_at),

  CONSTRAINT fk_webhook_events_store
    FOREIGN KEY (store_id)
    REFERENCES stores(store_id)
    ON DELETE CASCADE

) ENGINE=InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE=utf8mb4_unicode_ci;