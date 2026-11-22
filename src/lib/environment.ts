// ============================================
// Embedding detection
//
// Two ways this resolves to standalone mode:
//
// 1. Explicit: `npm run dev:local` sets VITE_FORCE_STANDALONE=true
//    (via .env.standalone) — this is the reliable one to reach for
//    during local development.
// 2. Automatic fallback: Shopify always appends a `host` query
//    parameter when it loads your app inside the admin iframe —
//    the standard signal every Shopify app template uses to detect
//    embedding. If it's missing (e.g. you opened the dev server URL
//    directly in a browser tab), that's treated as standalone too.
//
// Either way, window.shopify / App Bridge won't be available — see
// STANDALONE_MODE_README.md for how everything downstream of this
// function branches on it, and how to remove standalone mode
// entirely if you don't want it.
// ============================================

// Decided ONCE when the page loads. In-app navigation drops the ?host= query string,
// so checking it on every call would flip the app to standalone after the first click.
const embedded =
  import.meta.env.VITE_FORCE_STANDALONE !== 'true' &&
  new URLSearchParams(window.location.search).has('host');

export const isEmbedded = (): boolean => embedded;
