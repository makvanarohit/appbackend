import jwt from 'jsonwebtoken';
import { env } from '../config/env';

const TOKEN_TYPE = 'standalone';

export interface StandaloneTokenPayload {
    shop: string;
    ver: number;
    typ: typeof TOKEN_TYPE;
    iat: number;
    exp: number;
}

export class InvalidStandaloneTokenError extends Error { }

// Only called from GET /api/auth/standalone-token, which sits behind
// verifySessionToken, refuses anything but a real Shopify session, and is
// switched off in production. Never a login mechanism of its own.
export function issueStandaloneToken(shopDomain: string, currentVersion: number): string {
    return jwt.sign(
        {
            shop: shopDomain,
            ver: currentVersion,
            typ: TOKEN_TYPE,
        },
        env.standaloneTokenSecret,
        {
            algorithm: 'HS256',
            expiresIn: `${env.standaloneTokenTtlDays}d`,
        },
    );
}

export function isStandaloneToken(rawToken: string): boolean {
    const decoded = jwt.decode(rawToken);
    return typeof decoded === 'object' && decoded !== null && (decoded as { typ?: string }).typ === TOKEN_TYPE;
}

// Verifies signature + expiry only. The caller is still responsible for
// checking `ver` against the store's current standalone_token_version —
// that's a live database value, not something a JWT check alone can see.
export function validateStandaloneToken(rawToken: string): StandaloneTokenPayload {
    try {
        return jwt.verify(rawToken, env.standaloneTokenSecret, {
            algorithms: ['HS256'],
        }) as StandaloneTokenPayload;
    } catch {
        throw new InvalidStandaloneTokenError('Standalone token failed verification');
    }
}