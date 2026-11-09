import { describe, it, expect } from "vitest";
import { kalshiFee, kalshiFeeCents, calcArbProfit, mlToProb, midCents } from "../fees.js";

describe("kalshiFee", () => {
  it("charges taker 2¢ on a 50¢ contract (0.07 × 0.5 × 0.5 = 1.75¢, rounded up)", () => {
    expect(kalshiFeeCents(50, 1, false)).toBe(2);
  });
  it("charges maker roughly a quarter of taker", () => {
    expect(kalshiFee(50, 1, true)).toBeCloseTo(0.01, 2);
  });
  it("scales with contract count", () => {
    expect(kalshiFee(50, 100, false)).toBeCloseTo(1.75, 2);
  });
  it("is cheapest at extreme prices", () => {
    expect(kalshiFeeCents(5, 1, false)).toBeLessThanOrEqual(kalshiFeeCents(50, 1, false));
  });
});

describe("calcArbProfit", () => {
  it("47¢ + 47¢ pair is profitable after 4¢ total fees", () => {
    const r = calcArbProfit(47, 47);
    expect(r.totalCostCents).toBe(98);
    expect(r.profitCents).toBe(2);
    expect(r.profitable).toBe(true);
  });
  it("48¢ + 48¢ pair breaks even (not profitable)", () => {
    const r = calcArbProfit(48, 48);
    expect(r.profitCents).toBe(0);
    expect(r.profitable).toBe(false);
  });
});

describe("mlToProb", () => {
  it("+100 implies 50%", () => expect(mlToProb("+100")).toBeCloseTo(0.5));
  it("-150 implies 60%", () => expect(mlToProb("-150")).toBeCloseTo(0.6));
  it("garbage returns null", () => expect(mlToProb("abc")).toBeNull());
});

describe("midCents", () => {
  it("averages bid and ask", () => expect(midCents({ yes_bid: 40, yes_ask: 44 })).toBe(42));
  it("returns null with no quotes", () => expect(midCents({ yes_bid: 0, yes_ask: 0 })).toBeNull());
});
