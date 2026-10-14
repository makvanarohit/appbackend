// src/routes/auth.routes.ts
import { Router } from 'express';
import { verifySessionToken } from '../middleware/verify-session-token';
import { getStandaloneToken } from '../controllers/auth.controller';
import { revokeStandaloneTokens } from '../controllers/standalone.controller';

const router = Router();

router.get('/standalone-token', verifySessionToken, getStandaloneToken);
router.post('/standalone/revoke', verifySessionToken, revokeStandaloneTokens);

export default router;