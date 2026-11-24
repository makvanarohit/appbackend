import type { CookieOptions, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import type { StaffUser } from '../models/staff.model';

// Two cookies:
//  - staff_session: the real login. It ends STAFF_SESSION_MINUTES after the login, and never gets longer.
//  - staff_pending: "the password was right, now the 2FA code is needed". It lives 5 minutes.
// Both are httpOnly (JavaScript in the page cannot read them) and SameSite=Strict
// (the browser does not send them from another site).
const SESSION_COOKIE = 'staff_session';
const PENDING_COOKIE = 'staff_pending';
const SESSION_PATH = '/internal';
const PENDING_PATH = '/internal/staff';

const PENDING_MINUTES = 5;
const ALGORITHM = 'HS256';
// The audience makes a pending token useless as a session token (and the other way round).
const SESSION_AUDIENCE = 'staff-session';
const PENDING_AUDIENCE = 'staff-pending';

export interface StaffTokenClaims {
    staffId: number;
    // The session_version the user had when the token was made. If the number in the
    // database is higher now (logout, disable, new password, 2FA reset), the token is dead.
    version: number;
    // When the token ends, in seconds since 1970.
    expiresAt: number;
}

function cookieOptions(path: string): CookieOptions {
    return {
        httpOnly: true,
        secure: env.appEnv !== 'local', // local runs on plain http
        sameSite: 'strict',
        path,
    };
}

function sign(audience: string, staff: StaffUser, expiresAt: number): string {
    return jwt.sign({ ver: staff.session_version, exp: expiresAt }, env.staff.sessionSecret, {
        algorithm: ALGORITHM,
        audience,
        subject: String(staff.staff_id),
    });
}

function readToken(raw: unknown, audience: string): StaffTokenClaims | null {
    if (typeof raw !== 'string' || raw === '') return null;
    try {
        const payload = jwt.verify(raw, env.staff.sessionSecret, { algorithms: [ALGORITHM], audience });
        if (typeof payload === 'string') return null;
        const staffId = Number(payload.sub);
        if (!Number.isSafeInteger(staffId) || staffId <= 0) return null;
        if (typeof payload.ver !== 'number' || typeof payload.exp !== 'number') return null;
        return { staffId, version: payload.ver, expiresAt: payload.exp };
    } catch {
        return null; // wrong signature, ended, or not a token at all
    }
}

const nowInSeconds = () => Math.floor(Date.now() / 1000);

// Starts the real login. Returns the moment it ends.
export function issueSession(res: Response, staff: StaffUser): Date {
    const expiresAt = nowInSeconds() + env.staff.sessionMinutes * 60;
    res.cookie(SESSION_COOKIE, sign(SESSION_AUDIENCE, staff, expiresAt), {
        ...cookieOptions(SESSION_PATH),
        expires: new Date(expiresAt * 1000),
    });
    return new Date(expiresAt * 1000);
}

export function issuePending(res: Response, staff: StaffUser): void {
    const expiresAt = nowInSeconds() + PENDING_MINUTES * 60;
    res.cookie(PENDING_COOKIE, sign(PENDING_AUDIENCE, staff, expiresAt), {
        ...cookieOptions(PENDING_PATH),
        expires: new Date(expiresAt * 1000),
    });
}

export function readSession(req: Request): StaffTokenClaims | null {
    return readToken(req.cookies?.[SESSION_COOKIE], SESSION_AUDIENCE);
}

export function readPending(req: Request): StaffTokenClaims | null {
    return readToken(req.cookies?.[PENDING_COOKIE], PENDING_AUDIENCE);
}

export function clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, cookieOptions(SESSION_PATH));
}

export function clearPendingCookie(res: Response): void {
    res.clearCookie(PENDING_COOKIE, cookieOptions(PENDING_PATH));
}