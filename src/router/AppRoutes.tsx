// ============================================
// AppRoutes
// The actual <Route> definitions, shared between the
// embedded router (AppRouter.tsx, which wraps this with
// <s-app-nav>) and standalone mode (StandaloneApp.tsx,
// which wraps this with StandaloneSidebar instead). Neither
// wrapper duplicates the route list — this is the one
// source of truth for it. Must be rendered inside a
// <BrowserRouter> by the caller.
// ============================================

import { Routes, Route } from 'react-router-dom';
import Home from '@/pages/Home';
import Settings from '@/pages/Settings';
import AdvancedSettings from '@/pages/AdvancedSettings';
import NotFound from '@/pages/NotFound';

const AppRoutes = () => {
  return (
    <Routes>
      {/* Main dashboard */}
      <Route path="/" element={<Home />} />

      <Route path="/settings" element={<Settings />} />
      <Route path="/settings/advanced" element={<AdvancedSettings />} />

      {/* 404 — must be last */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default AppRoutes;
