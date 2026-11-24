import type { Request, Response, NextFunction } from 'express';
import {
  InvalidIdTokenError,
  validateIdToken,
  shopDomainFromIdToken,
} from '../services/shopify-auth.service';
import {
  isSupportToken,
  validateSupportToken,
  InvalidSupportTokenError,
} from '../services/support-token.service';
import { findByShopDomain } from '../repositories/store.repository';
import { findStaffById } from '../repositories/staff.repository';
import { env } from '../config/env';

export interface AuthenticatedRequest extends Request {
  shopDomain?: string;
  // 'shopify-session' = a merchant inside Shopify admin.
  // 'support' = a staff member who opened the shop with "Open as merchant".
  //   Role 'support' can only read. Role 'admin' can also change data.
  authMode?: 'shopify-session' | 'support';
  // The raw, already-verified Shopify ID token for this request. Only set
  // for real Shopify sessions (never support tokens, which can't be exchanged).
  idToken?: string;
  // Only set for a support session: which staff member is looking.
  staffId?: number;
}

// In a support session, only an ADMIN may change data. A staff member with the role 'support'
// can only read. Every route is protected by this one rule, so a new route that changes data
// can never be reached by a 'support' role by mistake.
// (This means a GET route must never change data.)
const READ_METHODS = ['GET', 'HEAD'];

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
    if (isSupportToken(rawToken)) {
      const claims = validateSupportToken(rawToken);

      // The staff user is checked in the database on every request, so a logout, a disabled
      // user, a new password or a 2FA reset stops the support session at once.
      const staff = await findStaffById(claims.staffId);
      if (
        !staff ||
        staff.status !== 'active' ||
        staff.session_version !== claims.version ||
        (env.staff.require2fa && !staff.totp_enabled)
      ) {
        res.status(401).json({ error: 'Support session ended. Please log in again.' });
        return;
      }

      const store = await findByShopDomain(claims.shop);
      if (!store) {
        res.status(401).json({ error: 'Unknown shop for this support token' });
        return;
      }

      if (!READ_METHODS.includes(req.method)) {
        // The role is read from MySQL on every request, so it always matches the staff row.
        if (staff.role !== 'admin') {
          res.status(403).json({ error: 'Only an admin can change data in a support session.' });
          return;
        }

        // There is no audit table, so EVERY change made in a support session is written to the log:
        // who, which shop, which route and how it ended. Never the body and never the query string
        // (they can hold private data).
        const route = `${req.baseUrl}${req.path}`;
        const who = `staff=${staff.username} shop=${claims.shop}`;
        res.on('finish', () => {
          console.log(`[support] write ${who} ${req.method} ${route} -> ${res.statusCode} ip=${req.ip}`);
        });
      }

      req.shopDomain = claims.shop;
      req.authMode = 'support';
      req.staffId = claims.staffId;
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
    if (err instanceof InvalidSupportTokenError) {
      res.status(401).json({ error: 'Support session ended. Please log in again.' });
      return;
    }
    next(err);
  }
}