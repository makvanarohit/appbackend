// Handles the order webhooks (orders/create, orders/updated, orders/fulfilled, orders/cancelled)
// and the theme webhook (themes/update).
//
// Order webhooks can carry personal data (name, email, phone, address). In shopify.app.toml we use
// `include_fields`, so Shopify sends ONLY the fields we read here and no customer data.
// To read more of an order later, ask the Admin API for it (the webhook is only the signal).
//
// Shopify does not promise the order of webhooks, and orders/updated fires very often.
// When you save order data, compare `updatedAt` and ignore an event that is older than what you have.

interface RawOrderAttribute {
    name?: string;
    value?: string;
}

interface RawOrder {
    id?: number | string;
    name?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    cancelled_at?: string | null;
    cancel_reason?: string | null;
    fulfillment_status?: string | null;
    financial_status?: string | null;
    note_attributes?: RawOrderAttribute[] | null;
}

export interface OrderSummary {
    id: string;
    name: string | null; // for example "#1001"
    createdAt: Date | null;
    updatedAt: Date | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    fulfillmentStatus: string | null;
    financialStatus: string | null;
    // The "note attributes" (cart attributes) of the order, as { name: value }.
    // A delivery date picked on the cart page is usually saved here.
    attributes: Record<string, string>;
}

export type OrderTopic = 'ORDERS_CREATE' | 'ORDERS_UPDATED' | 'ORDERS_FULFILLED' | 'ORDERS_CANCELLED';

function toDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// Returns null when the payload is not an order we can use (no id).
export function parseOrder(payload: unknown): OrderSummary | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const raw = payload as RawOrder;

    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
    if (!/^\d+$/.test(id)) return null;

    const attributes: Record<string, string> = {};
    for (const attribute of raw.note_attributes ?? []) {
        if (attribute?.name) attributes[attribute.name] = attribute.value ?? '';
    }

    return {
        id,
        name: raw.name ?? null,
        createdAt: toDate(raw.created_at),
        updatedAt: toDate(raw.updated_at),
        cancelledAt: toDate(raw.cancelled_at),
        cancelReason: raw.cancel_reason ?? null,
        fulfillmentStatus: raw.fulfillment_status ?? null,
        financialStatus: raw.financial_status ?? null,
        attributes,
    };
}

// The log lines show the order id and number only, never customer data.
const label = (order: OrderSummary): string => `${order.name ?? 'order'} (id ${order.id})`;

// ---- Where your own logic goes. Each function gets the shop and a small, safe summary. ----

async function onOrderCreated(shopDomain: string, order: OrderSummary): Promise<void> {
    console.log(`[orders] created: shop=${shopDomain} ${label(order)}`);
}

async function onOrderUpdated(shopDomain: string, order: OrderSummary): Promise<void> {
    console.log(`[orders] updated: shop=${shopDomain} ${label(order)} updated_at=${order.updatedAt?.toISOString() ?? 'unknown'}`);
}

async function onOrderFulfilled(shopDomain: string, order: OrderSummary): Promise<void> {
    console.log(`[orders] fulfilled: shop=${shopDomain} ${label(order)}`);
}

async function onOrderCancelled(shopDomain: string, order: OrderSummary): Promise<void> {
    console.log(`[orders] cancelled: shop=${shopDomain} ${label(order)} reason=${order.cancelReason ?? 'none'}`);
}

export async function handleOrderWebhook(topic: OrderTopic, shopDomain: string, payload: unknown): Promise<void> {
    const order = parseOrder(payload);
    if (!order) {
        // A payload without an order id will not fix itself, so do not make the queue try again.
        console.warn(`[orders] ${topic} for ${shopDomain} ignored: the payload has no order id`);
        return;
    }

    switch (topic) {
        case 'ORDERS_CREATE':
            return onOrderCreated(shopDomain, order);
        case 'ORDERS_UPDATED':
            return onOrderUpdated(shopDomain, order);
        case 'ORDERS_FULFILLED':
            return onOrderFulfilled(shopDomain, order);
        case 'ORDERS_CANCELLED':
            return onOrderCancelled(shopDomain, order);
    }
}

// themes/update: a theme was changed. A theme payload holds no customer data.
export async function handleThemeUpdateWebhook(shopDomain: string, payload: unknown): Promise<void> {
    const theme = (typeof payload === 'object' && payload !== null ? payload : {}) as {
        id?: number | string;
        name?: string;
        role?: string;
    };
    // Your own logic can go here (for example: check that the date picker block is still in the main theme).
    console.log(
        `[themes] updated: shop=${shopDomain} theme=${theme.name ?? 'unknown'} (id ${theme.id ?? 'unknown'}) role=${theme.role ?? 'unknown'}`,
    );
}