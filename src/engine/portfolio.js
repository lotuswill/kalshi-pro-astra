// ═══════════════════════════════════════════════════════════════
// PORTFOLIO ENGINE — pure logic for the 💼 Positions tab.
//
// Sources (docs.kalshi.com, 2026-09):
//   GET /portfolio/balance    → balance (cents) / balance_dollars,
//                               portfolio_value (cents)
//   GET /portfolio/positions  → market_positions[]: position_fp is
//     SIGNED (positive = YES, negative = NO), with dollar-string
//     market_exposure/realized_pnl/fees_paid/total_traded
//   GET /portfolio/orders?status=resting → resting orders (mixed
//     legacy/V2 field spellings — normalize both)
//
// Marking: a YES position exits at the yes bid; a NO position exits
// at the no bid (1 − yes ask). Unrealized = exit value − exposure.
// ═══════════════════════════════════════════════════════════════

const num = v => { const n = typeof v === "string" ? parseFloat(v) : v; return isFinite(n) ? n : null; };
const r2 = x => Math.round(x * 100) / 100;

export const BALANCE_PATH = "/portfolio/balance";
export const POSITIONS_PATH = "/portfolio/positions";
export const ORDERS_LIST_PATH = "/portfolio/orders";

export function normalizeBalance(d = {}) {
  const cash = num(d.balance_dollars) ?? (num(d.balance) != null ? num(d.balance) / 100 : null);
  const pv = num(d.portfolio_value_dollars) ?? (num(d.portfolio_value) != null ? num(d.portfolio_value) / 100 : null);
  return { cash, portfolioValue: pv };
}

// Signed position_fp → side + absolute count.
export function normalizePosition(p = {}) {
  const signed = num(p.position_fp) ?? num(p.position) ?? 0;
  return {
    ticker: p.ticker || "",
    signed,
    side: signed < 0 ? "no" : "yes",
    count: Math.abs(signed),
    exposure: num(p.market_exposure_dollars) ?? (num(p.market_exposure) != null ? num(p.market_exposure) / 100 : null),
    realized: num(p.realized_pnl_dollars) ?? (num(p.realized_pnl) != null ? num(p.realized_pnl) / 100 : 0),
    fees: num(p.fees_paid_dollars) ?? (num(p.fees_paid) != null ? num(p.fees_paid) / 100 : 0),
    traded: num(p.total_traded_dollars) ?? null,
    updatedMs: Date.parse(p.last_updated_ts || "") || null,
    isCombo: /MVE/.test(p.ticker || ""),
  };
}

// Exit-value mark from the live market: YES exits into the yes bid,
// NO exits into the no bid (1 − yes ask). Falls back to last price.
export function markPosition(pos, mkt) {
  if (!pos || !pos.count) return { mark: null, value: null, unrealized: null };
  let mark = null;
  if (mkt) {
    if (mkt.result === "yes") mark = pos.side === "yes" ? 1 : 0;
    else if (mkt.result === "no") mark = pos.side === "yes" ? 0 : 1;
    else if (pos.side === "yes") {
      const b = num(mkt.yes_bid_dollars);
      mark = b != null && b > 0 ? b : (num(mkt.last_price_dollars) || null);
    } else {
      const a = num(mkt.yes_ask_dollars);
      const noBid = a != null && a > 0 && a < 1 ? r4(1 - a) : null;
      mark = noBid ?? (num(mkt.last_price_dollars) != null && num(mkt.last_price_dollars) > 0 ? r4(1 - num(mkt.last_price_dollars)) : null);
    }
  }
  const value = mark != null ? r2(mark * pos.count) : null;
  const unrealized = value != null && pos.exposure != null ? r2(value - pos.exposure) : null;
  return { mark, value, unrealized };
}
function r4(x) { return Math.round(x * 10000) / 10000; }

// Average cost per share from exposure.
export function avgCost(pos) {
  if (!pos?.count || pos.exposure == null) return null;
  return r4(pos.exposure / pos.count);
}

export function portfolioSummary(rows = []) {
  const s = { exposure: 0, value: 0, unrealized: 0, realized: 0, fees: 0, marked: 0, open: rows.length };
  for (const r of rows) {
    s.exposure += r.exposure || 0;
    s.realized += r.realized || 0;
    s.fees += r.fees || 0;
    if (r.value != null) { s.value += r.value; s.unrealized += r.unrealized || 0; s.marked++; }
  }
  for (const k of ["exposure", "value", "unrealized", "realized", "fees"]) s[k] = r2(s[k]);
  return s;
}

// Resting order in either dialect (legacy yes/no+buy/sell cents, or
// V2 bid/ask dollar strings).
export function normalizeOrder(o = {}) {
  const yesD = num(o.yes_price_dollars);
  const noD = num(o.no_price_dollars);
  const legacyYes = num(o.yes_price);
  let price = yesD ?? noD ?? null;
  if (price == null && legacyYes != null) price = legacyYes > 1 ? legacyYes / 100 : legacyYes;
  const remaining = num(o.remaining_count_fp) ?? num(o.remaining_count) ?? null;
  const initial = num(o.initial_count_fp) ?? num(o.initial_count) ?? num(o.count_fp) ?? num(o.count) ?? null;
  return {
    id: o.order_id || o.id || "",
    ticker: o.ticker || "",
    side: o.side || "",          // yes|no or bid|ask
    action: o.action || "",      // buy|sell (legacy only)
    price,
    priced: noD != null && yesD == null ? "no" : "yes",
    remaining, initial,
    status: o.status || "",
    createdMs: Date.parse(o.created_time || "") || null,
    isCombo: /MVE/.test(o.ticker || ""),
  };
}

// Human label: "BID 3000 @ 16.1¢" / "BUY YES 100 @ 45¢"
export function orderLabel(o) {
  if (!o) return "";
  const px = o.price != null ? `${(o.price * 100).toFixed(o.isCombo ? 1 : 0)}¢` : "?";
  const qty = o.remaining != null ? Math.round(o.remaining) : "?";
  if (o.side === "bid" || o.side === "ask") return `${o.side.toUpperCase()} ${qty} @ ${px}`;
  return `${(o.action || "?").toUpperCase()} ${qty} ${(o.side || "?").toUpperCase()} @ ${px}`;
}
