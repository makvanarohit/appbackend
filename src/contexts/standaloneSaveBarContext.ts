// ============================================
// StandaloneSaveBarContext (definition)
//
// Split from the Provider component (StandaloneSaveBarProvider.tsx)
// because mixing component and non-component exports in one file
// breaks Vite's Fast Refresh.
//
// Embedded mode has a real save bar to delegate to
// (window.shopify.saveBar + <ui-save-bar>). Standalone mode has
// neither — there's no admin chrome to render into — so the
// Provider tracks the same show/hide state itself and renders our
// own bar (see StandaloneSaveBar.tsx) at the layout level.
//
// Only one save bar is ever shown at a time here, which matches
// how the real one behaves too.
// ============================================

import { createContext, useContext } from 'react';

export interface ActiveSaveBar {
  id: string;
  onSave: () => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
}

export interface StandaloneSaveBarContextValue {
  active: ActiveSaveBar | null;
  /** True briefly after a blocked navigation attempt, so the bar can
   * play a shake animation to draw attention — see StandaloneSaveBar.tsx. */
  shaking: boolean;
  show: (bar: ActiveSaveBar) => void;
  hide: (id: string) => void;
  /** Resolves immediately if nothing is active. If there ARE unsaved
   * changes, this triggers a shake on the bar and never resolves —
   * there's no "leave anyway" escape hatch, same as the real Shopify
   * admin's save bar: the merchant has to explicitly Save or Discard
   * before navigation can proceed. */
  leaveConfirmation: () => Promise<void>;
}

export const StandaloneSaveBarContext = createContext<StandaloneSaveBarContextValue | null>(null);

/** Strict accessor for components that only ever render inside the
 * provider (e.g. StandaloneSaveBar). Hooks that must also work in
 * embedded mode (useSaveBar, useSafeNavigate) use useContext directly
 * instead, since there's no provider in that tree. */
export const useStandaloneSaveBarContext = () => {
  const context = useContext(StandaloneSaveBarContext);
  if (!context) {
    throw new Error('useStandaloneSaveBarContext must be used within a StandaloneSaveBarProvider');
  }
  return context;
};
