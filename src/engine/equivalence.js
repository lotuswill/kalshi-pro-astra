// ═══════════════════════════════════════════════════════════════
// CROSS-EVENT EQUIVALENCE ENGINE
//
// Detects when markets in DIFFERENT Kalshi events settle on the same
// underlying outcome — e.g. "Team A wins tonight's game" (KXNBAGAME)
// and "Team A advances to the next round" (a series/advance market)
// are the same bet when the game is an elimination/decisive game.
//
// When two markets are equivalent but priced apart, buying YES on the
// cheap one and NO on the expensive one costs < $1 for a guaranteed
// $1 payout (minus fees) — a true cross-event arbitrage.
//
// Equivalence tiers (confidence):
//   EXACT       — progression market closes with this game (close times
//                 within `exactWindowMs`) and references the same team:
//                 the game decides it (single-elim, game 7, decisive leg)
//   LIKELY      — same team + same calendar day, but close times differ
//                 enough that settlement linkage isn't certain
//   CONDITIONAL — series-type market referencing the team with a later
//                 close: tonight's game may or may not decide it. Only a
//                 dominance bound applies: if a win tonight clinches,
//                 P(advance) ≥ P(win game).
// ═══════════════════════════════════════════════════════════════

import { calcArbProfit, kalshiFeeCents, midCents } from "./fees.js";
import { extractTeamsFromTicker, parseGameDate, getSeriesPrefix } from "./tickers.js";

const HOUR = 3600 * 1000;

// Series-ticker / title patterns that mark a market as settling a
// single game rather than a progression outcome.
const GAME_SERIES_RE = /GAME|MATCH|FIGHT/i;
const NON_WINNER_RE = /SPREAD|TOTAL|GOAL|RFI|1H|2H|FIRST|ANY/i;

// Progression outcomes: series winners, advancement, titles.
const PROG_SERIES_RE = /SERIES|ADVANCE|CHAMP|CUP|FINAL|PLAYOFF|ROUND|WINNER|CONF|EAST|WEST|MADNESS|PROMOT|QUALIF/i;
const PROG_TITLE_RE = /advance|series|next round|reach|qualif|champion|final four|elite eight|sweet 16|conference|promot|win the|make the|playoff/i;

export function classifyEvent(event) {
  const st = event?.series_ticker || getSeriesPrefix(event?.event_ticker);
  const title = event?.title || "";
  if (GAME_SERIES_RE.test(st) && !NON_WINNER_RE.test(st)) return "game";
  if (PROG_SERIES_RE.test(st) || PROG_TITLE_RE.test(title)) return "progression";
  return "other";
}

// A "match-scoped" progression event settles with one specific game:
// e.g. KXWCADVANCE-26JUL06USABEL ("USA vs Belgium", one market per team,
// "USA advances"). These are effectively match-winner markets (winner
// including extra time/penalties) and anchor the win ≡ advance pairing.
export function isMatchScopedAdvance(event) {
  const st = event?.series_ticker || getSeriesPrefix(event?.event_ticker);
  if (!/ADVANCE/i.test(st) && !/advance/i.test(event?.title || "")) return false;
  const mkts = event?.markets || [];
  if (mkts.length !== 2) return false;
  return /\d{2}[A-Z]{3}\d{2}[A-Z]{4,8}$/.test(event?.event_ticker || "");
}

// A game event with a TIE/DRAW market is a regulation-time moneyline
// (soccer): a team can tie in regulation and still advance on penalties,
// so its winner markets are NEVER exactly equivalent to advancing.
export function eventHasTie(event) {
  return (event?.markets || []).some(m =>
    /(^|-)(TIE|DRAW)$/.test(m.ticker || "") || /\b(tie|draw)\b/i.test(m.yes_sub_title || m.title || ""));
}

