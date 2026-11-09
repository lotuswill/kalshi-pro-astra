import { describe, it, expect } from "vitest";
import {
  RFQS_PATH, QUOTES_PATH, rfqDeletePath, quoteAcceptPath, quoteConfirmPath,
  normalizeRfq, normalizeQuote, filterRfqs, newRfqIds,
  quoteYesBid, rfqEdge, toRfqBody, toQuoteBody,
  needsConfirm, confirmSecondsLeft, bestQuoteForBuyingYes, bestQuoteForSellingYes, shouldAutoQuote,
} from "../rfq.js";

describe("paths", () => {
  it("targets the communications endpoints", () => {
    expect(RFQS_PATH).toBe("/communications/rfqs");
    expect(QUOTES_PATH).toBe("/communications/quotes");
    expect(rfqDeletePath("r1")).toBe("/communications/rfqs/r1");
    expect(quoteAcceptPath("r1", "q1")).toBe("/communications/rfqs/r1/quotes/q1/accept");
    expect(quoteConfirmPath("r1", "q1")).toBe("/communications/rfqs/r1/quotes/q1/confirm");
    expect(() => rfqDeletePath("")).toThrow();
    expect(() => quoteAcceptPath("r1", "")).toThrow();
  });
});

describe("normalizeRfq", () => {
  it("parses fp counts, dollars, timestamps and ownership", () => {
    const r = normalizeRfq({
      id: "r1", market_ticker: "KXMVE-X", contracts_fp: "500.00",
      target_cost_dollars: "80.0000", status: "open",
      created_ts: "2026-08-31T12:00:00Z", updated_ts: "2026-08-31T12:05:00Z",
      rest_remainder: true, creator_user_id: "u_me",
    });
    expect(r.contracts).toBe(500);
    expect(r.targetCost).toBe(80);
    expect(r.createdMs).toBe(Date.parse("2026-08-31T12:00:00Z"));
    expect(r.mine).toBe(true);
    expect(r.restRemainder).toBe(true);
  });
  it("marks foreign RFQs (no private creator_user_id) as not mine", () => {
    expect(normalizeRfq({ id: "r2", market_ticker: "T" }).mine).toBe(false);
  });
});

describe("normalizeQuote", () => {
  it("reads dollar-string bids and status", () => {
    const q = normalizeQuote({
      id: "q1", rfq_id: "r1", market_ticker: "KXMVE-X", contracts_fp: "500.00",
      yes_bid_dollars: "0.1610", no_bid_dollars: "0.0000", status: "accepted",
      created_ts: "2026-08-31T12:00:00Z", updated_ts: "2026-08-31T12:06:00Z",
    });
    expect(q.yesBid).toBe(0.161);
    expect(q.noBid).toBe(0);
    expect(q.status).toBe("accepted");
    expect(q.contracts).toBe(500);
  });
});

describe("filterRfqs / newRfqIds", () => {
  const mk = (id, ticker, o = {}) => normalizeRfq({ id, market_ticker: ticker, status: "open", created_ts: `2026-08-31T12:0${id.slice(-1)}:00Z`, ...o });
  const rfqs = [mk("r1", "A"), mk("r2", "B"), mk("r3", "A", { status: "closed" }), mk("r4", "A", { creator_user_id: "me" })];

  it("keeps open RFQs on watched tickers, newest first, excluding ours", () => {
    const out = filterRfqs(rfqs, new Set(["A"]));
    expect(out.map(r => r.id)).toEqual(["r1"]);
  });
  it("includeMine keeps our own", () => {
    expect(filterRfqs(rfqs, ["A"], { includeMine: true }).map(r => r.id)).toEqual(["r4", "r1"]);
  });
  it("empty watch set matches everything open", () => {
    expect(filterRfqs(rfqs, new Set()).length).toBe(2);
  });
  it("newRfqIds flags only unseen ids", () => {
    expect(newRfqIds(new Set(["r1"]), filterRfqs(rfqs, ["A", "B"]))).toEqual(["r2"]);
  });
});

describe("quoteYesBid — the payout − Z floor", () => {
  it("floors payout − margin to the tick", () => {
    expect(quoteYesBid({ payout: 0.2412, margin: 0.08, tick: 0.001 }).price).toBeCloseTo(0.161, 4);
  });
  it("refuses when there's no room", () => {
    expect(quoteYesBid({ payout: 0.05, margin: 0.08, tick: 0.001 }).price).toBe(null);
    expect(quoteYesBid({ payout: null, margin: 0.08 }).price).toBe(null);
  });
});

describe("rfqEdge", () => {
  it("dollar edge on a full fill", () => {
    expect(rfqEdge({ payout: 0.2412, yesBid: 0.161, contracts: 3000 })).toBeCloseTo(240.6, 2);
  });
  it("null when inputs missing", () => {
    expect(rfqEdge({ payout: null, yesBid: 0.16, contracts: 100 })).toBe(null);
  });
});

