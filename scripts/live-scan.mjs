// ═══════════════════════════════════════════════════════════════
// LIVE SCAN — fetches real open Kalshi events (public market-data
// endpoint, no auth) and runs the detection engine against them.
// Proves the fetch path + engine work end-to-end on live markets.
//
//   node scripts/live-scan.mjs            # game + progression series
//   node scripts/live-scan.mjs --games    # game series only (faster)
//   node scripts/live-scan.mjs --json     # dump raw opportunities
// ═══════════════════════════════════════════════════════════════
import { KALSHI_GAME_SERIES, KALSHI_PROGRESSION_SERIES } from "../src/engine/series.js";
import { findArbOpportunities } from "../src/engine/arbitrage.js";
import { findEquivalenceOpportunities, classifyEvent } from "../src/engine/equivalence.js";
import { findVolatileAndNew } from "../src/engine/scanner.js";
import { generateSuggestion } from "../src/engine/suggestions.js";
import { normalizeEvent } from "../src/engine/normalize.js";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";
const gamesOnly = process.argv.includes("--games");
const asJson = process.argv.includes("--json");
const SERIES = gamesOnly ? KALSHI_GAME_SERIES : [...KALSHI_GAME_SERIES, ...KALSHI_PROGRESSION_SERIES];

// Small batches: the public endpoint is unauthenticated and rate-limits
// bursts of concurrent requests (the app itself sends an API-key header
// and can go wider).
const BATCH_SIZE = 5, BATCH_DELAY = 900;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchSeries(st) {
  const url = `${KALSHI_API}/events?status=open&with_nested_markets=true&series_ticker=${st}&limit=50`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { st, ok: false, err: `HTTP ${r.status}`, events: [] };
    const d = await r.json();
    return { st, ok: true, events: (d.events || []).map(normalizeEvent) };
  } catch (e) {
    return { st, ok: false, err: e.message, events: [] };
  }
}

async function main() {
  const t0 = Date.now();
  console.log(`\n🔌 Live Kalshi scan — ${SERIES.length} series (${gamesOnly ? "games only" : "game + progression"})`);
  console.log(`   endpoint: ${KALSHI_API}/events (public, no auth)\n`);

  const seen = new Set();
  const events = [];
  let okEmpty = 0, okData = 0, failed = 0;
  const errs = [];

  for (let i = 0; i < SERIES.length; i += BATCH_SIZE) {
    const batch = SERIES.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(fetchSeries));
    for (const r of results) {
      if (!r.ok) { failed++; errs.push(`${r.st}: ${r.err}`); }
      else if (r.events.length) okData++;
      else okEmpty++;
      for (const e of r.events) {
        if (!seen.has(e.event_ticker)) { seen.add(e.event_ticker); events.push(e); }
      }
    }
    process.stdout.write(`\r   fetched ${Math.min(i + BATCH_SIZE, SERIES.length)}/${SERIES.length} series — ${events.length} unique events`);
    if (i + BATCH_SIZE < SERIES.length) await sleep(BATCH_DELAY);
  }
  console.log(`\n   ${okData} series with data, ${okEmpty} open-but-empty (out of season), ${failed} errored, in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed) console.log(`   errors: ${errs.slice(0, 6).join(" · ")}${errs.length > 6 ? ` …+${errs.length - 6}` : ""}`);
  console.log("");

  if (!events.length) {
    console.log("⚠️  No open events returned. Kalshi may be between games for these series right now.");
    console.log("    (In-season sports will populate; try again during game hours.)\n");
    return;
  }

  // Classification breakdown
  let games = 0, progs = 0, other = 0, markets = 0;
  for (const e of events) {
    markets += (e.markets || []).length;
    const c = classifyEvent(e);
    if (c === "game") games++; else if (c === "progression") progs++; else other++;
  }
  console.log(`📊 ${events.length} events / ${markets} markets — ${games} game, ${progs} progression, ${other} other`);

  // Run the engine
  const arbs = findArbOpportunities(events, [], []);
  const equiv = findEquivalenceOpportunities(events);
  const volNew = findVolatileAndNew(events);

  const byType = {};
  for (const o of arbs) byType[o.type] = (byType[o.type] || 0) + 1;
  console.log(`\n⚡ ${arbs.length} opportunities: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  console.log(`🔀 ${equiv.length} cross-event equivalence pairs`);
  console.log(`📈 ${volNew.volatile.length} volatile, ${volNew.newMarkets.length} new (<48h)\n`);

  if (asJson) { console.log(JSON.stringify({ arbs, equiv }, null, 2)); return; }

  const show = (title, list, n = 8) => {
    if (!list.length) return;
    console.log(`── ${title} ──`);
    for (const o of list.slice(0, n)) {
      const s = generateSuggestion(o);
      console.log(`  [${o.type}${o.tier ? "/" + o.tier : ""}] +${(o.edge || 0).toFixed(1)}  ${o.game}`);
      console.log(`     ${s.signal} ${s.confidence}% · ${o.action}`);
    }
    console.log("");
  };
  show("TOP ARBITRAGE", arbs);
  show("EQUIVALENCE (win ≡ advance)", equiv);

  console.log(`✅ Live fetch + engine ran clean in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error("\n❌ Scan failed:", e); process.exit(1); });
