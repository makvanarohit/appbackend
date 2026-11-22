import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import useSafeNavigate from '@/hooks/useSafeNavigate';
import StandaloneSaveBar from '@/components/StandaloneSaveBar';

interface StandaloneLayoutProps {
  onDisconnect: () => void;
  children: ReactNode;
}

const NAV_ITEMS = [
  { label: 'Home', path: '/', icon: 'home' },
  { label: 'Settings', path: '/settings', icon: 'settings' },
] as const;

const MOBILE_NAV_POPOVER_ID = 'standalone-mobile-navigation';

const StandaloneLayout = ({ onDisconnect, children }: StandaloneLayoutProps) => {
  const location = useLocation();
  const safeNavigate = useSafeNavigate();

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar" aria-label="App navigation">
        <s-box padding="base">
          <s-stack gap="small-200">
            <s-text type="strong">My Shopify App</s-text>
            <s-divider />
            {NAV_ITEMS.map((item) => {
              const active = location.pathname === item.path;
              return (
                <s-button
                  key={item.path}
                  variant={active ? 'primary' : 'tertiary'}
                  // inlineSize='fill'
                  onClick={() => safeNavigate(item.path)}
                  accessibilityLabel={item.label}
                  icon={item?.icon}
                >
                  {item.label}
                </s-button>
              );
            })}
          </s-stack>
        </s-box>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar-start">
            <s-button
              variant="tertiary"
              commandFor={MOBILE_NAV_POPOVER_ID}
              accessibilityLabel="Open navigation menu"
              icon="menu"
            >
            </s-button>
            <s-text type="strong">
              My Shopify App
            </s-text>

            <s-popover id={MOBILE_NAV_POPOVER_ID} inlineSize="120px">
              <s-box padding="small-200">
                <s-stack gap="small-200">
                  {NAV_ITEMS.map((item) => {
                    const active = location.pathname === item.path;
                    return (
                      <s-button
                        key={item.path}
                        variant={active ? 'primary' : 'tertiary'}
                        commandFor={MOBILE_NAV_POPOVER_ID}
                        command="--hide"
                        onClick={() => safeNavigate(item.path)}
                        accessibilityLabel={item.label}
                        icon={item?.icon}
                      >
                        {item.label}
                      </s-button>
                    );
                  })}
                </s-stack>
              </s-box>
            </s-popover>
          </div>

          <StandaloneSaveBar />

          <div className="admin-topbar-actions">
            <s-button icon="exit" variant="tertiary" tone="critical" onClick={onDisconnect}>
              Logout
            </s-button>
          </div>
        </header>

        <main className="admin-page-content">{children}</main>
      </div>
    </div>
  );
};

export default StandaloneLayout;
