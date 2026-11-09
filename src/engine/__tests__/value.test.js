import { describe, it, expect } from "vitest";
import { devigPair, bookConsensus, findBookDivergence, findFreshSkews } from "../value.js";
import { market } from "./fixtures.js";

const NOW = Date.parse("2026-07-05T12:00:00Z");

function oddsEvent(books) {
  return {
    home_team: "Seattle Mariners", away_team: "Toronto Blue Jays",
    sportLabel: "MLB", kalshiPrefixes: ["KXMLBGAME"],
    bookmakers: books.map(([name, torPrice, seaPrice]) => ({
      title: name,
      markets: [{ key: "h2h", outcomes: [
        { name: "Toronto Blue Jays", price: torPrice },
        { name: "Seattle Mariners", price: seaPrice },
      ] }],
    })),
  };
}

function mlbEvent(torBid, torAsk, opts = {}) {
  return {
    event_ticker: "KXMLBGAME-26JUL051700TORSEA",
    series_ticker: "KXMLBGAME",
    title: "Toronto vs Seattle",
    markets: [
      market({ ticker: "KXMLBGAME-26JUL051700TORSEA-TOR", yes_sub_title: "Toronto Blue Jays", yes_bid: torBid, yes_ask: torAsk, ...opts }),
      market({ ticker: "KXMLBGAME-26JUL051700TORSEA-SEA", yes_sub_title: "Seattle Mariners", yes_bid: 100 - torAsk - 2, yes_ask: 100 - torBid - 2, ...opts }),
    ],
  };
}

describe("devigPair", () => {
  it("strips the vig so probabilities sum to 1", () => {
    // -120/+100 book: raw 0.545 + 0.5 = 1.045 (4.5% vig)
    const dv = devigPair(0.545, 0.5);
    expect(dv.pA + dv.pB).toBeCloseTo(1);
    expect(dv.pA).toBeCloseTo(0.522, 2);
    expect(dv.vig).toBeCloseTo(0.045, 2);
  });
  it("rejects missing sides", () => {
    expect(devigPair(0.5, 0)).toBeNull();
  });
});

describe("bookConsensus", () => {
  it("takes the median devigged probability across books", () => {
    // Three books all around TOR -150 / SEA +130
    const c = bookConsensus(oddsEvent([["DK", -150, 130], ["FD", -145, 125], ["MGM", -155, 135]]));
    expect(c.bookCount).toBe(3);
    const tor = c.teams["toronto blue jays"];
    expect(tor.prob).toBeGreaterThan(0.55);
    expect(tor.prob).toBeLessThan(0.62);
  });
});

describe("findBookDivergence (VALUE)", () => {
  const books = oddsEvent([["DK", -150, 130], ["FD", -145, 125], ["MGM", -155, 135]]); // TOR fair ≈ 59%

  it("flags Kalshi trading well below consensus as +EV YES", () => {
    const opps = findBookDivergence([mlbEvent(48, 50)], [books]); // TOR at 49 vs fair ~59
    const v = opps.find(o => o.type === "VALUE" && o.markets[0].ticker.endsWith("-TOR"));
    expect(v).toBeTruthy();
    expect(v.suggestedSide).toBe("yes");
    expect(v.edge).toBeGreaterThan(5); // ~59 − 50 − fee
  });

  it("flags Kalshi trading well above consensus as +EV NO", () => {
    const opps = findBookDivergence([mlbEvent(70, 72)], [books]);
    const v = opps.find(o => o.markets[0].ticker.endsWith("-TOR"));
    expect(v).toBeTruthy();
    expect(v.suggestedSide).toBe("no");
  });

  it("stays quiet when Kalshi matches consensus", () => {
    const opps = findBookDivergence([mlbEvent(58, 60)], [books]);
    expect(opps.filter(o => o.markets[0].ticker.endsWith("-TOR"))).toHaveLength(0);
  });

  it("requires at least two books", () => {
    const one = oddsEvent([["DK", -150, 130]]);
    expect(findBookDivergence([mlbEvent(40, 42)], [one])).toHaveLength(0);
  });
});

describe("findFreshSkews", () => {
  const freshOpts = { created_time: new Date(NOW - 6 * 36e5).toISOString(), volume: 40 };

  it("ANCHORED: fresh 70¢ listing vs ~59% consensus → fade with NO", () => {
    const books = oddsEvent([["DK", -150, 130], ["FD", -145, 125]]);
    const opps = findFreshSkews([mlbEvent(69, 71, freshOpts)], [books], { now: NOW });
    const s = opps.find(o => o.tier === "ANCHORED" && o.markets[0].ticker.endsWith("-TOR"));
    expect(s).toBeTruthy();
    expect(s.suggestedSide).toBe("no");
    expect(s.desc).toContain("relax");
  });

  it("UNANCHORED: fresh extreme with no book anchor is a WATCH", () => {
    const opps = findFreshSkews([mlbEvent(69, 71, freshOpts)], [], { now: NOW });
    const s = opps.find(o => o.markets[0].ticker.endsWith("-TOR"));
    expect(s).toBeTruthy();
    expect(s.tier).toBe("UNANCHORED");
    expect(s.action).toContain("WATCH");
  });

  it("ignores old, heavily traded, or mid-range markets", () => {
    const old = { created_time: new Date(NOW - 72 * 36e5).toISOString(), volume: 40 };
    const heavy = { created_time: new Date(NOW - 6 * 36e5).toISOString(), volume: 5000 };
    expect(findFreshSkews([mlbEvent(69, 71, old)], [], { now: NOW })).toHaveLength(0);
    expect(findFreshSkews([mlbEvent(69, 71, heavy)], [], { now: NOW })).toHaveLength(0);
    expect(findFreshSkews([mlbEvent(54, 56, freshOpts)], [], { now: NOW })).toHaveLength(0);
  });
});
