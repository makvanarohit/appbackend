// ============================================
// StandaloneHeader
//
// Visual stand-in for the Shopify admin's own top bar, used
// only in standalone mode (see StandaloneLayout — there's no
// admin chrome to render into outside the embedded app).
//
// Deliberately minimal: just the inline nav routes and the
// save bar (StandaloneSaveBar renders as a compact pill here,
// only when there are unsaved changes — see that file). No
// logo, search, or notifications.
//
// A plain "Disconnect" text link sits at the far right — not
// part of the requested layout, but kept since it's the only
// way to clear the connected store without touching
// localStorage by hand. Remove it if you don't want it.
//
// Deliberately custom HTML/CSS, not Polaris web components —
// same reasoning as StandaloneSaveBar.tsx: this is a dark
// inverse-themed chrome bar, and Polaris component tones are
// all light/semantic with no override mechanism, so there's
// no way to reproduce this look with Polaris components.
// ============================================

// import { useLocation } from 'react-router-dom';
// import useSafeNavigate from '@/hooks/useSafeNavigate';
// import StandaloneSaveBar from '@/components/StandaloneSaveBar';

// interface NavItem {
//   label: string;
//   path: string;
// }

// const NAV_ITEMS: NavItem[] = [
//   { label: 'Dashboard', path: '/' },
//   { label: 'Settings', path: '/settings' },
// ];

// interface StandaloneHeaderProps {
//   onDisconnect: () => void;
// }

// const StandaloneHeader = ({ onDisconnect }: StandaloneHeaderProps) => {
//   const location = useLocation();
//   const safeNavigate = useSafeNavigate();

//   return (
//     <div
//       style={{
//         display: 'flex',
//         alignItems: 'center',
//         gap: '16px',
//         padding: '10px 20px',
//         background: '#1a1a1a',
//         color: '#ffffff',
//         fontFamily: 'system-ui, -apple-system, sans-serif',
//         flexShrink: 0,
//       }}
//     >
//       <nav style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
//         {NAV_ITEMS.map((item) => {
//           const isActive = location.pathname === item.path;
//           return (
//             <a
//               key={item.path}
//               href={item.path}
//               onClick={(event) => {
//                 event.preventDefault();
//                 safeNavigate(item.path);
//               }}
//               style={{
//                 padding: '6px 12px',
//                 borderRadius: '8px',
//                 background: isActive ? 'rgba(255,255,255,0.12)' : 'transparent',
//                 color: isActive ? '#ffffff' : 'rgba(255,255,255,0.7)',
//                 fontSize: '14px',
//                 fontWeight: isActive ? 600 : 400,
//                 textDecoration: 'none',
//               }}
//             >
//               {item.label}
//             </a>
//           );
//         })}
//       </nav>

//       <div style={{ flex: 1 }} />

//       <StandaloneSaveBar />

//       <button
//         type="button"
//         onClick={onDisconnect}
//         style={{
//           border: 'none',
//           background: 'transparent',
//           color: 'rgba(255,255,255,0.55)',
//           fontSize: '13px',
//           cursor: 'pointer',
//           flexShrink: 0,
//         }}
//       >
//         Disconnect
//       </button>
//     </div>
//   );
// };

// export default StandaloneHeader;
import { useLocation } from 'react-router-dom';
import useSafeNavigate from '@/hooks/useSafeNavigate';
import StandaloneSaveBar from '@/components/StandaloneSaveBar';

interface NavItem {
  label: string;
  path: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', path: '/' },
  { label: 'Settings', path: '/settings' },
];

interface StandaloneHeaderProps {
  onDisconnect: () => void;
}

const StandaloneHeader = ({ onDisconnect }: StandaloneHeaderProps) => {
  const location = useLocation();
  const safeNavigate = useSafeNavigate();

  return (
    <s-box padding="small-200" background="strong" borderRadius='large'>
      <s-stack direction="inline" alignItems="center" gap="base" justifyContent='space-between'>
        <s-stack direction="inline" alignItems="center" gap="small-200">
          {NAV_ITEMS.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <s-button
                key={item.path}
                variant={isActive ? "primary" : "tertiary"}
                // color={isActive ? "strong" : "subdued"}
                accessibilityLabel={item.label}
                onClick={(event) => {
                  event.preventDefault();
                  safeNavigate(item.path);
                }}
              >
                {item.label}
              </s-button>
            );
          })}
        </s-stack>

        <StandaloneSaveBar />

        <s-button variant="tertiary" tone="critical" onClick={onDisconnect}>
          Disconnect
        </s-button>
      </s-stack>
    </s-box>
  );
};

export default StandaloneHeader;