import { describe, it, expect } from "vitest";
import {
  isPostponedGameMarket, postponementDeadline, restartRule, scheduledStartFromTicker,
  priceAtPostponement, comboPayout, marketTick, tickAtPrice, floorToTick, autoBidTarget,
  bestCompetingBid, sortCombos, deadlineWindows,
} from "../postponements.js";

const NOW = Date.parse("2026-08-31T12:00:00Z");

const postponedLeg = {
  ticker: "KXKBOGAME-26AUG300500KTWSAM-SAM",
  market_type: "binary", status: "active", result: "",
  expected_expiration_time: "2026-08-30T13:00:00Z",
  close_time: "2026-09-01T09:00:00Z",
};

describe("isPostponedGameMarket", () => {
  it("flags an active market whose expected expiration passed but close extended", () => {
    expect(isPostponedGameMarket(postponedLeg, NOW)).toBe(true);
  });
  it("ignores settled markets", () => {
    expect(isPostponedGameMarket({ ...postponedLeg, status: "finalized", result: "yes" }, NOW)).toBe(false);
  });
  it("ignores games still inside the grace window (running long)", () => {
    const m = { ...postponedLeg, expected_expiration_time: "2026-08-31T11:00:00Z" };
    expect(isPostponedGameMarket(m, NOW)).toBe(false);
  });
  it("ignores markets past their deadline", () => {
    const m = { ...postponedLeg, close_time: "2026-08-31T09:00:00Z" };
    expect(isPostponedGameMarket(m, NOW)).toBe(false);
  });
});

describe("deadline + rules", () => {
  it("deadline is the extended close_time", () => {
    expect(postponementDeadline(postponedLeg)).toBe(Date.parse("2026-09-01T09:00:00Z"));
  });
  it("baseball series get the 48h label; others ~2 weeks", () => {
    expect(restartRule("KXKBOGAME")).toMatch(/48h/);
    expect(restartRule("KXNPBSPREAD")).toMatch(/48h/);
    expect(restartRule("KXNFLGAME")).toMatch(/2 weeks/);
    expect(restartRule("KXEPLGAME")).toMatch(/2 weeks/);
  });
});

describe("scheduledStartFromTicker", () => {
  it("parses date+time tickers", () => {
    expect(scheduledStartFromTicker("KXKBOGAME-26AUG300500KIWDOO-DOO")).toBe(Date.UTC(2026, 7, 30, 5, 0));
    expect(scheduledStartFromTicker("KXNPBGAME-26SEP010500FUKHOK-FUK")).toBe(Date.UTC(2026, 8, 1, 5, 0));
  });
  it("returns null on junk", () => {
    expect(scheduledStartFromTicker("KXMVECROSSCATEGORY-SHARD1-R")).toBe(null);
  });
});

describe("priceAtPostponement", () => {
  const cs = [
    { end_period_ts: 1788058800, price: { close_dollars: "0.6100" } }, // 03:00Z pre-start
    { end_period_ts: 1788066000, price: { close_dollars: "0.5800" } }, // 05:00Z start
    { end_period_ts: 1788069600, price: { close_dollars: "0.5800" } },
  ];
  it("uses the first candle at/after the scheduled start", () => {
    expect(priceAtPostponement(cs, 1788066000 * 1000)).toBe(0.58);
  });
  it("falls back to the last candle when start is after all candles", () => {
    expect(priceAtPostponement(cs, 1788999999 * 1000)).toBe(0.58);
  });
  it("null on empty", () => {
    expect(priceAtPostponement([], 0)).toBe(null);
  });
});

describe("comboPayout", () => {
  const combo = { mve_selected_legs: [
    { market_ticker: "A", side: "yes" },
    { market_ticker: "B", side: "yes" },
    { market_ticker: "C", side: "yes" },
    { market_ticker: "D", side: "yes" },
  ]};
  it("product of postponed fair prices when live legs settled yes (the 11-leg case)", () => {
    const info = { A: { state: "yes" }, B: { state: "postponed", fair: 0.58 }, C: { state: "postponed", fair: 0.71 }, D: { state: "postponed", fair: 0.62 } };
    const r = comboPayout(combo, info);
    expect(r.determined).toBe(true);
    expect(r.payout).toBeCloseTo(0.58 * 0.71 * 0.62, 4); // ≈ 0.2553 — the 25–29¢ zone
  });
  it("any settled-no leg zeroes the payout", () => {
    const info = { A: { state: "no" }, B: { state: "postponed", fair: 0.58 }, C: { state: "yes" }, D: { state: "yes" } };
    expect(comboPayout(combo, info).payout).toBe(0);
  });
  it("undetermined while a leg is still open", () => {
    const info = { A: { state: "yes" }, B: { state: "open" }, C: { state: "yes" }, D: { state: "yes" } };
    const r = comboPayout(combo, info);
    expect(r.determined).toBe(false);
    expect(r.payout).toBe(null);
    expect(r.unknown).toEqual(["B"]);
  });
  it("no-side legs invert their fair price", () => {
    const c2 = { mve_selected_legs: [{ market_ticker: "A", side: "no" }] };
    expect(comboPayout(c2, { A: { state: "postponed", fair: 0.58 } }).payout).toBeCloseTo(0.42, 4);
    expect(comboPayout(c2, { A: { state: "yes" } }).payout).toBe(0);
    expect(comboPayout(c2, { A: { state: "no" } }).payout).toBe(1);
  });
});

