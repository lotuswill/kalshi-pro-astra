// ═══════════════════════════════════════════════════════════════
// RFQ DESK ENGINE — pure logic for Kalshi's Request-for-Quote flow.
//
// RFQs are the negotiated side of combo trading: a holder broadcasts
// "I want to trade N contracts of this combo", makers answer with
// private two-sided quotes, the requester accepts one side, and the
// MAKER MUST CONFIRM WITHIN ~30 SECONDS or the trade dies. Nothing
// rests on the public book until after execution.
//
// Endpoints (verified against docs.kalshi.com 2026-08-31):
//   GET    /communications/rfqs?market_ticker=&status=open
//   POST   /communications/rfqs        {market_ticker, contracts_fp,
//                                       rest_remainder, replace_existing?}
//   DELETE /communications/rfqs/{id}
//   GET    /communications/quotes?rfq_id=&user_filter=self&status=
//   POST   /communications/quotes      {rfq_id, yes_bid, no_bid,
//                                       rest_remainder, post_only?}
//          yes_bid/no_bid are dollar STRINGS; yes_bid + no_bid ≤ 1;
//          at least one side non-zero; prices on the market's grid.
//   PUT    /communications/rfqs/{rfq}/quotes/{q}/accept  {accepted_side}
//   PUT    /communications/rfqs/{rfq}/quotes/{q}/confirm (maker, ≤30s)
//
// Strategy tie-in: our quote's yes_bid uses the same profit floor as
// the book quoter — payout − margin (Z), floored to the market tick —
// but needs no step-above-competition logic because quotes are private.
// ═══════════════════════════════════════════════════════════════

import { floorToTick } from "./postponements.js";

export const RFQS_PATH = "/communications/rfqs";
export const QUOTES_PATH = "/communications/quotes";

export function rfqDeletePath(rfqId) {
  if (!rfqId) throw new Error("rfqDeletePath: missing rfqId");
  return `${RFQS_PATH}/${rfqId}`;
}
export function quoteAcceptPath(rfqId, quoteId) {
  if (!rfqId || !quoteId) throw new Error("quoteAcceptPath: missing id");
  return `${RFQS_PATH}/${rfqId}/quotes/${quoteId}/accept`;
}
export function quoteConfirmPath(rfqId, quoteId) {
  if (!rfqId || !quoteId) throw new Error("quoteConfirmPath: missing id");
  return `${RFQS_PATH}/${rfqId}/quotes/${quoteId}/confirm`;
}

// ── Normalization ───────────────────────────────────────────────
const num = v => { const n = typeof v === "string" ? parseFloat(v) : v; return isFinite(n) ? n : null; };

export function normalizeRfq(r = {}) {
  return {
    id: r.id,
    ticker: r.market_ticker || "",
    contracts: num(r.contracts_fp) ?? num(r.contracts) ?? null,
    targetCost: num(r.target_cost_dollars),
    status: r.status || "open",
    createdMs: Date.parse(r.created_ts || "") || 0,
    updatedMs: Date.parse(r.updated_ts || r.created_ts || "") || 0,
    legs: r.mve_selected_legs || null,
    restRemainder: !!r.rest_remainder,
    // creator_user_id is a private field: present only on our own RFQs.
    mine: r.creator_user_id != null,
    raw: r,
  };
}

export function normalizeQuote(q = {}) {
  return {
    id: q.id,
    rfqId: q.rfq_id,
    ticker: q.market_ticker || "",
    contracts: num(q.contracts_fp) ?? null,
    yesBid: num(q.yes_bid_dollars ?? q.yes_bid),
    noBid: num(q.no_bid_dollars ?? q.no_bid),
    status: q.status || "open", // open|accepted|confirmed|executed|cancelled
    acceptedSide: q.accepted_side || null,
    createdMs: Date.parse(q.created_ts || "") || 0,
    updatedMs: Date.parse(q.updated_ts || q.created_ts || "") || 0,
    raw: q,
  };
}

// ── Watch + alert helpers ───────────────────────────────────────
// Keep RFQs that are open and on a watched combo ticker, newest first.
export function filterRfqs(rfqs = [], watched, { openOnly = true, includeMine = false } = {}) {
  const w = watched instanceof Set ? watched : new Set(watched || []);
  return rfqs
    .filter(r => (!openOnly || r.status === "open")
      && (includeMine || !r.mine)
      && (!w.size || w.has(r.ticker)))
    .sort((a, b) => b.createdMs - a.createdMs);
}

// Which of these RFQ ids haven't been seen before? (for toast alerts)
export function newRfqIds(prevIds, rfqs = []) {
  const seen = prevIds instanceof Set ? prevIds : new Set(prevIds || []);
  return rfqs.filter(r => r.id && !seen.has(r.id)).map(r => r.id);
}

// ── Quote pricing — the payout − Z floor ────────────────────────
// Suggested YES bid for quoting an RFQ: payout − margin, floored to
// the market tick. Private negotiation ⇒ no bestBid/step input.
export function quoteYesBid({ payout, margin, tick = 0.001 }) {
  if (payout == null || !isFinite(payout)) return { price: null, reason: "payout unknown" };
  const p = floorToTick(payout - margin, tick);
  if (p == null || p < tick) return { price: null, reason: "payout − margin leaves no room" };
  return { price: p, reason: "payout − margin floor" };
}

