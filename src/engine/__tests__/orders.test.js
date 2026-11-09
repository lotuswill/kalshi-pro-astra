import { describe, it, expect } from "vitest";
import { toV2Order, toV2OrderDollars, ordersV2CancelPath, centsToDollars, toCountFp, orderIdOf, ORDERS_V2_PATH } from "../orders.js";

describe("centsToDollars", () => {
  it("converts integer cents to 4-decimal dollar strings", () => {
    expect(centsToDollars(56)).toBe("0.5600");
    expect(centsToDollars(1)).toBe("0.0100");
    expect(centsToDollars(99)).toBe("0.9900");
  });
  it("is safe on junk", () => {
    expect(centsToDollars(undefined)).toBe("0.0000");
    expect(centsToDollars("nope")).toBe("0.0000");
  });
});

describe("toCountFp", () => {
  it("formats integers with two decimals", () => {
    expect(toCountFp(10)).toBe("10.00");
    expect(toCountFp("3")).toBe("3.00");
  });
  it("rejects non-positive counts", () => {
    expect(toCountFp(0)).toBe("0.00");
    expect(toCountFp(-5)).toBe("0.00");
  });
});

describe("toV2Order", () => {
  const base = { ticker: "KXNBAGAME-26OCT20BOSDET-BOS", count: 10, type: "limit" };

  it("buy YES @ 56¢ → bid @ 0.5600", () => {
    const o = toV2Order({ ...base, side: "yes", action: "buy", yes_price: 56 });
    expect(o.side).toBe("bid");
    expect(o.price).toBe("0.5600");
    expect(o.count).toBe("10.00");
    expect(o.time_in_force).toBe("good_till_canceled");
    expect(o.self_trade_prevention_type).toBe("taker_at_cross");
  });

  it("sell YES @ 56¢ → ask @ 0.5600", () => {
    const o = toV2Order({ ...base, side: "yes", action: "sell", yes_price: 56 });
    expect(o.side).toBe("ask");
    expect(o.price).toBe("0.5600");
  });

  it("buy NO @ 30¢ → ask @ 0.7000 (sell YES at 100−q)", () => {
    const o = toV2Order({ ...base, side: "no", action: "buy", no_price: 30 });
    expect(o.side).toBe("ask");
    expect(o.price).toBe("0.7000");
  });

  it("sell NO @ 30¢ → bid @ 0.7000 (buy YES at 100−q)", () => {
    const o = toV2Order({ ...base, side: "no", action: "sell", no_price: 30 });
    expect(o.side).toBe("bid");
    expect(o.price).toBe("0.7000");
  });

  it("market buy → aggressive IOC bid at 0.9900", () => {
    const o = toV2Order({ ...base, type: "market", side: "yes", action: "buy" });
    expect(o.side).toBe("bid");
    expect(o.price).toBe("0.9900");
    expect(o.time_in_force).toBe("immediate_or_cancel");
  });

  it("market sell → aggressive IOC ask at 0.0100", () => {
    const o = toV2Order({ ...base, type: "market", side: "yes", action: "sell", yes_price: 40 });
    expect(o.side).toBe("ask");
    expect(o.price).toBe("0.0100");
    expect(o.time_in_force).toBe("immediate_or_cancel");
  });

  it("clamps prices into 1–99¢", () => {
    expect(toV2Order({ ...base, side: "yes", action: "buy", yes_price: 0 }).price).toBe("0.0100");
    expect(toV2Order({ ...base, side: "yes", action: "buy", yes_price: 120 }).price).toBe("0.9900");
  });

  it("passes post_only and client_order_id through", () => {
    const o = toV2Order({ ...base, side: "yes", action: "buy", yes_price: 50, post_only: true, client_order_id: "abc" });
    expect(o.post_only).toBe(true);
    expect(o.client_order_id).toBe("abc");
  });

  it("throws without a ticker", () => {
    expect(() => toV2Order({ side: "yes", action: "buy" })).toThrow();
  });
});

describe("orderIdOf", () => {
  it("reads V2 top-level order_id", () => {
    expect(orderIdOf({ order_id: "abc123", ts_ms: 1 })).toBe("abc123");
  });
  it("reads legacy nested order.order_id", () => {
    expect(orderIdOf({ order: { order_id: "xyz" } })).toBe("xyz");
  });
  it("returns null when absent", () => {
    expect(orderIdOf({})).toBeNull();
    expect(orderIdOf(undefined)).toBeNull();
  });
});

describe("ORDERS_V2_PATH", () => {
  it("targets the V2 event-orders endpoint", () => {
    expect(ORDERS_V2_PATH).toBe("/portfolio/events/orders");
  });
});

describe("toV2OrderDollars (sub-cent combos)", () => {
  it("keeps deci-cent precision", () => {
    const o = toV2OrderDollars({ ticker: "KXMVE-X", side: "bid", price: 0.162, count: 3000 });
    expect(o.price).toBe("0.1620");
    expect(o.count).toBe("3000.00");
    expect(o.time_in_force).toBe("good_till_canceled");
  });
  it("accepts fixed-point strings", () => {
    expect(toV2OrderDollars({ ticker: "T", side: "ask", price: "0.1955", count: 1 }).price).toBe("0.1955");
  });
  it("rejects out-of-range prices and bad sides", () => {
    expect(() => toV2OrderDollars({ ticker: "T", side: "bid", price: 0, count: 1 })).toThrow();
    expect(() => toV2OrderDollars({ ticker: "T", side: "bid", price: 1.2, count: 1 })).toThrow();
    expect(() => toV2OrderDollars({ ticker: "T", side: "yes", price: 0.5, count: 1 })).toThrow();
  });
});

describe("ordersV2CancelPath", () => {
  it("builds the DELETE path", () => {
    expect(ordersV2CancelPath("abc")).toBe("/portfolio/events/orders/abc");
    expect(() => ordersV2CancelPath("")).toThrow();
  });
});