describe("tick math", () => {
  it("reads tick from price_ranges, falls back by structure", () => {
    expect(marketTick({ price_ranges: [{ step: "0.0010" }] })).toBe(0.001);
    expect(marketTick({ price_level_structure: "deci_cent" })).toBe(0.001);
    expect(marketTick({ price_level_structure: "linear_cent" })).toBe(0.01);
  });
  it("floors to tick", () => {
    expect(floorToTick(0.1234, 0.001)).toBe(0.123);
    expect(floorToTick(0.1699, 0.01)).toBe(0.16);
  });
  it("tickAtPrice picks the band the price lands in (banded combos, live 2026-09-03)", () => {
    const banded = { price_level_structure: "center_deci_edge_centi_cent", price_ranges: [
      { start: "0.0000", end: "0.0100", step: "0.0001" },
      { start: "0.0100", end: "0.9900", step: "0.0010" },
      { start: "0.9900", end: "1.0000", step: "0.0001" },
    ]};
    expect(tickAtPrice(banded, 0.005)).toBe(0.0001);  // sub-1c edge: 0.01c
    expect(tickAtPrice(banded, 0.16)).toBe(0.001);    // center: 0.1c
    expect(tickAtPrice(banded, 0.995)).toBe(0.0001);  // >99c edge: 0.01c
    expect(tickAtPrice(banded, 0.99)).toBe(0.0001);   // boundary belongs to edge band
    expect(tickAtPrice(banded, 0.01)).toBe(0.001);    // boundary belongs to center band
  });
  it("tickAtPrice on single-band and legacy markets matches marketTick", () => {
    const deci = { price_ranges: [{ start: "0.0000", end: "1.0000", step: "0.0010" }] };
    expect(tickAtPrice(deci, 0.16)).toBe(0.001);
    expect(tickAtPrice({ price_level_structure: "linear_cent" }, 0.5)).toBe(0.01);
  });
});

describe("autoBidTarget — the X/Y/Z strategy", () => {
  const T = { payout: 0.25, step: 0.002, margin: 0.08, tick: 0.001 };
  it("bids step above the best competing bid inside the cap", () => {
    const r = autoBidTarget({ ...T, bestBid: 0.16 });
    expect(r.price).toBeCloseTo(0.162, 4); // 16.0 + 0.2 deci-cents
    expect(r.capped).toBeFalsy();
  });
  it("caps at payout − margin", () => {
    const r = autoBidTarget({ ...T, bestBid: 0.169 });
    expect(r.price).toBeCloseTo(0.17, 4); // cap = 0.25 − 0.08
    const r2 = autoBidTarget({ ...T, bestBid: 0.18 });
    expect(r2.price).toBeCloseTo(0.17, 4);
    expect(r2.capped).toBe(true);
  });
  it("with no competing bid, rests at the cap", () => {
    expect(autoBidTarget({ ...T, bestBid: 0 }).price).toBeCloseTo(0.17, 4);
  });
  it("refuses when the cap leaves no room", () => {
    expect(autoBidTarget({ ...T, payout: 0.05 }).price).toBe(null);
    expect(autoBidTarget({ ...T, payout: null }).price).toBe(null);
  });
});

describe("bestCompetingBid", () => {
  const book = [["0.1700", "10000.00"], ["0.1920", "9923.00"], ["0.1950", "1000.00"], ["0.1960", "20.00"]];
  it("finds the highest bid", () => {
    expect(bestCompetingBid(book)).toEqual({ price: 0.196, size: 20 });
  });
  it("skips a level that is entirely our own order", () => {
    const r = bestCompetingBid(book, 0.196, 20);
    expect(r.price).toBeCloseTo(0.195, 4);
  });
  it("subtracts our size from a shared level", () => {
    const r = bestCompetingBid(book, 0.195, 400);
    expect(r.price).toBeCloseTo(0.196, 4); // higher level not ours
    const r2 = bestCompetingBid([["0.1950", "1000.00"]], 0.195, 400);
    expect(r2).toEqual({ price: 0.195, size: 600 });
  });
});

describe("sortCombos / deadlineWindows", () => {
  it("sorts by fp volume and open interest", () => {
    const ms = [{ ticker: "a", volume_fp: "10", open_interest_fp: "99" }, { ticker: "b", volume_fp: "20", open_interest_fp: "1" }];
    expect(sortCombos(ms, "volume")[0].ticker).toBe("b");
    expect(sortCombos(ms, "oi")[0].ticker).toBe("a");
  });
  it("groups near-identical deadlines into one query window", () => {
    const mk = (t, close) => ({ ticker: t, close_time: close });
    const w = deadlineWindows([mk("A", "2026-09-01T09:00:00Z"), mk("B", "2026-09-01T09:00:30Z"), mk("C", "2026-09-14T00:00:00Z")]);
    expect(w.length).toBe(2);
    expect(w[0].tickers).toEqual(["A", "B"]);
  });
});
