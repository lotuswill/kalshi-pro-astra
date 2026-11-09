import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import {kalshiProxy} from './scripts/kalshi-proxy.mjs'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/espn': {
        target: 'https://site.api.espn.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/espn/, ''),
      },
      '/kalshi-alt/': kalshiProxy('https://api.elections.kalshi.com', '/kalshi-alt'),
      '/kalshi/': kalshiProxy('https://external-api.kalshi.com', '/kalshi'),
      '/sportsdb': {
        target: 'https://www.thesportsdb.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sportsdb/, ''),
      },
      '/ncaa': {
        target: 'https://data.ncaa.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ncaa/, ''),
      },
      '/oddsapi': {
        target: 'https://api.the-odds-api.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/oddsapi/, ''),
      },
      // Published Google Sheet CSV exports (Mentor tab) — Google redirects
      // to googleusercontent.com, so follow redirects server-side.
      '/gsheet': {
        target: 'https://docs.google.com',
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/gsheet/, ''),
      },
    },
  },
})
