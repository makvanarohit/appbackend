import type { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';

// Counts are kept in this server's memory. If you run several copies of the server, every copy
// counts on its own (the real limit is then bigger). Use a Redis store if you ever need one shared count.
// The client is found by IP. For that to be right behind a proxy, TRUST_PROXY must be set (see env.ts).

interface LimiterOptions {
    windowMs: number; // the time window, in milliseconds
    limit: number; // how many requests one IP may make in that window
    // true = only answers with status 400 or higher are counted. Used for webhooks, so real
    // Shopify traffic (which we answer with 200) never counts against the limit.
    countOnlyFailures?: boolean;
}

export function createRateLimiter(options: LimiterOptions) {
    return rateLimit({
        windowMs: options.windowMs,
        limit: options.limit,
        standardHeaders: 'draft-7', // tells the client its limit and what is left (RateLimit headers)
        legacyHeaders: false,
        skipSuccessfulRequests: options.countOnlyFailures ?? false,
        // express-rate-limit also adds the Retry-After header before this runs.
        handler: (_req: Request, res: Response) => {
            res.status(429).json({ error: 'Too many requests. Please try again later.' });
        },
    });
}

// Everything under /api (the React admin app): 300 requests per minute per IP.
// A page load makes a handful of calls, so a normal merchant never gets near this.
export const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 300 });

// POST /webhooks: only FAILED requests count (bad signature, bad body, too big): 50 per 10 minutes per IP.
// Shopify's own webhooks (answered with 200) are never counted, so a busy shop cannot be blocked.
export const webhookLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    limit: 50,
    countOnlyFailures: true,
});

// For the public extension routes later (/proxy, /ext), make a limiter with createRateLimiter, for example:
//   export const publicLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 120 });