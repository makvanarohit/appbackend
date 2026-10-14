import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/verify-session-token';
import { callAdminApi, StoreNotInitializedError } from '../services/store.service';
import { findByShopDomain, markOnboardingCompleted } from '../repositories/store.repository';
import { shopify } from '../config/shopify';

// If Shopify does not answer within this time, we stop waiting.
const ADMIN_API_TIMEOUT_MS = 15_000;

// GET /store   (the FIRST API: initializeStore runs before this and sets up the store + token)
export async function getCurrentShop(req: AuthenticatedRequest, res: Response): Promise<void> {
    const shopDomain = req.shopDomain as string;

    const store = await findByShopDomain(shopDomain);
    if (!store) {
        res.status(404).json({ error: 'Store not found' });
        return;
    }

    res.json({
        shopDomain: store.shop_domain,
        shopName: store.shop_name,
        installationStatus: store.installation_status,
        onboardingCompleted: store.onboarding_completed,
        appPlan: store.app_plan,
        billingStatus: store.billing_status,
    });
}

// PATCH /store/onboarding
export async function completeOnboarding(req: AuthenticatedRequest, res: Response): Promise<void> {
    const updated = await markOnboardingCompleted(req.shopDomain as string);
    if (!updated) throw new StoreNotInitializedError();
    res.json({ success: true });
}

// GET /store/me/admin-api-example
// Shows the standard pattern for calling Shopify's Admin API: always go
// through callAdminApi so an unexpected 401 triggers one refresh + retry.
export async function fetchShopFromAdminApi(req: AuthenticatedRequest, res: Response): Promise<void> {
    const shopDomain = req.shopDomain as string;

    const data = await callAdminApi(shopDomain, async (accessToken) => {
        const response = await fetch(
            `https://${shopDomain}/admin/api/${shopify.config.apiVersion}/graphql.json`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': accessToken,
                },
                body: JSON.stringify({ query: '{ shop { name email } }' }),
                signal: AbortSignal.timeout(ADMIN_API_TIMEOUT_MS),
            },
        );
        return { status: response.status, data: await response.json() };
    }, req.idToken);

    res.json(data);
}