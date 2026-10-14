import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { pool, pingDatabase } from './config/database';
import { connectRedis, redisClient } from './config/redis';
import { scheduleRefreshStaleTokensJob } from './jobs/refresh-stale-tokens.job';
import { startWebhookWorker, stopWebhookWorker } from './queues/webhook.worker';
import { webhookQueue } from './queues/webhook.queue';
import { queueConnection, workerConnection } from './config/queue-redis';
import { scheduleRequeueStuckWebhooksJob } from './jobs/requeue-stuck-webhooks.job';
import { scheduleCleanupWebhookEventsJob } from './jobs/cleanup-webhook-events.job';

// After an uncaught exception the process may be half-broken (a lock that
// never gets released, a connection in an unknown state). Log it, exit, and
// let the process manager (PM2, Docker, systemd) start a clean one. Safe
// because webhook events are saved to MySQL before we answer Shopify, and
// the sweeper picks up anything that was mid-flight.
process.on('uncaughtException', (err) => {
    console.error('[fatal] uncaught exception, exiting:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection, exiting:', reason);
    process.exit(1);
});

// If the shutdown is not finished after this time, the process exits anyway.
// Your process manager must wait at least this long before it kills the process
// (Docker: stop_grace_period, PM2: kill_timeout, Kubernetes: terminationGracePeriodSeconds).
const SHUTDOWN_TIMEOUT_MS = 10_000;

// Stops accepting new connections and waits for the running requests to end.
function closeHttpServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve()); // also resolves if the server was already closed
        server.closeIdleConnections(); // do not wait for keep-alive connections that do nothing
    });
}

async function main(): Promise<void> {
    // Fail fast: don't start accepting traffic if a dependency is down.
    await pingDatabase();
    console.log('MySQL connected');
    await connectRedis();
    console.log('Redis connected');

    // We keep the cron jobs, so the shutdown can stop them.
    const cronJobs: Array<{ stop: () => unknown }> = [];

    cronJobs.push(scheduleRefreshStaleTokensJob());
    console.log('Stale-token refresh job scheduled');

    cronJobs.push(scheduleRequeueStuckWebhooksJob());
    console.log('Stuck-webhook sweeper scheduled');

    cronJobs.push(scheduleCleanupWebhookEventsJob());
    console.log('Webhook cleanup job scheduled');

    startWebhookWorker();
    console.log('Webhook worker started');

    const app = createApp();
    const server = app.listen(env.port, () => {
        console.log(`Server listening on port ${env.port} (${env.appEnv})`);
    });

    // Graceful shutdown: stop the timers, stop taking new requests, let the running
    // requests and webhook jobs finish, then close the connections cleanly.
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        // A second signal (for example Ctrl+C and then SIGTERM) must not start a second shutdown.
        if (shuttingDown) {
            console.log(`${signal} received, but the shutdown is already running`);
            return;
        }
        shuttingDown = true;
        console.log(`${signal} received, shutting down...`);

        // If something hangs (a request that never ends, a very long job), do not wait forever.
        const forceExit = setTimeout(() => {
            console.error(`[shutdown] not finished after ${SHUTDOWN_TIMEOUT_MS / 1000} seconds, forcing exit`);
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);
        forceExit.unref();

        try {
            // 1. No new cron runs.
            await Promise.all(cronJobs.map((job) => Promise.resolve(job.stop())));

            // 2. Stop the web server and the webhook worker at the same time.
            //    The worker finishes the jobs it is running now and takes no new ones.
            await Promise.all([closeHttpServer(server), stopWebhookWorker().catch(() => undefined)]);

            // 3. Only now close the connections (the running work above may still need them).
            await webhookQueue.close().catch(() => undefined);
            await queueConnection.quit().catch(() => undefined);
            await workerConnection.quit().catch(() => undefined);
            await redisClient.quit().catch(() => undefined);
            await pool.end().catch(() => undefined);
        } catch (err) {
            console.error('[shutdown] error while shutting down:', err);
            process.exit(1);
        }

        clearTimeout(forceExit);
        console.log('[shutdown] done');
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});