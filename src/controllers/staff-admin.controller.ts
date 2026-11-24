import type { Response } from 'express';
import type { StaffRole, StaffUser } from '../models/staff.model';
import { isValidUsername, normalizeUsername, USERNAME_RULE_MESSAGE } from '../models/staff.model';
import type { StaffRequest } from '../middleware/verify-staff';
import {
    createStaffUser,
    disableStaff,
    findStaffById,
    listStaff,
    resetTotp,
    setPasswordHash,
    setStaffStatus,
    StaffUsernameTakenError,
} from '../repositories/staff.repository';
import { checkPasswordPolicy, hashPassword } from '../services/password.service';

// What the frontend may see about a staff user. Never the password hash or the 2FA secret.
function toView(user: StaffUser) {
    return {
        staffId: user.staff_id,
        username: user.username,
        role: user.role,
        status: user.status,
        totpEnabled: user.totp_enabled,
        isLocked: user.is_locked,
        createdAt: user.created_at.toISOString(),
    };
}

const ROLES: StaffRole[] = ['support', 'admin'];

// GET /internal/staff/users
export async function listUsers(_req: StaffRequest, res: Response): Promise<void> {
    res.json({ users: (await listStaff()).map(toView) });
}

// POST /internal/staff/users   body: { username, password, role }
// The admin chooses the username and the first password, and gives them to the staff member.
// The staff member sets up 2FA at the first login.
export async function createUser(req: StaffRequest, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; role?: unknown };

    if (typeof body.username !== 'string' || !isValidUsername(normalizeUsername(body.username))) {
        res.status(400).json({ error: `${USERNAME_RULE_MESSAGE}.` });
        return;
    }
    if (typeof body.password !== 'string') {
        res.status(400).json({ error: 'Password is required' });
        return;
    }
    const passwordProblem = checkPasswordPolicy(body.password);
    if (passwordProblem) {
        res.status(400).json({ error: passwordProblem });
        return;
    }
    if (typeof body.role !== 'string' || !ROLES.includes(body.role as StaffRole)) {
        res.status(400).json({ error: 'Role must be "support" or "admin"' });
        return;
    }

    const username = normalizeUsername(body.username);
    try {
        const created = await createStaffUser({
            username,
            passwordHash: await hashPassword(body.password),
            role: body.role as StaffRole,
        });
        console.log(`[staff] created username=${created.username} role=${created.role} by=${req.staff?.username}`);
        res.status(201).json({ user: toView(created) });
    } catch (err) {
        if (err instanceof StaffUsernameTakenError) {
            res.status(409).json({ error: 'This username is already taken' });
            return;
        }
        throw err;
    }
}

// PATCH /internal/staff/users/:id
// Send exactly ONE of these in the body:
//   { "status": "disabled" }  or  { "status": "active" }
//   { "password": "a new password" }
//   { "resetTwoFactor": true }
// Each of them also ends all sessions of that user at once.
export async function updateUser(req: StaffRequest, res: Response): Promise<void> {
    const staffId = Number(req.params.id);
    if (!Number.isSafeInteger(staffId) || staffId <= 0) {
        res.status(400).json({ error: 'Invalid user id' });
        return;
    }

    const body = (req.body ?? {}) as { status?: unknown; password?: unknown; resetTwoFactor?: unknown };
    const actions = (['status', 'password', 'resetTwoFactor'] as const).filter((key) => body[key] !== undefined);
    if (actions.length !== 1) {
        res.status(400).json({ error: 'Send exactly one of: status, password, resetTwoFactor' });
        return;
    }

    const target = await findStaffById(staffId);
    if (!target) {
        res.status(404).json({ error: 'Staff user not found' });
        return;
    }
    const admin = req.staff?.username;

    if (actions[0] === 'status') {
        if (body.status !== 'active' && body.status !== 'disabled') {
            res.status(400).json({ error: 'Status must be "active" or "disabled"' });
            return;
        }
        if (body.status === 'disabled') {
            if (staffId === req.staff?.staff_id) {
                res.status(400).json({ error: 'You cannot disable your own account' });
                return;
            }
            const result = await disableStaff(staffId);
            if (result === 'last_admin') {
                res.status(409).json({ error: 'At least one active admin must stay' });
                return;
            }
            if (result === 'not_found') {
                res.status(404).json({ error: 'Staff user not found' });
                return;
            }
            console.log(`[staff] disabled username=${target.username} by=${admin}`);
        } else {
            await setStaffStatus(staffId, 'active');
            console.log(`[staff] enabled username=${target.username} by=${admin}`);
        }
    } else if (actions[0] === 'password') {
        if (typeof body.password !== 'string') {
            res.status(400).json({ error: 'Password must be text' });
            return;
        }
        const passwordProblem = checkPasswordPolicy(body.password);
        if (passwordProblem) {
            res.status(400).json({ error: passwordProblem });
            return;
        }
        await setPasswordHash(staffId, await hashPassword(body.password));
        console.log(`[staff] new password for username=${target.username} by=${admin}`);
    } else {
        if (body.resetTwoFactor !== true) {
            res.status(400).json({ error: 'resetTwoFactor must be true' });
            return;
        }
        await resetTotp(staffId);
        console.log(`[staff] reset 2FA for username=${target.username} by=${admin}`);
    }

    const updated = await findStaffById(staffId);
    res.json({ user: updated ? toView(updated) : null });
}