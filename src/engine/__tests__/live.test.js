import { describe, it, expect } from "vitest";
import { findFreshMarkets, findSettlementLags, findNearCertain, espnGameState } from "../live.js";
import { normalizeOrderbook, normalizeTrades } from "../normalize.js";
import { market } from "./fixtures.js";

const NOW = Date.parse("2026-07-05T20:00:00Z");

function mlbEvent(overrides = {}) {
  return {
    event_ticker: "KXMLBGAME-26JUL051700TORSEA",
    series_ticker: "KXMLBGAME",
    title: "Toronto vs Seattle",
    markets: [
      market({ ticker: "KXMLBGAME-26JUL051700TORSEA-TOR", yes_sub_title: "Toronto", yes_bid: 88, yes_ask: 90, occurrence_datetime: "2026-07-05T17:00:00Z", created_time: "2026-07-04T12:00:00Z", volume_24h: 500 }),
      market({ ticker: "KXMLBGAME-26JUL051700TORSEA-SEA", yes_sub_title: "Seattle", yes_bid: 9, yes_ask: 11, occurrence_datetime: "2026-07-05T17:00:00Z", created_time: "2026-07-04T12:00:00Z", volume_24h: 480 }),
    ],
    ...overrides,
  };
}

function espnFinal(overrides = {}) {
  return {
    name: "Toronto Blue Jays at Seattle Mariners",
    status: "STATUS_FINAL",
    statusDetail: "Final",
    competitors: [
      { abbr: "TOR", score: "7", homeAway: "away" },
      { abbr: "SEA", score: "3", homeAway: "home" },
    ],
    ...overrides,
  };
}

describe("normalizeOrderbook / normalizeTrades (drift)", () => {
  it("converts orderbook_fp dollar tuples to cents", () => {
    const ob = normalizeOrderbook({ orderbook_fp: { yes_dollars: [["0.4500", "10605.00"], ["0.4700", "25000.00"]], no_dollars: [["0.4500", "5520.00"]] } });
    expect(ob.orderbook.yes[0]).toEqual([45, 10605]);
    expect(ob.orderbook.yes[1]).toEqual([47, 25000]);
    expect(ob.orderbook.no[0]).toEqual([45, 5520]);
  });
  it("passes legacy cents orderbooks through", () => {
    const legacy = { orderbook: { yes: [[45, 100]], no: [] } };
    expect(normalizeOrderbook(legacy)).toBe(legacy);
  });
  it("converts trade dollar prices and fp counts", () => {
    const [t] = normalizeTrades([{ yes_price_dollars: "0.5100", no_price_dollars: "0.4900", count_fp: "94.78", taker_side: "yes", created_time: "2026-07-03T21:52:26Z" }]);
    expect(t.yes_price).toBe(51);
    expect(t.no_price).toBe(49);
    expect(t.count).toBe(95);
  });
});

describe("espnGameState", () => {
  it("classifies final / live / pre", () => {
    expect(espnGameState({ status: "STATUS_FINAL" })).toBe("final");
    expect(espnGameState({ status: "STATUS_IN_PROGRESS" })).toBe("live");
    expect(espnGameState({ status: "STATUS_SCHEDULED" })).toBe("pre");
  });
});

describe("findSettlementLags", () => {
  it("flags the winner still asking below threshold after ESPN FINAL", () => {
    const lags = findSettlementLags([mlbEvent()], [espnFinal()]);
    const w = lags.find(l => l.kind === "WINNER_UNDERPRICED");
    expect(w).toBeTruthy();
    expect(w.ticker).toBe("KXMLBGAME-26JUL051700TORSEA-TOR");
    expect(w.side).toBe("yes");
    expect(w.price).toBe(90); // buy YES at the 90¢ ask
    expect(w.edge).toBe(100 - 90 - w.fee);
  });
  it("flags the loser still bidding above the floor", () => {
    const lags = findSettlementLags([mlbEvent()], [espnFinal()]);
    const l = lags.find(x => x.kind === "LOSER_OVERPRICED");
    expect(l).toBeTruthy();
    expect(l.ticker).toBe("KXMLBGAME-26JUL051700TORSEA-SEA");
    expect(l.side).toBe("no");
    expect(l.price).toBe(91); // NO ask = 100 − 9 bid
  });
  it("stays quiet when the game is still live", () => {
    const live = espnFinal({ status: "STATUS_IN_PROGRESS", statusDetail: "Bottom 7th" });
    expect(findSettlementLags([mlbEvent()], [live])).toHaveLength(0);
  });
  it("stays quiet when prices already reflect the result", () => {
    const e = mlbEvent();
    e.markets[0] = { ...e.markets[0], yes_bid: 97, yes_ask: 99 };
    e.markets[1] = { ...e.markets[1], yes_bid: 1, yes_ask: 3 };
    expect(findSettlementLags([e], [espnFinal()])).toHaveLength(0);
  });
  it("does not misfire on tied scores", () => {
    const tied = espnFinal({ competitors: [{ abbr: "TOR", score: "3" }, { abbr: "SEA", score: "3" }] });
    expect(findSettlementLags([mlbEvent()], [tied])).toHaveLength(0);
  });
});

describe("findNearCertain", () => {
  it("lists in-game markets trading 80-96 sorted by mid", () => {
    const out = findNearCertain([mlbEvent()], { now: NOW });
    expect(out).toHaveLength(1); // TOR at 89; SEA at 10 is out of range
    expect(out[0].ticker).toContain("-TOR");
    // 100 − 90 ask − 1¢ fee (0.07 × 0.90 × 0.10 → 0.63¢ rounded up)
    expect(out[0].captureCents).toBe(9);
  });
  it("excludes games that have not started", () => {
    const e = mlbEvent();
    e.markets = e.markets.map(m => ({ ...m, occurrence_datetime: "2026-07-06T17:00:00Z" }));
    expect(findNearCertain([e], { now: NOW })).toHaveLength(0);
  });
  it("excludes near-settled markets at 97+", () => {
    const e = mlbEvent();
    e.markets[0] = { ...e.markets[0], yes_bid: 97, yes_ask: 99 };
    expect(findNearCertain([e], { now: NOW })).toHaveLength(0);
  });
});

describe("findFreshMarkets", () => {
  it("returns markets created within the window with time-to-game", () => {
    const out = findFreshMarkets([mlbEvent()], { now: NOW, maxAgeHours: 48 });
    expect(out).toHaveLength(2);
    expect(out[0].ageHours).toBeCloseTo(32, 0);
    expect(out[0].hoursToGame).toBeCloseTo(-3, 0); // game started 3h ago
  });
  it("respects a 24h filter", () => {
    const out = findFreshMarkets([mlbEvent()], { now: NOW, maxAgeHours: 24 });
    expect(out).toHaveLength(0);
  });
  it("marks wide/empty books as unpriced", () => {
    const e = mlbEvent();
    e.markets = [market({ ticker: "X-1", yes_bid: 0, yes_ask: 99, created_time: "2026-07-05T10:00:00Z" })];
    const out = findFreshMarkets([e], { now: NOW });
    expect(out[0].unpriced).toBe(true);
  });
});
