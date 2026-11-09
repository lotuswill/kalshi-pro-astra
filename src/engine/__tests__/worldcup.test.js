import { describe, it, expect } from "vitest";
import {
  classifyEvent, isMatchScopedAdvance, eventHasTie, parseRoundTag,
  buildRoundLadders, findLadderViolations, findAdvanceLadderPairs,
  findEquivalenceOpportunities, sameLeagueHint,
} from "../equivalence.js";
import { findMultiWayArbs } from "../arbitrage.js";
import { market } from "./fixtures.js";

// ── Fixtures modeled on live Kalshi data (2026-07-03) ─────────

// Regulation-time moneyline: team / team / TIE (mutually exclusive)
function wcGame(overrides = {}) {
  return {
    event_ticker: "KXWCGAME-26JUL05MEXENG",
    series_ticker: "KXWCGAME",
    title: "Mexico vs England: Regulation Time Moneyline",
    mutually_exclusive: true,
    markets: [
      market({ ticker: "KXWCGAME-26JUL05MEXENG-MEX", yes_sub_title: "Reg Time: Mexico", yes_bid: 31, yes_ask: 32, close_time: "2026-07-20T00:00:00Z" }),
      market({ ticker: "KXWCGAME-26JUL05MEXENG-ENG", yes_sub_title: "Reg Time: England", yes_bid: 39, yes_ask: 40, close_time: "2026-07-20T00:00:00Z" }),
      market({ ticker: "KXWCGAME-26JUL05MEXENG-TIE", yes_sub_title: "Reg Time: Tie", yes_bid: 29, yes_ask: 30, close_time: "2026-07-20T00:00:00Z" }),
    ],
    ...overrides,
  };
}

// Per-match advance: one market per team (match winner incl. ET/pens)
function wcAdvance(overrides = {}) {
  return {
    event_ticker: "KXWCADVANCE-26JUL05MEXENG",
    series_ticker: "KXWCADVANCE",
    title: "Mexico vs England",
    markets: [
      market({ ticker: "KXWCADVANCE-26JUL05MEXENG-MEX", yes_sub_title: "Mexico advances", yes_bid: 48, yes_ask: 49, close_time: "2026-08-03T00:00:00Z" }),
      market({ ticker: "KXWCADVANCE-26JUL05MEXENG-ENG", yes_sub_title: "England advances", yes_bid: 51, yes_ask: 52, close_time: "2026-08-03T00:00:00Z" }),
    ],
    ...overrides,
  };
}

// Round-qualifier ladder: QUAR / SEMI / FINAL, one market per team.
// Includes a dead (eliminated) team and a settled-yes team to test the
// live-market filter.
function wcRound(tag, mexPrices, overrides = {}) {
  return {
    event_ticker: `KXWCROUND-26${tag}`,
    series_ticker: "KXWCROUND",
    title: `FIFA World Cup ${tag} Qualifiers`,
    markets: [
      market({ ticker: `KXWCROUND-26${tag}-MEX`, yes_sub_title: "Mexico", yes_bid: mexPrices[0], yes_ask: mexPrices[1], close_time: "2026-08-03T14:00:00Z" }),
      market({ ticker: `KXWCROUND-26${tag}-KOR`, yes_sub_title: "Korea Republic", yes_bid: 0, yes_ask: 100, close_time: "2026-06-28T15:09:18Z" }),
    ],
    ...overrides,
  };
}

