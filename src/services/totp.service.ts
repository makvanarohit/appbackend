import { timingSafeEqual } from 'node:crypto';
import { generateSecret, generateSync, generateURI } from 'otplib';
import QRCode from 'qrcode';
import { decryptToken, encryptToken } from './shopify-auth.service';

// The authenticator app shows a new 6-digit code every 30 seconds.
// Both sides work out the same code from a shared secret and the clock (RFC 6238).
const PERIOD_SECONDS = 30;
const ISSUER = 'DeliveryScheduler Staff';

// The number of the 30-second window we are in now.
export function currentStep(nowMs: number = Date.now()): number {
    return Math.floor(nowMs / 1000 / PERIOD_SECONDS);
}

function sameText(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export interface TotpSetup {
    // The secret as text, for typing it in by hand if the QR code cannot be scanned.
    secret: string;
    // What we save in the database (encrypted with your TOKEN_ENCRYPTION_KEY).
    encryptedSecret: string;
    // A small PNG picture (a data: address) the frontend shows as the QR code.
    qrCodeDataUrl: string;
}

export async function createTotpSetup(username: string): Promise<TotpSetup> {
    const secret = generateSecret();
    const otpauthUrl = generateURI({ issuer: ISSUER, label: username, secret });
    return {
        secret,
        encryptedSecret: encryptToken(secret),
        qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }),
    };
}

// Checks a 6-digit code. Returns the number of the 30-second window the code belongs to,
// or null when the code is wrong. The caller must then "use up" that number
// (claimTotpStep), so the same code cannot be used twice.
// We accept the current window and one before and one after, because the clocks of the
// phone and the server are never exactly the same.
export function matchTotpCode(encryptedSecret: string, code: string, nowMs: number = Date.now()): number | null {
    if (!/^\d{6}$/.test(code)) return null;

    const secret = decryptToken(encryptedSecret);
    const now = currentStep(nowMs);

    // We check all three windows even after a match, so the time taken does not tell which one matched.
    let matched: number | null = null;
    for (const step of [now - 1, now, now + 1]) {
        const expected = generateSync({ secret, epoch: step * PERIOD_SECONDS });
        if (sameText(expected, code) && matched === null) matched = step;
    }
    return matched;
}