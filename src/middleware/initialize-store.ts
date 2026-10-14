import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './verify-session-token';
import { InvalidIdTokenError } from '../services/shopify-auth.service';
import { ensureOfflineToken } from '../services/store.service';
import { refreshShopDetailsIfNeeded } from '../services/shop-details.service';

// Used ONLY on GET /api/store (the first API the React app calls).
// verifySessionToken has already checked the ID token. Here we make sure the
// store exists in MySQL and has an offline token (token exchange if not), and that
// we know the shop's details (name, time zone, plan, ...).
export async function initializeStore(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        // A standalone token (local testing) can't be exchanged. Its store must already exist.
        if (req.authMode === 'shopify-session' && req.shopDomain && req.idToken) {
            const justExchanged = await ensureOfflineToken(req.shopDomain, req.idToken);

            // Never throws. It only reads from Shopify when the details are missing or old.
            const details = refreshShopDetailsIfNeeded(req.shopDomain, req.idToken);

            // First install: wait, so the very first answer already has the details.
            // Any other time: let it run in the background and do not slow down the page.
            if (justExchanged) await details;
        }
        next();
    } catch (err) {
        // Shopify can reject the ID token during the exchange (for example it became stale).
        // Same answer as in verifySessionToken: 401 + header, so App Bridge asks for a new token and retries.
        if (err instanceof InvalidIdTokenError) {
            res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
            res.status(401).json({ error: 'Invalid session token' });
            return;
        }
        next(err);
    }
}