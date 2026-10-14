import { Worker, type Job } from 'bullmq';
import { workerConnection } from '../config/queue-redis';
import { processWebhook } from '../services/webhook.service';
import { QUEUE_NAME, type WebhookJobData } from './webhook.queue';

let worker: Worker<WebhookJobData> | null = null;

// Call this once, when the server starts.
export function startWebhookWorker(): Worker<WebhookJobData> {
    worker = new Worker<WebhookJobData>(
        QUEUE_NAME,
        async (job: Job<WebhookJobData>) => {
            await processWebhook(job.data.eventId);
        },
        {
            connection: workerConnection,
            concurrency: 5, // handle up to 5 webhook jobs at the same time
        },
    );

    worker.on('completed', (job) => {
        console.log(`[webhook-worker] done: event ${job.data.eventId}`);
    });

    worker.on('failed', (job, err) => {
        // BullMQ will retry this on its own (5 attempts, growing delay —
        // configured on the queue side), so this log is informational, not
        // a dead end.
        console.error(`[webhook-worker] failed: event ${job?.data.eventId}`, err.message);
    });

    worker.on('error', (err) => {
        console.error('[webhook-worker] worker error:', err.message);
    });

    return worker;
}

export async function stopWebhookWorker(): Promise<void> {
    if (worker) {
        await worker.close();
    }
}