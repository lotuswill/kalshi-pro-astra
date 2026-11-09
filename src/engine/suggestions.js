// Trade suggestion engine — maps an opportunity to a signal.
export function generateSuggestion(opp) {
  if (opp.type === "GUARANTEED") return { signal: "STRONG BUY", confidence: 99, reason: "Risk-free arbitrage — guaranteed profit regardless of outcome" };
  if (opp.type === "EQUIVALENT" && opp.tier === "EXACT" && opp.fees?.profitable) return { signal: "STRONG BUY", confidence: 95, reason: "Equivalent outcomes in two markets priced apart — lock the spread with YES + NO legs" };
  if (opp.type === "EQUIVALENT" && opp.tier === "EXACT") return { signal: "WATCH", confidence: 75, reason: "Equivalent markets diverging — not yet profitable after fees; watch for wider gap" };
  if (opp.type === "EQUIVALENT" && opp.tier === "LIKELY") return { signal: "LEAN BUY", confidence: 65, reason: "Probably the same outcome in two markets — verify settlement terms before pairing" };
  if (opp.type === "EQUIVALENT") return { signal: "REVIEW", confidence: 55, reason: "Dominance bound violated IF tonight's game clinches — confirm series state first" };
  if (opp.type === "VALUE" && opp.edge >= 6) return { signal: "BUY", confidence: 82, reason: "Kalshi priced well outside the devigged multi-book consensus — positive EV after fees" };
  if (opp.type === "VALUE") return { signal: "LEAN BUY", confidence: 68, reason: "Kalshi modestly outside the no-vig book consensus" };
  if (opp.type === "FRESH_SKEW" && opp.tier === "ANCHORED") return { signal: "FADE", confidence: 72, reason: "Fresh listing skewed away from book consensus on thin volume — fade toward fair, expect relaxation by gametime" };
  if (opp.type === "FRESH_SKEW") return { signal: "WATCH", confidence: 55, reason: "Fresh extreme on a thin book with no anchor yet — track for relaxation; fade if books open lower" };
  if (opp.type === "NEAR_ARB") return { signal: "WATCH", confidence: 70, reason: "Near-arbitrage — monitor for ask prices to dip below $1 total" };
  if (opp.type === "CROSS_MARKET" && opp.edge > 10) return { signal: "BUY", confidence: 75, reason: "Significant cross-market mispricing between winner and spread contracts" };
  if (opp.type === "CROSS_MARKET") return { signal: "LEAN BUY", confidence: 60, reason: "Moderate cross-market gap — may correct as game approaches" };
  if (opp.type === "SPORTSBOOK" && opp.edge > 5) return { signal: "BUY", confidence: 80, reason: "Sportsbook odds diverge significantly from Kalshi price" };
  return { signal: "MONITOR", confidence: 50, reason: "Edge detected but not strong enough for high conviction" };
}