// ─── Tournament round ladders ────────────────────────────────
// Series like KXWCROUND list one event per round ("Quarterfinals
// Qualifiers") with one market per team. Containment is a hard rule:
// reaching round k+1 implies reaching round k, so P(k+1) ≤ P(k).
const ROUND_ORDER = {
  GS: 0, GROUP: 0,
  R64: 1, RO64: 1,
  R32: 2, RO32: 2,
  R16: 3, RO16: 3,
  QF: 4, QUAR: 4, QUARTER: 4, QUARTERS: 4,
  SF: 5, SEMI: 5, SEMIS: 5,
  FINAL: 6, FINALS: 6, F: 6,
  CHAMP: 7, WINNER: 7,
};

export function parseRoundTag(eventTicker) {
  const suffix = ((eventTicker || "").split("-").pop() || "").replace(/^\d+/, "").toUpperCase();
  return ROUND_ORDER[suffix] != null ? suffix : null;
}

// Live = actually tradeable and undecided: excludes dead 0/100 books
// (eliminated teams) and near-settled ~99¢ markets (already qualified).
function isLiveMarket(m) {
  const bid = m?.yes_bid || 0, ask = m?.yes_ask || 0;
  if (bid <= 0 || ask <= 0 || ask >= 100) return false;
  const mid = (bid + ask) / 2;
  return mid < 97 && mid > 1;
}

// Build ladders: seriesPrefix → Map(teamCode → [{order, tag, market, event}] sorted by order)
export function buildRoundLadders(kalshiEvents) {
  const bySeries = new Map();
  kalshiEvents.forEach(e => {
    if (classifyEvent(e) !== "progression") return;
    const tag = parseRoundTag(e.event_ticker);
    if (!tag) return;
    const prefix = getSeriesPrefix(e.event_ticker);
    if (!bySeries.has(prefix)) bySeries.set(prefix, new Map());
    const teams = bySeries.get(prefix);
    (e.markets || []).forEach(m => {
      const parts = (m.ticker || "").split("-");
      const code = parts.length >= 3 ? parts[parts.length - 1].toUpperCase() : null;
      if (!code) return;
      if (!teams.has(code)) teams.set(code, []);
      teams.get(code).push({ order: ROUND_ORDER[tag], tag, market: m, event: e });
    });
  });
  // Keep only series that form an actual ladder (≥2 rounds) and sort
  for (const [prefix, teams] of bySeries) {
    let maxRounds = 0;
    for (const arr of teams.values()) { arr.sort((a, b) => a.order - b.order); maxRounds = Math.max(maxRounds, arr.length); }
    if (maxRounds < 2) bySeries.delete(prefix);
  }
  return bySeries;
}

// Normalize a name for fuzzy team matching: keep words > 3 chars.
const STOP_WORDS = new Set([
  "will", "wins", "winner", "advance", "advances", "series", "champion", "game",
  "match", "reach", "next", "round", "make", "time", "regulation", "moneyline",
  "qualifiers", "fifa", "world",
]);
function nameTokens(...strings) {
  const out = new Set();
  strings.forEach(s => (s || "").toLowerCase().split(/[^a-z]+/).forEach(w => {
    if (w.length > 3 && !STOP_WORDS.has(w)) out.add(w);
  }));
  return out;
}

// The team a market is about, expressed as { code, tokens }.
// code: ticker suffix (e.g. "-LAL" → "LAL"); tokens: name words.
// IMPORTANT: prefer yes_sub_title ("Reg Time: Spain") and only fall back
// to the market title when there is no sub_title — market titles often
// name BOTH teams ("Portugal vs Spain: ...") and would cross-match.
function marketTeamRef(market, event) {
  const parts = (market?.ticker || "").split("-");
  const code = parts.length >= 3 ? parts[parts.length - 1].toUpperCase() : null;
  const tokens = nameTokens(market?.yes_sub_title || market?.title);
  return { code, tokens };
}

function refsMatch(a, b) {
  if (a.code && b.code && a.code === b.code) return true;
  for (const t of a.tokens) if (b.tokens.has(t)) return true;
  return false;
}

function closeTimeMs(market) {
  const t = market?.close_time ? Date.parse(market.close_time) : NaN;
  return isNaN(t) ? null : t;
}

