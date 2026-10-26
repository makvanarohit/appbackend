import { Queue } from 'bullmq';
import { queueConnection } from '../config/queue-redis';

export const QUEUE_NAME = 'webhook-events';

// Job data is ONLY the database row id. Never the real payload.
// BullMQ stores job data in Redis in plain text, and some webhook
// payloads (customers/redact) carry a real person's email and phone
// number. The full payload already lives safely in MySQL — the worker
// reads it back from there when the job runs.
export interface WebhookJobData {
    eventId: number;
}

export const webhookQueue = new Queue<WebhookJobData>(QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
        attempts: 5,
        backoff: {
            type: 'exponential',
            delay: 2000, // 2s, 4s, 8s, 16s, 32s
        },
        removeOnComplete: { count: 100 }, // keep a few for visibility, not forever
        removeOnFail: { count: 1000 }, // keep more failed ones, for debugging
    },
});

webhookQueue.on('error', (err) => {
    console.error('[webhook-queue] error:', err.message);
});

export const webhookJobId = (eventId: number): string => `webhook-event-${eventId}`;

// Called from the webhook controller, right after we save the event to
// MySQL and right before we answer Shopify with 200.
export async function enqueueWebhookEvent(eventId: number): Promise<void> {
    await webhookQueue.add(
        'process',
        { eventId },
        { jobId: webhookJobId(eventId) }, // stops the SAME row being queued twice
    );
}