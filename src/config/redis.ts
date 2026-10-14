import { createClient } from 'redis';
import { env } from './env';

// RESP: 2 forces the older wire protocol, which every Redis version
// supports — RESP3 (the client's default) requires the HELLO command,
// only available from Redis 6.0 onward.
export const redisClient = createClient({ url: env.redisUrl, RESP: 2 });

redisClient.on('error', (err) => {
    console.error('Redis client error:', err);
});

export async function connectRedis(): Promise<void> {
    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
}