// ============================================
// JSX augmentation patch
//
// @shopify/app-bridge-types declares its elements
// (s-app-nav, s-app-window, ui-save-bar, ...) only on
// the legacy global JSX namespace, not on the react-jsx
// module namespace that React 19's automatic JSX runtime
// resolves against (the pattern @shopify/polaris-types
// uses for every <s-*> element). Until that's fixed
// upstream, this restores the ones this app actually uses,
// via the package's own exported attribute types.
// ============================================

import type { SAppNavAttributes, SAppWindowAttributes, UISaveBarAttributes } from '@shopify/app-bridge-types';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      's-app-nav': SAppNavAttributes;
      's-app-window': SAppWindowAttributes;
      'ui-save-bar': UISaveBarAttributes;
    }
  }
}
