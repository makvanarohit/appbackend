import { Router, text } from 'express';
import { handleWebhook } from '../controllers/webhook.controller';

const router = Router();

// The biggest webhook body we accept. Express only accepts 100 KB by default, and a bigger
// body is refused with 413. That is bad for two reasons: Shopify sees an error, and a refused
// request counts as a FAILED request in the webhook rate limit (see middleware/rate-limit.ts).
// Order webhooks can be big when they have many line items (use include_fields to keep them small).
const WEBHOOK_BODY_LIMIT = '5mb';

// text({ type: '*/*' }) keeps the body as the raw string Shopify signed.
// Never put express.json() in front of this route.
router.post('/', text({ type: '*/*', limit: WEBHOOK_BODY_LIMIT }), handleWebhook);

export default router;