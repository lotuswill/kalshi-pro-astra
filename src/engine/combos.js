// ═══════════════════════════════════════════════════════════════
// COMBO OPPORTUNITY ENGINE — pure logic for the 🧩 Combos tab.
//
// The generalization of the postponement play: any combo whose best
// bid sits well below its ACTUAL value is a discount left by someone
// who wants out. For a postponed combo the actual value is exact (the
// product of frozen fair prices); for a live combo it's an estimate —
// the product of each leg's current market price. Smaller, riskier
// spreads, but far more of them, and they cluster where the action
// is: brand-new markets and events with unusual volume.
//
// Signals (all from the /markets payload — no extra calls needed):
//   volume_24h_fp vs volume_fp   → how fresh the activity is
//   open_time                    → new-market flag
//   last vs previous_price       → price shift (volatility proxy)
//   Σ leg volume_24h by event    → "chatter": which events are hot
// ═══════════════════════════════════════════════════════════════

const num = v => { const n = typeof v === "string" ? parseFloat(v) : v; return isFinite(n) ? n : null; };

// ── Leg pricing ─────────────────────────────────────────────────
// Live probability of one leg market: settled → 0/1; else the book
// mid when the book is real, else the last trade. Returns null when
// nothing usable (empty book, never traded).
export function legLivePrice(m) {
  if (!m) return null;
  if (m.result === "yes") return 1;
  if (m.result === "no") return 0;
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
  const hasBook = bid != null && ask != null && bid > 0 && ask > 0 && ask < 1 && ask >= bid;
  if (hasBook) return Math.round(((bid + ask) / 2) * 10000) / 10000;
  if (last != null && last > 0 && last < 1) return last;
  return null;
}

// ── Fair value of a combo from its legs' live prices ────────────
// legPrices: map market_ticker → price (dollars, already side-agnostic
// yes-probability). NO-side legs invert. Returns { fair, known,
// unknown[], legs[] } — fair is null until every leg has a price.
export function comboFairValue(combo, legPrices) {
  const legs = (combo?.mve_selected_legs || []).map(l => {
    const p0 = legPrices[l.market_ticker];
    const invert = (l.side || "yes") === "no";
    const p = p0 == null ? null : (invert ? Math.round((1 - p0) * 10000) / 10000 : p0);
    return { ...l, p };
  });
  const unknown = legs.filter(l => l.p == null).map(l => l.market_ticker);
  if (unknown.length) return { fair: null, known: false, unknown, legs };
  const fair = legs.reduce((a, l) => a * l.p, 1);
  return { fair: Math.round(fair * 10000) / 10000, known: true, unknown: [], legs };
}

// ── Spread + opportunity score ──────────────────────────────────
// spread = fair − best bid (dollars): what a seller into our bid
// leaves on the table. bidDepth$ approximates how much we could buy.
export function spreadMetrics(m, fair) {
  const bid = num(m?.yes_bid_dollars) || 0;
  const ask0 = num(m?.yes_ask_dollars);
  const ask = ask0 != null && ask0 > 0 && ask0 < 1 ? ask0 : null;
  const spread = fair != null ? Math.round((fair - bid) * 10000) / 10000 : null;
  const bidSize = num(m?.yes_bid_size_fp) || 0;
  return {
    bid, ask, spread,
    spreadPct: fair ? Math.round(((fair - bid) / fair) * 1000) / 10 : null,
    askDiscount: fair != null && ask != null ? Math.round((fair - ask) * 10000) / 10000 : null,
    bidSize,
  };
}

// Rank: wide spread on big open interest beats either alone.
// score = spread(¢) × log10(OI + 10). Null spread → −∞ (sinks).
export function opportunityScore({ spread, oi }) {
  if (spread == null) return -Infinity;
  return Math.round(spread * 100 * Math.log10((oi || 0) + 10) * 100) / 100;
}

// ── Freshness / volatility / chatter ────────────────────────────
export function isNewMarket(m, now = Date.now(), ageHours = 24) {
  const t = Date.parse(m?.open_time || m?.created_time || "");
  return !!t && (now - t) < ageHours * 3600e3;
}

