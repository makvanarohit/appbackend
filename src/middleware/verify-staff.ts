import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import type { StaffUser } from '../models/staff.model';
import { findStaffById } from '../repositories/staff.repository';
import { clearSessionCookie, readSession } from '../services/staff-session.service';

export interface StaffRequest extends Request {
    staff?: StaffUser;
    // When the staff login ends, in seconds since 1970. A support token ends at the same moment.
    staffSessionExpiresAt?: number;
}

// Runs on every staff route that needs a login. It reads the cookie AND checks the staff
// row in the database, so these things stop a session at once: logout, disabling the user,
// a new password, a 2FA reset. (They all raise session_version.)
export async function verifyStaff(req: StaffRequest, res: Response, next: NextFunction): Promise<void> {
    const claims = readSession(req);
    const staff = claims ? await findStaffById(claims.staffId) : null;

    const valid =
        claims !== null &&
        staff !== null &&
        staff.status === 'active' &&
        staff.session_version === claims.version &&
        // If 2FA is required, a session of a user without 2FA is never accepted.
        (!env.staff.require2fa || staff.totp_enabled);

    if (!valid || !staff || !claims) {
        clearSessionCookie(res);
        res.status(401).json({ error: 'Please log in again' });
        return;
    }

    req.staff = staff;
    req.staffSessionExpiresAt = claims.expiresAt;
    next();
}

// Use it AFTER verifyStaff, on routes only an admin may call.
export function requireAdmin(req: StaffRequest, res: Response, next: NextFunction): void {
    if (req.staff?.role !== 'admin') {
        res.status(403).json({ error: 'Only an admin can do this' });
        return;
    }
    next();
}