// Edge in dollars if a YES quote fills in full.
export function rfqEdge({ payout, yesBid, contracts }) {
  if (payout == null || yesBid == null || !contracts) return null;
  return Math.round((payout - yesBid) * contracts * 100) / 100;
}

// ── Request bodies ──────────────────────────────────────────────
const fp2 = n => { const v = Number(n); if (!isFinite(v) || v <= 0) throw new Error(`bad count ${n}`); return v.toFixed(2); };
const dollars4 = n => { const v = Number(n); if (!isFinite(v) || v < 0 || v > 1) throw new Error(`bad price ${n}`); return v.toFixed(4); };

// Create an RFQ (us as requester, e.g. asking to buy X shares).
export function toRfqBody({ ticker, contracts, rest_remainder = false, replace_existing }) {
  if (!ticker) throw new Error("toRfqBody: missing ticker");
  const body = { market_ticker: ticker, contracts_fp: fp2(contracts), rest_remainder: !!rest_remainder };
  if (replace_existing) body.replace_existing = true;
  return body;
}

// Quote an RFQ (us as maker). One-sided YES by default: yes_bid at our
// floor, no_bid 0. Validates the exchange's constraints up front.
export function toQuoteBody({ rfq_id, yesBid, noBid = 0, rest_remainder = false, post_only }) {
  if (!rfq_id) throw new Error("toQuoteBody: missing rfq_id");
  const y = Number(yesBid) || 0, n = Number(noBid) || 0;
  if (y <= 0 && n <= 0) throw new Error("toQuoteBody: at least one side must be non-zero");
  if (y + n > 1 + 1e-9) throw new Error("toQuoteBody: yes_bid + no_bid must be ≤ $1");
  const body = { rfq_id, yes_bid: dollars4(y), no_bid: dollars4(n), rest_remainder: !!rest_remainder };
  if (post_only) body.post_only = true;
  return body;
}

// ── Auto-responder guard ────────────────────────────────────────
// Tim's insight: almost all combo cash-out volume arrives as RFQs
// (Kalshi's cash-out screen fires one automatically), and a fat bid
// sitting in the public book just tells competing responders what to
// top by 0.1¢. So the responder quotes RFQs directly — and this guard
// decides, for one incoming RFQ, whether the bot should fire.
//   rfq          — normalized RFQ
//   price        — the suggested yes bid (null = no floor available)
//   maxContracts — per-RFQ size cap (a quote must cover the FULL size)
//   quotedIds    — Set of RFQ ids we already quoted
// Returns { ok, reason }.
export function shouldAutoQuote({ rfq, price, maxContracts, quotedIds }) {
  if (!rfq?.id) return { ok: false, reason: "no rfq" };
  if (rfq.status !== "open") return { ok: false, reason: "rfq not open" };
  if (rfq.mine) return { ok: false, reason: "our own rfq" };
  if (quotedIds && quotedIds.has(rfq.id)) return { ok: false, reason: "already quoted" };
  if (price == null || !isFinite(price) || price <= 0) return { ok: false, reason: "no payout floor" };
  const cap = Number(maxContracts);
  if (!rfq.contracts || rfq.contracts <= 0) return { ok: false, reason: "no size" };
  if (isFinite(cap) && cap > 0 && rfq.contracts > cap) return { ok: false, reason: `size ${rfq.contracts} above cap ${cap}` };
  return { ok: true, reason: "quote it" };
}

// ── Lifecycle helpers ───────────────────────────────────────────
// A quote of OURS that the requester accepted needs confirmation
// within ~30s of its acceptance (updated_ts moves on acceptance).
export function needsConfirm(quote, now = Date.now(), windowMs = 30_000) {
  if (!quote || quote.status !== "accepted") return false;
  const left = quote.updatedMs ? quote.updatedMs + windowMs - now : windowMs;
  return left > 0;
}
export function confirmSecondsLeft(quote, now = Date.now(), windowMs = 30_000) {
  if (!quote?.updatedMs) return null;
  return Math.max(0, Math.ceil((quote.updatedMs + windowMs - now) / 1000));
}

// Best quote on OUR RFQ when our goal is to END UP LONG YES.
// A maker's quote is two bids: yes_bid (maker buys YES) and no_bid
// (maker buys NO). The requester accepts the side they want to SELL.
// Selling NO at no_bid leaves us long YES at an effective cost of
// (1 − no_bid) per share — so the cheapest YES entry is the quote
// with the HIGHEST no_bid.
export function bestQuoteForBuyingYes(quotes = []) {
  const open = quotes.filter(q => q.status === "open" && q.noBid != null && q.noBid > 0);
  if (!open.length) return null;
  const best = open.reduce((a, b) => (b.noBid > a.noBid ? b : a));
  return { quote: best, yesCostPerShare: Math.round((1 - best.noBid) * 10000) / 10000 };
}

// And the mirror: to SELL YES (exit a long), accept the maker's YES
// side — they buy our contracts at their yes_bid, so the best exit is
// the quote with the HIGHEST yes_bid.
export function bestQuoteForSellingYes(quotes = []) {
  const open = quotes.filter(q => q.status === "open" && q.yesBid != null && q.yesBid > 0);
  if (!open.length) return null;
  const best = open.reduce((a, b) => (b.yesBid > a.yesBid ? b : a));
  return { quote: best, yesProceedsPerShare: best.yesBid };
}
