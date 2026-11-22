// ============================================
// SaveBar
// Renders the <ui-save-bar> element for the programmatic
// method. Pair with useSaveBar — it drives show()/hide(),
// this just renders the Save/Discard buttons consistently.
//
// Only renders anything when embedded. In standalone mode
// there's no admin chrome for <ui-save-bar> to hook into —
// useSaveBar drives StandaloneSaveBarContext instead, and
// StandaloneSaveBar (rendered once by the standalone layout)
// is what actually shows the bar there. This component still
// gets used the same way on every page either way; it's just
// a no-op when standalone.
// ============================================

import { isEmbedded } from '@/lib/environment';

interface SaveBarProps {
  id: string;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
  discardLabel?: string;
}

const SaveBar = ({ id, onSave, onDiscard, saveLabel = 'Save', discardLabel = 'Discard' }: SaveBarProps) => {
  // ===== STANDALONE MODE (see STANDALONE_MODE_README.md) =====
  // To remove standalone mode: delete this line (and the isEmbedded import
  // above) so this component always renders <ui-save-bar>.
  if (!isEmbedded()) return null;
  // ===== END STANDALONE MODE =====

  return (
    <ui-save-bar id={id}>
      <button variant="primary" onClick={onSave}>
        {saveLabel}
      </button>
      <button onClick={onDiscard}>{discardLabel}</button>
    </ui-save-bar>
  );
};

export default SaveBar;
