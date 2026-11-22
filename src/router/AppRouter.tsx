// ============================================
// App Router (embedded mode)
// Wraps the shared route list (AppRoutes.tsx) with the
// persistent app navigation menu (<s-app-nav>), declared
// once here so it doesn't need to be repeated on every page.
//
// Standalone mode uses StandaloneApp.tsx instead, which wraps
// the same AppRoutes with StandaloneSidebar rather than
// <s-app-nav> — see src/App.tsx for the branch between them.
//
// Home ("/") is already linked automatically via the app
// name in the sidebar, so it doesn't get its own <s-link> —
// see: https://shopify.dev/docs/api/app-home/app-bridge-web-components/app-nav
//
// "/settings/advanced" isn't in the nav on purpose — it's
// meant to be opened from the "Advanced configuration"
// button inside Settings via <s-app-window>, not navigated
// to directly from the sidebar.
// ============================================

import { BrowserRouter } from 'react-router-dom';
import useSafeNavigate from '@/hooks/useSafeNavigate';
import AppRoutes from '@/router/AppRoutes';

const AppNav = () => {
  const safeNavigate = useSafeNavigate();

  // href is kept for accessibility and middle-click/new-tab support, but
  // the click is intercepted so this stays an SPA navigation instead of a
  // full iframe reload. safeNavigate prompts to confirm first if there are
  // unsaved changes tracked by a save bar (see useSafeNavigate).
  const goTo = (path: string) => (event: Event) => {
    event.preventDefault();
    safeNavigate(path);
  };

  return (
    <s-app-nav>
      <s-link href="/settings" onClick={goTo('/settings')}>
        Settings
      </s-link>
    </s-app-nav>
  );
};

const AppRouter = () => {
  return (
    <BrowserRouter>
      <AppNav />
      <AppRoutes />
    </BrowserRouter>
  );
};

export default AppRouter;
