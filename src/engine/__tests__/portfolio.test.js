import { describe, it, expect } from "vitest";
import {
  BALANCE_PATH, POSITIONS_PATH, ORDERS_LIST_PATH,
  normalizeBalance, normalizePosition, markPosition, avgCost,
  portfolioSummary, normalizeOrder, orderLabel,
} from "../portfolio.js";

describe("paths", () => {
  it("targets the portfolio endpoints", () => {
    expect(BALANCE_PATH).toBe("/portfolio/balance");
    expect(POSITIONS_PATH).toBe("/portfolio/positions");
    expect(ORDERS_LIST_PATH).toBe("/portfolio/orders");
  });
});

describe("normalizeBalance", () => {
  it("prefers dollar strings, falls back to cents", () => {
    expect(normalizeBalance({ balance_dollars: "1234.5600", portfolio_value: 250000 }))
      .toEqual({ cash: 1234.56, portfolioValue: 2500 });
    expect(normalizeBalance({ balance: 5000 }).cash).toBe(50);
  });
});

describe("normalizePosition", () => {
  it("positive position_fp = YES, negative = NO", () => {
    const yes = normalizePosition({ ticker: "KXMLBGAME-X", position_fp: "3000.00", market_exposure_dollars: "483.0000", realized_pnl_dollars: "12.5000", fees_paid_dollars: "3.2000" });
    expect(yes.side).toBe("yes");
    expect(yes.count).toBe(3000);
    expect(yes.exposure).toBe(483);
    expect(yes.realized).toBe(12.5);
    const no = normalizePosition({ ticker: "T", position_fp: "-500.00" });
    expect(no.side).toBe("no");
    expect(no.count).toBe(500);
  });
  it("flags combos by ticker", () => {
    expect(normalizePosition({ ticker: "KXMVECROSSCATEGORY-SHARD1-X-Y", position_fp: "1.00" }).isCombo).toBe(true);
  });
});

describe("markPosition", () => {
  const pos = normalizePosition({ ticker: "T", position_fp: "1000.00", market_exposure_dollars: "161.0000" });
  it("YES marks at the yes bid; unrealized = value − exposure", () => {
    const m = markPosition(pos, { yes_bid_dollars: "0.1960", yes_ask_dollars: "0.3000" });
    expect(m.mark).toBe(0.196);
    expect(m.value).toBe(196);
    expect(m.unrealized).toBeCloseTo(35, 2); // bought 16.1¢, marks 19.6¢
  });
  it("NO marks at 1 − yes ask", () => {
    const noPos = normalizePosition({ ticker: "T", position_fp: "-1000.00", market_exposure_dollars: "600.0000" });
    const m = markPosition(noPos, { yes_bid_dollars: "0.3000", yes_ask_dollars: "0.3500" });
    expect(m.mark).toBeCloseTo(0.65, 4);
    expect(m.value).toBe(650);
    expect(m.unrealized).toBe(50);
  });
  it("settled markets mark at 0/1", () => {
    expect(markPosition(pos, { result: "yes" }).mark).toBe(1);
    expect(markPosition(pos, { result: "no" }).mark).toBe(0);
  });
  it("no market data → null mark, not zero", () => {
    expect(markPosition(pos, null).mark).toBe(null);
  });
});

describe("avgCost + portfolioSummary", () => {
  it("average cost per share from exposure", () => {
    expect(avgCost({ count: 1000, exposure: 161 })).toBe(0.161);
    expect(avgCost({ count: 0, exposure: 161 })).toBe(null);
  });
  it("summary totals ignore unmarked values but count exposure", () => {
    const s = portfolioSummary([
      { exposure: 161, value: 196, unrealized: 35, realized: 0, fees: 1 },
      { exposure: 50, value: null, unrealized: null, realized: 10, fees: 0.5 },
    ]);
    expect(s.exposure).toBe(211);
    expect(s.value).toBe(196);
    expect(s.unrealized).toBe(35);
    expect(s.realized).toBe(10);
    expect(s.marked).toBe(1);
    expect(s.open).toBe(2);
  });
});

describe("normalizeOrder + orderLabel", () => {
  it("reads V2 dollar-string orders", () => {
    const o = normalizeOrder({ order_id: "o1", ticker: "KXMVE-X", side: "bid", yes_price_dollars: "0.1610", remaining_count_fp: "3000.00", initial_count_fp: "3000.00", status: "resting", created_time: "2026-09-03T12:00:00Z" });
    expect(o.price).toBe(0.161);
    expect(o.remaining).toBe(3000);
    expect(orderLabel(o)).toBe("BID 3000 @ 16.1¢");
  });
  it("reads legacy cent orders", () => {
    const o = normalizeOrder({ order_id: "o2", ticker: "KXMLBGAME-X", side: "yes", action: "buy", yes_price: 45, remaining_count: 100, status: "resting" });
    expect(o.price).toBe(0.45);
    expect(orderLabel(o)).toBe("BUY 100 YES @ 45¢");
  });
});
