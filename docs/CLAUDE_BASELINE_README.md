# Kalshi Sports Terminal (kalshi-pro)

> **© 2026 Will (lotuswill). All rights reserved — proprietary software.**
> Access is for invited collaborators only, for running the tool and giving
> feedback. No copying, redistribution, or reuse of the code, detection
> logic, or methodology without written permission. See [LICENSE](LICENSE).

Real-time scanner for profitable trade opportunities on Kalshi sports markets.
v7.0.0 — the detection logic now lives in testable engine modules with a
Vitest suite, and adds cross-event equivalence arbitrage.

## Run

```
npm install
npm run dev        # Vite dev server (proxies Kalshi/ESPN/Odds APIs, see vite.config.js)
npm test           # run the engine unit tests
npm run test:watch # watch mode
npm run build      # production build
```

## Architecture

- `src/App.jsx` — the terminal UI (dashboard, trading, bots, vault, exports)
- `src/engine/` — pure detection logic, no browser dependencies:
  - `fees.js` — Kalshi fee formula, paired-arb profit math
  - `tickers.js` — Kalshi ticker parsing (teams, dates, game keys)
  - `arbitrage.js` — strategies: intra-event YES/NO arbs, winner-vs-spread
    gaps, sportsbook comparison (The Odds API), ESPN odds comparison
  - `equivalence.js` — cross-event equivalence: detects when markets in
    different events settle on the same outcome
  - `scanner.js` — volatile/new market detection + `OpportunityTracker`
    (diffs successive scans to surface genuinely NEW opportunities)
  - `suggestions.js` — signal/confidence per opportunity
- `src/engine/__tests__/` — Vitest suite with Kalshi-shaped fixtures

## Cross-event equivalence (win ≡ advance)

When a game is decisive, "Team A wins the game" and "Team A advances /
wins the series" are the same bet listed in two different markets
(e.g. `KXNBAGAME-…-OKC` vs `KXNBASERIES-…-OKC` on game 7). The engine
pairs game markets with progression markets by team + league, then tiers
confidence by close-time alignment:

- **EXACT** — the progression market closes with the game: same outcome.
  Divergence beyond fees is a lock: buy YES on the cheap market + buy NO
  on the rich one (< $1 total for a guaranteed $1 payout).
- **LIKELY** — same team, same day; verify settlement terms first.
- **CONDITIONAL** — the series may not be decided tonight. Only the
  dominance bound applies (if a win clinches, P(advance) ≥ P(win game));
  violations are flagged REVIEW, never auto-tradeable.

## Real-time detection

`OpportunityTracker` keys every opportunity and diffs each scan against
the registry: fresh and improved edges get a NEW badge, a live feed strip
in the Arbitrage tab, and a toast when a locked-profit opportunity
(GUARANTEED or profitable EQUIVALENT) appears.

## Detection priorities (v7.4)

True arbitrage is rare and fee-crushed. The scanner's workhorse signals:

- **VALUE** — Kalshi priced outside the *devigged* multi-sportsbook
  consensus (vig stripped, median across books), with fee-adjusted EV
  per contract. Needs The Odds API key in the vault.
- **FRESH SKEW** — freshly listed markets at an extreme on thin volume
  (the 70% YES that relaxes to ~55% by gametime). ANCHORED (books
  disagree → fade with EV) vs UNANCHORED (no anchor yet → tracked
  watch item; pair with the 📼 Tracker to measure how they relax).

## Pages (v7.2)

- **🔴 Live** — settlement-lag hunting: ESPN-confirmed finals whose Kalshi
  winner market still asks below 97¢ (or loser bids above 3¢), plus the
  in-game near-certain watchlist (80–96¢). Auto-refreshes while open.
- **🆕 New Markets** — markets listed in the last 24/48h (Kalshi typically
  lists 24–48h before game time) with time-to-game and unpriced-book
  highlighting for early limit orders.
- **🧭 Mentor** — methodology-mirror ingestion: his Kalshi fills
  (pattern profile: entry prices, timing vs game start, series bias,
  round trips, win rate) and his Google Sheet (column profile). See
  [docs/METHODOLOGY_MIRROR.md](docs/METHODOLOGY_MIRROR.md) for the
  full mirror roadmap.
- **📼 Tracker** (v7.3) — watch specific markets or a whole sport and
  record YES/NO prices plus every trade print over time: mid chart with
  bid/ask band, per-minute transaction flow colored by taker imbalance,
  trade tape with notionals, pattern detection (volume spikes, price
  jumps, momentum runs, one-sided flow), CSV export. Recording runs in
  the background across tabs and persists locally.
- **Logins** — the LockScreen supports per-user profiles, each an
  independently encrypted vault (the methodology creator gets his own
  password and keys).
