import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

// "::ffff:1.2.3.4" is the same address as "1.2.3.4".
function cleanIp(ip: string | undefined): string {
    return (ip ?? '').replace(/^::ffff:/i, '');
}

// If STAFF_ALLOWED_IPS is set, only those IPs may use /internal. An empty list lets everyone in.
// (Behind a proxy, TRUST_PROXY must be right, or every request looks like it comes from the proxy.)
export function internalIpAllowList(req: Request, res: Response, next: NextFunction): void {
    const allowed = env.staff.allowedIps;
    if (allowed.length > 0 && !allowed.includes(cleanIp(req.ip))) {
        res.status(403).json({ error: 'Not allowed from this address' });
        return;
    }
    next();
}

// Every request that changes something must come from YOUR frontend. A browser always sends the
// "Origin" header on POST and PATCH, so a page on another site cannot get through. This also
// protects the cookie from cross-site attacks (together with SameSite=Strict).
// If you test with Postman or curl, add the header:  Origin: <your APP_FRONTEND_URL>
export function requireFrontendOrigin(req: Request, res: Response, next: NextFunction): void {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        next();
        return;
    }
    if (req.headers.origin !== env.staff.frontendOrigin) {
        res.status(403).json({ error: 'Request not allowed' });
        return;
    }
    next();
}