describe("classification of live World Cup structures", () => {
  it("KXWCGAME is a game; advance/round/stage are progression", () => {
    expect(classifyEvent(wcGame())).toBe("game");
    expect(classifyEvent(wcAdvance())).toBe("progression");
    expect(classifyEvent(wcRound("QUAR", [49, 50]))).toBe("progression");
  });
  it("detects match-scoped advance events", () => {
    expect(isMatchScopedAdvance(wcAdvance())).toBe(true);
    expect(isMatchScopedAdvance(wcRound("QUAR", [49, 50]))).toBe(false);
    expect(isMatchScopedAdvance(wcGame())).toBe(false); // 3 markets
  });
  it("detects TIE markets", () => {
    expect(eventHasTie(wcGame())).toBe(true);
    expect(eventHasTie(wcAdvance())).toBe(false);
  });
  it("parses round tags, including Kalshi's RO16/RO32 spelling", () => {
    expect(parseRoundTag("KXWCROUND-26QUAR")).toBe("QUAR");
    expect(parseRoundTag("KXWCROUND-26SEMI")).toBe("SEMI");
    expect(parseRoundTag("KXWCROUND-26FINAL")).toBe("FINAL");
    expect(parseRoundTag("KXWCROUND-26RO16")).toBe("RO16");
    expect(parseRoundTag("KXWCADVANCE-26JUL05MEXENG")).toBeNull();
  });
  it("keeps World Cup families in one league", () => {
    expect(sameLeagueHint("KXWCADVANCE", "KXWCROUND")).toBe(true);
    expect(sameLeagueHint("KXMENWORLDCUP", "KXWCROUND")).toBe(true);
    expect(sameLeagueHint("KXWCADVANCE", "KXNBASERIES")).toBe(false);
    expect(sameLeagueHint("KXWSAL", "KXMLBGAME")).toBe(true);
  });
});

describe("round ladders", () => {
  const ladder = [wcRound("QUAR", [49, 50]), wcRound("SEMI", [21, 23]), wcRound("FINAL", [13, 14])];

  it("builds a per-team ladder sorted by round order, skipping dead markets", () => {
    const ladders = buildRoundLadders(ladder);
    const mex = ladders.get("KXWCROUND").get("MEX");
    expect(mex.map(r => r.tag)).toEqual(["QUAR", "SEMI", "FINAL"]);
  });

  it("finds no violation when prices are monotonic", () => {
    expect(findLadderViolations(ladder)).toHaveLength(0);
  });

  it("flags a later round priced above an earlier one as a lock", () => {
    // SEMI bid 55 > QUAR ask 50 — impossible by containment
    const bad = [wcRound("QUAR", [49, 50]), wcRound("SEMI", [55, 57])];
    const v = findLadderViolations(bad);
    expect(v).toHaveLength(1);
    expect(v[0].tier).toBe("LADDER");
    expect(v[0].fees.profitable).toBe(true);
    // buy QUAR YES @50 + buy SEMI NO @45 = 95 + 4 fees → 1¢ min lock
    expect(v[0].fees.profitCents).toBe(1);
    expect(v[0].legs).toHaveLength(2);
  });
});

