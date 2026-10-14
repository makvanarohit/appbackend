import { CronJob } from 'cron';
import { findStuckWebhookEventIds } from '../repositories/store.repository';
import { enqueueWebhookEvent } from '../queues/webhook.queue';

const STUCK_AFTER_MINUTES = 5;

export async function requeueStuckWebhooks(): Promise<void> {
  const eventIds = await findStuckWebhookEventIds(STUCK_AFTER_MINUTES);
  if (eventIds.length === 0) return;

  console.log(`[requeue-stuck-webhooks] ${eventIds.length} stuck event(s) found`);

  for (const eventId of eventIds) {
    try {
      // Safe even if a job with this id already exists: the jobId makes
      // this a no-op in that case, not a duplicate run.
      await enqueueWebhookEvent(eventId);
      console.log(`[requeue-stuck-webhooks] re-queued event ${eventId}`);
    } catch (err) {
      console.error(`[requeue-stuck-webhooks] failed to re-queue event ${eventId}:`, err);
    }
  }
}

export function scheduleRequeueStuckWebhooksJob(): CronJob {
  return CronJob.from({
    cronTime: '*/2 * * * *',
    onTick: requeueStuckWebhooks,
    start: true,
    errorHandler: (err) => {
      console.error('[requeue-stuck-webhooks] job crashed:', err);
    },
  });
}