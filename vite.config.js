import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/espn': {
        target: 'https://site.api.espn.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/espn/, ''),
      },
      '/kalshi': {
        target: 'https://api.elections.kalshi.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/kalshi/, ''),
      },
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
