// ═══════════════════════════════════════════════════════════════
// ARBITRAGE STRATEGIES — extracted from the terminal UI so each
// strategy is independently unit-testable. All functions are pure:
// (market data in) → (opportunity list out).
// ═══════════════════════════════════════════════════════════════

import { calcArbProfit, kalshiFeeCents, mlToProb } from "./fees.js";
import { extractTeamCodes, getTeamPair } from "./tickers.js";
import { findEquivalenceOpportunities, eventHasTie } from "./equivalence.js";
import { matchOddsToKalshi, findBookDivergence, findFreshSkews } from "./value.js";
export { matchOddsToKalshi };

// 1. YES/NO CONSISTENCY — two-sided game markets where both YES asks
// sum below $1 (buy both) or both YES bids sum above $1 (sell both).
export function findIntraEventArbs(kalshi) {
  const opps = [];
  kalshi.forEach(e => {
    const mkts = e.markets || [];
    if (mkts.length !== 2 || !/GAME|MATCH|FIGHT/i.test(e.series_ticker || "")) return;
    const m1 = mkts[0], m2 = mkts[1];
    const askSum = (m1.yes_ask || 0) + (m2.yes_ask || 0);
    const bidSum = (m1.yes_bid || 0) + (m2.yes_bid || 0);
    if (askSum < 100 && askSum > 0) {
      const buyYesCalc = calcArbProfit(m1.yes_ask, m2.yes_ask, 1, false);
      const no1Bid = 100 - m1.yes_ask;
      const no2Bid = 100 - m2.yes_ask;
      const sellNoSum = no1Bid + no2Bid;
      const sellNoFee1 = kalshiFeeCents(no1Bid, 1, false);
      const sellNoFee2 = kalshiFeeCents(no2Bid, 1, false);
      const sellNoProfit = sellNoSum - 100 - sellNoFee1 - sellNoFee2;
      const sellNoCalc = { profitCents: sellNoProfit, feeTotal: sellNoFee1 + sellNoFee2, totalCostCents: 100 + sellNoFee1 + sellNoFee2, profitable: sellNoProfit > 0 };

      const bestMethod = buyYesCalc.profitCents >= sellNoProfit ? "BUY YES" : "SELL NO";
      const bestCalc = bestMethod === "BUY YES" ? buyYesCalc : sellNoCalc;
      if (buyYesCalc.profitable || sellNoCalc.profitable) {
        const desc = bestMethod === "BUY YES"
          ? `BUY YES both: ${askSum}¢ + ${buyYesCalc.feeTotal}¢ fees → ${buyYesCalc.profitCents}¢ profit/contract. (Sell NO: ${sellNoProfit}¢)`
          : `SELL NO both: receive ${sellNoSum}¢ - $1 owed - ${sellNoCalc.feeTotal}¢ fees → ${sellNoProfit}¢ profit/contract. (Buy YES: ${buyYesCalc.profitCents}¢)`;
        opps.push({ type: "GUARANTEED", edge: Math.max(buyYesCalc.profitCents, sellNoProfit), game: e.title, sport: e.series_ticker,
          desc,
          action: bestMethod === "BUY YES"
            ? `BUY ${m1.ticker} YES @${m1.yes_ask}¢ + BUY ${m2.ticker} YES @${m2.yes_ask}¢`
            : `SELL ${m1.ticker} NO @${no1Bid}¢ + SELL ${m2.ticker} NO @${no2Bid}¢`,
          markets: mkts, color: "#00e8a4",
          suggestedSide: bestMethod === "BUY YES" ? "yes" : "no",
          suggestedAction: bestMethod === "BUY YES" ? "buy" : "sell",
          bestMethod, buyYesCalc, sellNoCalc, fees: bestCalc });
      }
    }
    if (bidSum > 100) {
      // Sell YES on both mutually-exclusive sides: collect both bids now,
      // owe $1 on whichever resolves YES. Net = bidSum − 100 − fees on both
      // sell legs. The gross bidSum−100 is fee-naive and overstates thin
      // edges (a 101¢ sum looks like +1¢ but loses to ~2-3¢ of fees), so
      // fee-adjust and only flag GUARANTEED when it actually clears.
      const sellFee1 = kalshiFeeCents(m1.yes_bid, 1, false);
      const sellFee2 = kalshiFeeCents(m2.yes_bid, 1, false);
      const netCents = bidSum - 100 - sellFee1 - sellFee2;
      if (netCents > 0) {
        opps.push({ type: "GUARANTEED", edge: netCents, game: e.title, sport: e.series_ticker,
          desc: `Sell YES on both sides: collect ${bidSum}¢ − $1 owed − ${sellFee1 + sellFee2}¢ fees → ${netCents}¢ risk-free profit/contract`,
          action: `SELL ${m1.ticker} YES @${m1.yes_bid}¢ + SELL ${m2.ticker} YES @${m2.yes_bid}¢`,
          markets: mkts, color: "#00e8a4",
          suggestedSide: "yes", suggestedAction: "sell",
          fees: { feeTotal: sellFee1 + sellFee2, profitCents: netCents, profitable: true } });
      } else {
        // Positive gross but fees eat it — surface as a watch, not a lock.
        opps.push({ type: "NEAR_ARB", edge: Math.max(netCents, 0.1), game: e.title, sport: e.series_ticker,
          desc: `Sell-both collects ${bidSum}¢ but ${sellFee1 + sellFee2}¢ fees leave ${netCents}¢ — not profitable after fees. Watch for bids to widen.`,
          action: `WATCH: SELL ${m1.ticker} YES @${m1.yes_bid}¢ + SELL ${m2.ticker} YES @${m2.yes_bid}¢`,
          markets: mkts, color: "#f59e0b" });
      }
    }
    // Near-arb (tight) — show fee-adjusted breakeven
    const spread = askSum - 100;
    if (spread <= 5 && spread > 0) {
      const nearCalc = calcArbProfit(m1.yes_ask, m2.yes_ask, 1, false);
      const makerCalc = calcArbProfit(m1.yes_ask, m2.yes_ask, 1, true);
      const desc = nearCalc.profitable
        ? `Both sides cost ${askSum}¢ + ${nearCalc.feeTotal}¢ taker fees = ${nearCalc.totalCostCents}¢. PROFITABLE: ${nearCalc.profitCents}¢/contract after fees!`
        : `Both sides cost ${askSum}¢ + ${nearCalc.feeTotal}¢ taker fees = ${nearCalc.totalCostCents}¢ (${-nearCalc.profitCents}¢ over $1). With maker fees: ${makerCalc.totalCostCents}¢ (${makerCalc.profitable ? "PROFITABLE with limit orders!" : "still unprofitable"})`;
      opps.push({ type: "NEAR_ARB", edge: nearCalc.profitable ? nearCalc.profitCents : makerCalc.profitable ? makerCalc.profitCents * 0.5 : 0.1, game: e.title, sport: e.series_ticker,
        desc, action: `${nearCalc.profitable ? "BUY BOTH" : "WATCH"}: ${m1.ticker} ask=${m1.yes_ask}¢ + ${m2.ticker} ask=${m2.yes_ask}¢`,
        markets: mkts, color: nearCalc.profitable ? "#00e8a4" : "#f59e0b", fees: nearCalc });
    }
  });
  return opps;
}

