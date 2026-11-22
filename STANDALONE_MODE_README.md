# Standalone mode — what it is, and how to remove it

Standalone mode lets this app run outside the Shopify admin (local
development, previewing UI without a real store, etc). It shows a
store-connect screen, then the same routes the embedded app uses, with a
custom sidebar and save bar standing in for the admin chrome that
doesn't exist outside the real iframe.

Every place it touches shared code is wrapped in a
`// ===== STANDALONE MODE ===== ... // ===== END STANDALONE MODE =====`
comment block, so you can find and delete it without hunting.

## Running it

- `npm run dev:local` — forces standalone mode on via `.env.standalone`
  (sets `VITE_FORCE_STANDALONE=true`). This is the reliable way to reach
  it during local development.
- `npm run dev` and open the URL directly (not through the Shopify
  iframe) also lands in standalone mode automatically — there's no
  `host` query param for `isEmbedded()` to find. `dev:local` exists so
  you don't have to rely on that implicitly.

## If you want to disable it without deleting anything

Open `src/lib/environment.ts` and make `isEmbedded()` always return
`true`. Every branch in the app checks that one function, so this is
the single fastest way to turn standalone mode off.

## If you want to remove it entirely

**Delete these files outright** (nothing else references them once the
steps below are done):

- `src/lib/environment.ts`
- `src/lib/shopifyBridge.ts`
- `src/StandaloneApp.tsx`
- `src/pages/StoreConnect.tsx`
- `src/components/StandaloneHeader.tsx` (contains the inline nav and
  renders `<StandaloneSaveBar />` itself, as a compact pill — not a
  separate row — see that file's own comments)
- `src/components/StandaloneSaveBar.tsx`
- `src/components/StandaloneLayout.tsx`
- `src/contexts/standaloneSaveBarContext.ts`
- `src/contexts/StandaloneSaveBarProvider.tsx`
- `.env.standalone`

**Edit these files** — remove everything between the `STANDALONE MODE`
comment markers (imports included), keeping only the embedded-mode code
that was outside the markers:

- `src/App.tsx` — removes the standalone branch; `App` just returns the
  `AppBridgeProvider`/`AppRouter` tree unconditionally.
- `src/hooks/useSaveBar.ts` — removes the `standalone` context read and
  every `else` branch; each `if (isEmbedded())` body becomes
  unconditional. The `enabled` option can stay either way — it's just a
  generic escape hatch, not standalone-specific.
- `src/hooks/useSafeNavigate.ts` — same pattern as above.
- `src/components/SaveBar.tsx` — removes the early return; it always
  renders `<ui-save-bar>`.
- `src/pages/Home.tsx` — removes the effect's early return and the
  standalone placeholder render.
- `src/pages/Settings.tsx` and `src/pages/AdvancedSettings.tsx` — these
  aren't wrapped in comment markers (the branching is small and mixed
  into JSX attributes, not separable blocks), but both have the same
  shape: `data-save-bar` only works when embedded, so `data-save-bar={...}`
  is conditional and each form also runs `useSaveBar({ ..., enabled:
  !isEmbedded() })` as the standalone fallback. To simplify once
  standalone mode is gone: drop the `enabled` option (or set it to
  `true`) and hardcode `data-save-bar` back to always-on. This is also
  the fix for the actual bug that prompted it — `data-save-bar` has no
  admin chrome to hook into outside the embedded app, and was falling
  back to a native browser confirmation popover instead of showing
  anything useful.

**Optional, not required for removal to work correctly:**

- `src/index.css` has a `standalone-save-bar-shake` keyframe block
  (marked with the same comment convention) used when a navigation
  attempt is blocked by unsaved changes. Safe to delete along with
  everything else once `StandaloneSaveBar.tsx` is gone.
- `src/pages/Settings.tsx` and `src/pages/AdvancedSettings.tsx` use
  `showToast()` from `shopifyBridge.ts` instead of calling
  `window.shopify.toast.show()` directly. If you delete
  `shopifyBridge.ts`, swap these back to the direct call — they're
  otherwise unrelated to standalone mode (it's just a safety wrapper).
- `package.json`'s `dev:local` script and the `.env.standalone` gitignore
  entry can be removed too, though leaving them is harmless if the
  files above are already gone (the script will just fail to find
  `.env.standalone`).

## Files that were never touched

`AppRoutes.tsx`, `AppRouter.tsx`, `AppBridgeProvider.tsx`, and every
hook/page not listed above are exactly as they were before standalone
mode existed — the shared route list, the embedded provider, and
`useAppBridgeConfig`/`useAuthenticatedFetch` don't know standalone mode
exists at all.
