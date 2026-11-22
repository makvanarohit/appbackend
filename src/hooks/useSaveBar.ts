// ============================================
// useSaveBar
//
// A reusable version of the PROGRAMMATIC save bar method —
// the one that works everywhere: plain pages, modals, and
// app-window content alike. (data-save-bar is simpler when
// it applies, but it only works on a real <form> that isn't
// inside a modal, and only when embedded in the Shopify admin
// — see Settings.tsx for both side by side.)
//
// Mode-aware: when embedded, this drives window.shopify.saveBar
// and the real <ui-save-bar> (rendered by <SaveBar>, which is
// itself mode-aware). When running standalone (no admin chrome
// to render into), it drives StandaloneSaveBarContext instead,
// which renders our own bar via <StandaloneSaveBar>. Callers
// don't need to know or care which mode is active.
//
// Attach the returned `containerRef` to whatever wraps your
// fields (a <div>, or a <form> if you don't need one — plain
// <div> is used here to avoid a <form>'s native
// submit-on-Enter behavior, which isn't wanted inside a
// modal). This listens for the same native input/change
// events data-save-bar listens for internally, so field
// components (s-text-field, s-checkbox, etc.) don't need any
// per-field wiring — just render them inside the container.
//
// Usage:
//   const saveBar = useSaveBar({
//     id: 'my-save-bar',
//     onSave: async () => { ...persist...; },
//     onDiscard: () => { ...reset local state...; },
//   });
//
//   <div ref={saveBar.containerRef}>
//     <s-text-field ... />
//   </div>
//   <SaveBar id="my-save-bar" onSave={saveBar.save} onDiscard={saveBar.discard} />
// ============================================

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { isEmbedded } from '@/lib/environment';
// ===== STANDALONE MODE (see STANDALONE_MODE_README.md) =====
import { StandaloneSaveBarContext } from '@/contexts/standaloneSaveBarContext';
// ===== END STANDALONE MODE =====

interface UseSaveBarOptions {
  /** Unique id for this save bar instance — must match the <SaveBar id> below. */
  id: string;
  /** Called when the merchant clicks Save. */
  onSave: () => void | Promise<void>;
  /** Called when the merchant clicks Discard. Use this to reset your
   * fields back to their last-saved values. */
  onDiscard?: () => void | Promise<void>;
  /** Set to false to disable change-tracking for this instance without
   * unmounting it — e.g. when data-save-bar is already handling the
   * embedded case and you only want this hook active for standalone
   * mode (see Settings.tsx's "Store preferences" section). The
   * containerRef is still safe to attach either way; it just won't
   * listen for anything while disabled. Defaults to true. */
  enabled?: boolean;
}

const useSaveBar = <T extends HTMLElement = HTMLDivElement>({
  id,
  onSave,
  onDiscard,
  enabled = true,
}: UseSaveBarOptions) => {
  const [isDirty, setIsDirty] = useState(false);
  const containerRef = useRef<T>(null);
  // ===== STANDALONE MODE =====
  // Present only when rendered under StandaloneSaveBarProvider (standalone
  // mode). Reading it unconditionally keeps hook order stable; it's only
  // actually used below when !isEmbedded(). To remove standalone mode:
  // delete this line and every `else` branch below that references it,
  // leaving the isEmbedded() body unconditional.
  const standalone = useContext(StandaloneSaveBarContext);
  // ===== END STANDALONE MODE =====

  const save = useCallback(async () => {
    await onSave();
    setIsDirty(false);
    if (isEmbedded()) {
      await window.shopify.saveBar.hide(id);
    } else {
      // ===== STANDALONE MODE =====
      standalone?.hide(id);
      // ===== END STANDALONE MODE =====
    }
  }, [id, onSave, standalone]);

  const discard = useCallback(async () => {
    await onDiscard?.();
    setIsDirty(false);
    if (isEmbedded()) {
      await window.shopify.saveBar.hide(id);
    } else {
      // ===== STANDALONE MODE =====
      standalone?.hide(id);
      // ===== END STANDALONE MODE =====
    }
  }, [id, onDiscard, standalone]);

  useEffect(() => {
    if (!enabled) return;
    const node = containerRef.current;
    if (!node) return;

    const markDirty = () => {
      setIsDirty((wasDirty) => {
        if (!wasDirty) {
          if (isEmbedded()) {
            window.shopify.saveBar.show(id);
          } else {
            // ===== STANDALONE MODE =====
            standalone?.show({ id, onSave: save, onDiscard: discard });
            // ===== END STANDALONE MODE =====
          }
        }
        return true;
      });
    };

    // input covers text/number/etc fields as they're typed into;
    // change covers checkboxes, selects, and fields only committed on blur.
    node.addEventListener('input', markDirty);
    node.addEventListener('change', markDirty);
    return () => {
      node.removeEventListener('input', markDirty);
      node.removeEventListener('change', markDirty);
    };
  }, [id, save, discard, standalone, enabled]);

  return { containerRef, isDirty, save, discard };
};

export default useSaveBar;
