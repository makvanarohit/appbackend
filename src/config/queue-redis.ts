import Redis from 'ioredis';
import { env } from './env';

// For the Queue (the part that ADDS jobs). This should give up fast if
// Redis is down, so an incoming webhook doesn't hang waiting for Redis.
export const queueConnection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});

// For the Worker (the part that DOES jobs). BullMQ needs this exact
// setting (maxRetriesPerRequest: null) or the worker can break in odd
// ways — this is not optional, BullMQ's own docs say so.
export const workerConnection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
});

queueConnection.on('error', (err) => {
    console.error('[queue-redis] queue connection error:', err.message);
});

workerConnection.on('error', (err) => {
    console.error('[queue-redis] worker connection error:', err.message);
});