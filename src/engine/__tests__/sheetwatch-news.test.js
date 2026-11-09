import { describe, it, expect } from "vitest";
import { diffSheets, SheetWatcher } from "../sheetwatch.js";
import { teamTokens, contextsFromWatchlist, matchStoriesToContexts } from "../news.js";

const T0 = Date.parse("2026-07-05T12:00:00Z");

describe("diffSheets", () => {
  const prev = [["Team", "Edge", "Note"], ["OKC", "4.5", "hold"], ["MEX", "2.1", ""]];

  it("detects cell changes with A1-style addresses and headers", () => {
    const next = [["Team", "Edge", "Note"], ["OKC", "6.0", "hold"], ["MEX", "2.1", ""]];
    const ch = diffSheets(prev, next);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ kind: "cell_changed", cell: "B2", header: "Edge", before: "4.5", after: "6.0" });
  });

  it("detects added and removed rows", () => {
    const added = diffSheets(prev, [...prev, ["USA", "7.9", "new"]]);
    expect(added[0]).toMatchObject({ kind: "row_added", row: 4 });
    const removed = diffSheets(prev, prev.slice(0, 2));
    expect(removed[0]).toMatchObject({ kind: "row_removed", row: 3 });
  });

  it("returns nothing for identical sheets", () => {
    expect(diffSheets(prev, prev.map(r => [...r]))).toHaveLength(0);
  });
});

describe("SheetWatcher", () => {
  it("logs timestamped change batches across polls and round-trips JSON", () => {
    const w = new SheetWatcher();
    expect(w.ingest([["A"], ["1"]], T0)).toHaveLength(0); // first poll = baseline
    const ch = w.ingest([["A"], ["2"]], T0 + 60_000);
    expect(ch).toHaveLength(1);
    expect(w.recentChanges()[0]).toMatchObject({ cell: "A2", after: "2", time: T0 + 60_000 });
    const w2 = SheetWatcher.fromJSON(w.toJSON());
    expect(w2.recentChanges()).toHaveLength(1);
    expect(w2.ingest([["A"], ["2"]], T0 + 120_000)).toHaveLength(0); // baseline restored
  });
});

describe("news matching", () => {
  const watch = [
    { ticker: "KXWCADVANCE-26JUL05MEXENG-MEX", event: "Mexico vs England", title: "Mexico advances" },
    { ticker: "KXMLBGAME-26JUL051700TORSEA-TOR", event: "Toronto vs Seattle", title: "Toronto" },
  ];
  const stories = [
    { headline: "Mexico's star striker doubtful for England clash", description: "Hamstring tightness in training", published: "2026-07-05T10:00:00Z" },
    { headline: "Blue Jays place ace on IL", description: "Toronto rotation shuffle before Seattle series", published: "2026-07-05T09:00:00Z" },
    { headline: "NBA free agency rumors", description: "Nothing to do with our games", published: "2026-07-05T08:00:00Z" },
  ];

  it("builds token contexts from the watchlist", () => {
    const ctx = contextsFromWatchlist(watch);
    expect(ctx).toHaveLength(2);
    expect([...ctx[0].tokens]).toContain("mexico");
    expect([...ctx[0].tokens]).toContain("england");
  });

  it("matches stories to the right games and drops unrelated ones", () => {
    const matched = matchStoriesToContexts(stories, contextsFromWatchlist(watch));
    expect(matched).toHaveLength(2);
    const mex = matched.find(s => /Mexico/.test(s.headline));
    expect(mex.hits[0].ticker).toContain("MEXENG");
    const tor = matched.find(s => /Blue Jays/.test(s.headline));
    expect(tor.hits[0].ticker).toContain("TORSEA");
  });

  it("filters junk words from tokens", () => {
    expect([...teamTokens("World Cup Game will start")]).not.toContain("game");
  });
});
