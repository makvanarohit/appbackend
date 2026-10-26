import { shopify } from '../config/shopify';
import { findByShopDomain } from '../repositories/store.repository';
import { decryptToken } from './shopify-auth.service';
import { forceRefresh, ReauthorizationRequiredError } from './store.service';

// Asks Shopify, with the tokens we saved, if the app is still installed on a shop.
// Used before shop/redact deletes a shop that our database still calls "installed".
//
//  'installed' : Shopify accepted our token (or a token we could refresh). The shop is in use.
//  'gone'      : we have no token, or Shopify refuses the access token AND the refresh token.
//                (After an uninstall every API request answers 401, and so does the refresh endpoint.)
//  'unknown'   : we could not tell (Shopify busy, network problem, an unexpected status). Do not guess.

export type InstallationCheck = 'installed' | 'gone' | 'unknown';

const PROBE_TIMEOUT_MS = 10_000;

// The cheapest Admin API call there is. Returns the HTTP status. Network errors and timeouts throw.
async function probeStatus(shopDomain: string, accessToken: string): Promise<number> {
    const response = await fetch(`https://${shopDomain}/admin/api/${shopify.config.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query: '{ shop { id } }' }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.status;
}

export async function checkAppStillInstalled(shopDomain: string): Promise<InstallationCheck> {
    const store = await findByShopDomain(shopDomain);
    if (!store?.access_token_encrypted) return 'gone'; // nothing usable is saved

    try {
        const first = await probeStatus(shopDomain, decryptToken(store.access_token_encrypted));
        if (first === 200) return 'installed';
        if (first !== 401) return 'unknown';

        // 401: the access token may only have ended (it lives about 1 hour). Try the refresh token.
        // forceRefresh also SAVES the new tokens, so we never throw away tokens Shopify just gave us.
        await forceRefresh(shopDomain);
        const fresh = await findByShopDomain(shopDomain);
        if (!fresh?.access_token_encrypted) return 'gone';

        const second = await probeStatus(shopDomain, decryptToken(fresh.access_token_encrypted));
        if (second === 200) return 'installed';
        return second === 401 ? 'gone' : 'unknown';
    } catch (err) {
        // Shopify refused the refresh token: no usable credential is left.
        if (err instanceof ReauthorizationRequiredError) return 'gone';
        return 'unknown'; // Shopify busy (429, 5xx), network error, timeout, another request refreshing, ...
    }
}