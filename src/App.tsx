// ============================================
// Root App Component
//
// No PolarisProvider here — Polaris web components
// need no context/i18n setup. They work as soon as
// the polaris.js CDN script (index.html) has loaded.
// ============================================

// ===== STANDALONE MODE: imports (see STANDALONE_MODE_README.md) =====
// To remove standalone mode entirely: delete this import, delete the
// `if (!isEmbedded())` block below, and delete src/lib/environment.ts,
// src/StandaloneApp.tsx, and everything else STANDALONE_MODE_README.md
// lists.
import { isEmbedded } from '@/lib/environment';
import StandaloneApp from '@/StandaloneApp';
// ===== END STANDALONE MODE: imports =====

import AppBridgeProvider from '@/providers/AppBridgeProvider';
import AppRouter from '@/router/AppRouter';

const App = () => {
  // ===== STANDALONE MODE: branch =====
  if (!isEmbedded()) {
    return <StandaloneApp />;
  }
  // ===== END STANDALONE MODE: branch =====

  return (
    <AppBridgeProvider>
      <AppRouter />
    </AppBridgeProvider>
  );
};

export default App;