// 1b. MULTI-WAY consistency — mutually exclusive N-way events (e.g.
// soccer regulation moneylines: team/team/tie).
//   Buy-all needs an EXHAUSTIVE set (exactly one outcome must resolve
//   YES) — we only assume that for 3-way sets that include a TIE market.
//   Sell-all only needs mutual exclusivity (at most one pays out):
//   collect every bid now, owe $1 at most.
export function findMultiWayArbs(kalshi) {
  const opps = [];
  kalshi.forEach(e => {
    const mkts = e.markets || [];
    if (mkts.length < 3 || mkts.length > 12 || e.mutually_exclusive !== true) return;

    const exhaustive = mkts.length === 3 && eventHasTie(e);
    const allAsks = mkts.every(m => (m.yes_ask || 0) > 0);
    const allBids = mkts.every(m => (m.yes_bid || 0) > 0);

    if (exhaustive && allAsks) {
      const askSum = mkts.reduce((s, m) => s + m.yes_ask, 0);
      const fees = mkts.reduce((s, m) => s + kalshiFeeCents(m.yes_ask, 1, false), 0);
      const profit = 100 - askSum - fees;
      if (profit > 0) {
        opps.push({ type: "GUARANTEED", edge: profit, game: e.title, sport: e.series_ticker,
          desc: `Buy YES on all ${mkts.length} outcomes: ${askSum}¢ + ${fees}¢ fees → ${profit}¢ risk-free (exactly one must resolve YES)`,
          action: mkts.map(m => `BUY ${m.ticker} YES @${m.yes_ask}¢`).join(" + "),
          markets: mkts, color: "#00e8a4",
          suggestedSide: "yes", suggestedAction: "buy",
          fees: { feeTotal: fees, profitCents: profit, profitable: true } });
      }
    }

    if (allBids) {
      const bidSum = mkts.reduce((s, m) => s + m.yes_bid, 0);
      const fees = mkts.reduce((s, m) => s + kalshiFeeCents(m.yes_bid, 1, false), 0);
      const profit = bidSum - 100 - fees;
      if (profit > 0) {
        opps.push({ type: "GUARANTEED", edge: profit, game: e.title, sport: e.series_ticker,
          desc: `Sell YES on all ${mkts.length} outcomes: collect ${bidSum}¢ − $1 max owed − ${fees}¢ fees → ${profit}¢ risk-free (at most one pays)`,
          action: mkts.map(m => `SELL ${m.ticker} YES @${m.yes_bid}¢`).join(" + "),
          markets: mkts, color: "#00e8a4",
          suggestedSide: "yes", suggestedAction: "sell",
          fees: { feeTotal: fees, profitCents: profit, profitable: true } });
      }
    }
  });
  return opps;
}

