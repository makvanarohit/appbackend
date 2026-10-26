import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../config/database';
import { findByShopDomain, markUninstalled, hardDeleteStore } from '../repositories/store.repository';
import { handleShopUpdateWebhook } from './shop-details.service';
import { handleOrderWebhook, handleThemeUpdateWebhook } from './order-webhook.service';
import { checkAppStillInstalled } from './app-installation.service';

interface WebhookInput {
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: unknown;
    triggeredAt: Date | null;
}

interface StoredWebhookEvent {
    id: number;
    topic: string;
    shop_domain: string;
    payload: unknown;
    triggered_at: Date | null;
}

interface CustomersDataRequestPayload {
    shop_id: number;
    shop_domain: string;
    orders_requested: number[];
    customer: { id: number; email: string; phone: string | null };
    data_request: { id: number };
}

interface CustomersRedactPayload {
    shop_id: number;
    shop_domain: string;
    customer: { id: number; email: string; phone: string | null };
    orders_to_redact: number[];
}

function isDuplicateKeyError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY';
}

async function markProcessed(
    id: number,
    status: 'completed' | 'failed',
    error?: string,
): Promise<void> {
    await pool.query(
        'UPDATE webhook_events SET status = :status, processed_at = NOW(), error = :error WHERE id = :id',
        { status, error: error ?? null, id },
    );
}

// Overwrites the payload once handled. The customer's email/phone from
// customers/redact and customers/data_request lives ONLY in this column.
// The row (topic, shop, timestamps, status) stays as the audit trail.
async function redactStoredPayload(eventId: number): Promise<void> {
    await pool.query(
        `UPDATE webhook_events SET payload = JSON_OBJECT('redacted', true) WHERE id = :eventId`,
        { eventId },
    );
}

async function loadWebhookEvent(eventId: number): Promise<StoredWebhookEvent | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT id, topic, shop_domain, payload, triggered_at FROM webhook_events WHERE id = :eventId LIMIT 1',
        { eventId },
    );
    const row = rows[0];
    if (!row) return null;
    return {
        id: row.id,
        topic: row.topic,
        shop_domain: row.shop_domain,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        triggered_at: row.triggered_at,
    };
}

async function handleCustomersDataRequest(payload: CustomersDataRequestPayload): Promise<void> {
    console.log(
        `[gdpr] data request for customer ${payload.customer.id} ` +
        `(shop ${payload.shop_domain}): this app stores no customer-level data, nothing to provide`,
    );
}

async function handleCustomersRedact(payload: CustomersRedactPayload): Promise<void> {
    console.log(
        `[gdpr] redact request for customer ${payload.customer.id} ` +
        `(shop ${payload.shop_domain}): this app stores no customer-level data, nothing to delete`,
    );
}

// The library turns "app/uninstalled" into "APP_UNINSTALLED"
// (topic.toUpperCase().replace(/\/|\./g, '_')), so these labels use
// that format, not the raw header format.
async function dispatch(
    eventId: number,
    topic: string,
    shopDomain: string,
    payload: unknown,
    triggeredAt: Date | null,
): Promise<void> {
    switch (topic) {
        case 'APP_UNINSTALLED':
            await markUninstalled(shopDomain, triggeredAt);
            break;

        case 'SHOP_REDACT': {
            const store = await findByShopDomain(shopDomain);
            if (store && (store.installation_status === 'installed' || store.installation_status === 'reinstalled')) {
                // The database says the app is installed. Either the uninstall webhook was lost, or the
                // merchant installed the app again and is using it. Ask Shopify before deleting anything.
                const check = await checkAppStillInstalled(shopDomain);
                if (check === 'installed') {
                    console.warn(`[gdpr] shop/redact for ${shopDomain}: Shopify says the app is installed (installed again?), data kept`);
                    break;
                }
                if (check === 'unknown') {
                    // Not sure. Do not delete and do not mark the event completed: the queue tries again.
                    throw new Error(`shop/redact for ${shopDomain}: could not confirm with Shopify that the app is gone; will try again`);
                }
            }
            await hardDeleteStore(shopDomain);
            break;
        }

        case 'CUSTOMERS_DATA_REQUEST':
            await handleCustomersDataRequest(payload as CustomersDataRequestPayload);
            await redactStoredPayload(eventId);
            break;

        case 'CUSTOMERS_REDACT':
            await handleCustomersRedact(payload as CustomersRedactPayload);
            await redactStoredPayload(eventId);
            break;

        case 'SHOP_UPDATE':
            await handleShopUpdateWebhook(shopDomain);
            break;

        case 'ORDERS_CREATE':
        case 'ORDERS_UPDATED':
        case 'ORDERS_FULFILLED':
        case 'ORDERS_CANCELLED':
            await handleOrderWebhook(topic, shopDomain, payload);
            // An order can hold personal data (name, email, address). Wipe the saved copy once handled.
            // (If the handler fails, the payload stays, because the retry needs it.)
            await redactStoredPayload(eventId);
            break;

        case 'THEMES_UPDATE':
            await handleThemeUpdateWebhook(shopDomain, payload);
            break;

        default:
            // Not an error, but say it: a topic you subscribed to and nobody handles is easy to miss.
            console.warn(`[webhook] no handler for topic ${topic} (event ${eventId}); marked completed`);
            break;
    }
}

export async function recordWebhook(input: WebhookInput): Promise<number | null> {
    const store = await findByShopDomain(input.shopDomain);
    if (!store) {
        console.warn(`Webhook for unknown shop ${input.shopDomain}, topic ${input.topic}`);
        return null;
    }

    try {
        const [result] = await pool.query<ResultSetHeader>(
            `INSERT INTO webhook_events (store_id, shopify_webhook_id, topic, shop_domain, payload, triggered_at)
       VALUES (:storeId, :webhookId, :topic, :shopDomain, CAST(:payload AS JSON), :triggeredAt)`,
            {
                storeId: store.store_id,
                webhookId: input.webhookId,
                topic: input.topic,
                shopDomain: input.shopDomain,
                payload: JSON.stringify(input.payload),
                triggeredAt: input.triggeredAt,
            },
        );
        return result.insertId;
    } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
    }
}

export async function processWebhook(eventId: number): Promise<void> {
    const event = await loadWebhookEvent(eventId);
    if (!event) {
        console.warn(`Webhook event ${eventId} not found (already deleted by shop/redact cascade?)`);
        return;
    }

    try {
        await dispatch(event.id, event.topic, event.shop_domain, event.payload, event.triggered_at);
        await markProcessed(eventId, 'completed');
    } catch (err) {
        await markProcessed(eventId, 'failed', err instanceof Error ? err.message : 'Unknown error');
        throw err;
    }
}