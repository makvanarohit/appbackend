import { redisClient } from '../config/redis';
import { shopify } from '../config/shopify';
import { updateShopDetails, type ShopDetailsUpdate } from '../repositories/store.repository';
import { callAdminApi, StoreNotInitializedError } from './store.service';

// Reads the shop's details from Shopify (name, email, time zone, currency, plan) and saves
// them in the stores table. No new column is needed: how fresh the details are is kept in
// Redis with short-lived keys.

const SHOP_DETAILS_TIMEOUT_MS = 5_000; // one call to Shopify may take at most 5 seconds
const FRESH_FOR_SECONDS = 24 * 60 * 60; // after a good save, do not read again for 24 hours
const RETRY_AFTER_MS = 5 * 60 * 1000; // after a try (good or bad), wait 5 minutes before the next one
const WEBHOOK_GUARD_MS = 60 * 1000; // shop/update: read from Shopify at most once a minute per shop

// Plan names that count as Shopify Plus. Add 'Plus Trial' here if trial shops should count too.
const PLUS_PLAN_NAMES = ['Plus'];

const freshKey = (shop: string): string => `shop-details:fresh:${shop}`;
const cooldownKey = (shop: string): string => `shop-details:cooldown:${shop}`;
const webhookGuardKey = (shop: string): string => `shop-details:webhook-guard:${shop}`;

// Check these fields with your API version in Shopify's GraphiQL before you deploy.
// "shopifyPlus" is not asked for on purpose: newer API versions list publicDisplayName instead.
const SHOP_DETAILS_QUERY = `query ShopDetails {
  shop {
    id
    name
    email
    contactEmail
    currencyCode
    ianaTimezone
    createdAt
    plan { publicDisplayName partnerDevelopment }
  }
}`;

interface ShopQueryResult {
    data?: {
        shop?: {
            id: string;
            name: string | null;
            email: string | null;
            contactEmail: string | null;
            currencyCode: string | null;
            ianaTimezone: string | null;
            createdAt: string | null;
            plan?: { publicDisplayName: string | null; partnerDevelopment: boolean } | null;
        };
    };
    errors?: unknown;
}

// "gid://shopify/Shop/548380009" -> 548380009
function shopIdFromGid(gid: string | undefined): number | null {
    const id = Number(gid?.split('/').pop());
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function readShopFromShopify(shopDomain: string, idToken?: string): Promise<ShopDetailsUpdate> {
    const result = await callAdminApi<ShopQueryResult | null>(
        shopDomain,
        async (accessToken) => {
            const response = await fetch(
                `https://${shopDomain}/admin/api/${shopify.config.apiVersion}/graphql.json`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': accessToken,
                    },
                    body: JSON.stringify({ query: SHOP_DETAILS_QUERY }),
                    signal: AbortSignal.timeout(SHOP_DETAILS_TIMEOUT_MS),
                },
            );
            // 401 is handled by callAdminApi (it refreshes the token and tries once more).
            if (response.status !== 401 && !response.ok) {
                throw new Error(`Shopify answered HTTP ${response.status}`);
            }
            const data = (await response.json().catch(() => null)) as ShopQueryResult | null;
            return { status: response.status, data };
        },
        idToken,
    );

    // GraphQL can answer HTTP 200 and still carry errors.
    const shop = result?.data?.shop;
    if (result?.errors || !shop) {
        throw new Error(
            `Shopify did not return the shop details: ${JSON.stringify(result?.errors ?? 'no data').slice(0, 200)}`,
        );
    }

    const planName = shop.plan?.publicDisplayName ?? null;
    const isPlus = planName !== null && PLUS_PLAN_NAMES.includes(planName);
    return {
        shopifyShopId: shopIdFromGid(shop.id),
        shopName: shop.name ?? null,
        shopEmail: shop.email ?? null,
        contactEmail: shop.contactEmail ?? null,
        currencyCode: shop.currencyCode ?? null,
        timezone: shop.ianaTimezone ?? null,
        shopifyPlanType: shop.plan?.partnerDevelopment ? 'development' : isPlus ? 'plus' : 'standard',
        shopifyPlanName: planName,
        isShopifyPlus: isPlus,
        shopCreatedAt: shop.createdAt ? new Date(shop.createdAt) : null,
    };
}

// Reads the details from Shopify and saves them. Throws if anything fails.
export async function syncShopDetails(shopDomain: string, idToken?: string): Promise<void> {
    const details = await readShopFromShopify(shopDomain, idToken);
    await updateShopDetails(shopDomain, details);
    await redisClient.set(freshKey(shopDomain), '1', { EX: FRESH_FOR_SECONDS });
}

// Used by GET /api/store. Reads the details only when they are missing or older than
// 24 hours, and tries at most once every 5 minutes per shop, even if Shopify keeps failing.
// It NEVER throws: if it fails, the page still works and we try again later.
export async function refreshShopDetailsIfNeeded(shopDomain: string, idToken?: string): Promise<void> {
    try {
        if ((await redisClient.exists(freshKey(shopDomain))) === 1) return;

        const gotTurn = await redisClient.set(cooldownKey(shopDomain), '1', {
            NX: true,
            PX: RETRY_AFTER_MS,
        });
        if (gotTurn !== 'OK') return;

        await syncShopDetails(shopDomain, idToken);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`[shop-details] could not save the details of ${shopDomain}: ${message}`);
    }
}

// Used by the worker for the shop/update webhook. Shopify can send many shop/update events
// (even for changes that are not about the name or time zone), so we read from Shopify at
// most once a minute per shop.
export async function handleShopUpdateWebhook(shopDomain: string): Promise<void> {
    const gotTurn = await redisClient.set(webhookGuardKey(shopDomain), '1', {
        NX: true,
        PX: WEBHOOK_GUARD_MS,
    });

    if (gotTurn !== 'OK') {
        // We read this shop a moment ago. Mark the saved details as old, so the next
        // GET /api/store reads them again.
        await redisClient.del(freshKey(shopDomain));
        return;
    }

    try {
        await syncShopDetails(shopDomain);
    } catch (err) {
        // Remove the guard, so the retry of this job is not blocked by it.
        await redisClient.del(webhookGuardKey(shopDomain)).catch(() => undefined);

        // The shop is uninstalled or was never set up: there is nothing to read.
        if (err instanceof StoreNotInitializedError) {
            console.log(`[shop-details] shop/update for ${shopDomain} skipped: no token saved`);
            return;
        }
        throw err; // the queue tries again
    }
}