// ============================================
// Not Found Page
// Catch-all route (path="*") for unmatched URLs
// ============================================

import useSafeNavigate from '@/hooks/useSafeNavigate';

const NotFound = () => {
  const safeNavigate = useSafeNavigate();

  // href="/" is kept below for accessibility and middle-click/new-tab
  // support, but we intercept the click so this stays an SPA navigation
  // instead of a full iframe reload. s-button's onClick fires its own
  // custom event (not a React MouseEvent), so this is typed as the
  // base Event that preventDefault() comes from. safeNavigate prompts to
  // confirm first if there are unsaved changes tracked by a save bar.
  const goHome = (event: Event) => {
    event.preventDefault();
    safeNavigate('/');
  };

  return (
    <s-page heading="Page not found" inlineSize="small">
      <s-section>
        <s-stack gap="base">
          <s-text>The page you're looking for doesn't exist, or may have moved.</s-text>
          <s-button variant="primary" href="/" onClick={goHome}>
            Go to dashboard
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
};

export default NotFound;