describe("advance ⇄ next-round pairing (win ≡ advance)", () => {
  const events = [
    wcAdvance(),
    wcRound("QUAR", [49, 50]),
    wcRound("SEMI", [21, 23]),
    wcRound("FINAL", [13, 14]),
  ];

  it("pairs the advance market with the LOWEST live round only, as EXACT", () => {
    const pairs = findAdvanceLadderPairs(events);
    const mex = pairs.filter(p => p.gameMarket.ticker.endsWith("-MEX"));
    expect(mex).toHaveLength(1);
    expect(mex[0].tier).toBe("EXACT");
    expect(mex[0].progMarket.ticker).toBe("KXWCROUND-26QUAR-MEX");
    expect(mex[0].semantic).toContain("QUAR");
    // never pairs with SEMI/FINAL (those are not this match)
    expect(pairs.some(p => p.progMarket.ticker.includes("SEMI") || p.progMarket.ticker.includes("FINAL"))).toBe(false);
  });

  it("uses the lowest LIVE rung: R32 teams pair with RO16, qualified teams skip their dead RO16 rung", () => {
    // Modeled on live 2026-07-03 data: Colombia is mid-R32 (RO16 rung live
    // at 80), Mexico already qualified for R16 (RO16 rung dead 0/100).
    const ro16 = {
      event_ticker: "KXWCROUND-26RO16", series_ticker: "KXWCROUND",
      title: "FIFA World Cup Round of 16 Qualifiers",
      markets: [
        market({ ticker: "KXWCROUND-26RO16-COL", yes_sub_title: "Colombia", yes_bid: 80, yes_ask: 81, close_time: "2026-08-02T14:00:00Z" }),
        market({ ticker: "KXWCROUND-26RO16-MEX", yes_sub_title: "Mexico", yes_bid: 0, yes_ask: 100, close_time: "2026-07-01T04:19:53Z" }),
      ],
    };
    const quar = {
      event_ticker: "KXWCROUND-26QUAR", series_ticker: "KXWCROUND",
      title: "FIFA World Cup Quarterfinals Qualifiers",
      markets: [
        market({ ticker: "KXWCROUND-26QUAR-COL", yes_sub_title: "Colombia", yes_bid: 54, yes_ask: 56, close_time: "2026-08-03T14:00:00Z" }),
        market({ ticker: "KXWCROUND-26QUAR-MEX", yes_sub_title: "Mexico", yes_bid: 49, yes_ask: 50, close_time: "2026-08-03T14:00:00Z" }),
      ],
    };
    const colAdvance = {
      event_ticker: "KXWCADVANCE-26JUL03COLGHA", series_ticker: "KXWCADVANCE",
      title: "Colombia vs Ghana",
      markets: [
        market({ ticker: "KXWCADVANCE-26JUL03COLGHA-COL", yes_sub_title: "Colombia advances", yes_bid: 80, yes_ask: 81, close_time: "2026-08-02T00:00:00Z" }),
        market({ ticker: "KXWCADVANCE-26JUL03COLGHA-GHA", yes_sub_title: "Ghana advances", yes_bid: 19, yes_ask: 20, close_time: "2026-08-02T00:00:00Z" }),
      ],
    };
    const pairs = findAdvanceLadderPairs([colAdvance, wcAdvance(), ro16, quar]);
    const col = pairs.find(p => p.gameMarket.ticker.endsWith("COLGHA-COL"));
    const mex = pairs.find(p => p.gameMarket.ticker.endsWith("MEXENG-MEX"));
    expect(col.progMarket.ticker).toBe("KXWCROUND-26RO16-COL"); // R32 match → next rung is RO16
    expect(mex.progMarket.ticker).toBe("KXWCROUND-26QUAR-MEX"); // R16 match → dead RO16 skipped
    // Colombia 80/81 vs RO16 80/81 → consistent, no opportunity
    const opps = findEquivalenceOpportunities([colAdvance, ro16, quar]);
    expect(opps.filter(o => o.markets.some(m => m.ticker.includes("COLGHA")))).toHaveLength(0);
  });

  it("tight live prices (48/49 vs 49/50) produce no opportunity", () => {
    const opps = findEquivalenceOpportunities(events);
    expect(opps.filter(o => o.tier === "EXACT" && o.markets.some(m => m.ticker.includes("QUAR-MEX")))).toHaveLength(0);
  });

  it("a mispriced next round becomes a profitable EXACT lock", () => {
    const mispriced = [
      wcAdvance(), // Mexico advances 48/49
      wcRound("QUAR", [59, 61]), // reach QF priced 60 — 11¢ above the identical advance market
      wcRound("SEMI", [21, 23]),
    ];
    const opps = findEquivalenceOpportunities(mispriced);
    const lock = opps.find(o => o.tier === "EXACT" && o.markets.some(m => m.ticker === "KXWCROUND-26QUAR-MEX"));
    expect(lock).toBeTruthy();
    // buy advance YES @49 + buy round NO @41 = 90 + 4 fees → 6¢ lock
    expect(lock.fees.profitable).toBe(true);
    expect(lock.fees.profitCents).toBe(6);
    expect(lock.desc).toContain("QUAR");
  });
});

