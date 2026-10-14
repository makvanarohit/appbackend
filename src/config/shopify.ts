import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion, LogSeverity } from '@shopify/shopify-api';
import { env } from './env';

export const shopify = shopifyApi({
    apiKey: env.shopifyClientId,
    apiSecretKey: env.shopifyClientSecret,
    hostName: env.appHost,
    apiVersion: ApiVersion.July26,
    isEmbeddedApp: true,
    logger: {
        level: env.isProduction ? LogSeverity.Error : LogSeverity.Info,
    },
});