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
        const eventId = job?.data.eventId;
        const maxTries = job?.opts.attempts ?? 1;
        if (job && job.attemptsMade >= maxTries) {
            // The queue used its last try. The sweeper tries this event again later (see
            // requeueFailedWebhooks), but someone should look at it.
            console.error(`[webhook-worker] GAVE UP on event ${eventId} after ${job.attemptsMade} tries: ${err.message}`);
            return;
        }
        console.error(`[webhook-worker] failed: event ${eventId} (try ${job?.attemptsMade} of ${maxTries}, will try again)`, err.message);
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