// 2. WINNER vs SPREAD cross-market — compare the moneyline market to
// the 1.5-point spread for the same game; the gap should be ~4%.
export function findWinnerSpreadGaps(kalshi) {
  const opps = [];
  const winnerEvents = kalshi.filter(e => /GAME|MATCH|FIGHT/i.test(e.series_ticker || "") && (e.markets || []).length === 2);
  const spreadEvents = kalshi.filter(e => /SPREAD/i.test(e.series_ticker || ""));

  winnerEvents.forEach(we => {
    const wePair = getTeamPair(we.event_ticker);
    if (!wePair || !we.markets?.length) return;

    const [teamA, teamB] = we.markets;
    const aMid = ((teamA.yes_bid || 0) + (teamA.yes_ask || 0)) / 2;
    const bMid = ((teamB.yes_bid || 0) + (teamB.yes_ask || 0)) / 2;
    const fav = aMid > bMid ? teamA : teamB;
    const dog = aMid > bMid ? teamB : teamA;
    const favMid = Math.max(aMid, bMid);
    const dogMid = Math.min(aMid, bMid);

    spreadEvents.forEach(se => {
      if (getTeamPair(se.event_ticker) !== wePair) return;
      (se.markets || []).forEach(sm => {
        const smTitle = sm.title || "";
        const smMid = ((sm.yes_bid || 0) + (sm.yes_ask || 0)) / 2;
        if (smMid <= 0 || (sm.yes_bid || 0) <= 0) return;
        if (!/\bover 1\.5 Point/i.test(smTitle)) return;

        const favNameLast = (fav.title || "").split("Winner")[0].split("?")[0].trim().split(" ").pop().toLowerCase();
        const dogNameLast = (dog.title || "").split("Winner")[0].split("?")[0].trim().split(" ").pop().toLowerCase();
        const isFavSpread = smTitle.toLowerCase().includes(favNameLast);
        const isDogSpread = smTitle.toLowerCase().includes(dogNameLast);
        const expectedGap = 4; // winning by 1.5+ is ~4% harder than just winning

        if (isFavSpread) {
          const actualGap = favMid - smMid;
          const edge = Math.abs(actualGap - expectedGap);
          if (edge >= 3 && actualGap > 0) {
            const desc = actualGap > expectedGap + 3
              ? `Winner mkt (${favMid.toFixed(0)}%) is ${actualGap.toFixed(0)}% above spread-1.5 (${smMid.toFixed(0)}%). Normal gap is ~4%. Winner may be overpriced — consider selling.`
              : `Spread-1.5 (${smMid.toFixed(0)}%) is unusually close to winner (${favMid.toFixed(0)}%). Spread may be overpriced — consider selling spread.`;
            opps.push({ type: "CROSS_MARKET", edge, game: we.title, sport: we.series_ticker,
              desc, action: actualGap > expectedGap + 3 ? `SELL YES on ${fav.ticker} @${fav.yes_bid}¢` : `SELL YES on ${sm.ticker} @${sm.yes_bid}¢`,
              markets: [fav, sm], color: "#6366f1", suggestedPrice: actualGap > expectedGap + 3 ? fav.yes_bid : sm.yes_bid, suggestedSide: "yes", suggestedAction: "sell" });
          }
        } else if (isDogSpread) {
          const actualGap = dogMid - smMid;
          const edge = Math.abs(actualGap - expectedGap);
          if (edge >= 3 && actualGap > 0) {
            opps.push({ type: "CROSS_MARKET", edge, game: we.title, sport: we.series_ticker,
              desc: `Dog winner (${dogMid.toFixed(0)}%) vs dog spread-1.5 (${smMid.toFixed(0)}%). Gap=${actualGap.toFixed(0)}%, expected ~4%.`,
              action: actualGap > expectedGap + 3 ? `SELL YES on ${dog.ticker} @${dog.yes_bid}¢` : `BUY YES on ${dog.ticker} @${dog.yes_ask}¢`,
              markets: [dog, sm], color: "#6366f1", suggestedPrice: actualGap > expectedGap + 3 ? dog.yes_bid : dog.yes_ask, suggestedSide: "yes", suggestedAction: actualGap > expectedGap + 3 ? "sell" : "buy" });
          }
        }
      });
    });
  });
  return opps;
}

