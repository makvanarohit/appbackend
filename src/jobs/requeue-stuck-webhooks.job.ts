import { CronJob } from 'cron';
import { findStuckWebhookEventIds, findRetryableFailedWebhookEventIds } from '../repositories/store.repository';
import { enqueueWebhookEvent, webhookJobId, webhookQueue } from '../queues/webhook.queue';
import { redisClient } from '../config/redis';

const STUCK_AFTER_MINUTES = 5;

// Events that ended as 'failed': try again one more time every 10 minutes, at most 6 times,
// and only for events that are less than 6 hours old. This covers a MySQL or Shopify outage of
// about an hour. The counters live in Redis, so no database column is needed.
const FAILED_RETRY_AFTER_MINUTES = 10;
const FAILED_RETRY_MAX_AGE_HOURS = 6;
const FAILED_RETRY_MAX_ROUNDS = 6;
const FAILED_RETRY_STATE_SECONDS = (FAILED_RETRY_MAX_AGE_HOURS + 1) * 3600;

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

export async function requeueFailedWebhooks(): Promise<void> {
  const eventIds = await findRetryableFailedWebhookEventIds(FAILED_RETRY_AFTER_MINUTES, FAILED_RETRY_MAX_AGE_HOURS);

  for (const eventId of eventIds) {
    try {
      // One try every 10 minutes per event.
      const myTurn = await redisClient.set(`webhook-failed-cooldown:${eventId}`, '1', {
        NX: true,
        PX: FAILED_RETRY_AFTER_MINUTES * 60 * 1000,
      });
      if (myTurn !== 'OK') continue;

      const roundsKey = `webhook-failed-rounds:${eventId}`;
      const round = await redisClient.incr(roundsKey);
      await redisClient.expire(roundsKey, FAILED_RETRY_STATE_SECONDS);
      if (round > FAILED_RETRY_MAX_ROUNDS) {
        if (round === FAILED_RETRY_MAX_ROUNDS + 1) {
          console.error(`[requeue-failed-webhooks] GAVE UP on event ${eventId} for good after ${FAILED_RETRY_MAX_ROUNDS} more rounds`);
        }
        continue;
      }

      // The failed job is still stored in the queue under the same job id. Remove it first,
      // or adding the job again would do nothing.
      await webhookQueue.remove(webhookJobId(eventId));
      await enqueueWebhookEvent(eventId);
      console.log(`[requeue-failed-webhooks] event ${eventId} queued again (round ${round} of ${FAILED_RETRY_MAX_ROUNDS})`);
    } catch (err) {
      console.error(`[requeue-failed-webhooks] failed to queue event ${eventId} again:`, err);
    }
  }
}

export function scheduleRequeueStuckWebhooksJob(): CronJob {
  return CronJob.from({
    cronTime: '*/2 * * * *',
    onTick: async () => {
      await requeueStuckWebhooks();
      await requeueFailedWebhooks();
    },
    start: true,
    waitForCompletion: true, // stop() waits for a run that is busy right now
    errorHandler: (err) => {
      console.error('[requeue-stuck-webhooks] job crashed:', err);
    },
  });
}