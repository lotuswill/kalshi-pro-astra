// ═══════════════════════════════════════════════════════════════
// POSTPONEMENT ARB ENGINE — pure logic for the ⏸ Postponed tab.
//
// When a game is postponed, Kalshi keeps its market ACTIVE but extends
// close_time to the settlement deadline (baseball: ~48h after the
// originally scheduled start; most other sports: up to ~2 weeks). If
// the game never restarts, positions resolve to a FAIR PRICE — in
// practice the market price around the time of postponement.
//
// A combo (MVE parlay) whose live legs have all settled YES therefore
// has a knowable terminal value: the PRODUCT of its postponed legs'
// fair prices. Holders anxious to cash out sell below that product;
// the strategy keeps a resting bid pinned at
//     min(best bid + step, payout − margin)
// in the market's native tick (deci-cent for combos).
//
// Detection signature (verified live 2026-08-31, KBO slate):
//   status active/open  AND  expected_expiration_time well in the past
//   AND close_time still in the future (the extended deadline).
// ═══════════════════════════════════════════════════════════════

const H = 3600 * 1000;

// ── Postponed-game detection ────────────────────────────────────
// `m` is a normalized market (integer cents) from a game series scan.
// graceMs: how long past the expected expiration before we call it
// postponed (games run long; default 2.5h).
export function isPostponedGameMarket(m, now = Date.now(), graceMs = 2.5 * H) {
  if (!m || m.market_type !== "binary") return false;
  if (m.status && !["active", "open"].includes(m.status)) return false;
  if (m.result) return false;
  const exp = Date.parse(m.expected_expiration_time || "");
  const close = Date.parse(m.close_time || "");
  if (!exp || !close) return false;
  return exp + graceMs < now && close > now;
}

// The settlement deadline for a postponed market is its extended close.
export function postponementDeadline(m) {
  return Date.parse(m?.close_time || "") || null;
}

// Human label for the sport's restart rule, from the series ticker.
export function restartRule(seriesTicker = "") {
  const st = seriesTicker.toUpperCase();
  if (/KBO|NPB|MLB|NCAABB|BASEBALL/.test(st)) return "48h restart window (baseball)";
  if (/NFL|NBA|NHL|NCAA|EPL|LALIGA|BUNDES|SERIA|UCL|UEL|MLS|SOCCER|WC/.test(st)) return "up to ~2 weeks";
  return "see market rules";
}

// Scheduled start from a game ticker: KXKBOGAME-26AUG300500KIWDOO-DOO
// → 2026-08-30T05:00Z. Returns ms epoch or null.
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
export function scheduledStartFromTicker(ticker = "") {
  const m = ticker.match(/-(\d{2})([A-Z]{3})(\d{2})(\d{4})?[A-Z]/);
  if (!m) return null;
  const [, yy, mon, dd, hhmm] = m;
  if (!(mon in MONTHS)) return null;
  const h = hhmm ? parseInt(hhmm.slice(0, 2), 10) : 0;
  const mi = hhmm ? parseInt(hhmm.slice(2), 10) : 0;
  return Date.UTC(2000 + +yy, MONTHS[mon], +dd, h, mi);
}

// ── Price at postponement ───────────────────────────────────────
// From candlesticks (fp shape: { end_period_ts, price:{close_dollars} }):
// the close of the last candle at/after the scheduled start (the frozen
// consensus once the postponement was known). Falls back to the last
// candle before start, else null.
export function priceAtPostponement(candles = [], scheduledStartMs) {
  if (!candles.length) return null;
  const startS = scheduledStartMs ? Math.floor(scheduledStartMs / 1000) : null;
  const closeOf = c => {
    const p = c?.price || {};
    const v = p.close_dollars != null ? parseFloat(p.close_dollars)
      : p.close != null ? Number(p.close) / 100 : null;
    return v != null && isFinite(v) ? v : null;
  };
  const sorted = [...candles].sort((a, b) => a.end_period_ts - b.end_period_ts);
  if (startS) {
    const after = sorted.filter(c => c.end_period_ts >= startS && closeOf(c) != null);
    if (after.length) return closeOf(after[0]);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const v = closeOf(sorted[i]);
    if (v != null) return v;
  }
  return null;
}

// ── Combo payout ────────────────────────────────────────────────
// legInfo: map market_ticker → { state: "yes"|"no"|"postponed"|"open",
//                                fair: dollars (for postponed) }.
// Returns { payout, determined, unknown, legs } where payout is the
// product in dollars, determined=true when every leg is yes/no/postponed
// (i.e. the value is knowable now), and unknown lists unresolved legs.
export function comboPayout(combo, legInfo) {
  const legs = (combo?.mve_selected_legs || []).map(l => {
    const info = legInfo[l.market_ticker] || { state: "open" };
    // A "no"-side leg inverts: leg wins if the underlying resolves NO.
    const invert = (l.side || "yes") === "no";
    let p = null;
    if (info.state === "yes") p = invert ? 0 : 1;
    else if (info.state === "no") p = invert ? 1 : 0;
    else if (info.state === "postponed" && info.fair != null) p = invert ? 1 - info.fair : info.fair;
    return { ...l, state: info.state, fair: info.fair ?? null, p };
  });
  const unknown = legs.filter(l => l.p == null);
  const payout = legs.reduce((acc, l) => acc * (l.p == null ? 1 : l.p), 1);
  return { payout: unknown.length ? null : round4(payout), determined: unknown.length === 0, unknown: unknown.map(l => l.market_ticker), legs };
}

