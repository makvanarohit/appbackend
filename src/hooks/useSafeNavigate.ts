// ============================================
// useSafeNavigate
//
// Wraps react-router's navigate() with a leave-confirmation
// check, so programmatic navigation (nav menu clicks, "back"
// links, redirects, etc.) respects unsaved changes tracked by
// a save bar — whether it's a declarative data-save-bar form
// or a programmatic <ui-save-bar> (see Settings.tsx for both).
//
// Resolves immediately if no save bar is currently visible, so
// this behaves exactly like a plain navigate() call when
// there's nothing unsaved. If a save bar IS visible:
// - Embedded: window.shopify.saveBar.leaveConfirmation() prompts
//   the merchant with the option to leave anyway; navigate()
//   only runs if they confirm.
// - Standalone: there's no admin-native prompt to show, so this
//   shakes the bar instead and blocks — navigate() never runs
//   until the merchant explicitly Saves or Discards (see
//   StandaloneSaveBarProvider's leaveConfirmation).
//
// This only covers navigation triggered from your own code.
// It doesn't intercept the browser back/forward buttons or
// the native admin chrome (e.g. the app name link in the
// sidebar) — those aren't under app control.
// ============================================

import { useCallback, useContext } from 'react';
import { useNavigate, type NavigateOptions } from 'react-router-dom';
import { isEmbedded } from '@/lib/environment';
// ===== STANDALONE MODE (see STANDALONE_MODE_README.md) =====
import { StandaloneSaveBarContext } from '@/contexts/standaloneSaveBarContext';
// ===== END STANDALONE MODE =====

const useSafeNavigate = () => {
  const navigate = useNavigate();
  // ===== STANDALONE MODE =====
  // Present only in standalone mode (see useSaveBar.ts for why this is
  // read unconditionally rather than behind the isEmbedded() check). To
  // remove standalone mode: delete this line, delete the `else` branch
  // below, and delete this import.
  const standalone = useContext(StandaloneSaveBarContext);
  // ===== END STANDALONE MODE =====

  return useCallback(
    async (path: string, options?: NavigateOptions) => {
      if (isEmbedded()) {
        await window.shopify.saveBar.leaveConfirmation();
      } else {
        // ===== STANDALONE MODE =====
        await standalone?.leaveConfirmation();
        // ===== END STANDALONE MODE =====
      }
      navigate(path, options);
    },
    [navigate, standalone]
  );
};

export default useSafeNavigate;
