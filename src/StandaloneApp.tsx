// ============================================
// StandaloneApp
// Entry point for standalone/local-development mode (see
// src/lib/environment.ts and App.tsx for how this is
// selected). Shows StoreConnect until a store is connected,
// then the same routes the embedded app uses, wrapped in
// StandaloneLayout (header + inline nav + save bar pill)
// instead of <s-app-nav> / <ui-save-bar>.
//
// The connected store name is persisted to localStorage so
// it survives a page reload during local development — this
// is a real browser running outside Claude's artifact sandbox,
// so localStorage is fine to use here.
// ============================================

import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { StandaloneSaveBarProvider } from '@/contexts/StandaloneSaveBarProvider';
import StandaloneLayout from '@/components/StandaloneLayout';
import StoreConnect from '@/pages/StoreConnect';
import AppRoutes from '@/router/AppRoutes';

const STORAGE_KEY = 'standalone-store-name';

const StandaloneApp = () => {
  const [storeName, setStoreName] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );

  if (!storeName) {
    return (
      <StoreConnect
        onConnected={(name) => {
          localStorage.setItem(STORAGE_KEY, name);
          setStoreName(name);
        }}
      />
    );
  }

  return (
    <BrowserRouter>
      <StandaloneSaveBarProvider>
        <StandaloneLayout
          onDisconnect={() => {
            localStorage.removeItem(STORAGE_KEY);
            setStoreName(null);
          }}
        >
          <AppRoutes />
        </StandaloneLayout>
      </StandaloneSaveBarProvider>
    </BrowserRouter>
  );
};

export default StandaloneApp;
