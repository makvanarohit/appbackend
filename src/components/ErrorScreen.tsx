// ============================================
// Error Screen
// Shown when App Bridge fails to initialize
// (missing config, bad host param, etc.)
// ============================================

interface ErrorScreenProps {
  message: string;
}

const ErrorScreen = ({ message }: ErrorScreenProps) => {
  return (
    <s-page heading="Something went wrong" inlineSize="small">
      <s-section>
        <s-banner heading="Unable to load app" tone="critical">
          {message}
        </s-banner>
      </s-section>
    </s-page>
  );
};

export default ErrorScreen;