// ─── Pair detection ──────────────────────────────────────────
// Returns equivalence pairs:
// { tier, team, gameEvent, gameMarket, progEvent, progMarket, closeDeltaMs }
export function findEquivalentPairs(kalshiEvents, opts = {}) {
  const exactWindowMs = opts.exactWindowMs ?? 6 * HOUR;
  const sameDayWindowMs = opts.sameDayWindowMs ?? 36 * HOUR;

  const games = [];
  const progs = [];
  kalshiEvents.forEach(e => {
    const cls = classifyEvent(e);
    if (cls === "game") games.push(e);
    else if (cls === "progression") progs.push(e);
  });

  const pairs = [];
  games.forEach(ge => {
    const teams = extractTeamsFromTicker(ge.event_ticker);
    const gameDate = parseGameDate(ge.event_ticker);
    (ge.markets || []).forEach(gm => {
      const gRef = marketTeamRef(gm, ge);
      const gClose = closeTimeMs(gm);
      if (!gRef.code && gRef.tokens.size === 0) return;

      progs.forEach(pe => {
        // A progression market can't be equivalent to a game in a
        // different sport — require matching league hint in the series
        // tickers when both carry one (e.g. NBA vs NHL).
        if (!sameLeagueHint(ge.series_ticker, pe.series_ticker)) return;

        (pe.markets || []).forEach(pm => {
          const pRef = marketTeamRef(pm, pe);
          // Progression events are often single-market ("Will X advance?")
          // where the team lives in the event title instead. Only fall back
          // to the event title when the market carries no team info of its
          // own — a title naming both teams would pair the wrong markets.
          if (pRef.tokens.size === 0 && !pRef.code) pRef.tokens = nameTokens(pe.title);
          if (!refsMatch(gRef, pRef)) return;

          const pClose = closeTimeMs(pm);
          let tier = "CONDITIONAL";
          let closeDeltaMs = null;
          if (gClose != null && pClose != null) {
            closeDeltaMs = Math.abs(pClose - gClose);
            if (closeDeltaMs <= exactWindowMs) tier = "EXACT";
            else if (closeDeltaMs <= sameDayWindowMs) tier = "LIKELY";
          } else if (gameDate && pm.close_time) {
            const pd = new Date(pm.close_time);
            if (pd.toDateString() === gameDate.toDateString()) tier = "LIKELY";
          }
          // Regulation-time moneylines (event has a TIE market) can tie
          // and still see the team advance — never exactly equivalent.
          if (tier !== "CONDITIONAL" && eventHasTie(ge)) tier = "CONDITIONAL";

          pairs.push({
            tier,
            team: gRef.code || [...gRef.tokens][0] || "?",
            teams,
            gameEvent: ge, gameMarket: gm,
            progEvent: pe, progMarket: pm,
            closeDeltaMs,
          });
        });
      });
    });
  });
  return pairs;
}