// (matchOddsToKalshi lives in value.js and is re-exported above)

// 3. MULTI-SPORTSBOOK comparison (The Odds API) — raw per-book gaps.
// Superseded in the default composition by findBookDivergence (devigged
// consensus in value.js), kept for per-book inspection.
export function findSportsbookGaps(kalshi, sportsbookOdds, minGapPct = 2) {
  const opps = [];
  (sportsbookOdds || []).forEach(oddsEv => {
    const matchedKalshi = matchOddsToKalshi(oddsEv, kalshi);
    if (!matchedKalshi.length) return;
    (oddsEv.bookmakers || []).forEach(bk => {
      const bookName = bk.title || bk.key || "?";
      (bk.markets || []).forEach(mkt => {
        if (mkt.key !== "h2h") return;
        (mkt.outcomes || []).forEach(outcome => {
          const teamName = (outcome.name || "").toLowerCase();
          const americanOdds = outcome.price;
          const impliedProb = mlToProb(String(americanOdds));
          if (!impliedProb) return;
          matchedKalshi.forEach(ke => {
            if (!/GAME|MATCH|FIGHT/i.test(ke.series_ticker || "")) return;
            (ke.markets || []).forEach(km => {
              const kmTitle = (km.title || "").toLowerCase();
              const teamWords = teamName.split(/\s+/).filter(w => w.length > 3);
              if (!teamWords.some(w => kmTitle.includes(w))) return;
              const kalshiMid = ((km.yes_bid || 0) + (km.yes_ask || 0)) / 200;
              const gap = Math.abs(impliedProb - kalshiMid) * 100;
              if (gap >= minGapPct) {
                const direction = impliedProb > kalshiMid ? "BUY YES" : "SELL YES";
                opps.push({
                  type: "SPORTSBOOK", edge: gap,
                  game: `${oddsEv.away_team} @ ${oddsEv.home_team}`,
                  sport: oddsEv.sportLabel || ke.series_ticker,
                  desc: `${bookName} implies ${(impliedProb * 100).toFixed(0)}% (${americanOdds > 0 ? "+" : ""}${americanOdds}) vs Kalshi ${(kalshiMid * 100).toFixed(0)}% — ${gap.toFixed(1)}% edge`,
                  action: `${direction} on ${km.ticker} @${direction.includes("BUY") ? km.yes_ask : km.yes_bid}¢ (${bookName}: ${outcome.name} ${americanOdds > 0 ? "+" : ""}${americanOdds})`,
                  markets: [km], color: "#00ccff", bookmaker: bookName,
                });
              }
            });
          });
        });
      });
    });
  });
  return opps;
}

