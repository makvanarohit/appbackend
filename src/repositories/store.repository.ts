import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../config/database';
import { env } from '../config/env';
import type { Store } from '../models/store.model';


function parseSettingsJson(value: unknown): Record<string, unknown> | null {
    if (!value) return null;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value as Record<string, unknown>;
}

function mapRow(row: RowDataPacket): Store {
    return {
        ...(row as unknown as Store),
        settings_json: parseSettingsJson(row.settings_json),
        is_shopify_plus: Boolean(row.is_shopify_plus),
        storefront_enabled: Boolean(row.storefront_enabled),
        onboarding_completed: Boolean(row.onboarding_completed),
    };
}

export async function findByShopDomain(shopDomain: string): Promise<Store | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM stores WHERE shop_domain = :shopDomain LIMIT 1',
        { shopDomain },
    );
    return rows[0] ? mapRow(rows[0]) : null;
}

export async function findOrCreateByShopDomain(shopDomain: string): Promise<Store> {
    const existing = await findByShopDomain(shopDomain);
    if (existing) return existing;

    await pool.query(
        `INSERT INTO stores (shop_domain)
     VALUES (:shopDomain)
     ON DUPLICATE KEY UPDATE shop_domain = shop_domain`,
        { shopDomain },
    );

    const created = await findByShopDomain(shopDomain);
    if (!created) {
        throw new Error(`Failed to create or load store for ${shopDomain}`);
    }
    return created;
}

interface SaveOfflineTokenInput {
    shopDomain: string;
    accessTokenEncrypted: string;
    accessTokenExpiresAt: Date | null;
    refreshTokenEncrypted: string | null;
    refreshTokenExpiresAt: Date | null;
}

export async function saveOfflineToken(input: SaveOfflineTokenInput): Promise<void> {
    await pool.query(
        `UPDATE stores SET
       access_token_encrypted = :accessTokenEncrypted,
       access_token_issued_at = NOW(),
       access_token_expires_at = :accessTokenExpiresAt,
       refresh_token_encrypted = :refreshTokenEncrypted,
       refresh_token_expires_at = :refreshTokenExpiresAt,
       token_encryption_key_id = :tokenEncryptionKeyId,
       last_token_exchange_at = NOW(),
       last_token_exchange_status = 'success',
       last_token_exchange_error = NULL,
       installation_status = IF(installation_status = 'uninstalled', 'reinstalled', 'installed'),
       installed_at = COALESCE(installed_at, NOW()),
       first_installed_at = COALESCE(first_installed_at, NOW()),
       last_installed_at = NOW(),
       last_seen_at = NOW(),
       app_status = 'enabled',
       uninstalled_at = NULL
     WHERE shop_domain = :shopDomain`,
        {
            shopDomain: input.shopDomain,
            accessTokenEncrypted: input.accessTokenEncrypted,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            refreshTokenEncrypted: input.refreshTokenEncrypted,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt,
            tokenEncryptionKeyId: env.tokenEncryptionKeyId,
        },
    );
}

// Saves tokens that came from a REFRESH (not from an install or a new authorization).
// A refresh is not an install, so this changes ONLY the tokens and the token health columns.
// It never touches installation_status, installed_at, last_installed_at or last_seen_at.
// It also never saves anything for a shop that is uninstalled (it returns false), so a slow
// refresh that finishes after the uninstall cannot bring the shop back to life.
export async function saveRefreshedTokens(input: SaveOfflineTokenInput): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE stores SET
       access_token_encrypted = :accessTokenEncrypted,
       access_token_issued_at = NOW(),
       access_token_expires_at = :accessTokenExpiresAt,
       refresh_token_encrypted = :refreshTokenEncrypted,
       refresh_token_expires_at = :refreshTokenExpiresAt,
       token_encryption_key_id = :tokenEncryptionKeyId,
       last_token_exchange_at = NOW(),
       last_token_exchange_status = 'success',
       last_token_exchange_error = NULL
     WHERE shop_domain = :shopDomain
       AND installation_status <> 'uninstalled'`,
        {
            shopDomain: input.shopDomain,
            accessTokenEncrypted: input.accessTokenEncrypted,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            refreshTokenEncrypted: input.refreshTokenEncrypted,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt,
            tokenEncryptionKeyId: env.tokenEncryptionKeyId,
        },
    );
    return result.affectedRows > 0;
}

export async function recordTokenExchangeFailure(shopDomain: string, error: string): Promise<void> {
    await pool.query(
        `UPDATE stores SET
       last_token_exchange_at = NOW(),
       last_token_exchange_status = 'failed',
       last_token_exchange_error = :error
     WHERE shop_domain = :shopDomain`,
        { shopDomain, error },
    );
}

// Shopify does not guarantee webhook delivery order. A late or retried
// app/uninstalled for a shop that has since reinstalled must not wipe the
// NEW tokens. If the webhook is older than the most recent install, skip.
export async function markUninstalled(shopDomain: string, triggeredAt: Date | null): Promise<void> {
    await pool.query(
        `UPDATE stores SET
       installation_status = 'uninstalled',
       app_status = 'disabled',
       uninstalled_at = NOW(),
       access_token_encrypted = NULL,
       refresh_token_encrypted = NULL,
       access_token_expires_at = NULL,
       refresh_token_expires_at = NULL
     WHERE shop_domain = :shopDomain
       AND (
         :triggeredAt IS NULL
         OR last_installed_at IS NULL
         OR last_installed_at <= :triggeredAt
       )`,
        { shopDomain, triggeredAt },
    );
}

// Used for shop/redact. Only deletes a shop that is NOT an active install.
// If the merchant reinstalled before this webhook was handled, the row is
// kept and this returns false. 'pending' rows are safe to delete: they never
// finished installing, so they hold no tokens or settings.
export async function hardDeleteStore(shopDomain: string): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `DELETE FROM stores
     WHERE shop_domain = :shopDomain
       AND installation_status IN ('uninstalled', 'pending')`,
        { shopDomain },
    );
    return result.affectedRows > 0;
}

export async function incrementStandaloneTokenVersion(shopDomain: string): Promise<void> {
    await pool.query(
        'UPDATE stores SET standalone_token_version = standalone_token_version + 1 WHERE shop_domain = :shopDomain',
        { shopDomain },
    );
}

// Returns false when there is no store row for this shop (GET /api/store has not run yet).
export async function markOnboardingCompleted(shopDomain: string): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE stores SET
       onboarding_completed = TRUE,
       onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())
     WHERE shop_domain = :shopDomain`,
        { shopDomain },
    );
    return result.affectedRows > 0;
}

