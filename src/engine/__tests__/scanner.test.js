import { describe, it, expect } from "vitest";
import { findVolatileAndNew, OpportunityTracker, opportunityKey } from "../scanner.js";
import { gameEvent, market } from "./fixtures.js";

const T0 = Date.parse("2026-06-15T12:00:00Z");

describe("findVolatileAndNew", () => {
  it("flags markets created within 48h as new", () => {
    const e = gameEvent();
    e.markets = [market({ created_time: new Date(T0 - 10 * 36e5).toISOString() })];
    const r = findVolatileAndNew([e], T0);
    expect(r.newMarkets).toHaveLength(1);
    expect(Number(r.newMarkets[0].hoursOld)).toBe(10);
  });
  it("scores wide-spread mid-range markets as volatile", () => {
    const e = gameEvent();
    e.markets = [market({ yes_bid: 40, yes_ask: 55, volume: 500, created_time: "2026-01-01T00:00:00Z" })];
    const r = findVolatileAndNew([e], T0);
    expect(r.volatile).toHaveLength(1);
  });
});

function opp(ticker, edge, type = "GUARANTEED") {
  return { type, edge, game: "G", markets: [{ ticker }] };
}

describe("OpportunityTracker", () => {
  it("everything is fresh on first scan, nothing on identical rescan", () => {
    const t = new OpportunityTracker();
    const scan = [opp("A", 5), opp("B", 3)];
    const r1 = t.ingest(scan, T0);
    expect(r1.fresh).toHaveLength(2);
    const r2 = t.ingest(scan, T0 + 60_000);
    expect(r2.fresh).toHaveLength(0);
    expect(r2.active).toHaveLength(2);
    expect(r2.active[0].firstSeen).toBe(T0);
  });

  it("reports improved when edge grows past the threshold", () => {
    const t = new OpportunityTracker({ improveThresholdCents: 2 });
    t.ingest([opp("A", 5)], T0);
    const r = t.ingest([opp("A", 8)], T0 + 60_000);
    expect(r.improved).toHaveLength(1);
    const r2 = t.ingest([opp("A", 9)], T0 + 120_000); // +1 below threshold
    expect(r2.improved).toHaveLength(0);
  });

  it("expires opportunities that vanish", () => {
    const t = new OpportunityTracker();
    t.ingest([opp("A", 5), opp("B", 3)], T0);
    const r = t.ingest([opp("A", 5)], T0 + 60_000);
    expect(r.expired).toHaveLength(1);
    expect(opportunityKey(r.expired[0])).toContain("B");
  });

  it("keys distinguish type and tier on the same market pair", () => {
    expect(opportunityKey({ type: "EQUIVALENT", tier: "EXACT", markets: [{ ticker: "A" }] }))
      .not.toBe(opportunityKey({ type: "EQUIVALENT", tier: "CONDITIONAL", markets: [{ ticker: "A" }] }));
  });

  it("isNew is true within the window, false after", () => {
    const t = new OpportunityTracker();
    const o = opp("A", 5);
    t.ingest([o], T0);
    expect(t.isNew(o, 5 * 60_000, T0 + 60_000)).toBe(true);
    expect(t.isNew(o, 5 * 60_000, T0 + 10 * 60_000)).toBe(false);
  });
});
