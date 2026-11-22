// ============================================
// React Entry Point
// Mounts the React app into the DOM
// Imports Polaris CSS globally here
// ============================================

import React from 'react';
import ReactDOM from 'react-dom/client';

// ============================================
// Root App component
// Polaris web components style themselves once
// the polaris.js CDN script (in index.html) loads —
// no separate stylesheet import needed here.
// ============================================
import App from './App';
import './index.css'

// ============================================
// Get the root DOM element
// ============================================
const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error(
    '❌ Root element not found. Make sure index.html has <div id="root"></div>'
  );
}

// ============================================
// Mount React app
// Using createRoot for React 18/19 concurrent mode
// ============================================
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
