// ═══════════════════════════════════════════════════════════════
// REAL-TIME SCANNER — volatile/new market detection plus an
// OpportunityTracker that diffs successive scans so the UI can
// surface only what's genuinely NEW (or newly improved) instead of
// re-flashing the same list every refresh.
// ═══════════════════════════════════════════════════════════════

// Volatile & new market detector (pure, injectable clock for tests)
export function findVolatileAndNew(kalshi, now = Date.now()) {
  const results = { volatile: [], newMarkets: [] };
  kalshi.forEach(e => {
    (e.markets || []).forEach(m => {
      const bid = m.yes_bid || 0, ask = m.yes_ask || 0, vol = m.volume || 0;
      const spread = ask - bid;
      const mid = (bid + ask) / 2;
      const created = new Date(m.created_time || 0).getTime();
      const hoursOld = (now - created) / 36e5;
      if (hoursOld < 48 && hoursOld > 0) {
        results.newMarkets.push({ event: e.title, market: m, ticker: m.ticker, title: m.title, bid, ask, mid, vol, hoursOld: hoursOld.toFixed(0), created: m.created_time, series: e.series_ticker });
      }
      // Volatile: wide spread with volume, or mid near 50% (max uncertainty)
      const volatilityScore = spread * 2 + (mid > 35 && mid < 65 ? 20 : 0) + Math.min(vol / 100, 10);
      if (volatilityScore > 15 && bid > 0) {
        results.volatile.push({ event: e.title, market: m, ticker: m.ticker, title: m.title, bid, ask, mid, vol, spread, score: volatilityScore.toFixed(0), series: e.series_ticker });
      }
    });
  });
  results.volatile.sort((a, b) => b.score - a.score);
  results.newMarkets.sort((a, b) => a.hoursOld - b.hoursOld);
  return results;
}

// ─── Volume outliers ─────────────────────────────────────────
// HIGH: a market trading far above its series' median volume — the
// crowd (or someone informed) is there. DEAD: near-zero volume close
// to game time when its peers are active — stale quotes, wide books,
// and lazy prices live here.
export function findVolumeOutliers(kalshi, opts = {}) {
  const now = opts.now ?? Date.now();
  const highX = opts.highX ?? 5;
  const minHigh = opts.minHigh ?? 1000;
  const deadMax = opts.deadMax ?? 5;
  const deadWindowMs = opts.deadWindowMs ?? 24 * 3600_000;

  const bySeries = new Map();
  (kalshi || []).forEach(e => {
    const s = e.series_ticker || "?";
    if (!bySeries.has(s)) bySeries.set(s, []);
    // ?? not ||: a genuine 0 volume must stay 0, not fall back
    (e.markets || []).forEach(m => bySeries.get(s).push({ e, m, vol: (m.volume_24h ?? m.volume) || 0 }));
  });

  const high = [], dead = [];
  for (const [series, rows] of bySeries) {
    const vols = rows.map(r => r.vol).filter(v => v > 0).sort((a, b) => a - b);
    const median = vols.length ? vols[Math.floor(vols.length / 2)] : 0;
    rows.forEach(({ e, m, vol }) => {
      const bid = m.yes_bid || 0, ask = m.yes_ask || 0;
      const entry = {
        event: e.title, series, ticker: m.ticker, title: m.yes_sub_title || m.title,
        market: m, bid, ask, mid: bid && ask ? (bid + ask) / 2 : null,
        vol, seriesMedian: median, ratio: median > 0 ? vol / median : null,
        close: m.close_time,
      };
      if (median > 0 && vol >= Math.max(median * highX, minHigh)) high.push(entry);
      else if (vol <= deadMax && median >= 20) {
        const close = m.close_time ? Date.parse(m.close_time) : null;
        if (close && close - now > 0 && close - now <= deadWindowMs) dead.push(entry);
      }
    });
  }
  high.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
  dead.sort((a, b) => (Date.parse(a.close || 0) || 0) - (Date.parse(b.close || 0) || 0));
  return { high, dead };
}

// Stable identity for an opportunity across scans.
export function opportunityKey(opp) {
  const tickers = (opp.markets || []).map(m => m?.ticker || "").sort().join("+");
  return `${opp.type || ""}|${opp.tier || ""}|${tickers || opp.game || ""}`;
}

// Tracks opportunities across scans. ingest() returns:
//   fresh    — never seen before this scan
//   improved — seen before, but edge grew by ≥ improveThresholdCents
//   active   — everything currently live (annotated with firstSeen/ageMs)
//   expired  — tracked keys that vanished this scan
export class OpportunityTracker {
  constructor({ improveThresholdCents = 2, maxHistory = 500 } = {}) {
    this.registry = new Map(); // key → { firstSeen, lastSeen, bestEdge, opp }
    this.improveThresholdCents = improveThresholdCents;
    this.maxHistory = maxHistory;
    this.alertLog = []; // { time, kind: "fresh"|"improved"|"expired", key, opp }
  }

  ingest(opps, now = Date.now()) {
    const fresh = [], improved = [], active = [], expired = [];
    const liveKeys = new Set();

    for (const opp of opps || []) {
      const key = opportunityKey(opp);
      if (liveKeys.has(key)) continue; // dedupe within one scan
      liveKeys.add(key);
      const entry = this.registry.get(key);
      if (!entry) {
        this.registry.set(key, { firstSeen: now, lastSeen: now, bestEdge: opp.edge || 0, opp });
        fresh.push(opp);
        this._log("fresh", key, opp, now);
      } else {
        entry.lastSeen = now;
        entry.opp = opp;
        if ((opp.edge || 0) >= entry.bestEdge + this.improveThresholdCents) {
          entry.bestEdge = opp.edge || 0;
          improved.push(opp);
          this._log("improved", key, opp, now);
        }
      }
      const e = this.registry.get(key);
      active.push({ ...opp, firstSeen: e.firstSeen, ageMs: now - e.firstSeen, isNew: fresh.includes(opp) });
    }

    for (const [key, entry] of this.registry) {
      if (!liveKeys.has(key)) {
        expired.push(entry.opp);
        this._log("expired", key, entry.opp, now);
        this.registry.delete(key);
      }
    }
    return { fresh, improved, active, expired };
  }

  _log(kind, key, opp, time) {
    this.alertLog.push({ time, kind, key, opp });
    if (this.alertLog.length > this.maxHistory) this.alertLog.splice(0, this.alertLog.length - this.maxHistory);
  }

  isNew(opp, withinMs = 5 * 60 * 1000, now = Date.now()) {
    const entry = this.registry.get(opportunityKey(opp));
    return !!entry && now - entry.firstSeen <= withinMs;
  }
}
