// ============================================
// Loading Screen
// Shown while App Bridge config is still resolving,
// before we know the app is ready to render.
//
// Deliberately minimal — no <s-page> heading here,
// since we don't want to flash a title into the
// native admin chrome only to replace it moments
// later with the real page heading.
// ============================================

const LoadingScreen = () => {
  return (
    <s-stack alignItems="center" justifyContent="center" gap="base" padding="large-500">
      <s-spinner accessibilityLabel="Loading app" size="large" />
      <s-text color="subdued">Loading…</s-text>
    </s-stack>
  );
};

export default LoadingScreen;