describe("toRfqBody / toQuoteBody", () => {
  it("builds a create-RFQ body with fp count", () => {
    expect(toRfqBody({ ticker: "KXMVE-X", contracts: 3000 })).toEqual({
      market_ticker: "KXMVE-X", contracts_fp: "3000.00", rest_remainder: false,
    });
  });
  it("builds a one-sided YES quote", () => {
    expect(toQuoteBody({ rfq_id: "r1", yesBid: 0.161 })).toEqual({
      rfq_id: "r1", yes_bid: "0.1610", no_bid: "0.0000", rest_remainder: false,
    });
  });
  it("enforces exchange constraints", () => {
    expect(() => toQuoteBody({ rfq_id: "r1", yesBid: 0, noBid: 0 })).toThrow(/non-zero/);
    expect(() => toQuoteBody({ rfq_id: "r1", yesBid: 0.6, noBid: 0.5 })).toThrow(/≤ \$1/);
    expect(() => toRfqBody({ ticker: "", contracts: 10 })).toThrow();
    expect(() => toRfqBody({ ticker: "T", contracts: 0 })).toThrow();
  });
});

describe("confirm window", () => {
  const t0 = Date.parse("2026-08-31T12:00:00Z");
  const accepted = normalizeQuote({ id: "q", rfq_id: "r", status: "accepted", updated_ts: "2026-08-31T12:00:00Z" });
  it("accepted quotes need confirmation inside 30s", () => {
    expect(needsConfirm(accepted, t0 + 10_000)).toBe(true);
    expect(needsConfirm(accepted, t0 + 31_000)).toBe(false);
    expect(needsConfirm({ ...accepted, status: "open" }, t0)).toBe(false);
  });
  it("counts down the seconds", () => {
    expect(confirmSecondsLeft(accepted, t0 + 10_000)).toBe(20);
    expect(confirmSecondsLeft(accepted, t0 + 40_000)).toBe(0);
  });
});

describe("shouldAutoQuote — the responder bot's trigger", () => {
  const rfq = normalizeRfq({ id: "r1", market_ticker: "KXMVE-X", contracts_fp: "2500.00", status: "open" });
  const base = { rfq, price: 0.161, maxContracts: 5000, quotedIds: new Set() };

  it("fires on a fresh open RFQ under the cap with a known floor", () => {
    expect(shouldAutoQuote(base).ok).toBe(true);
  });
  it("skips RFQs above the share cap (quotes must cover full size)", () => {
    const r = shouldAutoQuote({ ...base, maxContracts: 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/above cap/);
  });
  it("never double-quotes, never quotes our own, never without a floor", () => {
    expect(shouldAutoQuote({ ...base, quotedIds: new Set(["r1"]) }).ok).toBe(false);
    expect(shouldAutoQuote({ ...base, rfq: { ...rfq, mine: true } }).ok).toBe(false);
    expect(shouldAutoQuote({ ...base, price: null }).ok).toBe(false);
    expect(shouldAutoQuote({ ...base, rfq: { ...rfq, status: "closed" } }).ok).toBe(false);
  });
  it("no cap set means any size goes", () => {
    expect(shouldAutoQuote({ ...base, maxContracts: "" }).ok).toBe(true);
  });
});

describe("bestQuoteForBuyingYes", () => {
  const qs = [
    normalizeQuote({ id: "a", status: "open", no_bid_dollars: "0.7500" }),
    normalizeQuote({ id: "b", status: "open", no_bid_dollars: "0.8000" }),
    normalizeQuote({ id: "c", status: "cancelled", no_bid_dollars: "0.9000" }),
  ];
  it("picks the highest open no_bid → cheapest YES entry", () => {
    const r = bestQuoteForBuyingYes(qs);
    expect(r.quote.id).toBe("b");
    expect(r.yesCostPerShare).toBeCloseTo(0.20, 4);
  });
  it("null when no usable quotes", () => {
    expect(bestQuoteForBuyingYes([qs[2]])).toBe(null);
  });
  it("selling YES exits at the highest open yes_bid", () => {
    const sq = [
      normalizeQuote({ id: "a", status: "open", yes_bid_dollars: "0.1500" }),
      normalizeQuote({ id: "b", status: "open", yes_bid_dollars: "0.1800" }),
      normalizeQuote({ id: "c", status: "cancelled", yes_bid_dollars: "0.9000" }),
    ];
    const r = bestQuoteForSellingYes(sq);
    expect(r.quote.id).toBe("b");
    expect(r.yesProceedsPerShare).toBeCloseTo(0.18, 4);
    expect(bestQuoteForSellingYes([sq[2]])).toBe(null);
  });
});
