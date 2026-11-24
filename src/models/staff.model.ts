export type StaffRole = 'support' | 'admin';
export type StaffStatus = 'active' | 'disabled';

export interface StaffUser {
    staff_id: number;

    username: string;
    password_hash: string;
    role: StaffRole;
    status: StaffStatus;

    // Raise this number to end every session and support token of this user.
    session_version: number;

    totp_secret_encrypted: string | null;
    totp_enabled: boolean;
    // The time step of the last 2FA code that was accepted. A code from the same
    // step (or an older one) is refused, so one code cannot be used twice.
    totp_last_used_step: number | null;

    failed_login_count: number;
    locked_until: Date | null;
    // Worked out by the database (locked_until > NOW()), so the app's clock is never used for it.
    is_locked: boolean;

    created_at: Date;
}

// 3 to 50 characters: lowercase letters, numbers, dot, dash, underscore. It starts with a letter or number.
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,49}$/;

export function normalizeUsername(raw: string): string {
    return raw.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
    return USERNAME_PATTERN.test(username);
}

export const USERNAME_RULE_MESSAGE =
    'Username must be 3 to 50 characters: lowercase letters, numbers, dot, dash or underscore';