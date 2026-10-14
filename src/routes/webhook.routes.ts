import { Router, text } from 'express';
import { handleWebhook } from '../controllers/webhook.controller';

const router = Router();

// The biggest webhook body we accept. Express only accepts 100 KB by default,
// and a bigger body is refused with 413, so Shopify sees an error and the event
// can be lost. Shopify does not publish a fixed maximum size (some bodies, like
// orders, can pass 1 MB). Our topics today are small. If you subscribe to big
// topics later, raise this value.
const WEBHOOK_BODY_LIMIT = '1mb';

// text({ type: '*/*' }) keeps the body as the raw string Shopify signed.
// Never put express.json() in front of this route.
router.post('/', text({ type: '*/*', limit: WEBHOOK_BODY_LIMIT }), handleWebhook);

export default router;