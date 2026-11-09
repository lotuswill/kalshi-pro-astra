// ═══════════════════════════════════════════════════════════════
// ORDER TRANSLATOR — legacy order bodies → Kalshi V2 event-orders.
//
// Kalshi deprecated POST /portfolio/orders (escalating rate-limit
// cost since 2026-06, removal pending) in favor of the V2 endpoint
// POST /portfolio/events/orders, which speaks a different dialect:
//   • YES-leg book only: side is "bid"/"ask" (no side:no, no action)
//   • price is a fixed-point dollar STRING ("0.5600" = 56¢)
//   • count is a fixed-point STRING ("10.00")
//   • time_in_force replaces type (limit/market)
//   • self_trade_prevention_type is required
//
// The app (and its saved auto-trade rules) still think in the legacy
// shape {ticker, side: yes|no, action: buy|sell, type: limit|market,
// count, yes_price|no_price (integer cents), post_only}. This module
// converts one to the other so the change is contained here.
//
// NO-side equivalences on the YES book:
//   buy  NO @ q¢  ≡  ask (sell YES) @ (100−q)¢
//   sell NO @ q¢  ≡  bid (buy  YES) @ (100−q)¢
// ═══════════════════════════════════════════════════════════════

export const ORDERS_V2_PATH = "/portfolio/events/orders";

// Integer cents → fixed-point dollar string. 56 → "0.5600"
export function centsToDollars(c) {
  const n = Number(c);
  if (!isFinite(n)) return "0.0000";
  return (n / 100).toFixed(4);
}

// Fixed-point count string with 2 decimals. 10 → "10.00"
export function toCountFp(c) {
  const n = Number(c);
  if (!isFinite(n) || n <= 0) return "0.00";
  return n.toFixed(2);
}

// Legacy order body → V2 event-order body.
export function toV2Order(legacy) {
  if (!legacy || !legacy.ticker) throw new Error("toV2Order: missing ticker");
  const isNo = legacy.side === "no";
  const isSell = legacy.action === "sell";
  // Map to the YES-leg book: buy yes→bid, sell yes→ask,
  // buy no→ask@(100−q), sell no→bid@(100−q).
  const bookSide = (isNo !== isSell) ? "ask" : "bid"; // XOR
  let cents = isNo
    ? 100 - Number(legacy.no_price ?? (100 - (legacy.yes_price ?? 0)))
    : Number(legacy.yes_price ?? (100 - (legacy.no_price ?? 100)));
  let tif = "good_till_canceled";
  if (legacy.type === "market") {
    // Emulate a market order: aggressive limit, immediate-or-cancel.
    cents = bookSide === "bid" ? 99 : 1;
    tif = "immediate_or_cancel";
  }
  cents = Math.min(99, Math.max(1, Math.round(cents)));
  const body = {
    ticker: legacy.ticker,
    side: bookSide,
    price: centsToDollars(cents),
    count: toCountFp(legacy.count),
    time_in_force: tif,
    self_trade_prevention_type: "taker_at_cross",
  };
  if (legacy.post_only) body.post_only = true;
  if (legacy.client_order_id) body.client_order_id = legacy.client_order_id;
  return body;
}

// V2 responses put order_id at the top level; legacy nested it under
// .order. Read either so logs/toasts survive both shapes.
export function orderIdOf(resp) {
  return resp?.order_id ?? resp?.order?.order_id ?? null;
}

// ── Direct V2 orders (sub-cent aware) ───────────────────────────
// Combo (multivariate) markets trade in deci-cent ($0.001) or finer
// ticks that integer cents cannot express. This builder speaks the V2
// dialect natively: side is already "bid"/"ask" and price is a dollar
// number (e.g. 0.162) or fixed-point string.
export function toV2OrderDollars({ ticker, side, price, count, time_in_force, post_only, client_order_id }) {
  if (!ticker) throw new Error("toV2OrderDollars: missing ticker");
  if (side !== "bid" && side !== "ask") throw new Error("toV2OrderDollars: side must be bid|ask");
  const p = typeof price === "string" ? parseFloat(price) : price;
  if (!isFinite(p) || p < 0.0001 || p > 0.9999) throw new Error(`toV2OrderDollars: price ${price} out of (0,1)`);
  const body = {
    ticker,
    side,
    price: p.toFixed(4),
    count: toCountFp(count),
    time_in_force: time_in_force || "good_till_canceled",
    self_trade_prevention_type: "taker_at_cross",
  };
  if (post_only) body.post_only = true;
  if (client_order_id) body.client_order_id = client_order_id;
  return body;
}

// Cancel path for a resting V2 order.
export function ordersV2CancelPath(orderId) {
  if (!orderId) throw new Error("ordersV2CancelPath: missing orderId");
  return `${ORDERS_V2_PATH}/${orderId}`;
}
