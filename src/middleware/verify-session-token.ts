import type { Request, Response, NextFunction } from 'express';
import {
  InvalidIdTokenError,
  validateIdToken,
  shopDomainFromIdToken,
} from '../services/shopify-auth.service';
import {
  isStandaloneToken,
  validateStandaloneToken,
  InvalidStandaloneTokenError,
} from '../services/standalone-auth.service';
import { findByShopDomain } from '../repositories/store.repository';
import { env } from '../config/env';

export interface AuthenticatedRequest extends Request {
  shopDomain?: string;
  authMode?: 'shopify-session' | 'standalone';
  // The raw, already-verified Shopify ID token for this request. Only set
  // for real Shopify sessions (never standalone tokens, which can't be
  // exchanged).
  idToken?: string;
}

// Runs on every protected request. It ONLY checks the token and tells the
// controller which shop is calling. It never touches MySQL for a real Shopify
// session and never does a token exchange.
// The store setup + token exchange happens in ONE place only: GET /api/store
// (see initializeStore).
export async function verifySessionToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const rawToken = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!rawToken) {
    res.status(401).json({ error: 'Missing session token' });
    return;
  }

  try {
    if (isStandaloneToken(rawToken)) {
      if (!env.standaloneEnabled) {
        res.status(401).json({ error: 'Standalone tokens are disabled in this environment' });
        return;
      }

      const payload = validateStandaloneToken(rawToken);

      const store = await findByShopDomain(payload.shop);
      if (!store) {
        res.status(401).json({ error: 'Unknown shop for standalone token' });
        return;
      }

      if (payload.ver !== store.standalone_token_version) {
        res.status(401).json({ error: 'Standalone token has been revoked' });
        return;
      }

      req.shopDomain = payload.shop;
      req.authMode = 'standalone';
      next();
      return;
    }

    const payload = validateIdToken(rawToken);
    req.shopDomain = shopDomainFromIdToken(payload);
    req.authMode = 'shopify-session';
    req.idToken = rawToken;
    next();
  } catch (err) {
    if (err instanceof InvalidIdTokenError) {
      res.set('X-Shopify-Retry-Invalid-Session-Request', '1');
      res.status(401).json({ error: 'Invalid session token' });
      return;
    }
    if (err instanceof InvalidStandaloneTokenError) {
      res.status(401).json({ error: 'Invalid standalone token' });
      return;
    }
    next(err);
  }
}