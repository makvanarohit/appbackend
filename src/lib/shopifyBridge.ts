// ============================================
// Safe App Bridge helpers
//
// window.shopify only exists when the app is actually
// embedded in the Shopify admin — calling window.shopify.*
// directly will throw in standalone/local development. These
// wrappers check first and fall back to something reasonable
// (a console log) so pages that call toast/loading don't need
// to know or care which mode they're running in.
//
// The save bar has its own equivalent — see useSaveBar.ts and
// useSafeNavigate.ts, which route through StandaloneSaveBarContext
// instead of a no-op, since "show unsaved changes" is one of the
// things standalone mode explicitly needs to support.
// ============================================

import { isEmbedded } from '@/lib/environment';

export const showToast = (message: string, options?: { isError?: boolean }) => {
  if (isEmbedded() && window.shopify) {
    window.shopify.toast.show(message, options);
    return;
  }
  if (options?.isError) {
    console.error(`[toast] ${message}`);
  } else {
    console.log(`[toast] ${message}`);
  }
};

export const setLoading = (loading: boolean) => {
  if (isEmbedded() && window.shopify) {
    window.shopify.loading(loading);
  }
  // No standalone equivalent (no admin chrome to show a loading bar in) —
  // silently a no-op there.
};