describe("TIE guard — reg-time moneyline never EXACT-pairs", () => {
  it("caps a time-aligned reg-time × progression pair at CONDITIONAL", () => {
    // Force close-time alignment that would otherwise be EXACT
    const ge = wcGame();
    const prog = {
      event_ticker: "KXWCROUND-26QUAR",
      series_ticker: "KXWCROUND",
      title: "FIFA World Cup QUAR Qualifiers",
      markets: [market({ ticker: "KXWCROUND-26QUAR-MEX", yes_sub_title: "Mexico", yes_bid: 49, yes_ask: 50, close_time: "2026-07-20T00:00:00Z" })],
    };
    const opps = findEquivalenceOpportunities([ge, prog]);
    // Reg-time Mexico (mid 31.5) vs reach-QF (mid 49.5) diverge 18¢, but the
    // TIE guard must prevent an EXACT/LIKELY "lock" — P(advance) > P(reg win)
    // is legitimate, not mispricing.
    expect(opps.some(o => (o.tier === "EXACT" || o.tier === "LIKELY") && o.markets.some(m => m.ticker.endsWith("GAME-26JUL05MEXENG-MEX") || m.ticker.endsWith("-MEX") && o.markets.some(x => x.ticker.includes("WCGAME"))))).toBe(false);
    // And no dominance REVIEW either: round ask (50) > game bid (31) — no violation
    expect(opps.filter(o => o.markets.some(m => m.ticker.includes("WCGAME")))).toHaveLength(0);
  });
});

describe("CONDITIONAL 14-day gate", () => {
  it("does not flag season-long markets against nightly games", () => {
    // MLB game tonight vs World Series winner market closing in October:
    // WS ask (6¢) < game bid (55¢) is legitimate, not a dominance violation.
    const game = {
      event_ticker: "KXMLBGAME-26JUL051700TORSEA",
      series_ticker: "KXMLBGAME",
      title: "Toronto vs Seattle",
      markets: [
        market({ ticker: "KXMLBGAME-26JUL051700TORSEA-TOR", yes_sub_title: "Toronto", yes_bid: 55, yes_ask: 57, close_time: "2026-07-06T02:00:00Z" }),
        market({ ticker: "KXMLBGAME-26JUL051700TORSEA-SEA", yes_sub_title: "Seattle", yes_bid: 42, yes_ask: 44, close_time: "2026-07-06T02:00:00Z" }),
      ],
    };
    const ws = {
      event_ticker: "KXMLBWS-26",
      series_ticker: "KXMLBWS",
      title: "World Series Champion",
      markets: [market({ ticker: "KXMLBWS-26-TOR", yes_sub_title: "Toronto", yes_bid: 5, yes_ask: 6, close_time: "2026-11-05T00:00:00Z" })],
    };
    const opps = findEquivalenceOpportunities([game, ws]);
    expect(opps).toHaveLength(0);
  });
});

describe("findMultiWayArbs — 3-way regulation moneyline", () => {
  it("live-shaped prices (31/32 + 39/40 + 29/30 asks = 102) → no arb", () => {
    expect(findMultiWayArbs([wcGame()])).toHaveLength(0);
  });
  it("buy-all when the 3 asks sum below $1 minus fees", () => {
    const e = wcGame();
    e.markets = e.markets.map(m => ({ ...m, yes_ask: 30, yes_bid: 28 })); // sum 90
    const opps = findMultiWayArbs([e]);
    const buy = opps.find(o => o.suggestedAction === "buy");
    expect(buy).toBeTruthy();
    expect(buy.fees.profitable).toBe(true);
    expect(buy.edge).toBe(100 - 90 - buy.fees.feeTotal);
  });
  it("sell-all when the 3 bids sum above $1 plus fees", () => {
    const e = wcGame();
    e.markets = e.markets.map(m => ({ ...m, yes_bid: 37, yes_ask: 39 })); // bids 111
    const opps = findMultiWayArbs([e]);
    const sell = opps.find(o => o.suggestedAction === "sell");
    expect(sell).toBeTruthy();
    expect(sell.edge).toBe(111 - 100 - sell.fees.feeTotal);
  });
  it("requires the mutually_exclusive flag", () => {
    const e = wcGame({ mutually_exclusive: false });
    e.markets = e.markets.map(m => ({ ...m, yes_ask: 30 }));
    expect(findMultiWayArbs([e])).toHaveLength(0);
  });
});
