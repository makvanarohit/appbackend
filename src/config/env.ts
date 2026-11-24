import dotenv from 'dotenv';
import { isIP } from 'node:net';

dotenv.config();

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function requiredAppHost(): string {
    const value = required('APP_HOST').trim().toLowerCase();
    if (!value || value.includes('://') || value.includes('/') || value.includes('\\') ||
        value.includes('?') || value.includes('#') || value.includes('@') || value.includes(':') ||
        value.startsWith('<') || value.endsWith('>') || value.includes('your-app-host')) {
        throw new Error('APP_HOST must be a real hostname only (without protocol, port, path, or placeholder text)');
    }
    let parsed: URL;
    try {
        parsed = new URL(`https://${value}`);
    } catch {
        throw new Error('APP_HOST is not a valid hostname');
    }
    if (parsed.hostname !== value || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('APP_HOST must be a real hostname only (without protocol, port, path, or placeholder text)');
    }
    return value;
}

// Reads a whole number from the environment and checks the range.
// Blank or missing -> uses the default. Wrong value -> the app stops with a clear message.
function intFromEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(
            `${name} must be a whole number between ${min} and ${max} (got: ${JSON.stringify(raw)})`,
        );
    }
    return value;
}

// APP_ENV says WHICH of your 4 setups this is. It decides the behavior:
// error details, log style.
// NODE_ENV only says "build mode" and is kept for Express and other libraries.
const APP_ENVS = ['local', 'development', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

function requiredAppEnv(): AppEnv {
    const value = process.env.APP_ENV;
    if (!APP_ENVS.includes(value as AppEnv)) {
        throw new Error(
            `APP_ENV must be one of ${APP_ENVS.join(', ')} (got: ${JSON.stringify(value)})`,
        );
    }
    return value as AppEnv;
}

function requiredNodeEnv(): 'development' | 'production' {
    const value = process.env.NODE_ENV;
    if (value !== 'development' && value !== 'production') {
        throw new Error(
            `NODE_ENV must be set to exactly "development" or "production" (got: ${JSON.stringify(value)})`,
        );
    }
    return value;
}

const appEnv = requiredAppEnv();
const nodeEnv = requiredNodeEnv();

// Safety check: staging and production must run in Node's production mode.
if ((appEnv === 'staging' || appEnv === 'production') && nodeEnv !== 'production') {
    throw new Error(`APP_ENV=${appEnv} requires NODE_ENV=production`);
}

// Encryption keys. The ACTIVE key encrypts new tokens. OLD keys are only used
// to read tokens that were saved before a rotation.
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function decodeKey(id: string, base64: string): Buffer {
    if (!KEY_ID_PATTERN.test(id)) {
        throw new Error(`Encryption key id "${id}" may only use letters, numbers, - and _`);
    }
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) {
        throw new Error(`Encryption key "${id}" must decode to exactly 32 bytes (base64)`);
    }
    return key;
}

