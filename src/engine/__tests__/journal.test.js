import { describe, it, expect } from "vitest";
import { SignalJournal } from "../journal.js";
import { market } from "./fixtures.js";

const T0 = Date.parse("2026-07-05T12:00:00Z");
const HOUR = 3600_000;

function skewOpp(overrides = {}) {
  return {
    type: "FRESH_SKEW", tier: "ANCHORED", edge: 9,
    game: "Toronto vs Seattle", sport: "KXMLBGAME",
    suggestedSide: "no", suggestedAction: "buy", suggestedPrice: 31,
    anchor: { fair: 58, books: 3 },
    markets: [market({ ticker: "KXMLBGAME-26JUL051700TORSEA-TOR", yes_bid: 69, yes_ask: 71, close_time: "2026-07-06T02:00:00Z" })],
    ...overrides,
  };
}

function valueOpp() {
  return {
    type: "VALUE", edge: 7,
    game: "Mexico vs England", sport: "KXWCADVANCE",
    suggestedSide: "yes", suggestedAction: "buy", suggestedPrice: 49,
    consensus: { fairCents: 57, books: 4 },
    markets: [market({ ticker: "KXWCADVANCE-26JUL05MEXENG-MEX", yes_bid: 48, yes_ask: 49, close_time: "2026-07-06T02:00:00Z" })],
  };
}

describe("SignalJournal — logging", () => {
  it("logs first sightings once and tracks peak edge on repeats", () => {
    const j = new SignalJournal();
    expect(j.logSignals([skewOpp()], T0)).toBe(1);
    expect(j.logSignals([skewOpp({ edge: 14 })], T0 + HOUR)).toBe(0); // same key
    const [e] = j.list();
    expect(e.peakEdge).toBe(14);
    expect(e.entryMid).toBe(70);
    expect(e.targetCents).toBe(58); // the anchor
    expect(e.status).toBe("open");
  });

  it("skips sub-threshold edges", () => {
    const j = new SignalJournal({ minEdge: 2 });
    expect(j.logSignals([skewOpp({ edge: 0.3 })], T0)).toBe(0);
  });

  it("defaults FRESH_SKEW without anchor to the 50-50 happy medium", () => {
    const j = new SignalJournal();
    const opp = skewOpp(); delete opp.anchor; opp.tier = "UNANCHORED";
    j.logSignals([opp], T0);
    expect(j.list()[0].targetCents).toBe(50);
  });
});

describe("SignalJournal — convergence", () => {
  it("scores NO-side drift downward as positive convergence, capped at target", () => {
    const j = new SignalJournal();
    j.logSignals([skewOpp()], T0); // entry mid 70, side NO, target 58
    j.updateOutcomes(new Map([["KXMLBGAME-26JUL051700TORSEA-TOR", market({ yes_bid: 59, yes_ask: 61 })]]), T0 + 6 * HOUR);
    const [e] = j.list();
    expect(e.lastMid).toBe(60);
    expect(j.convergenceCents(e)).toBe(10); // 70 → 60, toward 58
    // Overshoot past the target doesn't earn extra convergence credit
    j.updateOutcomes(new Map([["KXMLBGAME-26JUL051700TORSEA-TOR", market({ yes_bid: 44, yes_ask: 46 })]]), T0 + 8 * HOUR);
    expect(j.convergenceCents(j.list()[0])).toBe(12); // capped at |58 − 70|
  });

  it("scores adverse YES-side drift as negative", () => {
    const j = new SignalJournal();
    j.logSignals([valueOpp()], T0); // entry mid 48.5, side YES
    j.updateOutcomes(new Map([["KXWCADVANCE-26JUL05MEXENG-MEX", market({ yes_bid: 41, yes_ask: 43 })]]), T0 + HOUR);
    expect(j.convergenceCents(j.list()[0])).toBeLessThan(0);
  });
});

describe("SignalJournal — settlement and expiry", () => {
  it("settles a winning NO signal with fee-adjusted P&L", () => {
    const j = new SignalJournal();
    j.logSignals([skewOpp()], T0); // buy NO @31
    j.updateOutcomes(new Map([["KXMLBGAME-26JUL051700TORSEA-TOR", market({ result: "no", yes_bid: 0, yes_ask: 1 })]]), T0 + 14 * HOUR);
    const [e] = j.list();
    expect(e.status).toBe("settled");
    expect(e.outcome.won).toBe(true);
    // 100 − 31 − fee(31¢ taker: ceil(0.07×0.31×0.69×100) = 2¢) = 67
    expect(e.outcome.pnlCents).toBe(67);
  });

  it("settles a losing signal at −price − fee", () => {
    const j = new SignalJournal();
    j.logSignals([valueOpp()], T0); // buy YES @49
    j.updateOutcomes(new Map([["KXWCADVANCE-26JUL05MEXENG-MEX", market({ result: "no" })]]), T0 + 14 * HOUR);
    const [e] = j.list();
    expect(e.outcome.won).toBe(false);
    expect(e.outcome.pnlCents).toBe(-49 - 2);
  });

  it("expires open entries 48h past close without a result", () => {
    const j = new SignalJournal();
    j.logSignals([skewOpp()], T0);
    j.updateOutcomes(new Map(), Date.parse("2026-07-09T12:00:00Z"));
    expect(j.list()[0].status).toBe("expired");
  });
});

describe("SignalJournal — stats, CSV, persistence", () => {
  it("aggregates win rate and average P&L per type/tier", () => {
    const j = new SignalJournal();
    j.logSignals([skewOpp(), valueOpp()], T0);
    j.updateOutcomes(new Map([
      ["KXMLBGAME-26JUL051700TORSEA-TOR", market({ result: "no" })],
      ["KXWCADVANCE-26JUL05MEXENG-MEX", market({ result: "no" })],
    ]), T0 + 14 * HOUR);
    const stats = j.stats();
    const skew = stats.find(s => s.group === "FRESH_SKEW/ANCHORED");
    expect(skew.settled).toBe(1);
    expect(skew.winRatePct).toBe(100);
    expect(skew.avgPnlCents).toBe(67);
    const val = stats.find(s => s.group === "VALUE");
    expect(val.winRatePct).toBe(0);
  });

  it("exports CSV and round-trips JSON", () => {
    const j = new SignalJournal();
    j.logSignals([skewOpp()], T0);
    expect(j.toCSV().split("\n")).toHaveLength(2);
    const j2 = SignalJournal.fromJSON(j.toJSON());
    expect(j2.list()).toHaveLength(1);
    expect(j2.logSignals([skewOpp()], T0 + HOUR)).toBe(0); // dedupe survives restore
  });

  it("trims oldest settled entries beyond the cap", () => {
    const j = new SignalJournal({ maxEntries: 2 });
    for (let i = 0; i < 4; i++) {
      j.logSignals([skewOpp({ game: `G${i}`, markets: [market({ ticker: `T${i}`, yes_bid: 69, yes_ask: 71 })] })], T0 + i);
    }
    expect(j.entries.size).toBeLessThanOrEqual(2);
  });
});
