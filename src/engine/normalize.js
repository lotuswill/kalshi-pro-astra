// ═══════════════════════════════════════════════════════════════
// API NORMALIZER — adapt Kalshi's live market schema to the canonical
// integer-cents shape the engine and UI expect.
//
// Kalshi's current /events response returns prices as decimal-dollar
// STRINGS ("0.5600" = 56¢) and sizes as float strings ("111.65"),
// under *_dollars / *_fp field names. The engine works in integer
// cents (yes_bid, yes_ask, no_bid, no_ask, volume). This converts one
// to the other so a schema change on Kalshi's side is contained here
// instead of rippling through every strategy and table.
// ═══════════════════════════════════════════════════════════════

// Decimal-dollar string|number → integer cents. "0.5600" → 56, 0.21 → 21.
export function dollarsToCents(v) {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Float string|number → rounded integer (for volume / open interest).
export function toInt(v) {
  if (v == null) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isFinite(n) ? Math.round(n) : 0;
}

// Normalize one market. Idempotent and backward-compatible: markets
// already in the cents shape (no *_dollars fields — e.g. test fixtures
// or a future API) pass through untouched.
export function normalizeMarket(m) {
  if (!m) return m;
  const hasDollars = m.yes_bid_dollars != null || m.yes_ask_dollars != null ||
    m.no_bid_dollars != null || m.no_ask_dollars != null;
  if (!hasDollars) return m;
  return {
    ...m,
    yes_bid: dollarsToCents(m.yes_bid_dollars),
    yes_ask: dollarsToCents(m.yes_ask_dollars),
    no_bid: dollarsToCents(m.no_bid_dollars),
    no_ask: dollarsToCents(m.no_ask_dollars),
    last_price: dollarsToCents(m.last_price_dollars),
    volume: toInt(m.volume_fp ?? m.volume),
    volume_24h: toInt(m.volume_24h_fp),
    open_interest: toInt(m.open_interest_fp),
  };
}

export function normalizeEvent(e) {
  if (!e) return e;
  return { ...e, markets: (e.markets || []).map(normalizeMarket) };
}

export function normalizeEvents(events) {
  return (events || []).map(normalizeEvent);
}

// Orderbook: live API returns { orderbook_fp: { yes_dollars: [["0.4500",
// "10605.00"], ...], no_dollars: [...] } }. Canonical shape is
// { orderbook: { yes: [[cents, qty], ...], no: [...] } }.
export function normalizeOrderbook(resp) {
  if (!resp) return resp;
  if (resp.orderbook?.yes || resp.orderbook?.no) return resp; // already cents
  const fp = resp.orderbook_fp;
  if (!fp) return resp;
  const conv = rows => (rows || []).map(([p, q]) => [dollarsToCents(p), toInt(q)]);
  return { ...resp, orderbook: { yes: conv(fp.yes_dollars), no: conv(fp.no_dollars) } };
}

// Trades: live API returns yes_price_dollars/no_price_dollars strings and
// count_fp floats. Canonical: yes_price/no_price cents, count int.
export function normalizeTrade(t) {
  if (!t || t.yes_price != null) return t;
  return {
    ...t,
    yes_price: dollarsToCents(t.yes_price_dollars),
    no_price: dollarsToCents(t.no_price_dollars),
    count: toInt(t.count_fp ?? t.count),
    // taker_side is deprecated upstream in favor of taker_outcome_side —
    // keep the canonical name alive for the tape/bot-detection code.
    taker_side: t.taker_side ?? t.taker_outcome_side,
  };
}

export function normalizeTrades(trades) {
  return (trades || []).map(normalizeTrade);
}

// Portfolio fills (authenticated) use the same dollar-string convention.
export function normalizeFill(f) {
  if (!f || f.yes_price != null) return f;
  return {
    ...f,
    yes_price: dollarsToCents(f.yes_price_dollars ?? f.yes_price),
    no_price: dollarsToCents(f.no_price_dollars ?? f.no_price),
    count: toInt(f.count_fp ?? f.count),
  };
}

export function normalizeFills(fills) {
  return (fills || []).map(normalizeFill);
}