// Both series tickers mention a league token → require same token.
// If either has no recognizable league token, don't block the match.
const LEAGUE_TOKENS = ["NBA", "NFL", "NHL", "MLB", "NCAAMB", "NCAAWB", "NCAABB", "NCAAF", "EPL", "UCL", "UEL", "MLS", "LALIGA", "BUNDESLIGA", "SERIA", "ATP", "WTA", "UFC", "IPL", "T20", "WC"];
// Different tickers for the same competition (KXMENWORLDCUP vs KXWCROUND,
// KXWSAL "AL champion" vs KXMLBGAME) — alias to one canonical league.
const LEAGUE_ALIASES = { WORLDCUP: "WC", MENWORLDCUP: "WC", MWORLDCUP: "WC", WSAL: "MLB", WSNL: "MLB", MLBWS: "MLB" };
function leagueOf(seriesTicker) {
  const st = (seriesTicker || "").toUpperCase();
  for (const [alias, canon] of Object.entries(LEAGUE_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    if (st.includes(alias)) return canon;
  }
  // Longest match first so NCAAMB doesn't hit NBA etc.
  return LEAGUE_TOKENS.slice().sort((a, b) => b.length - a.length).find(t => st.includes(t)) || null;
}
export function sameLeagueHint(seriesA, seriesB) {
  const a = leagueOf(seriesA), b = leagueOf(seriesB);
  if (!a || !b) return true;
  return a === b;
}

// ─── Pricing equivalence pairs into opportunities ────────────
// For EXACT/LIKELY pairs the two markets should trade at the same price.
// Arb construction when they diverge beyond fees:
//   buy YES on the cheaper market at its ask,
//   buy NO  on the pricier market at its NO ask (= 100 − yes_bid).
// If the outcomes are truly identical, exactly one leg pays $1.
export function priceEquivalencePair(pair) {
  const { gameMarket: gm, progMarket: pm, tier } = pair;
  const gMid = midCents(gm), pMid = midCents(pm);
  if (gMid == null || pMid == null) return null;

  const cheap = gMid <= pMid ? gm : pm;
  const rich = gMid <= pMid ? pm : gm;
  const cheapYesAsk = cheap.yes_ask || 0;
  const richNoAsk = rich.yes_bid ? 100 - rich.yes_bid : 0; // NO ask ≈ 100 − yes bid
  const divergence = Math.abs(gMid - pMid);

  if (!cheapYesAsk || !richNoAsk) {
    return { pair, divergence, executable: false, calc: null };
  }
  const calc = calcArbProfit(cheapYesAsk, richNoAsk, 1, false);
  return {
    pair,
    divergence,
    executable: true,
    calc,
    legs: [
      { ticker: cheap.ticker, side: "yes", action: "buy", price: cheapYesAsk, title: cheap.title || cheap.yes_sub_title },
      { ticker: rich.ticker, side: "no", action: "buy", price: richNoAsk, title: rich.title || rich.yes_sub_title },
    ],
  };
}

// CONDITIONAL pairs only support the dominance bound when a win
// tonight clinches the progression outcome: P(advance) ≥ P(win game).
// A violation (advance YES ask < game YES bid) is a dominance arb:
// buy advance YES @ ask, sell game YES @ bid — collects the spread if
// the team wins, and keeps upside if the team loses tonight but still
// advances. Guaranteed profit ONLY if the clinch assumption holds, so
// these are surfaced as REVIEW items, never auto-tradeable.
export function findDominanceViolation(pair) {
  const { gameMarket: gm, progMarket: pm } = pair;
  const advanceAsk = pm.yes_ask || 0;
  const gameBid = gm.yes_bid || 0;
  if (!advanceAsk || !gameBid) return null;
  const spread = gameBid - advanceAsk;
  if (spread <= 0) return null;
  const fees = kalshiFeeCents(advanceAsk, 1, false) + kalshiFeeCents(gameBid, 1, false);
  return { spread, fees, netCents: spread - fees, profitable: spread - fees > 0 };
}

// Ladder monotonicity violations: later round priced ABOVE an earlier
// round for the same team. Containment makes this a pure arb — buy the
// earlier-round YES + buy the later-round NO. Payout is ≥ $1 in every
// outcome (both pay if the team stalls between rounds), cost < $1 when
// laterBid > earlierAsk beyond fees.
export function findLadderViolations(kalshiEvents) {
  const opps = [];
  for (const [prefix, teams] of buildRoundLadders(kalshiEvents)) {
    for (const [code, rounds] of teams) {
      const live = rounds.filter(r => isLiveMarket(r.market));
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const early = live[i], late = live[j];
          if (late.order <= early.order) continue;
          const spread = (late.market.yes_bid || 0) - (early.market.yes_ask || 0);
          if (spread <= 0) continue;
          const earlyAsk = early.market.yes_ask;
          const lateNoAsk = 100 - late.market.yes_bid;
          const calc = calcArbProfit(earlyAsk, lateNoAsk, 1, false);
          opps.push({
            type: "EQUIVALENT", tier: "LADDER",
            edge: calc.profitable ? calc.profitCents : spread,
            game: `${early.event.title} ⇄ ${late.event.title} (${code})`,
            sport: prefix,
            desc: `Round ladder inverted for ${code}: reaching ${late.tag} (bid ${late.market.yes_bid}¢) is priced ABOVE reaching ${early.tag} (ask ${earlyAsk}¢) — impossible, later rounds require earlier ones. ` +
              (calc.profitable ? `LOCK: buy ${early.tag} YES @${earlyAsk}¢ + ${late.tag} NO @${lateNoAsk}¢ → ≥${calc.profitCents}¢/contract after ${calc.feeTotal}¢ fees (pays double if eliminated between rounds).`
                : `Not profitable after ${calc.feeTotal}¢ fees.`),
            action: `BUY YES ${early.market.ticker} @${earlyAsk}¢ + BUY NO ${late.market.ticker} @${lateNoAsk}¢`,
            markets: [early.market, late.market],
            legs: [
              { ticker: early.market.ticker, side: "yes", action: "buy", price: earlyAsk, title: early.market.yes_sub_title || early.market.title },
              { ticker: late.market.ticker, side: "no", action: "buy", price: lateNoAsk, title: late.market.yes_sub_title || late.market.title },
            ],
            color: calc.profitable ? "#00e8a4" : "#e879f9",
            suggestedSide: "yes", suggestedAction: "buy", suggestedPrice: earlyAsk,
            fees: calc,
          });
        }
      }
    }
  }
  return opps;
}