// 4. ESPN moneyline comparison (when the scoreboard carries odds)
export function findEspnGaps(kalshi, espn, minGapPct = 2) {
  const opps = [];
  (espn || []).forEach(game => {
    if (!game.odds?.moneyline) return;
    const homeAbbr = (game.competitors?.find(c => c.homeAway === "home")?.abbr || "").toUpperCase();
    const awayAbbr = (game.competitors?.find(c => c.homeAway === "away")?.abbr || "").toUpperCase();
    const espnHomeProb = mlToProb(game.odds.moneyline.home?.close?.odds);
    const espnAwayProb = mlToProb(game.odds.moneyline.away?.close?.odds);
    if (!espnHomeProb) return;
    kalshi.forEach(e => {
      const tk = e.event_ticker || "";
      if (!tk.includes(homeAbbr) || !tk.includes(awayAbbr)) return;
      if (!/GAME|MATCH/i.test(e.series_ticker || "")) return;
      (e.markets || []).forEach(m => {
        const mTk = m.ticker || "";
        const isHome = mTk.endsWith(`-${homeAbbr}`) || mTk.endsWith(`-${homeAbbr.slice(0, 3)}`);
        const isAway = mTk.endsWith(`-${awayAbbr}`) || mTk.endsWith(`-${awayAbbr.slice(0, 3)}`);
        const espnProb = isHome ? espnHomeProb : isAway ? espnAwayProb : null;
        if (!espnProb) return;
        const kalshiMid = ((m.yes_bid || 0) + (m.yes_ask || 0)) / 200;
        const gap = Math.abs(espnProb - kalshiMid) * 100;
        if (gap >= minGapPct) {
          opps.push({ type: "SPORTSBOOK", edge: gap, game: e.title, sport: e.series_ticker,
            desc: `DraftKings implies ${(espnProb * 100).toFixed(0)}% vs Kalshi ${(kalshiMid * 100).toFixed(0)}% — ${gap.toFixed(1)}% edge`,
            action: espnProb > kalshiMid ? `BUY YES on ${m.ticker} @${m.yes_ask}¢` : `SELL YES on ${m.ticker} @${m.yes_bid}¢`,
            markets: [m], color: "#00ccff" });
        }
      });
    });
  });
  return opps;
}

// Keep only the best edge per game+type+lead-ticker combination.
export function dedupeOpportunities(opps) {
  const seen = new Map();
  opps.forEach(o => {
    const key = (o.game || "") + "|" + (o.type || "") + "|" + ((o.markets?.[0]?.ticker) || "");
    const existing = seen.get(key);
    if (!existing || o.edge > existing.edge) seen.set(key, o);
  });
  return [...seen.values()].sort((a, b) => b.edge - a.edge);
}

// Top-level composition — all strategies, deduped, sorted by edge.
export function findArbOpportunities(kalshi, espn, sportsbookOdds = [], opts = {}) {
  const opps = [
    ...findIntraEventArbs(kalshi),
    ...findMultiWayArbs(kalshi),
    ...findWinnerSpreadGaps(kalshi),
    // Devigged consensus VALUE replaces raw per-book gaps in the default
    // composition — repeatable edge beats rare arbitrage.
    ...findBookDivergence(kalshi, sportsbookOdds, opts),
    ...findFreshSkews(kalshi, sportsbookOdds, opts),
    ...findEspnGaps(kalshi, espn),
    ...(opts.equivalence === false ? [] : findEquivalenceOpportunities(kalshi, opts)),
  ];
  return dedupeOpportunities(opps);
}
