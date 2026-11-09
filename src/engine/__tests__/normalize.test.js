import { describe, it, expect } from "vitest";
import { dollarsToCents, toInt, normalizeMarket, normalizeEvent } from "../normalize.js";

describe("dollarsToCents", () => {
  it("converts decimal-dollar strings to integer cents", () => {
    expect(dollarsToCents("0.5600")).toBe(56);
    expect(dollarsToCents("0.2100")).toBe(21);
    expect(dollarsToCents("1.0000")).toBe(100);
  });
  it("handles numbers and rounds", () => {
    expect(dollarsToCents(0.555)).toBe(56);
  });
  it("is safe on null/garbage", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents("abc")).toBe(0);
  });
});

describe("toInt", () => {
  it("rounds float strings", () => {
    expect(toInt("111.65")).toBe(112);
    expect(toInt("0.00")).toBe(0);
  });
});

describe("normalizeMarket", () => {
  it("maps the live dollar-string schema to cents", () => {
    const live = {
      ticker: "KXMLBGAME-26JUL052130BOSLAA-BOS",
      yes_bid_dollars: "0.5600", yes_ask_dollars: "0.5900",
      no_bid_dollars: "0.4100", no_ask_dollars: "0.4400",
      last_price_dollars: "0.6000", volume_fp: "111.65",
      volume_24h_fp: "111.65", open_interest_fp: "111.65",
    };
    const m = normalizeMarket(live);
    expect(m.yes_bid).toBe(56);
    expect(m.yes_ask).toBe(59);
    expect(m.no_bid).toBe(41);
    expect(m.no_ask).toBe(44);
    expect(m.last_price).toBe(60);
    expect(m.volume).toBe(112);
    expect(m.open_interest).toBe(112);
  });

  it("passes through markets already in cents (fixtures / future API)", () => {
    const cents = { ticker: "X", yes_bid: 40, yes_ask: 44, volume: 1000 };
    expect(normalizeMarket(cents)).toBe(cents); // untouched reference
  });

  it("is idempotent", () => {
    const live = { ticker: "X", yes_bid_dollars: "0.5000", yes_ask_dollars: "0.5200" };
    const once = normalizeMarket(live);
    const twice = normalizeMarket(once);
    expect(twice.yes_bid).toBe(50);
    expect(twice.yes_ask).toBe(52);
  });
});

describe("normalizeEvent", () => {
  it("normalizes every nested market", () => {
    const e = normalizeEvent({
      event_ticker: "E", series_ticker: "KXMLBGAME",
      markets: [
        { ticker: "A", yes_bid_dollars: "0.2100", yes_ask_dollars: "0.7300" },
        { ticker: "B", yes_bid_dollars: "0.2800", yes_ask_dollars: "0.6100" },
      ],
    });
    expect(e.markets[0].yes_bid).toBe(21);
    expect(e.markets[1].yes_ask).toBe(61);
  });
});