// How much of this market's lifetime volume happened in the last 24h.
// 1.0 on a young market is normal; 0.8 on an old one is a surge.
export function volumePulse(m) {
  const v24 = num(m?.volume_24h_fp) ?? num(m?.volume_24h) ?? 0;
  const vAll = num(m?.volume_fp) ?? num(m?.volume) ?? 0;
  return { v24, vAll, ratio: vAll > 0 ? Math.round((v24 / vAll) * 1000) / 1000 : null };
}

// Price shift since the previous close/trade — the volatility proxy.
export function priceShift(m) {
  const last = num(m?.last_price_dollars), prev = num(m?.previous_price_dollars);
  if (last == null || prev == null || (last === 0 && prev === 0)) return null;
  return Math.round((last - prev) * 10000) / 10000;
}

// A market is "hot" when it's old enough to have a baseline yet most
// of its volume is fresh, or its price jumped hard.
export function isHotMarket(m, now = Date.now(), { minV24 = 500, ratioMin = 0.5, shiftMin = 0.10 } = {}) {
  const { v24, ratio } = volumePulse(m);
  const shift = priceShift(m);
  const fresh = !isNewMarket(m, now, 24);
  if (v24 >= minV24 && ratio != null && ratio >= ratioMin && fresh) return { hot: true, why: `${Math.round(ratio * 100)}% of volume in 24h` };
  if (shift != null && Math.abs(shift) >= shiftMin && v24 >= minV24 / 5) return { hot: true, why: `price moved ${(shift * 100).toFixed(0)}¢` };
  return { hot: false, why: "" };
}

// ── Event chatter — where is the unusual action? ────────────────
// Aggregate leg markets by event: total 24h volume, biggest shift,
// count. Sorted hottest first. `markets` are leg /markets payloads.
export function eventChatter(markets = [], { top = 12, minV24 = 200 } = {}) {
  const by = new Map();
  for (const m of markets) {
    const ev = m.event_ticker || "?";
    const { v24 } = volumePulse(m);
    const shift = priceShift(m);
    const e = by.get(ev) || { event: ev, v24: 0, markets: 0, maxShift: 0, title: "" };
    e.v24 += v24; e.markets++;
    if (shift != null && Math.abs(shift) > Math.abs(e.maxShift)) e.maxShift = shift;
    if (!e.title) e.title = m.title || m.yes_sub_title || "";
    by.set(ev, e);
  }
  return [...by.values()]
    .filter(e => e.v24 >= minV24)
    .sort((a, b) => b.v24 - a.v24)
    .slice(0, top);
}

// ── Scan filtering ──────────────────────────────────────────────
// Pre-filter the raw combo list before the (expensive) leg resolve:
// needs open interest and at least one side of a market to trade at.
export function combosWorthPricing(markets = [], { minOI = 100 } = {}) {
  return markets.filter(m => {
    const oi = num(m.open_interest_fp) ?? num(m.open_interest) ?? 0;
    if (oi < minOI) return false;
    const bid = num(m.yes_bid_dollars) || 0;
    const vol = num(m.volume_fp) || 0;
    return bid > 0 || vol > 0; // dead one-sided books are noise
  });
}

// Unique leg tickers across a set of combos (for batched resolution).
export function uniqueLegTickers(combos = [], cap = 400) {
  const s = new Set();
  for (const c of combos) {
    for (const l of c.mve_selected_legs || []) {
      s.add(l.market_ticker);
      if (s.size >= cap) return [...s];
    }
  }
  return [...s];
}

// New-arrival detection across rescans (alert wiring).
export function newOpportunityIds(prevIds, rows = [], { minSpread = 0.03 } = {}) {
  const seen = prevIds instanceof Set ? prevIds : new Set(prevIds || []);
  return rows.filter(r => r.spread != null && r.spread >= minSpread && !seen.has(r.ticker)).map(r => r.ticker);
}