function round4(x) { return Math.round(x * 10000) / 10000; }

// ── Tick + auto-bid math ────────────────────────────────────────
// Native tick in dollars from a market's price metadata.
export function marketTick(m) {
  const step = parseFloat(m?.price_ranges?.[0]?.step ?? "");
  if (isFinite(step) && step > 0) return step;
  return m?.price_level_structure === "deci_cent" ? 0.001 : 0.01;
}

// Band-aware tick: newer combos use BANDED grids (verified live
// 2026-09-03, structure "center_deci_edge_centi_cent"):
//   0–1¢ step 0.01¢ · 1¢–99¢ step 0.1¢ · 99–100¢ step 0.01¢
// so the valid tick depends on WHERE the price lands. Reading only
// price_ranges[0] (marketTick) returns the edge band's 0.0001 and
// produces off-grid center prices the exchange rejects. Always use
// this when pricing a specific level.
export function tickAtPrice(m, price) {
  const ranges = m?.price_ranges;
  if (Array.isArray(ranges) && ranges.length && isFinite(price)) {
    for (const r of ranges) {
      const s = parseFloat(r.start), e = parseFloat(r.end), st = parseFloat(r.step);
      if (!isFinite(st) || st <= 0) continue;
      if (price >= s - 1e-12 && (price < e - 1e-12 || (e >= 1 && price <= e + 1e-12))) return st;
    }
    // outside every band (shouldn't happen) → coarsest step, stays valid everywhere
    const steps = ranges.map(r => parseFloat(r.step)).filter(v => isFinite(v) && v > 0);
    if (steps.length) return Math.max(...steps);
  }
  return marketTick(m);
}

export function floorToTick(price, tick) {
  if (!isFinite(price) || !isFinite(tick) || tick <= 0) return null;
  return Math.round(Math.floor(price / tick + 1e-9) * tick * 10000) / 10000;
}

// The strategy: bid step above the best competing bid, but never above
// payout − margin (the profit floor). All args in dollars.
//   bestBid   — highest bid that is NOT ours (null/0 if none)
//   payout    — computed combo payout per share
//   step      — how far above the competition to sit (e.g. 0.002)
//   margin    — minimum edge below payout (e.g. 0.08)
//   tick      — market tick (0.001 for combos)
// Returns { price, capped, reason } — price=null means "don't bid".
export function autoBidTarget({ bestBid, payout, step, margin, tick }) {
  if (payout == null || !isFinite(payout)) return { price: null, reason: "payout unknown" };
  const cap = floorToTick(payout - margin, tick);
  if (cap == null || cap < tick) return { price: null, reason: "cap below tick — no room" };
  const desired = (bestBid || 0) > 0 ? (bestBid + step) : cap;
  const price = Math.min(floorToTick(desired, tick) ?? cap, cap);
  if (price < tick) return { price: null, reason: "no positive bid possible" };
  return { price: round4(price), capped: desired > cap, reason: price === cap ? "at cap (payout − margin)" : "step above best bid" };
}

// Best bid from a normalized-or-fp YES orderbook, excluding our own
// resting order (ourPrice dollars, ourCount shares) if it makes up the
// entire size at that level.
export function bestCompetingBid(yesLevels = [], ourPrice = null, ourCount = 0) {
  // yesLevels: [[dollars(string|number), qty(string|number)], ...] any order.
  const rows = yesLevels
    .map(([p, q]) => [typeof p === "string" ? parseFloat(p) : p, typeof q === "string" ? parseFloat(q) : q])
    .filter(([p, q]) => isFinite(p) && isFinite(q) && q > 0)
    .sort((a, b) => b[0] - a[0]);
  for (const [p, q] of rows) {
    if (ourPrice != null && Math.abs(p - ourPrice) < 1e-9) {
      const rest = q - ourCount;
      if (rest > 1e-9) return { price: p, size: rest };
      continue; // level is entirely ours
    }
    return { price: p, size: q };
  }
  return { price: 0, size: 0 };
}

// Sort helper for the combo list.
export function sortCombos(combos, key = "volume") {
  const val = m => parseFloat((key === "oi" ? m.open_interest_fp : m.volume_fp) ?? (key === "oi" ? m.open_interest : m.volume) ?? 0) || 0;
  return [...combos].sort((a, b) => val(b) - val(a));
}

// Group selected postponed games by their settlement deadline (epoch s),
// for the close-window combo discovery queries.
export function deadlineWindows(markets, slackS = 60) {
  const seen = new Map();
  for (const m of markets) {
    const d = postponementDeadline(m);
    if (!d) continue;
    const s = Math.floor(d / 1000);
    const hit = [...seen.keys()].find(k => Math.abs(k - s) <= slackS);
    if (hit == null) seen.set(s, [m.ticker]);
    else seen.get(hit).push(m.ticker);
  }
  return [...seen.entries()].map(([ts, tickers]) => ({ min_close_ts: ts - slackS, max_close_ts: ts + slackS, tickers }));
}
