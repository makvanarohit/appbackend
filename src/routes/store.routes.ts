import { Router } from 'express';
import { verifySessionToken } from '../middleware/verify-session-token';
import { initializeStore } from '../middleware/initialize-store';
import { getCurrentShop, completeOnboarding, fetchShopFromAdminApi } from '../controllers/store.controller';
import { env } from '../config/env';

const router = Router();

// Every route below requires a valid session (Shopify ID token, or a
// standalone token when standalone mode is on). This step ONLY verifies the token.
router.use(verifySessionToken);

// FIRST API: the React app calls this once when it opens. It also finds or creates
// the store and does the token exchange if the shop has no token yet.
router.get('/', initializeStore, getCurrentShop);

// All other routes: verify only. They never create the store or exchange tokens.
router.patch('/onboarding', completeOnboarding);
// The example returns a raw Shopify answer, so it exists only where error details are shown (local and development).
if (env.exposeErrorDetails) {
    router.get('/me/admin-api-example', fetchShopFromAdminApi);
}

export default router;