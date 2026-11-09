// ═══════════════════════════════════════════════════════════════
// LIVE & FRESH MARKET DETECTION
//
// findFreshMarkets    — markets listed recently (Kalshi typically adds
//                       game markets 24-48h before game time); early
//                       books are thin and often lazily priced.
// findSettlementLags  — the "already happened but still selling" case:
//                       an external score feed (ESPN) says a game is
//                       FINAL, but the Kalshi winner market still asks
//                       below ~97¢ (or the loser still bids above ~3¢).
//                       These windows last seconds to minutes.
// findNearCertain     — no external feed needed: today's in-game
//                       markets trading 80-96¢ — the watchlist to eye
//                       when something just happened on the field.
// ═══════════════════════════════════════════════════════════════

import { parseGameDate } from "./tickers.js";
import { kalshiFeeCents } from "./fees.js";

const HOUR = 3600 * 1000;

// ─── Fresh listings ──────────────────────────────────────────
export function findFreshMarkets(kalshiEvents, opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeHours = opts.maxAgeHours ?? 48;
  const out = [];
  (kalshiEvents || []).forEach(e => {
    const gameDate = parseGameDate(e.event_ticker);
    (e.markets || []).forEach(m => {
      const created = new Date(m.created_time || m.open_time || 0).getTime();
      if (!created) return;
      const ageHours = (now - created) / HOUR;
      if (ageHours < 0 || ageHours > maxAgeHours) return;
      const start = m.occurrence_datetime ? Date.parse(m.occurrence_datetime) : (gameDate ? gameDate.getTime() : null);
      const hoursToGame = start != null ? (start - now) / HOUR : null;
      const bid = m.yes_bid || 0, ask = m.yes_ask || 0;
      out.push({
        event: e.title, series: e.series_ticker, market: m,
        ticker: m.ticker, title: m.yes_sub_title || m.title,
        bid, ask, mid: bid && ask ? (bid + ask) / 2 : null,
        spread: bid && ask ? ask - bid : null,
        vol: m.volume || 0,
        ageHours,
        hoursToGame,
        // Thin, unpriced books right after listing are where early
        // limit orders capture the spread before market makers arrive.
        unpriced: !bid || !ask || (ask - bid) >= 20,
      });
    });
  });
  out.sort((a, b) => a.ageHours - b.ageHours);
  return out;
}

// ─── Settlement lag vs an external score feed ────────────────
// espnGames: shape from the app's fetchESPN — { name, status,
// statusDetail, competitors: [{ abbr, score, homeAway }] }.
const FINAL_RE = /FINAL|FULL.?TIME|STATUS_FT/i;
const LIVE_RE = /IN_?PROGRESS|LIVE|HALF|QUARTER|PERIOD|END_PERIOD|CLOCK/i;

export function espnGameState(game) {
  const status = `${game?.status || ""} ${game?.statusDetail || ""}`;
  if (FINAL_RE.test(status)) return "final";
  if (LIVE_RE.test(status)) return "live";
  return "pre";
}

function matchEventToEspn(e, game) {
  const tk = (e.event_ticker || "").toUpperCase();
  const abbrs = (game.competitors || []).map(c => (c.abbr || "").toUpperCase()).filter(a => a.length >= 2);
  if (abbrs.length < 2) return false;
  return abbrs.every(a => tk.includes(a));
}

