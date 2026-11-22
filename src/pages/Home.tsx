// ============================================
// Home Page
// Built with Polaris web components:
// - <s-page> supplies the layout AND configures the
//   native admin title bar (heading + primary action)
//   in one declaration — no separate <ui-title-bar>
// - showToast/setLoading (src/lib/shopifyBridge.ts) wrap
//   window.shopify.toast/loading safely, since window.shopify
//   doesn't exist at all in standalone mode
//
// In standalone mode there's no session/idToken to call the
// real API with yet (see useAuthenticatedFetch — that's the
// next piece), so this skips the fetch entirely there and
// shows a placeholder instead of a real dashboard.
// ============================================

import { useCallback, useEffect, useState } from 'react';
import useAuthenticatedFetch from '@/hooks/useAuthenticatedFetch';
import { isEmbedded } from '@/lib/environment';
import { showToast, setLoading } from '@/lib/shopifyBridge';

interface ShopData {
  name: string;
  email: string;
  myshopifyDomain: string;
  plan: {
    displayName: string;
  };
}

const Home = () => {
  const { authenticatedFetch } = useAuthenticatedFetch();
  const [shopData, setShopData] = useState<ShopData | null>(null);
  const [isLoading, setIsLoading] = useState(isEmbedded());
  const [error, setError] = useState<string | null>(null);

  const fetchShopData = useCallback(async (signal?: AbortSignal) => {
    try {
      setIsLoading(true);
      setError(null);
      setLoading(true);

      const params = new URLSearchParams(window.location.search);
      const shop = params.get('shop');

      const response = await authenticatedFetch(`/api/shop?shop=${shop}`, { signal });

      if (!response.ok) {
        throw new Error('Failed to fetch shop data');
      }

      const data: ShopData = await response.json();
      if (signal?.aborted) return;
      setShopData(data);

      showToast('Shop data loaded successfully');
    } catch (err) {
      if (signal?.aborted) return;
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      showToast(message, { isError: true });
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
        setLoading(false);
      }
    }
  }, [authenticatedFetch]);

  useEffect(() => {
    // ===== STANDALONE MODE (see STANDALONE_MODE_README.md) =====
    // No session/idToken in standalone mode yet — skip the real fetch
    // there rather than call an API that doesn't exist for it yet. To
    // remove standalone mode: delete this line.
    if (!isEmbedded()) return;
    // ===== END STANDALONE MODE =====

    // Guards against setting state after unmount (e.g. the user navigates
    // away mid-fetch) — also covers the case of a fast unmount/remount.
    const controller = new AbortController();
    // Standard fetch-on-mount pattern; fetchShopData is abort-guarded above.
    // Moving this off useEffect entirely (e.g. to a query library) is a
    // bigger change than this migration covers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchShopData(controller.signal);
    return () => controller.abort();
  }, [fetchShopData]);

  // ===== STANDALONE MODE =====
  // To remove standalone mode: delete this whole block (and the
  // isEmbedded/showToast/setLoading imports above, once nothing else in
  // this file needs the isEmbedded check).
  if (!isEmbedded()) {
    return (
      <s-page heading="Dashboard">
        <s-section>
          <s-stack gap="base">
            <s-heading>Welcome to your app!</s-heading>
            <s-text color="subdued">
              Running in standalone mode — the real shop data API isn't wired up here yet.
            </s-text>
          </s-stack>
        </s-section>
      </s-page>
    );
  }
  // ===== END STANDALONE MODE =====

  return (
    <s-page heading="Dashboard">
      {/* Reflected into the native admin title bar automatically.
          The primary-action slot only accepts one variant="primary" button. */}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => fetchShopData()}
        loading={isLoading}
      >
        Refresh
      </s-button>

      {error && (
        <s-banner heading="Error loading data" tone="critical">
          {error}
          <s-button slot="secondary-actions" variant="secondary" onClick={() => fetchShopData()}>
            Retry
          </s-button>
        </s-banner>
      )}

      <s-section>
        <s-stack gap="base">
          <s-heading>Welcome to your app!</s-heading>

          {isLoading ? (
            <s-text color="subdued">Loading shop data...</s-text>
          ) : shopData ? (
            <s-stack gap="small">
              <s-text>
                <strong>Shop:</strong> {shopData.name}
              </s-text>
              <s-text>
                <strong>Email:</strong> {shopData.email}
              </s-text>
              <s-text>
                <strong>Domain:</strong> {shopData.myshopifyDomain}
              </s-text>
              <s-text>
                <strong>Plan:</strong> {shopData.plan?.displayName}
              </s-text>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
};

export default Home;
