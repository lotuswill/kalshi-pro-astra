// ═══════════════════════════════════════════════════════════════
// VALUE DETECTION — the workhorse strategies. True arbitrage is rare
// and fee-crushed; the repeatable edges are:
//
//   VALUE       — Kalshi priced outside the DEVIGGED sportsbook
//                 consensus. Books bake ~4-5% vig into raw implied
//                 probabilities; stripping it and taking the median
//                 across books gives a fair-value anchor. Kalshi
//                 trading meaningfully away from it is a mispricing.
//   FRESH_SKEW  — freshly listed Kalshi markets often open skewed on
//                 thin books (a 70% YES that relaxes to ~55% or 50-50
//                 by gametime). Fade the skew: ANCHORED when the book
//                 consensus confirms the mispricing, UNANCHORED (watch)
//                 when there's no book anchor yet, just extremity +
//                 thin volume + freshness.
// ═══════════════════════════════════════════════════════════════

import { mlToProb, kalshiFeeCents, midCents } from "./fees.js";

// Strip the vig from a two-sided market: raw implied probabilities sum
// to >1; the no-vig probability is each side's share of the total.
export function devigPair(pA, pB) {
  if (!pA || !pB || pA <= 0 || pB <= 0) return null;
  const total = pA + pB;
  return { pA: pA / total, pB: pB / total, vig: total - 1 };
}

// Match a The-Odds-API event to Kalshi events by team names + series.
export function matchOddsToKalshi(oddsEvent, kalshi) {
  const homeTeam = (oddsEvent.home_team || "").toLowerCase();
  const awayTeam = (oddsEvent.away_team || "").toLowerCase();
  const matches = [];
  kalshi.forEach(e => {
    const title = (e.title || "").toLowerCase();
    const st = e.series_ticker || "";
    const homeWords = homeTeam.split(/\s+/).filter(w => w.length > 3);
    const awayWords = awayTeam.split(/\s+/).filter(w => w.length > 3);
    const homeMatch = homeWords.some(w => title.includes(w));
    const awayMatch = awayWords.some(w => title.includes(w));
    const prefixes = oddsEvent.kalshiPrefixes || [];
    const seriesMatch = prefixes.some(p => st.startsWith(p));
    if ((homeMatch && awayMatch) || (homeMatch && seriesMatch) || (awayMatch && seriesMatch)) matches.push(e);
  });
  return matches;
}

// Per-team no-vig consensus for one odds event: devig each book's h2h
// pair, then take the median across books. Returns
// { teams: { [lowercase name]: { prob, books } }, bookCount }.
export function bookConsensus(oddsEvent) {
  const perTeam = new Map(); // name → [devigged probs]
  (oddsEvent.bookmakers || []).forEach(bk => {
    (bk.markets || []).forEach(mkt => {
      if (mkt.key !== "h2h") return;
      const outs = (mkt.outcomes || []).filter(o => o.price != null);
      if (outs.length !== 2) return; // 3-way (soccer draw) handled separately later
      const p0 = mlToProb(String(outs[0].price));
      const p1 = mlToProb(String(outs[1].price));
      const dv = devigPair(p0, p1);
      if (!dv) return;
      const n0 = (outs[0].name || "").toLowerCase();
      const n1 = (outs[1].name || "").toLowerCase();
      if (!perTeam.has(n0)) perTeam.set(n0, []);
      if (!perTeam.has(n1)) perTeam.set(n1, []);
      perTeam.get(n0).push(dv.pA);
      perTeam.get(n1).push(dv.pB);
    });
  });
  const teams = {};
  let bookCount = 0;
  for (const [name, probs] of perTeam) {
    probs.sort((a, b) => a - b);
    teams[name] = { prob: probs[Math.floor(probs.length / 2)], books: probs.length };
    bookCount = Math.max(bookCount, probs.length);
  }
  return { teams, bookCount };
}

function teamConsensusFor(marketTitleWords, consensus) {
  for (const [name, c] of Object.entries(consensus.teams)) {
    const words = name.split(/\s+/).filter(w => w.length > 3);
    if (words.some(w => marketTitleWords.includes(w))) return c;
  }
  return null;
}

// ─── VALUE: Kalshi vs devigged consensus ─────────────────────
export function findBookDivergence(kalshi, sportsbookOdds = [], opts = {}) {
  const minBooks = opts.minBooks ?? 2;
  const minEvCents = opts.minEvCents ?? 3;
  const opps = [];

  (sportsbookOdds || []).forEach(oddsEv => {
    const consensus = bookConsensus(oddsEv);
    if (consensus.bookCount < minBooks) return;
    const matched = matchOddsToKalshi(oddsEv, kalshi);
    matched.forEach(ke => {
      if (!/GAME|MATCH|FIGHT|ADVANCE/i.test(ke.series_ticker || "")) return;
      (ke.markets || []).forEach(km => {
        const words = `${km.yes_sub_title || km.title || ""}`.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
        const c = teamConsensusFor(words, consensus);
        if (!c) return;
        const fair = c.prob * 100;
        const bid = km.yes_bid || 0, ask = km.yes_ask || 0;
        if (!bid || !ask) return;

        // Fee-adjusted expected value of each executable action
        const buyYesEv = fair - ask - kalshiFeeCents(ask, 1, false);
        const noAsk = 100 - bid;
        const buyNoEv = (100 - fair) - noAsk - kalshiFeeCents(noAsk, 1, false);

        const best = buyYesEv >= buyNoEv
          ? { side: "yes", action: "buy", price: ask, ev: buyYesEv }
          : { side: "no", action: "buy", price: noAsk, ev: buyNoEv };
        if (best.ev < minEvCents) return;

        opps.push({
          type: "VALUE", edge: best.ev,
          game: `${oddsEv.away_team} @ ${oddsEv.home_team}`,
          sport: oddsEv.sportLabel || ke.series_ticker,
          desc: `${c.books}-book no-vig consensus ${fair.toFixed(0)}% vs Kalshi ${midCents(km)?.toFixed(0)}¢ — buy ${best.side.toUpperCase()} @${best.price}¢ has +${best.ev.toFixed(1)}¢ EV/contract after fees.`,
          action: `BUY ${best.side.toUpperCase()} ${km.ticker} @${best.price}¢ (fair ${fair.toFixed(0)}%)`,
          markets: [km], color: "#22d3ee",
          suggestedSide: best.side, suggestedAction: "buy", suggestedPrice: best.price,
          consensus: { fairCents: fair, books: c.books },
        });
      });
    });
  });

  opps.sort((a, b) => b.edge - a.edge);
  return opps;
}

