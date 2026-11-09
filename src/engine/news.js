// ═══════════════════════════════════════════════════════════════
// GAME NEWS — match ESPN stories to the games we're in (watched,
// favorited, or held) so a lineup change or injury headline shows up
// next to the market it moves.
// ═══════════════════════════════════════════════════════════════

const STOP = new Set(["will", "with", "from", "that", "this", "their", "have", "after", "before", "game", "match", "team", "season", "world", "sports", "news"]);

export function teamTokens(...strings) {
  const out = new Set();
  strings.forEach(s => (s || "").toLowerCase().split(/[^a-z]+/).forEach(w => {
    if (w.length > 3 && !STOP.has(w)) out.add(w);
  }));
  return out;
}

// contexts: [{ label, tokens:Set, ticker? }] — build from watched/held games.
export function contextsFromWatchlist(watchList) {
  return (watchList || []).map(w => ({
    label: w.event || w.ticker,
    ticker: w.ticker,
    tokens: teamTokens(w.event, w.title),
  })).filter(c => c.tokens.size > 0);
}

// stories: [{ headline, description, published, links, images }]
// Returns stories annotated with which contexts they hit, sorted by
// relevance (matched token count) then recency.
export function matchStoriesToContexts(stories, contexts) {
  const out = [];
  (stories || []).forEach(st => {
    const text = `${st.headline || ""} ${st.description || ""}`.toLowerCase();
    const hits = [];
    (contexts || []).forEach(ctx => {
      let matched = 0;
      for (const t of ctx.tokens) if (text.includes(t)) matched++;
      if (matched >= 1) hits.push({ label: ctx.label, ticker: ctx.ticker, matched });
    });
    if (hits.length) {
      hits.sort((a, b) => b.matched - a.matched);
      out.push({ ...st, hits, relevance: hits[0].matched });
    }
  });
  out.sort((a, b) => b.relevance - a.relevance || (Date.parse(b.published || 0) - Date.parse(a.published || 0)));
  return out;
}
