import { describe, it, expect } from "vitest";
import { fingerprintActors, detectBots } from "../bots.js";
import { findVolumeOutliers } from "../scanner.js";
import { SnapshotStore, MarketRecorder } from "../timeseries.js";
import { market } from "./fixtures.js";

const T0 = Date.parse("2026-07-05T18:00:00Z");
const MIN = 60_000;

function tp(tSec, price, count, taker = "yes") {
  return { t: T0 + tSec * 1000, price, count, taker };
}

describe("fingerprintActors", () => {
  it("clusters repeating order sizes and flags clockwork timing", () => {
    // Exactly 100 contracts every 60s — a rebalancing bot
    const tape = Array.from({ length: 8 }, (_, i) => tp(i * 60, 50 + (i % 2), 100));
    const actors = fingerprintActors(tape);
    expect(actors).toHaveLength(1);
    expect(actors[0].size).toBe(100);
    expect(actors[0].clockwork).toBe(true);
    expect(actors[0].meanGapSec).toBeCloseTo(60, 0);
  });

  it("does not flag irregular human-like sizes", () => {
    const tape = [tp(0, 50, 7), tp(30, 51, 23), tp(400, 49, 11), tp(500, 52, 41), tp(900, 50, 3)];
    expect(fingerprintActors(tape)).toHaveLength(0);
  });
});

describe("detectBots", () => {
  it("detects a clockwork actor with a counter-tactic", () => {
    const tape = Array.from({ length: 10 }, (_, i) => tp(i * 60, 50 + (i % 2), 100));
    const { detections } = detectBots(tape);
    const cw = detections.find(d => d.type === "CLOCKWORK");
    expect(cw).toBeTruthy();
    expect(cw.tactic).toContain("fade");
  });

  it("detects penny jumping chains", () => {
    const tape = Array.from({ length: 10 }, (_, i) => tp(i * 10, 40 + i, 5 + i));
    const { detections } = detectBots(tape);
    expect(detections.some(d => d.type === "PENNY_JUMPER")).toBe(true);
  });

  it("detects sniper bursts", () => {
    const tape = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 300, price: 50, count: 3 + i, taker: "yes" }));
    const { detections } = detectBots(tape);
    expect(detections.some(d => d.type === "SNIPER")).toBe(true);
  });

  it("detects balanced two-sided flow as a market maker", () => {
    const tape = Array.from({ length: 12 }, (_, i) => tp(i * 120, 50, 8 + i, i % 2 ? "yes" : "no"));
    const { detections } = detectBots(tape);
    expect(detections.some(d => d.type === "MARKET_MAKER")).toBe(true);
  });

  it("returns nothing on a tiny tape", () => {
    expect(detectBots([tp(0, 50, 5)]).detections).toHaveLength(0);
  });
});

describe("findVolumeOutliers", () => {
  function ev(ticker, vol, closeInH = 12) {
    return {
      event_ticker: `KXMLBGAME-26JUL05${ticker}`, series_ticker: "KXMLBGAME", title: `Game ${ticker}`,
      markets: [market({ ticker: `KXMLBGAME-26JUL05${ticker}-A`, volume_24h: vol, close_time: new Date(T0 + closeInH * 3600_000).toISOString() })],
    };
  }

  it("flags high-volume outliers against the series median", () => {
    const events = [ev("AA", 100), ev("BB", 120), ev("CC", 90), ev("DD", 8000)];
    const { high } = findVolumeOutliers(events, { now: T0 });
    expect(high).toHaveLength(1);
    expect(high[0].ticker).toContain("DD");
    expect(high[0].ratio).toBeGreaterThan(5);
  });

  it("flags dead markets close to game time when peers are active", () => {
    const events = [ev("AA", 500), ev("BB", 600), ev("CC", 0, 6)];
    const { dead } = findVolumeOutliers(events, { now: T0 });
    expect(dead).toHaveLength(1);
    expect(dead[0].ticker).toContain("CC");
  });

  it("does not call everything dead in a quiet series", () => {
    const events = [ev("AA", 0), ev("BB", 2), ev("CC", 1)];
    const { dead, high } = findVolumeOutliers(events, { now: T0 });
    expect(dead).toHaveLength(0);
    expect(high).toHaveLength(0);
  });
});

describe("SnapshotStore + sampleAt", () => {
  it("stores at most one snapshot per interval and answers 24h-ago queries", () => {
    const s = new SnapshotStore({ minIntervalMs: 3600_000 });
    expect(s.add([{ ticker: "T", mid: 70, vol: 100 }], T0 - 24 * 3600_000)).toBe(true);
    expect(s.add([{ ticker: "T", mid: 71, vol: 110 }], T0 - 24 * 3600_000 + 60_000)).toBe(false); // too soon
    s.add([{ ticker: "T", mid: 55, vol: 900 }], T0);
    const ago = s.at("T", T0 - 24 * 3600_000);
    expect(ago.mid).toBe(70);
    expect(s.history("T")).toHaveLength(2);
  });

  it("prunes beyond max age and round-trips JSON", () => {
    const s = new SnapshotStore({ minIntervalMs: 1, maxAgeMs: 48 * 3600_000 });
    s.add([{ ticker: "T", mid: 60, vol: 1 }], T0 - 60 * 3600_000);
    s.add([{ ticker: "T", mid: 61, vol: 2 }], T0); // triggers prune
    expect(s.history("T")).toHaveLength(1);
    const s2 = SnapshotStore.fromJSON(s.toJSON());
    expect(s2.at("T", T0).mid).toBe(61);
  });

  it("MarketRecorder.sampleAt returns the nearest sample", () => {
    const r = new MarketRecorder();
    r.record("T", { yes_bid: 40, yes_ask: 42, volume: 10 }, T0 - 24 * 3600_000);
    r.record("T", { yes_bid: 60, yes_ask: 62, volume: 500 }, T0);
    expect(r.sampleAt("T", T0 - 23 * 3600_000).mid).toBe(41);
  });
});
