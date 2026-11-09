import { describe, it, expect } from "vitest";
import { analyzeFills, parseCSV, summarizeSheet } from "../fills.js";
import { normalizeFills } from "../normalize.js";

const fills = [
  { ticker: "KXMLBGAME-26JUL051700TORSEA-TOR", side: "yes", action: "buy", count: 20, yes_price: 42, no_price: 58, is_taker: true, created_time: "2026-07-05T10:00:00Z" },
  { ticker: "KXMLBGAME-26JUL051700TORSEA-TOR", side: "yes", action: "sell", count: 20, yes_price: 55, no_price: 45, is_taker: true, created_time: "2026-07-05T19:00:00Z" },
  { ticker: "KXWCADVANCE-26JUL05MEXENG-MEX", side: "no", action: "buy", count: 10, yes_price: 52, no_price: 48, is_taker: false, created_time: "2026-07-04T09:00:00Z" },
  { ticker: "KXNBAGAME-26MAR07GSWOKC-GSW", side: "yes", action: "buy", count: 5, yes_price: 18, no_price: 82, is_taker: true, created_time: "2026-03-06T22:00:00Z" },
];

describe("analyzeFills", () => {
  const a = analyzeFills(fills);

  it("aggregates series distribution", () => {
    expect(a.count).toBe(4);
    expect(a.bySeries[0][0]).toBe("KXMLBGAME"); // 2 fills
  });
  it("computes side/action/taker mix", () => {
    expect(a.buyPct).toBe(75);
    expect(a.yesPct).toBe(75);
    expect(a.takerPct).toBe(75);
  });
  it("computes round trips with hold time and pnl", () => {
    expect(a.roundTrips).toHaveLength(1);
    const rt = a.roundTrips[0];
    expect(rt.entry).toBe(42);
    expect(rt.exit).toBe(55);
    expect(rt.pnlCents).toBe((55 - 42) * 20);
    expect(rt.holdHours).toBe(9);
    expect(a.winRatePct).toBe(100);
  });
  it("uses NO price for no-side entries", () => {
    // median of buy entries: [42(yes), 48(no), 18(yes)] → 42
    expect(a.medianEntryCents).toBe(42);
  });
  it("computes hours-before-game timing", () => {
    expect(a.medianHoursBeforeGame).toBeGreaterThan(0);
  });
  it("handles empty input", () => {
    expect(analyzeFills([]).count).toBe(0);
  });
});

describe("normalizeFills", () => {
  it("adapts dollar-string fills to cents", () => {
    const [f] = normalizeFills([{ ticker: "T", side: "yes", action: "buy", yes_price_dollars: "0.4200", no_price_dollars: "0.5800", count_fp: "20.00" }]);
    expect(f.yes_price).toBe(42);
    expect(f.count).toBe(20);
  });
});

describe("parseCSV", () => {
  it("parses quoted fields with commas", () => {
    const rows = parseCSV('Team,Edge,Note\n"Thunder, OKC",4.5,"said ""go"""\nPacers,2.1,ok\n');
    expect(rows).toHaveLength(3);
    expect(rows[1][0]).toBe("Thunder, OKC");
    expect(rows[1][2]).toBe('said "go"');
  });
});

describe("summarizeSheet", () => {
  it("profiles numeric columns with ranges", () => {
    const s = summarizeSheet(parseCSV("Team,Edge %,Price\nOKC,4.5,$0.55\nIND,2.1,$0.38\nMEX,7.9,$0.49\n"));
    expect(s.rows).toBe(3);
    const edge = s.columns.find(c => c.name === "Edge %");
    expect(edge.numeric).toBe(true);
    expect(edge.min).toBe(2.1);
    expect(edge.max).toBe(7.9);
    const team = s.columns.find(c => c.name === "Team");
    expect(team.numeric).toBe(false);
  });
});
