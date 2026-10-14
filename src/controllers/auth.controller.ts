// src/controllers/auth.controller.ts
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/verify-session-token';
import { issueStandaloneToken } from '../services/standalone-auth.service';
import { findByShopDomain } from '../repositories/store.repository';
import { env } from '../config/env';

// GET /api/auth/standalone-token
// Works only after GET /api/store has run at least once for this shop (that call
// creates the store); otherwise this returns 404. Only mintable from a REAL Shopify session, never
// from an existing standalone token — otherwise one leaked token could
// keep renewing itself forever.
export async function getStandaloneToken(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!env.standaloneEnabled) {
        res.status(404).json({ error: 'Not found' });
        return;
    }

    if (req.authMode !== 'shopify-session') {
        res.status(403).json({ error: 'Standalone tokens can only be issued from a real Shopify session' });
        return;
    }

    const shopDomain = req.shopDomain as string;
    const store = await findByShopDomain(shopDomain);
    if (!store) {
        res.status(404).json({ error: 'Store not found' });
        return;
    }

    const standaloneToken = issueStandaloneToken(shopDomain, store.standalone_token_version);
    res.json({ shopDomain, standaloneToken });
}