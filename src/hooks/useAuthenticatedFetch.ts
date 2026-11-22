// ============================================
// Hook: useAuthenticatedFetch
// App Bridge v4 version
// Uses window.shopify.idToken() to get JWT
// Injects token into every backend request
// ============================================

import { useCallback } from 'react';

interface FetchOptions extends RequestInit {
    headers?: Record<string, string>;
}

interface UseAuthenticatedFetchResult {
    authenticatedFetch: (url: string, options?: FetchOptions) => Promise<Response>;
}

const useAuthenticatedFetch = (): UseAuthenticatedFetchResult => {

    const authenticatedFetch = useCallback(
        async (url: string, options: FetchOptions = {}): Promise<Response> => {

            // ============================================
            // Step 1: Get fresh session token from
            // App Bridge v4 via window.shopify.idToken()
            // This is the modern way — no Provider needed
            // ============================================
            const sessionToken = await window.shopify.idToken();

            // Get shop from URL params
            const params = new URLSearchParams(window.location.search);
            const shop = params.get('shop');

            // ============================================
            // Step 2: Merge headers with session token
            // ============================================
            const mergedOptions: FetchOptions = {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    // Inject session token — backend verifies this
                    'Authorization': `Bearer ${sessionToken}`,
                    // Send shop domain for backend identification
                    ...(shop ? { 'X-Shopify-Shop-Domain': shop } : {}),
                    ...options.headers,
                },
            };

            // ============================================
            // Step 3: Make the request
            // ============================================
            const response = await fetch(url, mergedOptions);

            // ============================================
            // Step 4: Handle re-authentication
            // If backend returns 401 with reauth: true
            // redirect merchant through OAuth
            // ============================================
            if (response.status === 401) {
                const data = await response.clone().json();
                if (data?.reauth) {
                    window.location.href = `/auth?shop=${shop}`;
                    return response;
                }
            }

            return response;
        },
        []
    );

    return { authenticatedFetch };
};

export default useAuthenticatedFetch;