export function findSettlementLags(kalshiEvents, espnGames, opts = {}) {
  const threshold = opts.threshold ?? 97;
  const floor = opts.floor ?? 3;
  const lags = [];

  (espnGames || []).forEach(game => {
    if (espnGameState(game) !== "final") return;
    const comps = (game.competitors || []);
    if (comps.length < 2) return;
    const scores = comps.map(c => ({ ...c, pts: parseInt(c.score) || 0 }));
    scores.sort((a, b) => b.pts - a.pts);
    if (scores[0].pts === scores[1].pts) return; // tie/unknown — no winner call
    const winner = (scores[0].abbr || "").toUpperCase();
    const loser = (scores[1].abbr || "").toUpperCase();

    (kalshiEvents || []).forEach(e => {
      if (!/GAME|MATCH|FIGHT|ADVANCE/i.test(e.series_ticker || "")) return;
      if (!matchEventToEspn(e, game)) return;
      (e.markets || []).forEach(m => {
        const mTk = (m.ticker || "").toUpperCase();
        const isWinner = mTk.endsWith(`-${winner}`);
        const isLoser = mTk.endsWith(`-${loser}`);
        if (!isWinner && !isLoser) return;

        if (isWinner && m.yes_ask > 0 && m.yes_ask < threshold) {
          const fee = kalshiFeeCents(m.yes_ask, 1, false);
          const profit = 100 - m.yes_ask - fee;
          lags.push({
            kind: "WINNER_UNDERPRICED", game: game.name, ticker: m.ticker, market: m,
            score: `${scores[0].abbr} ${scores[0].pts}–${scores[1].pts} ${scores[1].abbr}`,
            status: game.statusDetail || game.status,
            side: "yes", action: "buy", price: m.yes_ask,
            edge: profit, fee,
            desc: `ESPN says FINAL (${scores[0].abbr} won) but ${winner} YES still asks ${m.yes_ask}¢ → ${profit}¢ after ${fee}¢ fee if settlement confirms.`,
          });
        }
        if (isLoser && m.yes_bid > floor) {
          const noAsk = 100 - m.yes_bid;
          const fee = kalshiFeeCents(noAsk, 1, false);
          const profit = m.yes_bid - fee;
          lags.push({
            kind: "LOSER_OVERPRICED", game: game.name, ticker: m.ticker, market: m,
            score: `${scores[0].abbr} ${scores[0].pts}–${scores[1].pts} ${scores[1].abbr}`,
            status: game.statusDetail || game.status,
            side: "no", action: "buy", price: noAsk,
            edge: profit, fee,
            desc: `ESPN says FINAL (${loser} lost) but ${loser} YES still bids ${m.yes_bid}¢ → buy NO @${noAsk}¢ for ${profit}¢ after ${fee}¢ fee if settlement confirms.`,
          });
        }
      });
    });
  });

  lags.sort((a, b) => b.edge - a.edge);
  return lags;
}

// ─── Near-certain in-game watchlist ──────────────────────────
export function findNearCertain(kalshiEvents, opts = {}) {
  const now = opts.now ?? Date.now();
  const minMid = opts.minMid ?? 80;
  const maxMid = opts.maxMid ?? 97;
  const out = [];
  (kalshiEvents || []).forEach(e => {
    if (!/GAME|MATCH|FIGHT|ADVANCE/i.test(e.series_ticker || "")) return;
    (e.markets || []).forEach(m => {
      const bid = m.yes_bid || 0, ask = m.yes_ask || 0;
      if (!bid || !ask) return;
      const mid = (bid + ask) / 2;
      if (mid < minMid || mid >= maxMid) return;
      const start = m.occurrence_datetime ? Date.parse(m.occurrence_datetime) : null;
      const inGame = start != null ? start <= now : (() => {
        const d = parseGameDate(e.event_ticker);
        return d ? d.toDateString() === new Date(now).toDateString() : false;
      })();
      if (!inGame) return;
      const fee = kalshiFeeCents(ask, 1, false);
      out.push({
        event: e.title, series: e.series_ticker, market: m,
        ticker: m.ticker, title: m.yes_sub_title || m.title,
        bid, ask, mid, vol24h: m.volume_24h || m.volume || 0,
        captureCents: 100 - ask - fee, // what's left on the table if it settles YES
        startedAt: start,
      });
    });
  });
  out.sort((a, b) => b.mid - a.mid || b.vol24h - a.vol24h);
  return out;
}
