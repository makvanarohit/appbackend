// ============================================
// StandaloneSaveBar
//
// Visual stand-in for Shopify's own save bar, used only in
// standalone mode (there is no embedded Shopify Admin chrome
// to render the real save bar into). Polaris web components
// handle the content and controls; the outer wrapper provides
// responsive sizing and true horizontal centering in the header.
// ============================================

import { useStandaloneSaveBarContext } from '@/contexts/standaloneSaveBarContext';

const StandaloneSaveBar = () => {
  const { active, shaking, hide } = useStandaloneSaveBarContext();

  if (!active) return null;

  const handleDiscard = async () => {
    await active.onDiscard();
    hide(active.id);
  };

  const handleSave = async () => {
    await active.onSave();
    hide(active.id);
  };

  return (
    <div
      className={`standalone-save-bar-container${shaking ? ' standalone-save-bar-shake' : ''}`}
      aria-live="polite"
    >
      <s-box
        padding="small-200"
        border="base"
        inlineSize="100%"
        borderRadius="large"
        borderWidth="large"
        background="strong"
      >
        <s-stack
          direction="inline"
          alignItems="center"
          gap="small-100"
          justifyContent="space-between"
        >
          <s-stack
            direction="inline"
            alignItems="center"
            gap="small-100"
          >
            <s-icon type="alert-bubble" tone="auto" color="base" size="base" />
            <s-text type="strong">
              Unsaved changes
            </s-text>
          </s-stack>

          <s-stack
            direction="inline"
            alignItems="center"
            gap="small-100"
          >
            <s-button variant="secondary" tone="auto" onClick={handleDiscard}>
              Discard
            </s-button>
            <s-button variant="primary" tone="auto" onClick={handleSave}>
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </s-box>
    </div>
  );
};

export default StandaloneSaveBar;

