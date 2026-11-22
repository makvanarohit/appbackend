// ============================================
// Vite Configuration
// Handles: development, local, and production
// ============================================

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Load env variables based on current mode
  // mode = 'development' | 'production'
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],

    // ============================================
    // Path aliases — cleaner imports
    // Instead of: '../../components/Button'
    // Use: '@/components/Button'
    // ============================================
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },

    // ============================================
    // Dev Server Configuration
    // ============================================
    server: {
      // Port for local development
      port: 5173,

      // Allow connections from ngrok/external tunnels
      host: true,

      // Vite blocks unknown Host headers. A tunnel (Cloudflare / ngrok) has a random
      // hostname, so allow it. This only affects the dev server.
      allowedHosts: true,

      // HTTPS — Shopify requires HTTPS for embedded apps in dev.
      // Vite's dev server itself stays on plain HTTP here; run it behind
      // an HTTPS tunnel (ngrok, Cloudflare Tunnel, etc.) pointed at
      // port 5173, and use that tunnel's URL as your app URL.
      // If you'd rather terminate TLS locally, pass a cert/key object
      // here instead: https: { cert: fs.readFileSync(...), key: ... }

      // ============================================
      // Proxy API calls to Express backend
      // Avoids CORS issues in development
      // All /api and /auth calls go to backend
      // ============================================
      proxy: {
        '/api': {
          target: env.VITE_BACKEND_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
        '/auth': {
          target: env.VITE_BACKEND_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
        '/webhooks': {
          target: env.VITE_BACKEND_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
        },
      },
    },

    // ============================================
    // Preview Server (npm run preview)
    // Simulates production build locally
    // ============================================
    preview: {
      port: 4173,
      host: true,
    },

    // ============================================
    // Build Configuration (production)
    // ============================================
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production', // Source maps in dev only
      minify: mode === 'production',    // Minify in production only

      rollupOptions: {
        output: {
          // Split vendor chunk for better caching.
          // Note: Polaris and App Bridge are no longer bundled here —
          // they're loaded via CDN <script> tags in index.html (see
          // "Adding Polaris to your app" in the Shopify docs), so there's
          // nothing Shopify-related left for Rollup to chunk.
          manualChunks(id) {
            if (/node_modules\/(react|react-dom|react-router-dom)\//.test(id)) {
              return 'react';
            }
          },
        },
      },
    },

    // ============================================
    // Environment variable handling
    // Only VITE_ prefixed vars are exposed
    // to the browser
    // ============================================
    define: {
      __DEV__: mode === 'development',
      __PROD__: mode === 'production',
    },
  };
});
