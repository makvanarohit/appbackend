// ============================================
// Hook: useAppBridgeConfig
// App Bridge v4 — reads config from
// window.shopify.config (injected by Shopify)
// Falls back to URL params if needed
// ============================================

import { useState, useEffect } from 'react';

interface AppBridgeConfig {
    apiKey: string;
    host: string;
    shop: string;
    locale: string;
}

interface UseAppBridgeConfigResult {
    config: AppBridgeConfig | null;
    error: string | null;
    isLoading: boolean;
}

const useAppBridgeConfig = (): UseAppBridgeConfigResult => {
    const [config, setConfig] = useState<AppBridgeConfig | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    // One-time synchronous read of window.shopify.config on mount; App
    // Bridge doesn't emit a config-change event to subscribe to instead.
    useEffect(() => {
        try {
            const params = new URLSearchParams(window.location.search);

            // App Bridge v4 injects window.shopify.config
            // Use it if available, fall back to URL params
            const apiKey =
                window.shopify?.config?.apiKey ??
                import.meta.env.VITE_SHOPIFY_API_KEY;

            const host =
                window.shopify?.config?.host ??
                params.get('host');

            const shop =
                window.shopify?.config?.shop ??
                params.get('shop');

            const locale =
                window.shopify?.config?.locale ?? 'en';

            if (!apiKey) {
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setError('Missing API key — check VITE_SHOPIFY_API_KEY');
                setIsLoading(false);
                return;
            }

            if (!host) {
                setError('Missing host — open app from Shopify admin');
                setIsLoading(false);
                return;
            }

            if (!shop) {
                setError('Missing shop — open app from Shopify admin');
                setIsLoading(false);
                return;
            }

            setConfig({ apiKey, host, shop, locale });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to read App Bridge config';
            setError(message);
        } finally {
            setIsLoading(false);
        }
    }, []);

    return { config, error, isLoading };
};

export default useAppBridgeConfig;