// ─── FRESH_SKEW: newly listed markets priced at an extreme ───
export function findFreshSkews(kalshiEvents, sportsbookOdds = [], opts = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeHours = opts.maxAgeHours ?? 36;
  const extremeCents = opts.extremeCents ?? 65;
  const maxVolume = opts.maxVolume ?? 300;
  const minAnchorGap = opts.minAnchorGap ?? 5;
  const opps = [];

  // Pre-compute consensus per odds event once
  const consensusList = (sportsbookOdds || []).map(ev => ({ ev, c: bookConsensus(ev) })).filter(x => x.c.bookCount >= (opts.minBooks ?? 2));

  (kalshiEvents || []).forEach(e => {
    if (!/GAME|MATCH|FIGHT|ADVANCE/i.test(e.series_ticker || "")) return;
    (e.markets || []).forEach(m => {
      const created = new Date(m.created_time || m.open_time || 0).getTime();
      if (!created) return;
      const ageHours = (now - created) / 36e5;
      if (ageHours < 0 || ageHours > maxAgeHours) return;
      const mid = midCents(m);
      if (mid == null) return;
      const vol = m.volume || 0;
      if (vol > maxVolume) return;
      const isExtreme = mid >= extremeCents || mid <= 100 - extremeCents;
      if (!isExtreme) return;

      // Anchor to consensus when a matching book market exists
      const words = `${m.yes_sub_title || m.title || ""} ${e.title || ""}`.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
      let anchor = null;
      for (const { ev, c } of consensusList) {
        const evTeams = `${ev.home_team} ${ev.away_team}`.toLowerCase();
        if (!words.some(w => evTeams.includes(w))) continue;
        const t = teamConsensusFor(words, c);
        if (t) { anchor = { fair: t.prob * 100, books: t.books }; break; }
      }

      if (anchor && Math.abs(mid - anchor.fair) >= minAnchorGap) {
        const rich = mid > anchor.fair; // Kalshi above fair → fade with NO
        const price = rich ? 100 - (m.yes_bid || 0) : (m.yes_ask || 0);
        if (!price || price >= 100) return;
        const ev = rich
          ? (100 - anchor.fair) - price - kalshiFeeCents(price, 1, false)
          : anchor.fair - price - kalshiFeeCents(price, 1, false);
        opps.push({
          type: "FRESH_SKEW", tier: "ANCHORED", edge: Math.max(ev, Math.abs(mid - anchor.fair) / 2),
          game: e.title, sport: e.series_ticker,
          desc: `Listed ${ageHours.toFixed(0)}h ago at ${mid.toFixed(0)}¢ on ${vol} volume, but ${anchor.books}-book consensus says ${anchor.fair.toFixed(0)}%. Fresh books open skewed and relax toward fair by gametime — fade the ${rich ? "rich" : "cheap"} side (+${ev.toFixed(1)}¢ EV after fees).`,
          action: `BUY ${rich ? "NO" : "YES"} ${m.ticker} @${price}¢ (fair ${anchor.fair.toFixed(0)}%)`,
          markets: [m], color: "#f472b6",
          suggestedSide: rich ? "no" : "yes", suggestedAction: "buy", suggestedPrice: price,
          ageHours, anchor,
        });
      } else if (!anchor) {
        // No book anchor: extremity + freshness + thin volume alone is a
        // WATCH, not a trade — record it so the tracker can measure how
        // these actually relax by gametime.
        opps.push({
          type: "FRESH_SKEW", tier: "UNANCHORED", edge: (Math.abs(mid - 50) - (extremeCents - 50)) / 2 + 1,
          game: e.title, sport: e.series_ticker,
          desc: `Listed ${ageHours.toFixed(0)}h ago at ${mid.toFixed(0)}¢ on only ${vol} volume with no sportsbook anchor yet. Fresh extremes on thin books tend to relax toward consensus by gametime — track it and fade if books open lower.`,
          action: `WATCH ${m.ticker} — mid ${mid.toFixed(0)}¢, ${vol} vol, ${ageHours.toFixed(0)}h old`,
          markets: [m], color: "#a78bfa",
          suggestedSide: mid > 50 ? "no" : "yes", suggestedAction: "buy",
          ageHours,
        });
      }
    });
  });

  opps.sort((a, b) => b.edge - a.edge);
  return opps;
}