// Shops whose refresh token will die within `withinDays` — the pool the
// background job needs to touch. Filtering this way (rather than "every
// installed shop, on a timer") means an active shop is never refreshed
// needlessly; only ones actually approaching the 90-day cliff show up.
export async function findShopsWithExpiringRefreshToken(withinDays: number): Promise<string[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT shop_domain FROM stores
     WHERE installation_status IN ('installed', 'reinstalled')
       AND refresh_token_encrypted IS NOT NULL
       AND refresh_token_expires_at < DATE_ADD(NOW(), INTERVAL :withinDays DAY)`,
        { withinDays },
    );
    return rows.map((row) => row.shop_domain as string);
}

// Rows still 'received' after a few minutes — the queue add failed after
// we already answered Shopify 200, so no Shopify retry is coming.
export async function findStuckWebhookEventIds(olderThanMinutes: number): Promise<number[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM webhook_events
     WHERE status = 'received'
       AND received_at < DATE_SUB(NOW(), INTERVAL :olderThanMinutes MINUTE)`,
        { olderThanMinutes },
    );
    return rows.map((row) => row.id as number);
}

// Deleting a huge pile of rows in one go can lock the table for a long time.
// So we delete in small batches until nothing is left to delete.
const CLEANUP_BATCH_SIZE = 1000;

type WebhookEventStatus = 'received' | 'processing' | 'completed' | 'failed';

async function deleteOldWebhookEventsWithStatus(
    status: WebhookEventStatus,
    olderThanDays: number,
): Promise<number> {
    let total = 0;
    for (; ;) {
        const [result] = await pool.query<ResultSetHeader>(
            `DELETE FROM webhook_events
       WHERE status = :status
         AND received_at < DATE_SUB(NOW(), INTERVAL :olderThanDays DAY)
       LIMIT ${CLEANUP_BATCH_SIZE}`,
            { status, olderThanDays },
        );
        total += result.affectedRows;
        if (result.affectedRows < CLEANUP_BATCH_SIZE) return total;
    }
}

// completed: kept `completedOlderThanDays`.
// failed, received, processing: kept `otherOlderThanDays`.
// A row that is still 'received' or 'processing' after this long was never
// finished, so the caller should log it as a warning.
export async function deleteOldWebhookEvents(
    completedOlderThanDays: number,
    otherOlderThanDays: number,
): Promise<{ completed: number; failed: number; received: number; processing: number }> {
    const completed = await deleteOldWebhookEventsWithStatus('completed', completedOlderThanDays);
    const failed = await deleteOldWebhookEventsWithStatus('failed', otherOlderThanDays);
    const received = await deleteOldWebhookEventsWithStatus('received', otherOlderThanDays);
    const processing = await deleteOldWebhookEventsWithStatus('processing', otherOlderThanDays);
    return { completed, failed, received, processing };
}

export interface ShopDetailsUpdate {
    shopifyShopId: number | null;
    shopName: string | null;
    shopEmail: string | null;
    contactEmail: string | null;
    currencyCode: string | null;
    timezone: string | null;
    shopifyPlanType: string | null;
    shopifyPlanName: string | null;
    isShopifyPlus: boolean;
    shopCreatedAt: Date | null;
}

// Saves what we read from Shopify about the shop (name, time zone, plan, ...).
// shop_updated_at = the time of this save, so you can see how fresh the details are.
export async function updateShopDetails(shopDomain: string, details: ShopDetailsUpdate): Promise<void> {
    const buildSql = (withShopId: boolean): string => `UPDATE stores SET
       ${withShopId ? 'shopify_shop_id = :shopifyShopId,' : ''}
       shop_name = :shopName,
       shop_email = :shopEmail,
       contact_email = :contactEmail,
       currency_code = :currencyCode,
       timezone = :timezone,
       shopify_plan_type = :shopifyPlanType,
       shopify_plan_name = :shopifyPlanName,
       is_shopify_plus = :isShopifyPlus,
       shop_created_at = :shopCreatedAt,
       shop_updated_at = NOW()
     WHERE shop_domain = :shopDomain`;

    try {
        await pool.query(buildSql(true), { shopDomain, ...details });
    } catch (err) {
        // shopify_shop_id is UNIQUE. If another row already has this id (for example the shop
        // got a new myshopify.com domain), save everything else and leave the id alone.
        if ((err as { code?: string }).code !== 'ER_DUP_ENTRY') throw err;
        console.warn(`[shop-details] shopify_shop_id ${details.shopifyShopId} is already used by another row; saved the rest for ${shopDomain}`);
        await pool.query(buildSql(false), { shopDomain, ...details });
    }
}