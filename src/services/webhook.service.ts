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

// Persist only fields consumed by this backend. Shopify order payloads can contain
// addresses, emails, phone numbers, and other customer data that this app does not need.
function minimizeWebhookPayload(topic: string, payload: unknown): unknown {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
    const source = payload as Record<string, unknown>;
    const pick = (keys: string[]) => Object.fromEntries(keys
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]]));

    switch (topic) {
        case 'ORDERS_CREATE':
        case 'ORDERS_UPDATED':
        case 'ORDERS_FULFILLED':
        case 'ORDERS_CANCELLED': {
            const safeOrder = pick([
                'id', 'name', 'created_at', 'updated_at', 'cancelled_at', 'cancel_reason',
                'fulfillment_status', 'financial_status',
            ]);
            const deliveryDateAttribute = pickDeliveryDateAttribute(source.note_attributes);
            if (deliveryDateAttribute.length > 0) safeOrder.note_attributes = deliveryDateAttribute;
            return safeOrder;
        }
        case 'CUSTOMERS_DATA_REQUEST': {
            const customer = source.customer as Record<string, unknown> | undefined;
            const request = source.data_request as Record<string, unknown> | undefined;
            return {
                ...pick(['shop_id', 'shop_domain', 'orders_requested']),
                ...(customer && typeof customer === 'object' ? { customer: pickNested(customer, ['id']) } : {}),
                ...(request && typeof request === 'object' ? { data_request: pickNested(request, ['id']) } : {}),
            };
        }
        case 'CUSTOMERS_REDACT': {
            const customer = source.customer as Record<string, unknown> | undefined;
            return {
                ...pick(['shop_id', 'shop_domain', 'orders_to_redact']),
                ...(customer && typeof customer === 'object' ? { customer: pickNested(customer, ['id']) } : {}),
            };
        }
        case 'THEMES_UPDATE':
            return pick(['id', 'name', 'role']);
        default:
            // No payload fields are needed for app/uninstalled, shop/redact, or shop/update.
            return {};
    }
}

function pickNested(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    return Object.fromEntries(keys
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]]));
}

// Keep only a date-shaped delivery-date attribute. Shopify note_attributes are
// arbitrary merchant/customer-entered strings and must not be persisted wholesale.
function pickDeliveryDateAttribute(value: unknown): { name: string; value: string }[] {
    if (!Array.isArray(value)) return [];

    for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const attribute = item as { name?: unknown; value?: unknown };
        if (typeof attribute.name !== 'string' || typeof attribute.value !== 'string') continue;

        const normalizedName = attribute.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!/delivery.*date|date.*delivery/.test(normalizedName)) continue;

        const dateValue = attribute.value.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) continue;
        const [year, month, day] = dateValue.split('-').map(Number);
        const parsed = new Date(Date.UTC(year, month - 1, day));
        if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) continue;

        // Standardize the key and discard arbitrary attribute names and values.
        return [{ name: 'Delivery Date', value: dateValue }];
    }
    return [];
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
        `[gdpr] customer data request received for shop ${payload.shop_domain}; no customer-level data is stored`,
    );
}

async function redactPendingOrderWebhookPayloads(shopDomain: string, orderIds: unknown): Promise<void> {
    if (!Array.isArray(orderIds)) return;

    // Shopify may include many order IDs. Validate them and use bounded batches so
    // a single compliance request cannot create an excessively large SQL statement.
    const ids = [...new Set(orderIds
        .map((value) => {
            if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
            if (typeof value === 'string' && /^\d+$/.test(value)) return value;
            return null;
        })
        .filter((value): value is string => value !== null))];

    for (let offset = 0; offset < ids.length; offset += 250) {
        const batch = ids.slice(offset, offset + 250);
        const placeholders = batch.map((_, index) => `:orderId${index}`).join(', ');
        const params: Record<string, string> = { shopDomain };
        batch.forEach((id, index) => { params[`orderId${index}`] = id; });

        await pool.query(
            `UPDATE webhook_events
             SET payload = JSON_OBJECT('redacted', true)
             WHERE shop_domain = :shopDomain
               AND topic IN ('ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_FULFILLED', 'ORDERS_CANCELLED')
               AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.id')) IN (${placeholders})`,
            params,
        );
    }
}

async function handleCustomersRedact(payload: CustomersRedactPayload): Promise<void> {
    // An earlier order event may still be waiting or failed in the queue. Remove
    // its stored delivery date before acknowledging completion of this request.
    await redactPendingOrderWebhookPayloads(payload.shop_domain, payload.orders_to_redact);
    console.log(
        `[gdpr] customer redact request received for shop ${payload.shop_domain}; related pending order payloads were redacted`,
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
                payload: JSON.stringify(minimizeWebhookPayload(input.topic, input.payload)),
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