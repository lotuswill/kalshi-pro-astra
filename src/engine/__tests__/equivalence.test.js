import { describe, it, expect } from "vitest";
import { classifyEvent, findEquivalentPairs, findEquivalenceOpportunities, sameLeagueHint, priceEquivalencePair, findDominanceViolation } from "../equivalence.js";
import { gameEvent, seriesEvent, market } from "./fixtures.js";

describe("classifyEvent", () => {
  it("tags game-winner series as game", () => {
    expect(classifyEvent(gameEvent())).toBe("game");
  });
  it("tags series/advance markets as progression", () => {
    expect(classifyEvent(seriesEvent())).toBe("progression");
    expect(classifyEvent({ series_ticker: "KXNCAAMBCHAMP", title: "Will UConn reach the Final Four?" })).toBe("progression");
  });
  it("does not treat spreads or totals as games", () => {
    expect(classifyEvent({ series_ticker: "KXNBASPREAD", title: "x" })).not.toBe("game");
    expect(classifyEvent({ series_ticker: "KXNBATOTAL", title: "x" })).not.toBe("game");
  });
});

describe("sameLeagueHint", () => {
  it("blocks cross-league pairing", () => {
    expect(sameLeagueHint("KXNBAGAME", "KXNHLSERIES")).toBe(false);
  });
  it("allows same league and unknown leagues", () => {
    expect(sameLeagueHint("KXNBAGAME", "KXNBASERIES")).toBe(true);
    expect(sameLeagueHint("KXNBAGAME", "KXMYSTERYCUP")).toBe(true);
  });
});

describe("findEquivalentPairs — game 7: win ≡ win series", () => {
  it("pairs each team's game market with its series market as EXACT when close times align", () => {
    const pairs = findEquivalentPairs([gameEvent(), seriesEvent()]);
    const okc = pairs.filter(p => p.gameMarket.ticker.endsWith("-OKC"));
    expect(okc).toHaveLength(1);
    expect(okc[0].tier).toBe("EXACT");
    expect(okc[0].progMarket.ticker).toBe("KXNBASERIES-26FINALS-OKC");
    // And never pairs OKC's game with IND's series market
    expect(pairs.some(p => p.gameMarket.ticker.endsWith("-OKC") && p.progMarket.ticker.endsWith("-IND"))).toBe(false);
  });

  it("downgrades to LIKELY when the progression market closes half a day later", () => {
    const se = seriesEvent();
    se.markets = se.markets.map(m => ({ ...m, close_time: "2026-06-16T15:00:00Z" }));
    const pairs = findEquivalentPairs([gameEvent(), se]);
    expect(pairs.every(p => p.tier === "LIKELY")).toBe(true);
  });

  it("marks far-future series closes CONDITIONAL", () => {
    const se = seriesEvent();
    se.markets = se.markets.map(m => ({ ...m, close_time: "2026-06-23T03:00:00Z" }));
    const pairs = findEquivalentPairs([gameEvent(), se]);
    expect(pairs.every(p => p.tier === "CONDITIONAL")).toBe(true);
  });

  it("matches single-market advance events via the event title", () => {
    const adv = {
      event_ticker: "KXNBAADVANCE-26THUNDER",
      series_ticker: "KXNBAADVANCE",
      title: "Will the Thunder advance to the next round?",
      markets: [market({ ticker: "KXNBAADVANCE-26THUNDER", yes_sub_title: "", yes_bid: 55, yes_ask: 57 })],
    };
    const pairs = findEquivalentPairs([gameEvent(), adv]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].gameMarket.ticker).toBe("KXNBAGAME-26JUN15OKCIND-OKC");
  });

  it("does not pair across leagues", () => {
    const nhl = seriesEvent({ event_ticker: "KXNHLSERIES-26FINALS", series_ticker: "KXNHLSERIES" });
    const pairs = findEquivalentPairs([gameEvent(), nhl]);
    expect(pairs).toHaveLength(0);
  });
});

