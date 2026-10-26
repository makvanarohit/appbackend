import { randomUUID } from 'crypto';
import { redisClient } from '../config/redis';
import { exchangeOfflineToken, refreshOfflineToken, encryptToken, decryptToken } from './shopify-auth.service';
import { findByShopDomain, findOrCreateByShopDomain, saveOfflineToken, saveRefreshedTokens, recordTokenExchangeFailure } from '../repositories/store.repository';

// Must comfortably exceed the slowest thing it can protect: a refresh
// call (up to 30s) possibly followed by a fallback exchange call.
const REFRESH_LOCK_TTL_MS = 45_000;
const REFRESH_LOCK_WAIT_MS = 5_000;
const EXPIRY_BUFFER_MS = 60_000;

// A request that waits for ANOTHER request to finish the first token exchange waits a bit longer,
// because that exchange may take up to 10 seconds (see TOKEN_EXCHANGE_TIMEOUT_MS in shopify-auth.service.ts).
const EXCHANGE_LOCK_WAIT_MS = 12_000;

// Thrown when Shopify still says 401 after we already refreshed the token.
// status 502 = "the other server (Shopify) refused us", not the merchant's fault.
export class AdminApiAuthError extends Error {
    status = 502;
    constructor(shopDomain: string) {
        super(`Shopify rejected the access token for ${shopDomain} even after a refresh`);
    }
}

// Thrown when a route needs the store (or its token) but GET /api/store has not set it up yet.
// status 409 = "conflict with the current state". The frontend should call GET /api/store first,
// then try again. expose = true means the message is shown to the frontend in every environment.
export class StoreNotInitializedError extends Error {
    status = 409;
    expose = true;
    constructor() {
        super('Store is not set up yet. Call GET /api/store first.');
    }
}

// Thrown when a call to Shopify's Admin API takes too long.
// status 504 = "gateway timeout": the other server (Shopify) was too slow.
export class AdminApiTimeoutError extends Error {
    status = 504;
    constructor(shopDomain: string) {
        super(`Shopify Admin API did not answer in time for ${shopDomain}`);
    }
}

// Thrown when Shopify answers an Admin API call with an error status (400 or higher, except 401,
// which is handled by a token refresh). 429 stays 429 (too many calls); everything else is 502.
export class AdminApiRequestError extends Error {
    status: number;
    constructor(shopDomain: string, shopifyStatus: number) {
        super(`Shopify answered HTTP ${shopifyStatus} for ${shopDomain}`);
        this.status = shopifyStatus === 429 ? 429 : 502;
    }
}

// Thrown when another request is refreshing the token and does not finish in time.
// status 503 = "try again in a moment".
export class TokenRefreshBusyError extends Error {
    status = 503;
    constructor(shopDomain: string) {
        super(`The token refresh for ${shopDomain} is still running in another request`);
    }
}

// Shopify says the saved refresh token cannot be used any more (answer 401: unknown, replaced, expired,
// revoked, or the app is uninstalled; Shopify does not say which, and we do not need to know).
// Only a new token exchange with a fresh ID token (the merchant opening the app) can repair it.
export class ReauthorizationRequiredError extends Error { }

function isExpiringSoon(expiresAt: Date | null): boolean {
    return expiresAt !== null && expiresAt.getTime() - Date.now() < EXPIRY_BUFFER_MS;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockKey(shopDomain: string): string {
    return `refresh-lock:${shopDomain}`;
}

async function acquireRefreshLock(shopDomain: string): Promise<string | null> {
    const lockValue = randomUUID();
    const result = await redisClient.set(lockKey(shopDomain), lockValue, {
        NX: true,
        PX: REFRESH_LOCK_TTL_MS,
    });
    return result === 'OK' ? lockValue : null;
}

async function releaseRefreshLock(shopDomain: string, lockValue: string): Promise<void> {
    const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;
    await redisClient.eval(script, { keys: [lockKey(shopDomain)], arguments: [lockValue] });
}

async function waitForLockRelease(shopDomain: string, maxWaitMs: number = REFRESH_LOCK_WAIT_MS): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const stillLocked = await redisClient.exists(lockKey(shopDomain));
        if (!stillLocked) return;
        await sleep(150);
    }
}

