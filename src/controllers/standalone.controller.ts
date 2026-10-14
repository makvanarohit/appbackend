import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/verify-session-token';
import { incrementStandaloneTokenVersion } from '../repositories/store.repository';

// POST /auth/standalone/revoke
// Protected by verifySessionToken (either token type works to reach this
// route) — instantly invalidates every standalone token issued so far
// for this shop, e.g. if one leaked.
export async function revokeStandaloneTokens(req: AuthenticatedRequest, res: Response): Promise<void> {
  const shopDomain = req.shopDomain as string;
  await incrementStandaloneTokenVersion(shopDomain);
  res.json({ success: true });
}