// Match-scoped advance ⇄ round ladder: "Team advances (this match)" is
// EXACTLY "team reaches the next round" — the lowest still-live rung of
// the ladder. (For a team alive in the R16, reaching the QF ⟺ winning
// this match, including extra time and penalties.)
export function findAdvanceLadderPairs(kalshiEvents) {
  const ladders = buildRoundLadders(kalshiEvents);
  if (!ladders.size) return [];
  const pairs = [];
  kalshiEvents.forEach(e => {
    if (!isMatchScopedAdvance(e)) return;
    (e.markets || []).forEach(m => {
      if (!isLiveMarket(m)) return;
      const parts = (m.ticker || "").split("-");
      const code = parts.length >= 3 ? parts[parts.length - 1].toUpperCase() : null;
      if (!code) return;
      for (const [prefix, teams] of ladders) {
        if (!sameLeagueHint(e.series_ticker || getSeriesPrefix(e.event_ticker), prefix)) continue;
        const rounds = (teams.get(code) || []).filter(r => isLiveMarket(r.market));
        if (!rounds.length) continue;
        const next = rounds[0]; // lowest live order = the round this match decides
        pairs.push({
          tier: "EXACT",
          team: code,
          teams: extractTeamsFromTicker(e.event_ticker),
          gameEvent: e, gameMarket: m,
          progEvent: next.event, progMarket: next.market,
          closeDeltaMs: null,
          semantic: `winning this match ⟺ reaching ${next.tag}`,
        });
      }
    });
  });
  return pairs;
}

// ─── Top-level: equivalence opportunities in the standard opp shape ──
const MAX_CONDITIONAL_DELTA_MS = 14 * 24 * HOUR;

