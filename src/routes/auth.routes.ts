// src/routes/auth.routes.ts
import { env } from '../config/env';
import { Router } from 'express';
import { verifySessionToken } from '../middleware/verify-session-token';
import { getStandaloneToken } from '../controllers/auth.controller';
import { revokeStandaloneTokens } from '../controllers/standalone.controller';

const router = Router();

router.get('/standalone-token', verifySessionToken, getStandaloneToken);
// Standalone tokens only exist in the local environment.
if (env.standaloneEnabled) {
    router.post('/standalone/revoke', verifySessionToken, revokeStandaloneTokens);
}

export default router;