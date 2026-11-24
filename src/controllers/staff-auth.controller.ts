import type { Request, Response } from 'express';
import type { StaffUser } from '../models/staff.model';
import { normalizeUsername } from '../models/staff.model';
import {
    bumpSessionVersion,
    claimTotpStep,
    clearFailedLogins,
    enableTotp,
    findStaffById,
    findStaffByUsername,
    recordFailedLogin,
    saveTotpSecret,
} from '../repositories/staff.repository';
import { verifyPassword } from '../services/password.service';
import {
    clearPendingCookie,
    clearSessionCookie,
    issuePending,
    issueSession,
    readPending,
    readSession,
} from '../services/staff-session.service';
import { createTotpSetup, matchTotpCode } from '../services/totp.service';
import { env } from '../config/env';

// 5 wrong tries (password or 2FA code) lock the account for 15 minutes.
const MAX_FAILED_TRIES = 5;
const LOCK_MINUTES = 15;

// One message for every login problem (unknown user, wrong password, disabled, locked),
// so nobody can find out which usernames exist.
const LOGIN_FAILED = 'Wrong username or password, or the account is locked.';

function sessionAnswer(staff: StaffUser, expiresAt: Date) {
    return { next: 'done' as const, username: staff.username, role: staff.role, expiresAt: expiresAt.toISOString() };
}

// Everything is checked: start the real session.
async function finishLogin(req: Request, res: Response, staff: StaffUser): Promise<void> {
    await clearFailedLogins(staff.staff_id);
    clearPendingCookie(res);
    const expiresAt = issueSession(res, staff);
    console.log(`[staff] login username=${staff.username} ip=${req.ip}`);
    res.json(sessionAnswer(staff, expiresAt));
}

// Reads the "password was right" cookie and loads the user. Answers 401 itself when it is not valid.
async function loadPendingStaff(req: Request, res: Response): Promise<StaffUser | null> {
    const claims = readPending(req);
    const staff = claims ? await findStaffById(claims.staffId) : null;
    if (!claims || !staff || staff.status !== 'active' || staff.session_version !== claims.version) {
        clearPendingCookie(res);
        res.status(401).json({ error: 'This login step ended. Please log in again.' });
        return null;
    }
    return staff;
}

function readCode(req: Request): string {
    const code = (req.body as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? code.trim() : '';
}

// POST /internal/staff/login   body: { username, password }
// Answers { next: 'verify' | 'setup' | 'done' }:
//   verify = ask for the 2FA code, setup = the user must set up 2FA first, done = logged in.
export async function login(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof body.username !== 'string' || typeof body.password !== 'string' ||
        body.username === '' || body.password === '' || body.username.length > 100 || body.password.length > 256) {
        res.status(400).json({ error: 'Username and password are required' });
        return;
    }

    const staff = await findStaffByUsername(normalizeUsername(body.username));

    // Unknown, disabled or locked: we still do a password check on a dummy hash, so the answer
    // takes the same time as a real one. A locked account does not get more wrong tries counted.
    if (!staff || staff.status !== 'active' || staff.is_locked) {
        await verifyPassword(null, body.password);
        console.warn(`[staff] login refused username=${normalizeUsername(body.username).slice(0, 50)} ip=${req.ip}`);
        res.status(401).json({ error: LOGIN_FAILED });
        return;
    }

    if (!(await verifyPassword(staff.password_hash, body.password))) {
        await recordFailedLogin(staff.staff_id, MAX_FAILED_TRIES, LOCK_MINUTES);
        console.warn(`[staff] wrong password username=${staff.username} ip=${req.ip}`);
        res.status(401).json({ error: LOGIN_FAILED });
        return;
    }

    // Password is right. The count of wrong tries is cleared only after the 2FA step is done too,
    // so someone who knows the password still cannot guess 2FA codes without limit.
    if (!env.staff.require2fa && !staff.totp_enabled) {
        await finishLogin(req, res, staff);
        return;
    }

    issuePending(res, staff);
    res.json({ next: staff.totp_enabled ? 'verify' : 'setup' });
}

// POST /internal/staff/2fa/verify   body: { code }
export async function verifyTwoFactor(req: Request, res: Response): Promise<void> {
    const staff = await loadPendingStaff(req, res);
    if (!staff) return;

    if (!staff.totp_enabled || !staff.totp_secret_encrypted) {
        res.status(409).json({ error: 'Two-step login is not set up yet' });
        return;
    }
    if (staff.is_locked) {
        res.status(429).json({ error: 'Too many wrong tries. Please try again later.' });
        return;
    }

    const step = matchTotpCode(staff.totp_secret_encrypted, readCode(req));
    if (step === null) {
        await recordFailedLogin(staff.staff_id, MAX_FAILED_TRIES, LOCK_MINUTES);
        console.warn(`[staff] wrong 2FA code username=${staff.username} ip=${req.ip}`);
        res.status(401).json({ error: 'Wrong code' });
        return;
    }

    // The same code (or an older one) must never work twice.
    if (!(await claimTotpStep(staff.staff_id, step))) {
        res.status(401).json({ error: 'This code was already used. Wait for the next code.' });
        return;
    }

    await finishLogin(req, res, staff);
}

// POST /internal/staff/2fa/setup   (no body)
// Makes a new secret and answers { qrCodeDataUrl, secret }. Allowed only until 2FA is confirmed.
export async function setupTwoFactor(req: Request, res: Response): Promise<void> {
    const staff = await loadPendingStaff(req, res);
    if (!staff) return;

    if (staff.totp_enabled) {
        res.status(409).json({ error: 'Two-step login is already set up' });
        return;
    }

    const setup = await createTotpSetup(staff.username);
    if (!(await saveTotpSecret(staff.staff_id, setup.encryptedSecret))) {
        res.status(409).json({ error: 'Two-step login is already set up' });
        return;
    }

    res.json({ qrCodeDataUrl: setup.qrCodeDataUrl, secret: setup.secret });
}

// POST /internal/staff/2fa/confirm   body: { code }
// The first code from the authenticator app. If it is right, 2FA is turned on and the user is logged in.
export async function confirmTwoFactor(req: Request, res: Response): Promise<void> {
    const staff = await loadPendingStaff(req, res);
    if (!staff) return;

    if (staff.totp_enabled || !staff.totp_secret_encrypted) {
        res.status(409).json({ error: 'Start the setup first' });
        return;
    }
    if (staff.is_locked) {
        res.status(429).json({ error: 'Too many wrong tries. Please try again later.' });
        return;
    }

    const step = matchTotpCode(staff.totp_secret_encrypted, readCode(req));
    if (step === null) {
        await recordFailedLogin(staff.staff_id, MAX_FAILED_TRIES, LOCK_MINUTES);
        res.status(401).json({ error: 'Wrong code' });
        return;
    }

    if (!(await enableTotp(staff.staff_id, step))) {
        res.status(409).json({ error: 'Two-step login is already set up' });
        return;
    }

    await finishLogin(req, res, staff);
}

// POST /internal/staff/logout
// Ends this session AND every other session and support token of this user (session_version goes up).
export async function logout(req: Request, res: Response): Promise<void> {
    const claims = readSession(req);
    if (claims) {
        const staff = await findStaffById(claims.staffId);
        // Only a cookie that is still the current one may log the user out everywhere.
        if (staff && staff.session_version === claims.version) {
            await bumpSessionVersion(staff.staff_id);
            console.log(`[staff] logout username=${staff.username} ip=${req.ip}`);
        }
    }
    clearSessionCookie(res);
    clearPendingCookie(res);
    res.json({ success: true });
}