import { describe, it, expect } from "vitest";
import { findIntraEventArbs, findWinnerSpreadGaps, dedupeOpportunities, findArbOpportunities, matchOddsToKalshi } from "../arbitrage.js";
import { gameEvent, seriesEvent, spreadEvent, market } from "./fixtures.js";

describe("findIntraEventArbs", () => {
  it("finds a guaranteed buy-both when asks sum under $1 minus fees", () => {
    const e = gameEvent();
    e.markets = [
      market({ ticker: "KXNBAGAME-26JUN15OKCIND-OKC", yes_bid: 45, yes_ask: 47 }),
      market({ ticker: "KXNBAGAME-26JUN15OKCIND-IND", yes_bid: 45, yes_ask: 47 }),
    ];
    const opps = findIntraEventArbs([e]);
    const g = opps.find(o => o.type === "GUARANTEED");
    expect(g).toBeTruthy();
    expect(g.edge).toBe(2); // 100 − 94 − 4¢ fees
  });

  it("finds a sell-both GUARANTEED only when it clears fees", () => {
    const e = gameEvent();
    e.markets = [
      market({ ticker: "A", yes_bid: 55, yes_ask: 57 }),
      market({ ticker: "B", yes_bid: 50, yes_ask: 52 }),
    ];
    // bidSum 105 − 100 − ~4¢ fees → net positive, still GUARANTEED
    const opps = findIntraEventArbs([e]);
    const g = opps.find(o => o.type === "GUARANTEED" && o.suggestedAction === "sell");
    expect(g).toBeTruthy();
    expect(g.edge).toBeLessThan(5); // fee-adjusted, below the 5¢ gross
    expect(g.fees.profitable).toBe(true);
  });

  it("downgrades a thin sell-both to NEAR_ARB when fees eat the edge", () => {
    const e = gameEvent();
    e.markets = [
      market({ ticker: "A", yes_bid: 47, yes_ask: 49 }),
      market({ ticker: "B", yes_bid: 54, yes_ask: 56 }),
    ];
    // bidSum 101 − 100 = 1¢ gross, wiped out by ~4¢ fees → not GUARANTEED
    const opps = findIntraEventArbs([e]);
    expect(opps.some(o => o.type === "GUARANTEED" && o.suggestedAction === "sell")).toBe(false);
    expect(opps.some(o => o.type === "NEAR_ARB" && /after fees/.test(o.desc))).toBe(true);
  });

  it("emits NEAR_ARB when asks sum just over $1", () => {
    const e = gameEvent(); // 62 + 39 = 101
    const opps = findIntraEventArbs([e]);
    expect(opps.some(o => o.type === "NEAR_ARB")).toBe(true);
  });

  it("ignores non-game and >2-market events", () => {
    expect(findIntraEventArbs([seriesEvent()])).toHaveLength(0);
  });
});

describe("findWinnerSpreadGaps", () => {
  it("flags a winner/spread-1.5 gap far from the normal ~4%", () => {
    const ge = gameEvent(); // OKC (Thunder) mid 61 fav
    const se = spreadEvent(); // "Thunder wins by over 1.5 Points" mid 56 → gap 5, edge |5−4|=1 < 3 → none
    expect(findWinnerSpreadGaps([ge, se])).toHaveLength(0);
    // Widen: winner overpriced vs spread
    se.markets[0] = { ...se.markets[0], yes_bid: 49, yes_ask: 51 }; // mid 50 → gap 11, edge 7
    const opps = findWinnerSpreadGaps([ge, se]);
    expect(opps).toHaveLength(1);
    expect(opps[0].type).toBe("CROSS_MARKET");
  });
});

describe("matchOddsToKalshi", () => {
  it("matches by both team names in the Kalshi title", () => {
    const odds = { home_team: "Indiana Pacers", away_team: "Oklahoma City Thunder", kalshiPrefixes: ["KXNBAGAME"] };
    expect(matchOddsToKalshi(odds, [gameEvent()])).toHaveLength(1);
  });
  it("does not match unrelated events", () => {
    const odds = { home_team: "Boston Celtics", away_team: "Miami Heat", kalshiPrefixes: [] };
    expect(matchOddsToKalshi(odds, [gameEvent()])).toHaveLength(0);
  });
});

describe("dedupeOpportunities", () => {
  it("keeps the best edge per game/type/ticker", () => {
    const a = { type: "SPORTSBOOK", game: "G", edge: 3, markets: [{ ticker: "T" }] };
    const b = { type: "SPORTSBOOK", game: "G", edge: 7, markets: [{ ticker: "T" }] };
    const out = dedupeOpportunities([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].edge).toBe(7);
  });
});

describe("findArbOpportunities (composition)", () => {
  it("includes EQUIVALENT opportunities from the equivalence engine", () => {
    const ge = gameEvent();
    ge.markets[0] = { ...ge.markets[0], yes_bid: 69, yes_ask: 71 };
    const opps = findArbOpportunities([ge, seriesEvent()], []);
    expect(opps.some(o => o.type === "EQUIVALENT")).toBe(true);
  });
  it("can disable equivalence scanning", () => {
    const opps = findArbOpportunities([gameEvent(), seriesEvent()], [], [], { equivalence: false });
    expect(opps.some(o => o.type === "EQUIVALENT")).toBe(false);
  });
  it("sorts by edge descending", () => {
    const ge = gameEvent();
    ge.markets[0] = { ...ge.markets[0], yes_bid: 69, yes_ask: 71 };
    const opps = findArbOpportunities([ge, seriesEvent()], []);
    for (let i = 1; i < opps.length; i++) expect(opps[i].edge).toBeLessThanOrEqual(opps[i - 1].edge);
  });
});
