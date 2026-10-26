import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { RequestedTokenType, InvalidJwtError, HttpResponseError } from '@shopify/shopify-api';
import { shopify } from '../config/shopify';
import { env } from '../config/env';

export interface IdTokenPayload {
    iss: string;
    dest: string;
    aud: string;
    sub: string;
    exp: number;
    nbf: number;
    [key: string]: unknown;
}

export class InvalidIdTokenError extends Error { }

// A shop is always <shop name>.myshopify.com. The name goes into URLs we call, so check its shape.
const SHOP_HOST_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function safeHostname(url: string): string | null {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

export function validateIdToken(idToken: string): IdTokenPayload {
    let payload: IdTokenPayload;
    try {
        payload = jwt.verify(idToken, env.shopifyClientSecret, {
            algorithms: ['HS256'],
            audience: env.shopifyClientId,
            // Allow 10 seconds of clock difference between Shopify and this
            // server. Applies to both `nbf` (not before) and `exp` (expiry).
            clockTolerance: 10,
        }) as IdTokenPayload;
    } catch {
        throw new InvalidIdTokenError('ID token failed verification');
    }

    const issuerHost = safeHostname(payload.iss);
    const destHost = safeHostname(payload.dest);
    if (!issuerHost || !destHost || issuerHost !== destHost) {
        throw new InvalidIdTokenError('Token issuer and destination do not match');
    }

    // Shopify always sends exp and nbf. A token without them would never end, so refuse it.
    if (typeof payload.exp !== 'number' || typeof payload.nbf !== 'number') {
        throw new InvalidIdTokenError('Token has no exp or nbf');
    }
    if (!SHOP_HOST_PATTERN.test(destHost)) {
        throw new InvalidIdTokenError('Token destination is not a myshopify.com shop');
    }

    return payload;
}

export function shopDomainFromIdToken(payload: IdTokenPayload): string {
    const hostname = safeHostname(payload.dest);
    if (!hostname) throw new InvalidIdTokenError('Invalid dest claim');
    return hostname;
}

export interface OfflineTokenResult {
    accessToken: string;
    expiresAt: Date | null;
    refreshToken: string | null;
    refreshTokenExpiresAt: Date | null;
}

// How long we wait for Shopify to answer a token exchange. It must stay well below the
// Redis lock time (45 seconds in store.service.ts), so the lock never ends in the middle of an exchange.
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

// Thrown when Shopify does not answer the token exchange in time.
// status 504 = "gateway timeout": the other server (Shopify) was too slow.
export class TokenExchangeTimeoutError extends Error {
    status = 504;
    constructor(shopDomain: string) {
        super(`Shopify did not answer the token exchange for ${shopDomain} in time`);
    }
}

// The Shopify library has no time limit and no way to cancel a request, so we stop WAITING
// after `ms`. If Shopify answers later, that answer is thrown away. (Promise.race also
// handles a late failure, so it can never become an unhandled rejection.)
function waitAtMost<T>(promise: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(makeError()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function exchangeOfflineToken(
    shopDomain: string,
    idToken: string,
): Promise<OfflineTokenResult> {
    let session;
    try {
        ({ session } = await waitAtMost(
            shopify.auth.tokenExchange({
                shop: shopDomain,
                sessionToken: idToken,
                requestedTokenType: RequestedTokenType.OfflineAccessToken,
                expiring: true,
            }),
            TOKEN_EXCHANGE_TIMEOUT_MS,
            () => new TokenExchangeTimeoutError(shopDomain),
        ));
    } catch (err) {
        // Shopify answers with 400 when the ID token is stale or otherwise
        // invalid by the time this reaches their servers — a few seconds can
        // pass between our own jwt.verify() and this network call. The
        // library's own pre-flight decode can reject it the same way, via
        // InvalidJwtError, before ever making the request. Both mean the same
        // thing to the caller as our own local validation failing, so we reuse
        // InvalidIdTokenError — verifySessionToken already knows how to turn
        // that into a 401 + retry header, with no extra wiring needed here.
        if (err instanceof InvalidJwtError) {
            throw new InvalidIdTokenError('ID token rejected during exchange');
        }
        if (err instanceof HttpResponseError && err.response.code === 400) {
            throw new InvalidIdTokenError('ID token rejected by Shopify during exchange');
        }
        throw err;
    }

    if (!session.accessToken) {
        throw new Error(`Token exchange for ${shopDomain} returned no access token`);
    }

    return {
        accessToken: session.accessToken,
        expiresAt: session.expires ?? null,
        refreshToken: session.refreshToken ?? null,
        refreshTokenExpiresAt: session.refreshTokenExpires ?? null,
    };
}

const SHOPIFY_TIMEOUT_MS = 30_000;

export class ShopifyUnreachableError extends Error { }

async function shopifyTokenRequest(shopDomain: string, body: URLSearchParams): Promise<Response> {
    try {
        return await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
        });
    } catch {
        throw new ShopifyUnreachableError(`Could not reach ${shopDomain}`);
    }
}

export type RefreshResult =
    | { outcome: 'refreshed'; data: OfflineTokenResult }
    | { outcome: 'reauthorize' }
    | { outcome: 'retry' }
    | { outcome: 'failed' };

export async function refreshOfflineToken(
    shopDomain: string,
    refreshToken: string,
): Promise<RefreshResult> {
    let response: Response;
    try {
        response = await shopifyTokenRequest(
            shopDomain,
            new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: env.shopifyClientId,
                client_secret: env.shopifyClientSecret,
                refresh_token: refreshToken,
            }),
        );
    } catch (err) {
        if (err instanceof ShopifyUnreachableError) return { outcome: 'retry' };
        throw err;
    }

    if (response.status === 401) return { outcome: 'reauthorize' };
    if (response.status === 429 || response.status >= 500) return { outcome: 'retry' };
    if (!response.ok) return { outcome: 'failed' };

    const json = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        refresh_token_expires_in?: number;
    };

    // An answer without an access token is useless. Say it clearly and save nothing.
    if (typeof json.access_token !== 'string' || json.access_token === '') {
        throw new Error(`Shopify's refresh answer for ${shopDomain} had no access token`);
    }

    return {
        outcome: 'refreshed',
        data: {
            accessToken: json.access_token,
            expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
            refreshToken: json.refresh_token ?? null,
            refreshTokenExpiresAt: json.refresh_token_expires_in
                ? new Date(Date.now() + json.refresh_token_expires_in * 1000)
                : null,
        },
    };
}

// Saved format:  <keyId>:<base64(iv + authTag + encrypted)>
// Tokens saved before key rotation existed have no "<keyId>:" in front.
// They were all written with key "v1", so we read them with "v1".
const LEGACY_KEY_ID = 'v1';

function getKey(keyId: string): Buffer {
    const key = env.tokenEncryptionKeys.get(keyId);
    if (!key) {
        throw new Error(
            `No encryption key configured for key id "${keyId}". ` +
            'Add it to TOKEN_ENCRYPTION_OLD_KEYS.',
        );
    }
    return key;
}

export function encryptToken(plainText: string): string {
    const keyId = env.tokenEncryptionKeyId;
    const key = getKey(keyId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const body = Buffer.concat([iv, authTag, encrypted]).toString('base64');
    return `${keyId}:${body}`;
}

export function decryptToken(stored: string): string {
    // base64 never contains ":", so a ":" always means a key id is in front.
    const separator = stored.indexOf(':');
    const keyId = separator === -1 ? LEGACY_KEY_ID : stored.slice(0, separator);
    const body = separator === -1 ? stored : stored.slice(separator + 1);

    const key = getKey(keyId);
    const raw = Buffer.from(body, 'base64');
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}