function loadEncryptionKeys(activeId: string): Map<string, Buffer> {
    const keys = new Map<string, Buffer>();
    keys.set(activeId, decodeKey(activeId, required('TOKEN_ENCRYPTION_KEY')));

    // Format: v1=base64key,v0=base64key
    // Split at the FIRST "=" only, because base64 can end with "=" too.
    const oldKeys = (process.env.TOKEN_ENCRYPTION_OLD_KEYS ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

    for (const entry of oldKeys) {
        const index = entry.indexOf('=');
        if (index === -1) {
            throw new Error('TOKEN_ENCRYPTION_OLD_KEYS must look like: v1=base64key,v0=base64key');
        }
        const id = entry.slice(0, index);
        if (keys.has(id)) {
            throw new Error(`Encryption key id "${id}" is used more than once`);
        }
        keys.set(id, decodeKey(id, entry.slice(index + 1)));
    }
    return keys;
}

const activeKeyId = process.env.TOKEN_ENCRYPTION_KEY_ID ?? 'v1';
const encryptionKeys = loadEncryptionKeys(activeKeyId);

// ---------- Staff login and support access ----------

// A secret for signing tokens: a base64 text that decodes to at least 32 bytes.
function secretFromEnv(name: string): Buffer {
    const key = Buffer.from(required(name), 'base64');
    if (key.length < 32) {
        throw new Error(`${name} must be a base64 text that decodes to at least 32 bytes`);
    }
    return key;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = raw.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${name} must be "true" or "false" (got: ${JSON.stringify(raw)})`);
}

// The address of your frontend, as an origin only (no path). The staff cookie and the CORS check use it.
function frontendOriginFromEnv(): string {
    const raw = required('APP_FRONTEND_URL').trim();
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('APP_FRONTEND_URL must be a full address, for example https://app.example.com');
    }
    if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.pathname !== '/' || url.search || url.hash || url.username || url.password
    ) {
        throw new Error('APP_FRONTEND_URL must be an origin only (protocol + host, without a path)');
    }
    if ((appEnv === 'staging' || appEnv === 'production') && url.protocol !== 'https:') {
        throw new Error(`APP_FRONTEND_URL must use https on ${appEnv}`);
    }
    return url.origin;
}

function ipListFromEnv(name: string): string[] {
    const list = (process.env[name] ?? '').split(',').map((ip) => ip.trim()).filter(Boolean);
    for (const ip of list) {
        if (isIP(ip) === 0) throw new Error(`${name} has a value that is not an IP address: ${JSON.stringify(ip)}`);
    }
    return list;
}

// 2FA is required everywhere except on your own computer.
const staffRequire2fa = boolFromEnv('STAFF_REQUIRE_2FA', true);
if (!staffRequire2fa && appEnv !== 'local') {
    throw new Error(`STAFF_REQUIRE_2FA=false is allowed only when APP_ENV=local (APP_ENV is ${appEnv})`);
}

const staffSessionSecret = secretFromEnv('STAFF_SESSION_SECRET');
const supportTokenSecret = secretFromEnv('SUPPORT_TOKEN_SECRET');

// Every secret must be different. One leaked secret must never open the others.
const secretsInUse: Array<[string, string]> = [
    ['STAFF_SESSION_SECRET', staffSessionSecret.toString('base64')],
    ['SUPPORT_TOKEN_SECRET', supportTokenSecret.toString('base64')],
    ['SHOPIFY_CLIENT_SECRET', required('SHOPIFY_CLIENT_SECRET')],
    ...[...encryptionKeys].map(([id, key]): [string, string] => [`TOKEN_ENCRYPTION_KEY (${id})`, key.toString('base64')]),
];

for (let i = 0; i < secretsInUse.length; i += 1) {
    for (let j = i + 1; j < secretsInUse.length; j += 1) {
        if (secretsInUse[i][1] === secretsInUse[j][1]) {
            throw new Error(`${secretsInUse[i][0]} and ${secretsInUse[j][0]} must not have the same value`);
        }
    }
}

const staffFrontendOrigin = frontendOriginFromEnv();

export const env = {
    appEnv,
    nodeEnv,
    isProduction: appEnv === 'production',
    // Staging and production must never show internal error messages.
    exposeErrorDetails: appEnv === 'local' || appEnv === 'development',

    port: intFromEnv('PORT', 3000, 1, 65535),

    // How many proxies / load balancers stand between the internet and this server.
    // 0 = none (your laptop). 1 = one (for example a load balancer or a Cloudflare Tunnel).
    // A wrong number breaks rate limiting, so set it on purpose.
    trustProxy: intFromEnv('TRUST_PROXY', 0, 0, 10),

    shopifyClientId: required('SHOPIFY_CLIENT_ID'),
    shopifyClientSecret: required('SHOPIFY_CLIENT_SECRET'),
    appHost: requiredAppHost(),

    db: {
        host: required('DB_HOST'),
        port: intFromEnv('DB_PORT', 3306, 1, 65535),
        user: required('DB_USER'),
        // A real server must never start without a database password.
        password: appEnv === 'staging' || appEnv === 'production' ? required('DB_PASSWORD') : (process.env.DB_PASSWORD ?? ''),
        database: required('DB_NAME'),
    },

    tokenEncryptionKeyId: activeKeyId,
    tokenEncryptionKeys: encryptionKeys,

    // Staff login and support access ("Open as merchant").
    staff: {
        sessionSecret: staffSessionSecret,
        // The staff login, and every support session, ends this many minutes after login.
        sessionMinutes: intFromEnv('STAFF_SESSION_MINUTES', 30, 5, 480),
        require2fa: staffRequire2fa,
        // Origin of your frontend (the CORS check and the Origin check use it).
        frontendOrigin: staffFrontendOrigin,
        // Empty = every IP may reach /internal. Otherwise only these IPs.
        allowedIps: ipListFromEnv('STAFF_ALLOWED_IPS'),
    },
    supportTokenSecret,

    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

    corsOrigins: (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
};