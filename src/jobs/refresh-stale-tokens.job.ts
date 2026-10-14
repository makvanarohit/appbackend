import { CronJob } from 'cron';
import { findShopsWithExpiringRefreshToken } from '../repositories/store.repository';
import { forceRefresh } from '../services/store.service';

const WITHIN_DAYS = 14; // touch any shop whose refresh token dies within 2 weeks
const DELAY_BETWEEN_SHOPS_MS = 250; // spread calls out; don't burst Shopify's API

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function refreshStaleTokens(): Promise<void> {
    const shopDomains = await findShopsWithExpiringRefreshToken(WITHIN_DAYS);
    if (shopDomains.length === 0) return;

    console.log(`[refresh-stale-tokens] ${shopDomains.length} shop(s) need a keep-alive refresh`);

    for (const shopDomain of shopDomains) {
        try {
            await forceRefresh(shopDomain);
            console.log(`[refresh-stale-tokens] refreshed ${shopDomain}`);
        } catch (err) {
            console.error(`[refresh-stale-tokens] failed for ${shopDomain}:`, err);
        }
        await sleep(DELAY_BETWEEN_SHOPS_MS);
    }
}

export function scheduleRefreshStaleTokensJob(): CronJob {
    return CronJob.from({
        cronTime: '0 3 * * *',
        onTick: refreshStaleTokens,
        start: true,
        errorHandler: (err) => {
            console.error('[refresh-stale-tokens] job crashed:', err);
        },
    });
}