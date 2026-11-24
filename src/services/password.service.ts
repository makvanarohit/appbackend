import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { HashOptions } from 'argon2';

// argon2id with the minimum settings the OWASP Password Storage Cheat Sheet recommends
// (19 MiB of memory, 2 rounds, 1 thread). Each password gets its own random salt automatically.
const HASH_OPTIONS: HashOptions = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
};

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Returns a message when the password is not allowed, or null when it is fine.
export function checkPasswordPolicy(password: string): string | null {
    if (password.length < PASSWORD_MIN_LENGTH) {
        return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
    }
    return null;
}

export function hashPassword(password: string): Promise<string> {
    return argon2.hash(password, HASH_OPTIONS);
}

// A hash of nothing real. It is used when the username does not exist, so the login
// takes the same time as for a real user and nobody can find out which usernames exist.
let dummyHash: Promise<string> | null = null;

// Pass the saved hash, or null when the user was not found.
// Always returns true or false, and never throws.
export async function verifyPassword(savedHash: string | null, password: string): Promise<boolean> {
    if (savedHash === null) {
        dummyHash ??= argon2.hash('this-is-not-a-real-password', HASH_OPTIONS);
        await argon2.verify(await dummyHash, password).catch(() => false);
        return false;
    }
    try {
        return await argon2.verify(savedHash, password);
    } catch {
        return false;
    }
}

// A random password without look-alike characters (no 0 O 1 l I).
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePassword(length = 20): string {
    let password = '';
    for (let i = 0; i < length; i += 1) {
        password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    }
    return password;
}