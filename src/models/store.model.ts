export type InstallationStatus = 'pending' | 'installed' | 'reinstalled' | 'uninstalled';
export type AppStatus = 'enabled' | 'disabled';
export type AppPlan = 'free' | 'starter' | 'pro' | 'enterprise';
export type AppPlanStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';
export type BillingStatus =
    | 'free'
    | 'trialing'
    | 'pending'
    | 'active'
    | 'paused'
    | 'cancelled'
    | 'expired';
export type BillingInterval = 'none' | 'monthly' | 'annual';
export type TokenExchangeStatus = 'success' | 'failed';

export interface Store {
    store_id: number;
    shopify_shop_id: number | null;
    shop_domain: string;

    shop_name: string | null;
    shop_email: string | null;
    contact_email: string | null;
    primary_domain: string | null;

    country_code: string | null;
    currency_code: string | null;
    timezone: string | null;
    locale: string | null;

    shopify_plan_type: string | null;
    shopify_plan_name: string | null;
    is_shopify_plus: boolean;

    installation_status: InstallationStatus;
    app_status: AppStatus;

    installed_at: Date | null;
    first_installed_at: Date | null;
    last_installed_at: Date | null;
    uninstalled_at: Date | null;
    last_seen_at: Date | null;

    onboarding_completed: boolean;
    onboarding_completed_at: Date | null;

    access_token_encrypted: string | null;
    access_token_issued_at: Date | null;
    access_token_expires_at: Date | null;

    refresh_token_encrypted: string | null;
    refresh_token_expires_at: Date | null;

    token_encryption_key_id: string | null;
    standalone_token_version: number;

    last_token_exchange_at: Date | null;
    last_token_exchange_status: TokenExchangeStatus | null;
    last_token_exchange_error: string | null;

    storefront_enabled: boolean;
    settings_json: Record<string, unknown> | null;

    app_plan: AppPlan;
    app_plan_status: AppPlanStatus;
    app_plan_started_at: Date | null;
    app_plan_renews_at: Date | null;
    requires_plan_selection: boolean;
    plan_selection_url: string | null;

    shopify_subscription_id: string | null;
    shopify_subscription_name: string | null;
    billing_status: BillingStatus;
    billing_currency: string | null;
    billing_price_amount: string | null;
    billing_interval: BillingInterval;
    trial_days: number;
    trial_started_at: Date | null;
    trial_ends_at: Date | null;
    current_billing_period_start: Date | null;
    current_billing_period_end: Date | null;
    subscription_activated_at: Date | null;
    subscription_cancelled_at: Date | null;

    shop_created_at: Date | null;
    shop_updated_at: Date | null;

    created_at: Date;
    updated_at: Date;
}