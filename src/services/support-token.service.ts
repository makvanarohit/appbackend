import jwt from 'jsonwebtoken';
import { env } from '../config/env';

// The token a staff member uses to look at ONE shop ("Open as merchant").
// It is signed with SUPPORT_TOKEN_SECRET, which is not the Shopify secret, so a support token
// can never pass as a Shopify ID token, and a Shopify token can never pass as a support token.
const AUDIENCE = 'support';
const ALGORITHM = 'HS256';

export interface SupportTokenClaims {
    // The one shop this token is for.
    shop: string;
    staffId: number;
    // The staff user's session_version when the token was made. If the number in the database
    // is higher now (logout, disable, new password, 2FA reset), the token is dead.
    version: number;
    // When the token ends, in seconds since 1970.
    expiresAt: number;
}

export class InvalidSupportTokenError extends Error { }

// The token ends at the SAME moment as the staff login (expiresAt is that moment, in seconds),
// so a support session never lives longer than the login it came from.
export function issueSupportToken(
    shopDomain: string,
    staff: { staff_id: number; session_version: number },
    expiresAt: number,
): string {
    return jwt.sign(
        { shop: shopDomain, staff: staff.staff_id, ver: staff.session_version, exp: expiresAt },
        env.supportTokenSecret,
        { algorithm: ALGORITHM, audience: AUDIENCE },
    );
}

// Only looks at the token to decide which check to run. The real check is validateSupportToken.
export function isSupportToken(rawToken: string): boolean {
    const decoded = jwt.decode(rawToken);
    return typeof decoded === 'object' && decoded !== null && decoded.aud === AUDIENCE;
}

// Checks the signature and the end time. The caller must still check the staff user in the database.
export function validateSupportToken(rawToken: string): SupportTokenClaims {
    let payload: jwt.JwtPayload;
    try {
        const verified = jwt.verify(rawToken, env.supportTokenSecret, { algorithms: [ALGORITHM], audience: AUDIENCE });
        if (typeof verified === 'string') throw new Error('not an object');
        payload = verified;
    } catch {
        throw new InvalidSupportTokenError('Support token failed verification');
    }

    if (
        typeof payload.shop !== 'string' ||
        !Number.isSafeInteger(payload.staff) ||
        typeof payload.ver !== 'number' ||
        typeof payload.exp !== 'number'
    ) {
        throw new InvalidSupportTokenError('Support token has wrong content');
    }

    return { shop: payload.shop, staffId: payload.staff as number, version: payload.ver, expiresAt: payload.exp };
}