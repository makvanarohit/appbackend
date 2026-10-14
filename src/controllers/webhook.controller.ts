import type { Request, Response } from 'express';
import { shopify } from '../config/shopify';
import { recordWebhook } from '../services/webhook.service';
import { enqueueWebhookEvent } from '../queues/webhook.queue';

export async function handleWebhook(req: Request, res: Response): Promise<void> {
    const rawBody = req.body as string;

    const validation = await shopify.webhooks.validate({
        rawBody,
        rawRequest: req,
        rawResponse: res,
    });

    if (!validation.valid) {
        res.status(401).json({ error: 'Invalid webhook', reason: validation.reason });
        return;
    }

    let payload: unknown;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        res.status(400).json({ error: 'Malformed JSON body' });
        return;
    }
    // X-Shopify-Triggered-At is an RFC 3339 timestamp.
    const triggeredAtHeader = req.get('X-Shopify-Triggered-At');
    const triggeredAt = triggeredAtHeader ? new Date(triggeredAtHeader) : null;
    // 1. Save first. If this fails we answer 500, so Shopify retries later.
    let eventId: number | null;
    try {
        eventId = await recordWebhook({
            webhookId: validation.webhookId,
            topic: validation.topic,
            shopDomain: validation.domain,
            payload,
            triggeredAt,
        });
    } catch (err) {
        console.error('Failed to record webhook:', err);
        res.status(500).json({ error: 'Could not record webhook' });
        return;
    }

    // 2. Acknowledge. The event is safely stored, so Shopify can stop retrying.
    res.status(200).json({ received: true });

    // 3. Add a job to the line. A worker (a separate part of the app) will
    // pick it up and do the real work. We don't wait for it here.
    if (eventId !== null) {
        try {
            await enqueueWebhookEvent(eventId);
        } catch (err) {
            // We already answered Shopify 200, so this can't change the HTTP
            // response — but the row is safely sitting in MySQL either way, so
            // nothing is lost. Logged so you can see it happened.
            console.error(`Failed to queue webhook event ${eventId}:`, err);
        }
    }
}