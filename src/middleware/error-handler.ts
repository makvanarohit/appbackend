import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import type { AuthenticatedRequest } from './verify-session-token';

interface HttpLikeError {
    status?: number;
    statusCode?: number;
    expose?: boolean;
    message?: string;
}

// Writes one entry in the log for every error that reaches this handler.
// - 4xx (409 "store not set up yet", 400 bad JSON, 413 body too big, ...) is an EXPECTED answer:
//   one short warning, no stack.
// - 5xx is a REAL problem: the full error with its stack, and where it happened.
function logError(err: unknown, status: number, req: Request): void {
    // Never log the query string, it can hold private data.
    const path = req.originalUrl.split('?')[0];
    const shop = (req as AuthenticatedRequest).shopDomain;
    const where = `${req.method} ${path}${shop ? ` shop=${shop}` : ''}`;

    if (status < 500) {
        const reason = err instanceof Error ? err.message : 'no message';
        console.warn(`[http] ${status} ${where} - ${reason.slice(0, 200)}`);
        return;
    }

    console.error(`[http] ${status} ${where}`, err);
}

// Express recognises an error handler by its 4 parameters — keep all
// four even though `_next` is unused.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    const e = (typeof err === 'object' && err !== null ? err : {}) as HttpLikeError;
    const candidate = e.status ?? e.statusCode;
    const status =
        typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
            ? candidate
            : 500;

    logError(err, status, req);

    if (res.headersSent) return;

    let message = 'Internal server error';
    if (status < 500 && e.expose && e.message) {
        message = e.message;
    } else if (env.exposeErrorDetails && err instanceof Error) {
        message = err.message;
    }

    res.status(status).json({ error: message });
}