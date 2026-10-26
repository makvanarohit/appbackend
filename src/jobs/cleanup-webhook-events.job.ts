import { CronJob } from 'cron';
import { deleteOldWebhookEvents } from '../repositories/store.repository';

// Finished events are only an audit trail, so they do not need to live long.
// Everything else (failed, and events that never finished) is kept longer.
const KEEP_COMPLETED_DAYS = 30;
const KEEP_OTHER_DAYS = 90;

export async function cleanupWebhookEvents(): Promise<void> {
    const deleted = await deleteOldWebhookEvents(KEEP_COMPLETED_DAYS, KEEP_OTHER_DAYS);

    const total = deleted.completed + deleted.failed + deleted.received + deleted.processing;
    if (total === 0) return;

    console.log(
        `[cleanup-webhook-events] deleted ${deleted.completed} completed, ${deleted.failed} failed, ` +
        `${deleted.received} received, ${deleted.processing} processing event(s)`,
    );

    // These were never finished. If one was a GDPR webhook (customers/redact,
    // shop/redact), that request was missed, so make this easy to notice.
    const unfinished = deleted.received + deleted.processing;
    if (unfinished > 0) {
        console.warn(
            `[cleanup-webhook-events] WARNING: ${unfinished} event(s) were never processed ` +
            `in ${KEEP_OTHER_DAYS} days and have now been deleted`,
        );
    }
}

export function scheduleCleanupWebhookEventsJob(): CronJob {
    return CronJob.from({
        cronTime: '0 4 * * *', // every day at 04:00, one hour after the token refresh job
        onTick: cleanupWebhookEvents,
        start: true,
        waitForCompletion: true, // stop() waits for a run that is busy right now
        errorHandler: (err) => {
            console.error('[cleanup-webhook-events] job crashed:', err);
        },
    });
}