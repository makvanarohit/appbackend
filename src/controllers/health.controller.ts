import type { Request, Response } from 'express';
import { pool } from '../config/database';
import { redisClient } from '../config/redis';
import { queueConnection } from '../config/queue-redis';

// GET /health  (in app.ts) only says "the process is running". Use it to decide if the
//              app must be RESTARTED. It never checks MySQL or Redis, so a short MySQL or
//              Redis problem does not make your platform restart a healthy server.
// GET /ready   (this file) says "the app can really do its work right now", which means
//              MySQL and Redis both answer. Use it to decide if a load balancer should send
//              traffic to this server.

const CHECK_TIMEOUT_MS = 2_000; // one check may take at most 2 seconds
const CACHE_MS = 3_000; // keep the last answer for 3 seconds, so many probes do not hammer MySQL and Redis

type CheckResult = 'ok' | 'down';

interface ReadinessAnswer {
    ready: boolean;
    body: { status: 'ready' | 'not_ready'; checks: { mysql: CheckResult; redis: CheckResult } };
}

// Runs one check, but never waits longer than CHECK_TIMEOUT_MS (a frozen server must not freeze /ready).
// The reason of a failure goes to the log only. The public answer is just "ok" or "down".
async function runCheck(name: string, check: () => Promise<unknown>): Promise<CheckResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            check(),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('no answer in time')), CHECK_TIMEOUT_MS);
            }),
        ]);
        return 'ok';
    } catch (err) {
        console.error(`[ready] ${name} check failed:`, err instanceof Error ? err.message : err);
        return 'down';
    } finally {
        clearTimeout(timer);
    }
}

async function checkMysql(): Promise<unknown> {
    return pool.query('SELECT 1');
}

// Both Redis connections must work: the one for locks, and the one for the webhook queue.
async function checkRedis(): Promise<void> {
    if (!redisClient.isReady) throw new Error('the Redis client is not connected');
    await redisClient.ping();
    await queueConnection.ping();
}

async function runChecks(): Promise<ReadinessAnswer> {
    const [mysql, redis] = await Promise.all([
        runCheck('mysql', checkMysql),
        runCheck('redis', checkRedis),
    ]);
    const ready = mysql === 'ok' && redis === 'ok';
    return { ready, body: { status: ready ? 'ready' : 'not_ready', checks: { mysql, redis } } };
}

let cached: { at: number; answer: ReadinessAnswer } | null = null;
let running: Promise<ReadinessAnswer> | null = null;

export async function readiness(_req: Request, res: Response): Promise<void> {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
        // Requests that arrive while the checks run share the same run.
        if (!running) {
            running = runChecks().finally(() => {
                running = null;
            });
        }
        cached = { at: Date.now(), answer: await running };
    }

    res.set('Cache-Control', 'no-store');
    res.status(cached.answer.ready ? 200 : 503).json(cached.answer.body);
}