export function findEquivalenceOpportunities(kalshiEvents, opts = {}) {
  const minDivergence = opts.minDivergence ?? 2; // cents
  // Round-ladder markets are owned by the semantic logic (advance ⇄ next
  // round, monotonicity). Exclude them from generic time-based pairing:
  // "reach the Final" vs tonight's game is NOT a dominance relation —
  // winning tonight only implies reaching the NEXT round.
  const ladderTickers = new Set();
  for (const teams of buildRoundLadders(kalshiEvents).values()) {
    for (const rounds of teams.values()) rounds.forEach(r => ladderTickers.add(r.market.ticker));
  }
  const generic = findEquivalentPairs(kalshiEvents, opts).filter(p => !ladderTickers.has(p.progMarket.ticker));
  // Semantic pairs first (EXACT by tournament structure) so they win
  // dedupe over any time-heuristic duplicates.
  const pairs = [...findAdvanceLadderPairs(kalshiEvents), ...generic];
  const opps = findLadderViolations(kalshiEvents).filter(o => o.fees?.profitable);

  pairs.forEach(pair => {
    const { tier, gameEvent, gameMarket: gm, progEvent, progMarket: pm } = pair;
    const label = `${gm.yes_sub_title || gm.title || gm.ticker} ⇄ ${pm.yes_sub_title || pm.title || pm.ticker}`;

    if (tier === "EXACT" || tier === "LIKELY") {
      const priced = priceEquivalencePair(pair);
      if (!priced || priced.divergence < minDivergence) return;
      const conf = pair.semantic ? pair.semantic
        : tier === "EXACT" ? "settles with this game (close times aligned)"
        : "same team, same day — verify settlement linkage";
      const profitable = priced.executable && priced.calc.profitable;
      opps.push({
        type: "EQUIVALENT",
        tier,
        edge: profitable ? priced.calc.profitCents : priced.divergence,
        game: `${gameEvent.title} ⇄ ${progEvent.title}`,
        sport: gameEvent.series_ticker,
        desc: `Same outcome in two markets: ${label}. Game mkt ${midCents(gm)?.toFixed(0)}¢ vs progression mkt ${midCents(pm)?.toFixed(0)}¢ (${priced.divergence.toFixed(0)}¢ apart). ${tier}: ${conf}.` +
          (profitable ? ` LOCK: ${priced.calc.profitCents}¢/contract after ${priced.calc.feeTotal}¢ fees.` : priced.executable ? ` Not yet profitable after fees (${-priced.calc.profitCents}¢ short).` : " One side has no executable quote."),
        action: priced.executable
          ? priced.legs.map(l => `BUY ${l.side.toUpperCase()} ${l.ticker} @${l.price}¢`).join(" + ")
          : `WATCH ${gm.ticker} vs ${pm.ticker}`,
        markets: [gm, pm],
        legs: priced.legs || null,
        color: profitable ? "#00e8a4" : "#e879f9",
        suggestedSide: priced.legs?.[0]?.side,
        suggestedAction: "buy",
        suggestedPrice: priced.legs?.[0]?.price,
        fees: priced.calc || undefined,
        closeDeltaMs: pair.closeDeltaMs,
      });
    } else {
      // Dominance is only meaningful when the progression outcome is
      // decided soon (potential clinch). A season-long market (World
      // Series winner months out) is legitimately priced far below any
      // single game's win probability — not a signal. Require the two
      // close times to be within 14 days.
      if (pair.closeDeltaMs == null || pair.closeDeltaMs > MAX_CONDITIONAL_DELTA_MS) return;
      const dom = findDominanceViolation(pair);
      if (!dom || !dom.profitable) return;
      opps.push({
        type: "EQUIVALENT",
        tier: "CONDITIONAL",
        edge: dom.netCents,
        game: `${gameEvent.title} ⇄ ${progEvent.title}`,
        sport: gameEvent.series_ticker,
        desc: `Dominance check: if a win tonight clinches "${progEvent.title}", then advance (${pm.yes_ask}¢ ask) should cost ≥ game win (${gm.yes_bid}¢ bid). It's ${dom.spread}¢ UNDER — ${dom.netCents}¢ net after fees. REVIEW series state before trading: only valid if tonight clinches.`,
        action: `REVIEW: BUY YES ${pm.ticker} @${pm.yes_ask}¢ + SELL YES ${gm.ticker} @${gm.yes_bid}¢`,
        markets: [pm, gm],
        color: "#f59e0b",
        suggestedSide: "yes",
        suggestedAction: "buy",
        suggestedPrice: pm.yes_ask,
        closeDeltaMs: pair.closeDeltaMs,
      });
    }
  });

  // Best edge per market pair
  const seen = new Map();
  opps.forEach(o => {
    const key = (o.markets || []).map(m => m.ticker).sort().join("|");
    const ex = seen.get(key);
    if (!ex || o.edge > ex.edge) seen.set(key, o);
  });
  return [...seen.values()].sort((a, b) => b.edge - a.edge);
}
