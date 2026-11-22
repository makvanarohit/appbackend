// ============================================
// StandaloneSaveBarProvider
// See standaloneSaveBarContext.ts for the context definition
// and why this is a separate file.
// ============================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { StandaloneSaveBarContext, type ActiveSaveBar } from '@/contexts/standaloneSaveBarContext';

const SHAKE_DURATION_MS = 500;

export const StandaloneSaveBarProvider = ({ children }: { children: ReactNode }) => {
  const [active, setActive] = useState<ActiveSaveBar | null>(null);
  const [shaking, setShaking] = useState(false);
  const shakeTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (shakeTimeoutRef.current !== null) {
        window.clearTimeout(shakeTimeoutRef.current);
      }
    };
  }, []);

  const show = useCallback((bar: ActiveSaveBar) => {
    setActive(bar);
  }, []);

  const hide = useCallback((id: string) => {
    setActive((current) => (current?.id === id ? null : current));
  }, []);

  const leaveConfirmation = useCallback(() => {
    return new Promise<void>((resolve) => {
      setActive((current) => {
        if (!current) {
          resolve();
          return current;
        }
        // Unsaved changes exist — shake the bar to draw attention and
        // block the navigation. This promise intentionally never
        // resolves; the merchant has to explicitly Save or Discard on
        // the bar itself (which calls hide()) before a retried
        // navigation can succeed.
        if (shakeTimeoutRef.current !== null) {
          window.clearTimeout(shakeTimeoutRef.current);
        }
        setShaking(true);
        shakeTimeoutRef.current = window.setTimeout(() => {
          setShaking(false);
        }, SHAKE_DURATION_MS);
        return current;
      });
    });
  }, []);

  const value = useMemo(
    () => ({ active, shaking, show, hide, leaveConfirmation }),
    [active, shaking, show, hide, leaveConfirmation],
  );

  return <StandaloneSaveBarContext.Provider value={value}>{children}</StandaloneSaveBarContext.Provider>;
};

export default StandaloneSaveBarProvider;
