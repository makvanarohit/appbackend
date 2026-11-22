// ============================================
// Advanced Settings
//
// This route is loaded inside an <s-app-window> (see the
// "Advanced configuration" button in Settings.tsx), in its
// own iframe — NOT rendered inline the way a modal's content
// is. Because it's a genuine separate page load, data-save-bar
// works exactly the same way here as it does on any normal
// page when embedded. Compare with the modal in Settings.tsx,
// which can't use data-save-bar at all, embedded or not.
//
// The exit control in the top bar is provided automatically
// by the Shopify admin — no close button needed here.
//
// This route is also reachable directly by URL in standalone
// mode (there's no app-window concept there, it just renders
// inside the normal sidebar layout) — data-save-bar has no
// admin chrome to hook into in that case, so this falls back
// to useSaveBar there too, same as Settings.tsx's "Store
// preferences" section.
// ============================================

import useSaveBar from '@/hooks/useSaveBar';
import { showToast } from '@/lib/shopifyBridge';
import { isEmbedded } from '@/lib/environment';

const ADVANCED_SETTINGS_SAVE_BAR_ID = 'advanced-settings-save-bar';

const AdvancedSettings = () => {
  const saveConfig = async () => {
    const form = formRef.current;
    if (!form) return;
    const data = Object.fromEntries(new FormData(form));
    // Persist `data` to your backend here.
    console.log('Saving advanced configuration', data);
    showToast('Advanced configuration saved');
  };

  const discardConfig = () => {
    formRef.current?.reset();
  };

  // enabled: !isEmbedded() — same pattern as Settings.tsx's "Store
  // preferences": data-save-bar owns this when embedded, useSaveBar
  // takes over only in standalone mode. containerRef is safe to attach
  // either way.
  const { containerRef: formRef } = useSaveBar<HTMLFormElement>({
    id: ADVANCED_SETTINGS_SAVE_BAR_ID,
    onSave: saveConfig,
    onDiscard: discardConfig,
    enabled: !isEmbedded(),
  });

  return (
    <s-page heading="Advanced configuration">
      <s-section heading="Webhooks">
        <form
          ref={formRef}
          data-save-bar={isEmbedded() ? true : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            saveConfig();
          }}
          onReset={discardConfig}
        >
          <s-stack gap="base">
            <s-url-field
              label="Webhook URL"
              name="webhookUrl"
              placeholder="https://example.com/webhooks/orders"
            ></s-url-field>
            <s-number-field
              label="API rate limit (requests per minute)"
              name="rateLimit"
              value="60"
            ></s-number-field>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
};

export default AdvancedSettings;