// Saves WHY a token step failed on the store row (last_token_exchange_status / _error),
// so you can find broken shops with a simple SQL query.
// If saving the failure ALSO fails (for example the database is down), we only log it,
// so the original error is never hidden.
async function recordTokenFailure(shopDomain: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : 'Unknown error';
    try {
        await recordTokenExchangeFailure(shopDomain, message.slice(0, 500));
    } catch (recordErr) {
        console.error(`Could not record token failure for ${shopDomain}:`, recordErr);
    }
}

// Called ONLY by GET /api/store (the first API). Makes sure this shop has a row in MySQL
// and an offline access token. The ID token was already verified by verifySessionToken,
// so it is not checked again here.
// Returns true when it did a new token exchange just now, and false when the shop already had a token.
export async function ensureOfflineToken(shopDomain: string, idToken: string): Promise<boolean> {
    const existing = await findOrCreateByShopDomain(shopDomain);

    if (existing.access_token_encrypted !== null) {
        return false;
    }

    const lockValue = await acquireRefreshLock(shopDomain);

    if (!lockValue) {
        await waitForLockRelease(shopDomain, EXCHANGE_LOCK_WAIT_MS);
        const afterWait = await findByShopDomain(shopDomain);
        if (!afterWait?.access_token_encrypted) {
            throw new Error(`Token exchange for ${shopDomain} did not complete`);
        }
        return false;
    }

    try {
        const fresh = await findByShopDomain(shopDomain);
        if (fresh?.access_token_encrypted) {
            return false;
        }

        const tokenResult = await exchangeOfflineToken(shopDomain, idToken);
        await saveWithRetry(shopDomain, () =>
            saveOfflineToken({
                shopDomain,
                accessTokenEncrypted: encryptToken(tokenResult.accessToken),
                accessTokenExpiresAt: tokenResult.expiresAt,
                refreshTokenEncrypted: tokenResult.refreshToken ? encryptToken(tokenResult.refreshToken) : null,
                refreshTokenExpiresAt: tokenResult.refreshTokenExpiresAt,
            }),
        );
        return true;
    } catch (err) {
        await recordTokenFailure(shopDomain, err);
        throw err;
    } finally {
        await releaseRefreshLock(shopDomain, lockValue);
    }
}

// If the database fails while we save NEW tokens, try again a few times. Saving the newest tokens
// avoids a second, needless refresh. (If every try fails, nothing is lost: Shopify keeps the refresh
// token we still hold usable until the newer one is used.)
const SAVE_RETRY_DELAYS_MS = [300, 1000];

async function saveWithRetry<T>(shopDomain: string, save: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await save();
        } catch (err) {
            if (attempt >= SAVE_RETRY_DELAYS_MS.length) {
                console.error(
                    `[token-refresh] the new tokens for ${shopDomain} could NOT be saved after ${attempt + 1} tries. ` +
                    'Shopify keeps the refresh token we still hold usable until the new one is used, so the next refresh normally still works. Check the database.',
                    err,
                );
                throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_DELAYS_MS[attempt]));
        }
    }
}

// idToken is optional and ONLY exists inside a real foreground request.
// When the refresh token is dead or missing and we DO have it, we fall
// back to a full token exchange instead of failing. Background callers
// (the cron job) have no idToken, so they still fail and wait for the
// merchant to come back.
async function performRefresh(shopDomain: string, idToken?: string): Promise<void> {
    const store = await findByShopDomain(shopDomain);
    if (!store) throw new Error(`Unknown store: ${shopDomain}`);

    const fallBackToExchange = async (reason: string): Promise<void> => {
        if (!idToken) {
            throw new ReauthorizationRequiredError(`${reason} for ${shopDomain}; merchant must reopen the app`);
        }
        const tokenResult = await exchangeOfflineToken(shopDomain, idToken);
        await saveWithRetry(shopDomain, () =>
            saveOfflineToken({
                shopDomain,
                accessTokenEncrypted: encryptToken(tokenResult.accessToken),
                accessTokenExpiresAt: tokenResult.expiresAt,
                refreshTokenEncrypted: tokenResult.refreshToken ? encryptToken(tokenResult.refreshToken) : null,
                refreshTokenExpiresAt: tokenResult.refreshTokenExpiresAt,
            }),
        );
    };

    if (!store.refresh_token_encrypted) {
        await fallBackToExchange('No refresh token stored');
        return;
    }

    const refreshToken = decryptToken(store.refresh_token_encrypted);
    const result = await refreshOfflineToken(shopDomain, refreshToken);

    if (result.outcome === 'reauthorize') {
        await fallBackToExchange('Refresh token no longer valid');
        return;
    }
    if (result.outcome !== 'refreshed') {
        throw new Error(`Token refresh failed for ${shopDomain}: ${result.outcome}`);
    }

    // A refresh is not an install, so it uses its own save (tokens only).
    const saved = await saveWithRetry(shopDomain, () =>
        saveRefreshedTokens({
            shopDomain,
            accessTokenEncrypted: encryptToken(result.data.accessToken),
            accessTokenExpiresAt: result.data.expiresAt,
            refreshTokenEncrypted: result.data.refreshToken ? encryptToken(result.data.refreshToken) : null,
            refreshTokenExpiresAt: result.data.refreshTokenExpiresAt,
        }),
    );

    if (!saved) {
        // The shop was uninstalled while we were refreshing. The new tokens are thrown away.
        console.log(`[token-refresh] ${shopDomain} was uninstalled during the refresh; the new tokens were not saved`);
    }
}

