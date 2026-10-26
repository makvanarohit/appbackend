import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { env } from './config/env';
import routes from './routes';
import webhookRoutes from './routes/webhook.routes';
import { errorHandler } from './middleware/error-handler';
import { readiness } from './controllers/health.controller';
import { apiLimiter, webhookLimiter } from './middleware/rate-limit';

export function createApp() {
    const app = express();

    // Behind a load balancer or tunnel, the real client IP is in the X-Forwarded-For header.
    // We trust exactly TRUST_PROXY proxies (0 = none), so a client cannot fake its IP.
    app.set('trust proxy', env.trustProxy === 0 ? false : env.trustProxy);

    // Security headers. Shopify embeds the app in an iframe, so the default
    // "X-Frame-Options: SAMEORIGIN" would break it — we turn that off and
    // use the modern CSP `frame-ancestors` rule instead, allowing only
    // Shopify's admin to frame us.
    app.use(
        helmet({
            frameguard: false,
            contentSecurityPolicy: {
                directives: {
                    frameAncestors: ['https://admin.shopify.com', 'https://*.myshopify.com'],
                },
            },
        }),
    );

    // Log the path only. The query string can hold private data (for example the App Proxy
    // signature and logged_in_customer_id).
    morgan.token('path-only', (req) => ((req as { originalUrl?: string }).originalUrl ?? req.url ?? '').split('?')[0]);
    const logFormat =
        env.appEnv === 'local'
            ? ':method :path-only :status :response-time ms - :res[content-length]'
            : ':remote-addr - :remote-user [:date[clf]] ":method :path-only HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"';
    app.use(morgan(logFormat));
    app.use(compression());
    app.use(cors({ origin: env.corsOrigins }));

    // Webhooks come from Shopify, not from your frontend: they use their
    // own body format (raw text, for signature checks) and their own
    // authentication, so they live outside /api.
    app.use('/webhooks', webhookLimiter, webhookRoutes);

    // Liveness: the process is running. Never checks MySQL or Redis.
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });

    // Readiness: MySQL and Redis both answer. A load balancer should use this one.
    app.get('/ready', readiness);

    // Everything your frontend calls lives under /api. The JSON body parser
    // is scoped to /api only, so it can never touch the webhook route's
    // raw body, whatever order things are mounted in.
    app.use('/api', apiLimiter, express.json(), routes);

    app.use((_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    app.use(errorHandler);

    return app;
}

