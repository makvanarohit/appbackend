// ============================================
// Settings Page
//
// Demonstrates all three save bar contexts side by side,
// so the difference is concrete rather than just described:
//
// 1. "Store preferences" below — a plain page section.
//    Embedded: uses the declarative `data-save-bar`
//    attribute, zero JS needed. Standalone: data-save-bar
//    has no admin chrome to hook into there — Shopify's own
//    JS was falling back to a native browser confirmation
//    popover instead of showing anything useful, so this
//    falls back to the same useSaveBar hook Quick Edit uses
//    below (see the `enabled` option on useSaveBar).
//
// 2. "Quick edit" — opens an <s-modal>. Per Shopify's docs,
//    data-save-bar isn't supported inside modals at all
//    (embedded or not), so this always uses the reusable
//    useSaveBar hook + <SaveBar> component instead (see
//    src/hooks/useSaveBar.ts) — the same programmatic
//    mechanism, packaged so it's not rewritten by hand every
//    time it's needed.
//
// 3. "Advanced configuration" — opens an <s-app-window>,
//    which loads AdvancedSettings.tsx as a *separate route*
//    in its own iframe (see src prop below). Because that's
//    a full page load rather than an inline overlay, it can
//    use declarative data-save-bar again when embedded — see
//    AdvancedSettings.tsx. (Same standalone caveat as #1
//    applies if that route is opened directly outside the
//    admin.)
// ============================================

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import useSaveBar from '@/hooks/useSaveBar';
import SaveBar from '@/components/SaveBar';
import { showToast } from '@/lib/shopifyBridge';
import { isEmbedded } from '@/lib/environment';

type FieldChangeEvent = Event & { currentTarget: HTMLElementTagNameMap['s-text-field'] };

const PREFERENCES_SAVE_BAR_ID = 'preferences-save-bar';
const QUICK_EDIT_SAVE_BAR_ID = 'quick-edit-save-bar';
const INITIAL_SUPPORT_EMAIL = 'support@example.com';

const Settings = () => {
  // ---------- 1. Store preferences ----------
  const savePreferences = async () => {
    const form = preferencesContainerRef.current;
    if (!form) return;
    const data = Object.fromEntries(new FormData(form));
    // Persist `data` to your backend here.
    console.log('Saving preferences', data);
    showToast('Preferences saved');
  };

  const discardPreferences = () => {
    preferencesContainerRef.current?.reset();
    showToast('Changes discarded');
  };

  const handlePreferencesSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    savePreferences();
  };

  const handlePreferencesReset = () => {
    discardPreferences();
  };

  // enabled: !isEmbedded() — when embedded, data-save-bar (below) already
  // owns this form's change-tracking, so this stays inert there and only
  // actually listens in standalone mode. containerRef is still safe to
  // attach either way (see useSaveBar's `enabled` option).
  const { containerRef: preferencesContainerRef } = useSaveBar<HTMLFormElement>({
    id: PREFERENCES_SAVE_BAR_ID,
    onSave: savePreferences,
    onDiscard: discardPreferences,
    enabled: !isEmbedded(),
  });

  // ---------- 2. Quick edit modal: useSaveBar (programmatic, reusable) ----------
  const modalRef = useRef<HTMLElementTagNameMap['s-modal']>(null);
  // Seeded from the same constant as state below, rather than read from
  // each other, so neither reads a ref's .current during render.
  const savedEmailRef = useRef(INITIAL_SUPPORT_EMAIL);
  const [supportEmail, setSupportEmail] = useState(INITIAL_SUPPORT_EMAIL);

  const {
    containerRef: quickEditContainerRef,
    save: saveQuickEdit,
    discard: discardQuickEdit,
  } = useSaveBar({
    id: QUICK_EDIT_SAVE_BAR_ID,
    onSave: async () => {
      // Persist `supportEmail` to your backend here.
      savedEmailRef.current = supportEmail;
      showToast('Support email updated');
      modalRef.current?.hideOverlay();
    },
    onDiscard: () => {
      setSupportEmail(savedEmailRef.current);
    },
  });

  // Keeps the controlled field in sync. Dirty-tracking and showing the
  // save bar happen independently, inside useSaveBar's own event listener
  // on the container below — this only needs to update React state.
  const handleQuickEditInput = (event: FieldChangeEvent) => {
    setSupportEmail(event.currentTarget.value ?? '');
  };

  const handleQuickEditCancel = async () => {
    await discardQuickEdit();
    modalRef.current?.hideOverlay();
  };

  return (
    <s-page heading="Settings">
      <s-section heading="Store preferences">
        <s-stack gap="base">
          <s-text color="subdued">
            {isEmbedded()
              ? 'A plain form on the page. Add data-save-bar to the form element and the save bar appears automatically whenever a field changes.'
              : "data-save-bar only works inside the real Shopify admin — standalone mode falls back to the same useSaveBar hook Quick Edit uses below."}
          </s-text>
          <form
            ref={preferencesContainerRef}
            data-save-bar={isEmbedded() ? true : undefined}
            onSubmit={handlePreferencesSubmit}
            onReset={handlePreferencesReset}
          >
            <s-stack gap="base">
              <s-text-field
                label="Storefront announcement"
                name="announcement"
                placeholder="e.g. Free shipping over $50"
              ></s-text-field>
              <s-checkbox label="Notify me about new orders" name="orderNotifications"></s-checkbox>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section heading="Quick edit (modal)">
        <s-stack gap="base">
          <s-text color="subdued">
            Opens in a modal. data-save-bar doesn't work inside modals, so this uses the
            useSaveBar hook instead — the same show()/hide() mechanism, reused rather
            than rewritten.
          </s-text>
          <s-button commandFor="quick-edit-modal" command="--show">
            Edit support email
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Advanced configuration (app window)">
        <s-stack gap="base">
          <s-text color="subdued">
            Opens a separate full-screen route in its own iframe. Because that's a full
            page load rather than an inline overlay, it can use data-save-bar again —
            see AdvancedSettings.tsx.
          </s-text>
          <s-button commandFor="advanced-window" command="--show">
            Open advanced configuration
          </s-button>
        </s-stack>
      </s-section>

      <s-app-window id="advanced-window" src="/settings/advanced"></s-app-window>

      <s-modal
        ref={modalRef}
        id="quick-edit-modal"
        heading="Quick edit"
        accessibilityLabel="Quick edit support email"
      >
        {/* containerRef listens for native input/change events bubbling
            from any field inside it — no per-field wiring needed beyond
            keeping the controlled value in sync above. */}
        <div ref={quickEditContainerRef}>
          <s-text-field
            label="Support email"
            name="supportEmail"
            value={supportEmail}
            onInput={handleQuickEditInput}
          ></s-text-field>
        </div>

        <s-button slot="secondary-actions" onClick={handleQuickEditCancel}>
          Cancel
        </s-button>
      </s-modal>

      {/* Lives at the page level (not inside the modal) — it's the same
          persistent bar the admin shows for data-save-bar forms, just
          driven programmatically here via useSaveBar. */}
      <SaveBar id={QUICK_EDIT_SAVE_BAR_ID} onSave={saveQuickEdit} onDiscard={discardQuickEdit} />
    </s-page>
  );
};

export default Settings;
