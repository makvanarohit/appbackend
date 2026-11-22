// ============================================
// App Bridge Provider — v4
// No React Provider needed in v4!
// window.shopify is auto-injected by Shopify
// This component just validates the config
// and handles loading/error states
// ============================================

import type { ReactNode } from 'react';
import useAppBridgeConfig from '@/hooks/useAppBridgeConfig';
import LoadingScreen from '@/components/LoadingScreen';
import ErrorScreen from '@/components/ErrorScreen';

interface AppBridgeProviderProps {
    children: ReactNode;
}

const AppBridgeProvider = ({ children }: AppBridgeProviderProps) => {
    const { config, error, isLoading } = useAppBridgeConfig();

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (error || !config) {
        return <ErrorScreen message={error ?? 'Failed to initialize App Bridge'} />;
    }

    // No <Provider> wrapper needed in v4!
    // window.shopify handles everything
    return <>{children}</>;
};

export default AppBridgeProvider;
