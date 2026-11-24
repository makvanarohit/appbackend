import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from '../config/database';
import type { StaffRole, StaffStatus, StaffUser } from '../models/staff.model';

export class StaffUsernameTakenError extends Error { }

// is_locked is worked out by the database, so we never compare dates with the app's clock.
const SELECT_STAFF = `SELECT *, (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked FROM staff_users`;

function mapRow(row: RowDataPacket): StaffUser {
    return {
        ...(row as unknown as StaffUser),
        totp_enabled: Boolean(row.totp_enabled),
        is_locked: Boolean(row.is_locked),
    };
}

export async function findStaffByUsername(username: string): Promise<StaffUser | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `${SELECT_STAFF} WHERE username = :username LIMIT 1`,
        { username },
    );
    return rows[0] ? mapRow(rows[0]) : null;
}

export async function findStaffById(staffId: number): Promise<StaffUser | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `${SELECT_STAFF} WHERE staff_id = :staffId LIMIT 1`,
        { staffId },
    );
    return rows[0] ? mapRow(rows[0]) : null;
}

export async function listStaff(): Promise<StaffUser[]> {
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT_STAFF} ORDER BY username`);
    return rows.map(mapRow);
}

export async function countActiveAdmins(): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM staff_users WHERE role = 'admin' AND status = 'active'`,
    );
    return Number(rows[0]?.total ?? 0);
}

interface CreateStaffInput {
    username: string;
    passwordHash: string;
    role: StaffRole;
}

// Throws StaffUsernameTakenError when the username already exists.
export async function createStaffUser(input: CreateStaffInput): Promise<StaffUser> {
    let insertId: number;
    try {
        const [result] = await pool.query<ResultSetHeader>(
            `INSERT INTO staff_users (username, password_hash, role)
       VALUES (:username, :passwordHash, :role)`,
            { username: input.username, passwordHash: input.passwordHash, role: input.role },
        );
        insertId = result.insertId;
    } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
            throw new StaffUsernameTakenError('Username is already taken');
        }
        throw err;
    }

    const created = await findStaffById(insertId);
    if (!created) throw new Error('Failed to load the new staff user');
    return created;
}

// ---------- Login protection ----------

// Counts one wrong password or wrong 2FA code, in ONE atomic query.
// When the count reaches maxTries, the account is locked for lockMinutes and the count starts again.
// MySQL runs the SET parts from left to right and a later part sees the NEW value of an
// earlier part. So locked_until must come FIRST: it needs the OLD failed_login_count.
export async function recordFailedLogin(staffId: number, maxTries: number, lockMinutes: number): Promise<void> {
    await pool.query(
        `UPDATE staff_users SET
       locked_until = IF(failed_login_count + 1 >= :maxTries, DATE_ADD(NOW(), INTERVAL :lockMinutes MINUTE), locked_until),
       failed_login_count = IF(failed_login_count + 1 >= :maxTries, 0, failed_login_count + 1)
     WHERE staff_id = :staffId`,
        { staffId, maxTries, lockMinutes },
    );
}

export async function clearFailedLogins(staffId: number): Promise<void> {
    await pool.query(
        `UPDATE staff_users SET failed_login_count = 0, locked_until = NULL WHERE staff_id = :staffId`,
        { staffId },
    );
}

// ---------- Sessions ----------

// Ends every staff session and every support token of this user (they all hold the old number).
// Returns false when there is no such user.
export async function bumpSessionVersion(staffId: number): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE staff_users SET session_version = session_version + 1 WHERE staff_id = :staffId`,
        { staffId },
    );
    return result.affectedRows > 0;
}

// ---------- Changes made by an admin (each one also ends the user's sessions) ----------

export async function setStaffStatus(staffId: number, status: StaffStatus): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE staff_users SET status = :status, session_version = session_version + 1 WHERE staff_id = :staffId`,
        { staffId, status },
    );
    return result.affectedRows > 0;
}

// A new password also clears a lock and the wrong-try count.
export async function setPasswordHash(staffId: number, passwordHash: string): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE staff_users SET
       password_hash = :passwordHash,
       failed_login_count = 0,
       locked_until = NULL,
       session_version = session_version + 1
     WHERE staff_id = :staffId`,
        { staffId, passwordHash },
    );
    return result.affectedRows > 0;
}

// Removes 2FA. The user sets it up again at the next login.
export async function resetTotp(staffId: number): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE staff_users SET
       totp_secret_encrypted = NULL,
       totp_enabled = FALSE,
       totp_last_used_step = NULL,
       session_version = session_version + 1
     WHERE staff_id = :staffId`,
        { staffId },
    );
    return result.affectedRows > 0;
}

// ---------- Two-step login (TOTP) ----------

// Saves a NEW secret while setting up. Allowed only while 2FA is not enabled yet,
// so nobody can swap the secret of a user who already uses 2FA (an admin reset is needed for that).
export async function saveTotpSecret(staffId: number, secretEncrypted: string): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE staff_users SET
       totp_secret_encrypted = :secretEncrypted,
       totp_last_used_step = NULL
     WHERE staff_id = :staffId AND totp_enabled = FALSE`,
        { staffId, secretEncrypted },
    );
    return result.affectedRows > 0;
}

// Turns 2FA on after the first code was checked. `step` is the step of that first code.
export async function enableTotp(staffId: number, step: number): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE staff_users SET totp_enabled = TRUE, totp_last_used_step = :step
     WHERE staff_id = :staffId AND totp_enabled = FALSE AND totp_secret_encrypted IS NOT NULL`,
        { staffId, step },
    );
    return result.affectedRows > 0;
}

// Uses up a 2FA time step. Returns false when this step (or a later one) was already used,
// so the same code cannot be used twice. It is ONE atomic query, so two requests with the
// same code at the same moment cannot both win.
export async function claimTotpStep(staffId: number, step: number): Promise<boolean> {
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE staff_users SET totp_last_used_step = :step
     WHERE staff_id = :staffId AND (totp_last_used_step IS NULL OR totp_last_used_step < :step)`,
        { staffId, step },
    );
    return result.affectedRows > 0;
}


// ---------- Disabling a user (the last active admin must always stay) ----------

export type DisableResult = 'disabled' | 'not_found' | 'last_admin';

// Disables a user and ends all of their sessions. It refuses when this user is the last active admin.
// It runs in a transaction and locks the rows of all active admins first, so two admins that disable
// each other at the same moment cannot both succeed (the second one waits, then sees only one admin left).
export async function disableStaff(staffId: number): Promise<DisableResult> {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [admins] = await connection.query<RowDataPacket[]>(
            `SELECT staff_id FROM staff_users WHERE role = 'admin' AND status = 'active' FOR UPDATE`,
        );
        const [targets] = await connection.query<RowDataPacket[]>(
            `SELECT role, status FROM staff_users WHERE staff_id = :staffId FOR UPDATE`,
            { staffId },
        );
        const target = targets[0];

        if (!target) {
            await connection.rollback();
            return 'not_found';
        }
        if (target.role === 'admin' && target.status === 'active' && admins.length <= 1) {
            await connection.rollback();
            return 'last_admin';
        }

        await connection.query(
            `UPDATE staff_users SET status = 'disabled', session_version = session_version + 1 WHERE staff_id = :staffId`,
            { staffId },
        );
        await connection.commit();
        return 'disabled';
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
}