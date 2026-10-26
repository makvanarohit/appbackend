import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
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
// standalone tokens, error details, log style.
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

// Standalone tokens are ONLY for your local machine. Never on a shared server.
const standaloneEnabled = appEnv === 'local';

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

export const env = {
    appEnv,
    nodeEnv,
    isProduction: appEnv === 'production',
    standaloneEnabled,
    // Staging and production must never show internal error messages.
    exposeErrorDetails: appEnv === 'local' || appEnv === 'development',

    port: intFromEnv('PORT', 3000, 1, 65535),

    // How many proxies / load balancers stand between the internet and this server.
    // 0 = none (your laptop). 1 = one (for example a load balancer or a Cloudflare Tunnel).
    // A wrong number breaks rate limiting, so set it on purpose.
    trustProxy: intFromEnv('TRUST_PROXY', 0, 0, 10),

    shopifyClientId: required('SHOPIFY_CLIENT_ID'),
    shopifyClientSecret: required('SHOPIFY_CLIENT_SECRET'),
    appHost: required('APP_HOST'),

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

    // Only needed on local. Other environments don't have to carry a useless secret.
    standaloneTokenSecret: standaloneEnabled ? required('STANDALONE_TOKEN_SECRET') : '',
    standaloneTokenTtlDays: intFromEnv('STANDALONE_TOKEN_TTL_DAYS', 30, 1, 365),

    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

    corsOrigins: (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
};