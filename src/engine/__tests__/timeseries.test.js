import { describe, it, expect } from "vitest";
import { MarketRecorder, bucketTrades, detectPatterns } from "../timeseries.js";

const T0 = Date.parse("2026-07-05T18:00:00Z");
const MIN = 60_000;

function snap(bid, ask, vol = 0) { return { yes_bid: bid, yes_ask: ask, volume: vol }; }
function print(tMin, price, count, taker = "yes") {
  return { trade_id: `${tMin}-${price}-${count}-${taker}`, created_time: new Date(T0 + tMin * MIN).toISOString(), yes_price: price, count, taker_side: taker };
}

describe("MarketRecorder", () => {
  it("records snapshots with volume deltas and skips exact repeats", () => {
    const r = new MarketRecorder();
    r.record("T", snap(40, 42, 100), T0);
    r.record("T", snap(40, 42, 100), T0 + 1000); // identical within 5s → skipped
    r.record("T", snap(41, 43, 160), T0 + 30_000);
    const { samples } = r.series("T");
    expect(samples).toHaveLength(2);
    expect(samples[1].volDelta).toBe(60);
    expect(samples[1].noBid).toBe(57); // 100 − ask
  });

  it("dedupes trade prints across polls", () => {
    const r = new MarketRecorder();
    const t1 = print(0, 45, 10);
    r.recordTrades("T", [t1]);
    r.recordTrades("T", [t1, print(1, 46, 5)]);
    expect(r.series("T").tape).toHaveLength(2);
  });

  it("caps sample buffers", () => {
    const r = new MarketRecorder({ maxSamples: 10 });
    for (let i = 0; i < 25; i++) r.record("T", snap(40 + (i % 3), 42 + (i % 3), i * 10), T0 + i * MIN);
    expect(r.series("T").samples.length).toBeLessThanOrEqual(10);
  });

  it("round-trips through JSON with tape dedupe intact", () => {
    const r = new MarketRecorder();
    r.record("T", snap(40, 42, 100), T0);
    r.recordTrades("T", [print(0, 45, 10)]);
    const r2 = MarketRecorder.fromJSON(r.toJSON());
    expect(r2.series("T").samples).toHaveLength(1);
    r2.recordTrades("T", [print(0, 45, 10)]); // same print again post-restore
    expect(r2.series("T").tape).toHaveLength(1);
  });

  it("exports CSVs", () => {
    const r = new MarketRecorder();
    r.record("T", snap(40, 42, 100), T0);
    r.recordTrades("T", [print(0, 45, 10)]);
    expect(r.toCSV("T").split("\n")).toHaveLength(2);
    expect(r.tapeCSV("T")).toContain("4.50"); // 45¢ × 10 = $4.50 notional
  });
});

describe("bucketTrades", () => {
  it("aggregates contracts, notional, vwap and imbalance per window", () => {
    const tape = [print(0, 40, 10, "yes"), print(0.5, 44, 30, "yes"), print(1.2, 46, 20, "no")].map(t => ({
      t: Date.parse(t.created_time), price: t.yes_price, count: t.count, notionalCents: t.yes_price * t.count, taker: t.taker_side,
    }));
    const b = bucketTrades(tape, MIN);
    expect(b).toHaveLength(2);
    expect(b[0].contracts).toBe(40);
    expect(b[0].vwapCents).toBeCloseTo((40 * 10 + 44 * 30) / 40);
    expect(b[0].imbalance).toBe(1); // all yes-taker
    expect(b[1].imbalance).toBe(-1); // all no-taker
  });
});

describe("detectPatterns", () => {
  it("flags a volume spike against the median bucket", () => {
    const tape = [];
    for (let m = 0; m < 8; m++) tape.push({ t: T0 + m * MIN, price: 50, count: 10, notionalCents: 500, taker: "yes" });
    tape.push({ t: T0 + 8 * MIN, price: 55, count: 300, notionalCents: 16500, taker: "yes" });
    const p = detectPatterns({ tape }, { minSpikeContracts: 50 });
    expect(p.some(x => x.type === "VOLUME_SPIKE")).toBe(true);
  });

  it("flags price jumps between samples", () => {
    const samples = [
      { t: T0, mid: 50, bid: 49, ask: 51, vol: 0, volDelta: 0 },
      { t: T0 + 30_000, mid: 62, bid: 61, ask: 63, vol: 0, volDelta: 0 },
    ];
    const p = detectPatterns({ samples });
    expect(p.some(x => x.type === "PRICE_JUMP" && /jumped 12/.test(x.desc))).toBe(true);
  });

  it("flags momentum runs", () => {
    const samples = Array.from({ length: 7 }, (_, i) => ({ t: T0 + i * MIN, mid: 50 + i, bid: 0, ask: 0, vol: 0 }));
    const p = detectPatterns({ samples }, { runLen: 5 });
    expect(p.some(x => x.type === "MOMENTUM")).toBe(true);
  });

  it("flags sustained one-sided taker flow", () => {
    const tape = [];
    for (let m = 0; m < 5; m++) tape.push({ t: T0 + m * MIN, price: 50, count: 30, notionalCents: 1500, taker: "yes" });
    const p = detectPatterns({ tape }, { minSpikeContracts: 50 });
    expect(p.some(x => x.type === "FLOW_IMBALANCE" && /YES buying/.test(x.desc))).toBe(true);
  });

  it("stays quiet on flat, thin series", () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({ t: T0 + i * MIN, mid: 50, bid: 49, ask: 51, vol: 0 }));
    expect(detectPatterns({ samples, tape: [] })).toHaveLength(0);
  });
});
