import React from 'react'
import ReactDOM from 'react-dom/client'

// ── Native (Capacitor APK) fetch shim ───────────────────────────
// In the browser/PWA the app talks to same-origin proxy paths that
// Vite (dev) or Vercel (prod) rewrite to the real APIs. Inside the
// Android webview there is no proxy, so map those prefixes to their
// upstream origins before any app code runs. CapacitorHttp (enabled
// in capacitor.config.json) routes fetch through the native layer,
// which sidesteps CORS entirely.
const NATIVE_PROXY = {
  '/kalshi/': 'https://external-api.kalshi.com/',
  '/kalshi-alt/': 'https://api.elections.kalshi.com/',
  '/espn/': 'https://site.api.espn.com/',
  '/sportsdb/': 'https://www.thesportsdb.com/',
  '/ncaa/': 'https://data.ncaa.com/',
  '/oddsapi/': 'https://api.the-odds-api.com/',
  '/gsheet/': 'https://docs.google.com/',
}
if (window.Capacitor?.isNativePlatform?.()) {
  const origFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url
    if (typeof url === 'string') {
      for (const [prefix, origin] of Object.entries(NATIVE_PROXY)) {
        if (url.startsWith(prefix)) return origFetch(origin + url.slice(prefix.length), init)
      }
    }
    return origFetch(input, init)
  }
}

import App from './App.jsx'

// PWA: register the service worker in production builds only (the dev
// server's proxy + HMR don't mix with SW caching).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
