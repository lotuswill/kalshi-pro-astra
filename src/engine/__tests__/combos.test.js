import { describe, it, expect } from "vitest";
import {
  legLivePrice, comboFairValue, spreadMetrics, opportunityScore,
  isNewMarket, volumePulse, priceShift, isHotMarket, eventChatter,
  combosWorthPricing, uniqueLegTickers, newOpportunityIds,
} from "../combos.js";

const NOW = Date.parse("2026-09-02T02:00:00Z");

describe("legLivePrice", () => {
  it("settled legs are 0/1", () => {
    expect(legLivePrice({ result: "yes" })).toBe(1);
    expect(legLivePrice({ result: "no" })).toBe(0);
  });
  it("uses the book mid when the book is real", () => {
    expect(legLivePrice({ yes_bid_dollars: "0.5500", yes_ask_dollars: "0.5900" })).toBe(0.57);
  });
  it("falls back to last trade on a degenerate book", () => {
    expect(legLivePrice({ yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000", last_price_dollars: "0.6200" })).toBe(0.62);
  });
  it("null when nothing usable", () => {
    expect(legLivePrice({ yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000", last_price_dollars: "0.0000" })).toBe(null);
  });
});

describe("comboFairValue", () => {
  const combo = { mve_selected_legs: [
    { market_ticker: "A", side: "yes" },
    { market_ticker: "B", side: "yes" },
    { market_ticker: "C", side: "no" },
  ]};
  it("product of leg prices, NO legs inverted", () => {
    const r = comboFairValue(combo, { A: 0.6, B: 0.5, C: 0.3 });
    expect(r.known).toBe(true);
    expect(r.fair).toBeCloseTo(0.6 * 0.5 * 0.7, 4); // C inverts to 0.7
  });
  it("unknown until every leg is priced", () => {
    const r = comboFairValue(combo, { A: 0.6, B: 0.5 });
    expect(r.known).toBe(false);
    expect(r.fair).toBe(null);
    expect(r.unknown).toEqual(["C"]);
  });
});

describe("spreadMetrics + opportunityScore", () => {
  const m = { yes_bid_dollars: "0.1600", yes_ask_dollars: "0.3000", yes_bid_size_fp: "5000.00" };
  it("spread = fair − best bid; ask discount when ask below fair", () => {
    const s = spreadMetrics(m, 0.30);
    expect(s.spread).toBeCloseTo(0.14, 4);
    expect(s.spreadPct).toBeCloseTo(46.7, 1);
    expect(s.askDiscount).toBeCloseTo(0, 4);
    expect(s.bidSize).toBe(5000);
  });
  it("wide spread on big OI outranks either alone", () => {
    const wideSmall = opportunityScore({ spread: 0.14, oi: 100 });
    const wideBig = opportunityScore({ spread: 0.14, oi: 100000 });
    const narrowBig = opportunityScore({ spread: 0.02, oi: 100000 });
    expect(wideBig).toBeGreaterThan(wideSmall);
    expect(wideBig).toBeGreaterThan(narrowBig);
    expect(opportunityScore({ spread: null, oi: 5 })).toBe(-Infinity);
  });
});

describe("freshness / volatility", () => {
  it("flags markets opened in the last 24h", () => {
    expect(isNewMarket({ open_time: "2026-09-01T12:00:00Z" }, NOW)).toBe(true);
    expect(isNewMarket({ open_time: "2026-08-25T12:00:00Z" }, NOW)).toBe(false);
  });
  it("volumePulse ratio = 24h share of lifetime volume", () => {
    expect(volumePulse({ volume_24h_fp: "800.00", volume_fp: "1000.00" }).ratio).toBe(0.8);
    expect(volumePulse({ volume_24h_fp: "0.00", volume_fp: "0.00" }).ratio).toBe(null);
  });
  it("priceShift reads last vs previous", () => {
    expect(priceShift({ last_price_dollars: "0.6200", previous_price_dollars: "0.4500" })).toBeCloseTo(0.17, 4);
    expect(priceShift({ last_price_dollars: "0.0000", previous_price_dollars: "0.0000" })).toBe(null);
  });
  it("isHotMarket: volume surge on an aged market, or a hard price move", () => {
    const surge = { volume_24h_fp: "900.00", volume_fp: "1000.00", open_time: "2026-08-20T00:00:00Z" };
    expect(isHotMarket(surge, NOW).hot).toBe(true);
    const jump = { volume_24h_fp: "150.00", volume_fp: "5000.00", open_time: "2026-08-20T00:00:00Z", last_price_dollars: "0.6200", previous_price_dollars: "0.4500" };
    expect(isHotMarket(jump, NOW).hot).toBe(true);
    const quietNew = { volume_24h_fp: "900.00", volume_fp: "1000.00", open_time: "2026-09-01T12:00:00Z" };
    expect(isHotMarket(quietNew, NOW).hot).toBe(false); // young: 24h-heavy is normal
  });
});

describe("eventChatter", () => {
  const mk = (ev, v24, last, prev) => ({ event_ticker: ev, volume_24h_fp: String(v24), volume_fp: "9999", last_price_dollars: String(last), previous_price_dollars: String(prev), title: ev });
  it("aggregates 24h volume by event, hottest first, keeps max shift", () => {
    const out = eventChatter([mk("E1", 500, 0.6, 0.55), mk("E1", 700, 0.3, 0.62), mk("E2", 300, 0.5, 0.5)]);
    expect(out[0].event).toBe("E1");
    expect(out[0].v24).toBe(1200);
    expect(out[0].maxShift).toBeCloseTo(-0.32, 4);
    expect(out[1].event).toBe("E2");
  });
  it("drops events under the volume floor", () => {
    expect(eventChatter([mk("E3", 50, 0.5, 0.5)]).length).toBe(0);
  });
});

describe("scan filtering", () => {
  it("combosWorthPricing keeps OI + any life", () => {
    const rows = combosWorthPricing([
      { ticker: "a", open_interest_fp: "500.00", yes_bid_dollars: "0.1000", volume_fp: "0" },
      { ticker: "b", open_interest_fp: "50.00", yes_bid_dollars: "0.1000", volume_fp: "9" },
      { ticker: "c", open_interest_fp: "500.00", yes_bid_dollars: "0.0000", volume_fp: "0.00" },
    ], { minOI: 100 });
    expect(rows.map(r => r.ticker)).toEqual(["a"]);
  });
  it("uniqueLegTickers dedupes across combos", () => {
    const cs = [
      { mve_selected_legs: [{ market_ticker: "A" }, { market_ticker: "B" }] },
      { mve_selected_legs: [{ market_ticker: "B" }, { market_ticker: "C" }] },
    ];
    expect(uniqueLegTickers(cs).sort()).toEqual(["A", "B", "C"]);
  });
  it("newOpportunityIds flags unseen wide spreads only", () => {
    const rows = [
      { ticker: "x", spread: 0.05 }, { ticker: "y", spread: 0.01 }, { ticker: "z", spread: 0.08 },
    ];
    expect(newOpportunityIds(new Set(["z"]), rows, { minSpread: 0.03 })).toEqual(["x"]);
  });
});