describe("priceEquivalencePair", () => {
  it("builds buy-YES-cheap + buy-NO-rich legs", () => {
    const pairs = findEquivalentPairs([gameEvent(), seriesEvent()]);
    const okc = pairs.find(p => p.gameMarket.ticker.endsWith("-OKC"));
    const priced = priceEquivalencePair(okc);
    // game mid 61 vs series mid 55 → series is cheap side
    expect(priced.divergence).toBe(6);
    expect(priced.legs[0]).toMatchObject({ ticker: "KXNBASERIES-26FINALS-OKC", side: "yes", action: "buy", price: 56 });
    expect(priced.legs[1]).toMatchObject({ ticker: "KXNBAGAME-26JUN15OKCIND-OKC", side: "no", action: "buy", price: 40 });
  });
});

describe("findEquivalenceOpportunities", () => {
  it("emits a profitable EXACT lock when divergence exceeds fees", () => {
    const ge = gameEvent();
    ge.markets[0] = { ...ge.markets[0], yes_bid: 69, yes_ask: 71 }; // game mid 70
    const se = seriesEvent(); // series OKC mid 55 → 15¢ apart
    const opps = findEquivalenceOpportunities([ge, se]);
    const lock = opps.find(o => o.tier === "EXACT" && o.markets.some(m => m.ticker.endsWith("FINALS-OKC")));
    expect(lock).toBeTruthy();
    // buy series YES @56 + buy game NO @31 = 87¢ + 4¢ fees → 9¢ lock
    expect(lock.fees.profitable).toBe(true);
    expect(lock.fees.profitCents).toBe(9);
    expect(lock.edge).toBe(9);
    expect(lock.legs).toHaveLength(2);
  });

  it("still surfaces unprofitable divergence as a watch item", () => {
    const opps = findEquivalenceOpportunities([gameEvent(), seriesEvent()]);
    const watch = opps.find(o => o.markets.some(m => m.ticker === "KXNBASERIES-26FINALS-OKC"));
    expect(watch).toBeTruthy();
    expect(watch.fees.profitable).toBe(false);
    expect(watch.desc).toContain("Not yet profitable");
  });

  it("respects minDivergence", () => {
    const se = seriesEvent();
    se.markets[0] = { ...se.markets[0], yes_bid: 59, yes_ask: 61 }; // series mid 60 vs game mid 61
    se.markets[1] = { ...se.markets[1], yes_bid: 36, yes_ask: 38 }; // ind series mid 37 vs game mid 38
    const opps = findEquivalenceOpportunities([gameEvent(), se], { minDivergence: 2 });
    expect(opps).toHaveLength(0);
  });

  it("flags CONDITIONAL dominance violations as REVIEW, only when net-positive", () => {
    const ge = gameEvent(); // OKC game bid 60
    const se = seriesEvent();
    // Series closes a week later (CONDITIONAL) and OKC advance ask 45 < game bid 60
    se.markets = se.markets.map(m => ({ ...m, close_time: "2026-06-23T03:00:00Z" }));
    se.markets[0] = { ...se.markets[0], yes_bid: 43, yes_ask: 45 };
    const opps = findEquivalenceOpportunities([ge, se]);
    const dom = opps.find(o => o.tier === "CONDITIONAL");
    expect(dom).toBeTruthy();
    expect(dom.action).toContain("REVIEW");
    expect(dom.desc).toContain("clinches");
  });
});

describe("findDominanceViolation", () => {
  it("nets fees out of the spread", () => {
    const pair = { gameMarket: market({ yes_bid: 60 }), progMarket: market({ yes_ask: 45 }) };
    const v = findDominanceViolation(pair);
    expect(v.spread).toBe(15);
    expect(v.netCents).toBe(15 - v.fees);
    expect(v.profitable).toBe(true);
  });
  it("returns null when no violation", () => {
    const pair = { gameMarket: market({ yes_bid: 40 }), progMarket: market({ yes_ask: 55 }) };
    expect(findDominanceViolation(pair)).toBeNull();
  });
});
