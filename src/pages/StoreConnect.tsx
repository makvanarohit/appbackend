// ============================================
// StoreConnect
//
// First screen shown in standalone mode (no `host` param —
// see src/lib/environment.ts) before there's a connected
// store to show data for. Takes a store name and hands it up
// once "connected".
//
// Built entirely from Polaris web components — polaris.js is
// loaded unconditionally in index.html, so these render fine
// here regardless of embedding. The <form> itself stays a
// plain native element (Polaris has no form wrapper component;
// fields live inside a regular <form> the same way they do
// everywhere else in this app).
//
// The actual API call is stubbed for now — wire the real
// fetch up here next. onSubmit already has the right shape
// (async, sets isSubmitting/error) for that to drop in later.
// ============================================

import { useState } from 'react';
import type { FormEvent } from 'react';

type FieldChangeEvent = Event & { currentTarget: HTMLElementTagNameMap['s-text-field'] };

interface StoreConnectProps {
  onConnected: (storeName: string) => void;
}

const StoreConnect = ({ onConnected }: StoreConnectProps) => {
  const [storeName, setStoreName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInput = (event: FieldChangeEvent) => {
    setStoreName(event.currentTarget.value ?? '');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = storeName.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    setError(null);

    try {
      // TODO: replace with the real API call to fetch store data, e.g:
      // const response = await fetch(`/api/shop?shop=${trimmed}`);
      // if (!response.ok) throw new Error('Store not found');
      // const data = await response.json();
      await new Promise((resolve) => setTimeout(resolve, 400));

      onConnected(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to that store');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <s-stack alignItems="center" justifyContent="center" minBlockSize="100%" padding="large-500">
      <s-box
        background="base"
        border="base"
        borderRadius="large"
        padding="base"
        inlineSize="500px"
      >
        <form onSubmit={handleSubmit}>
          <s-stack gap="small-200">
            <s-stack gap="small-200">
              <s-heading>Connect a store</s-heading>
              <s-paragraph>
                Running in standalone mode. Enter a store name to preview the app locally.
              </s-paragraph>
            </s-stack>

            <s-text-field
              label="Store name"
              name="storeName"
              placeholder="my-store"
              value={storeName}
              onInput={handleInput}
              disabled={isSubmitting}
              suffix='.myshopify.com'
            ></s-text-field>

            {error && (
              <s-banner tone="critical" heading="Couldn't connect">
                {error}
              </s-banner>
            )}

            <s-button
              type="submit"
              variant="primary"
              loading={isSubmitting}
              disabled={!storeName.trim()}
            >
              {isSubmitting ? 'Connecting…' : 'Connect'}
            </s-button>
          </s-stack>
        </form>
      </s-box>
    </s-stack>
  );
};

export default StoreConnect;