async function refreshWithLock(shopDomain: string, skipIfFresh: boolean, idToken?: string): Promise<void> {
    let lockValue = await acquireRefreshLock(shopDomain);

    if (!lockValue) {
        // Another request is refreshing. Wait for it, then look at what it did.
        await waitForLockRelease(shopDomain);
        const afterWait = await findByShopDomain(shopDomain);
        if (afterWait && !isExpiringSoon(afterWait.access_token_expires_at)) return; // it finished: use its tokens

        // Still not fresh: the other request failed or is too slow. Try to do it ourselves, once.
        lockValue = await acquireRefreshLock(shopDomain);
        if (!lockValue) throw new TokenRefreshBusyError(shopDomain);
    }

    try {
        if (skipIfFresh) {
            const fresh = await findByShopDomain(shopDomain);
            if (fresh && !isExpiringSoon(fresh.access_token_expires_at)) return;
        }

        await performRefresh(shopDomain, idToken);
    } catch (err) {
        await recordTokenFailure(shopDomain, err);
        throw err;
    } finally {
        await releaseRefreshLock(shopDomain, lockValue);
    }
}

export async function getValidOfflineAccessToken(shopDomain: string, idToken?: string): Promise<string> {
    const store = await findByShopDomain(shopDomain);
    if (!store) throw new StoreNotInitializedError();

    if (isExpiringSoon(store.access_token_expires_at)) {
        await refreshWithLock(shopDomain, true, idToken);
    }

    const fresh = await findByShopDomain(shopDomain);
    if (!fresh?.access_token_encrypted) {
        throw new StoreNotInitializedError();
    }
    return decryptToken(fresh.access_token_encrypted);
}

export async function forceRefresh(shopDomain: string, idToken?: string): Promise<void> {
    await refreshWithLock(shopDomain, false, idToken);
}

// Runs one Admin API call. fetch() with AbortSignal.timeout() fails with an error named
// "TimeoutError" when Shopify is too slow; we turn that into AdminApiTimeoutError (504).
async function runAdminApiCall<T>(
    shopDomain: string,
    fn: (accessToken: string) => Promise<AdminApiCallResult<T>>,
    accessToken: string,
): Promise<AdminApiCallResult<T>> {
    try {
        return await fn(accessToken);
    } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
            throw new AdminApiTimeoutError(shopDomain);
        }
        throw err;
    }
}

interface AdminApiCallResult<T> {
    status: number;
    data: T;
}

// Any HTTP error from Shopify (403, 429, 5xx, ...) is an error for the caller, not a normal answer.
function assertAdminApiOk(shopDomain: string, status: number): void {
    if (status >= 400) throw new AdminApiRequestError(shopDomain, status);
}

export async function callAdminApi<T>(
    shopDomain: string,
    fn: (accessToken: string) => Promise<AdminApiCallResult<T>>,
    idToken?: string,
): Promise<T> {
    const token = await getValidOfflineAccessToken(shopDomain, idToken);
    const first = await runAdminApiCall(shopDomain, fn, token);
    if (first.status !== 401) {
        assertAdminApiOk(shopDomain, first.status);
        return first.data;
    }
    await forceRefresh(shopDomain, idToken);
    const retryToken = await getValidOfflineAccessToken(shopDomain, idToken);
    const second = await runAdminApiCall(shopDomain, fn, retryToken);

    // Still 401 after a refresh: do NOT return this as if it worked.
    if (second.status === 401) {
        throw new AdminApiAuthError(shopDomain);
    }
    assertAdminApiOk(shopDomain, second.status);
    return second.data;
}