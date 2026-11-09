// ═══════════════════════════════════════════════════════════════
// SIGNAL JOURNAL — the learning database. Every signal the scanner
// emits is logged with its entry market state, then automatically
// scored against what the market actually did:
//
//   convergence — did the price move toward the predicted target
//                 (book consensus / 50-50 happy medium), and by how
//                 much? This measures the middleman thesis directly.
//   P&L         — when the market settles, what did acting on the
//                 signal at its suggested price actually pay, fees in?
//
// Accumulated over weeks of World Cup + MLB signals, the stats() table
// is what turns thresholds from guesses into per-sport numbers before
// the NFL/NBA season.
// ═══════════════════════════════════════════════════════════════

import { opportunityKey } from "./scanner.js";
import { kalshiFeeCents, midCents } from "./fees.js";

export class SignalJournal {
  constructor({ maxEntries = 2000, minEdge = 0.5 } = {}) {
    this.maxEntries = maxEntries;
    this.minEdge = minEdge;
    this.entries = new Map(); // key → entry
  }

  // Record first sightings; refresh peak edge / last-seen on repeats.
  logSignals(opps, now = Date.now()) {
    let logged = 0;
    for (const opp of opps || []) {
      if ((opp.edge || 0) < this.minEdge) continue;
      const key = opportunityKey(opp);
      const existing = this.entries.get(key);
      if (existing) {
        existing.lastSeen = now;
        if ((opp.edge || 0) > existing.peakEdge) existing.peakEdge = opp.edge || 0;
        continue;
      }
      const primary = (opp.markets || [])[0];
      if (!primary?.ticker) continue;
      const side = opp.suggestedSide || "yes";
      const price = opp.suggestedPrice ?? (side === "yes" ? primary.yes_ask : (100 - (primary.yes_bid || 0))) ?? 0;
      const entryMid = midCents(primary);
      this.entries.set(key, {
        key,
        firstSeen: now, lastSeen: now,
        type: opp.type, tier: opp.tier || "", sport: opp.sport || "", game: opp.game || "",
        ticker: primary.ticker,
        side, action: opp.suggestedAction || "buy",
        price: Number(price) || 0,
        entryMid,
        entryVol: primary.volume || 0,
        // Where the signal says the price SHOULD go: book consensus for
        // VALUE/anchored skews; the 50-50 happy medium for unanchored
        // fresh skews; otherwise the direction implied by the side.
        targetCents: opp.consensus?.fairCents ?? opp.anchor?.fair ?? (opp.type === "FRESH_SKEW" ? 50 : null),
        edge: opp.edge || 0, peakEdge: opp.edge || 0,
        closeTime: primary.close_time || null,
        status: "open", // open → settled | expired
        lastMid: entryMid, lastCheckedAt: now,
        outcome: null,
      });
      logged++;
    }
    this._trim();
    return logged;
  }

  openTickers() {
    const t = new Set();
    for (const e of this.entries.values()) if (e.status === "open") t.add(e.ticker);
    return [...t];
  }

  // Feed current market states (canonical cents shape, keyed by ticker).
  // Settles entries whose market has a result; tracks price drift for
  // the rest; expires entries long past close with no result seen.
  updateOutcomes(marketByTicker, now = Date.now()) {
    let changed = 0;
    for (const e of this.entries.values()) {
      if (e.status !== "open") continue;
      const m = marketByTicker.get ? marketByTicker.get(e.ticker) : marketByTicker[e.ticker];
      if (m) {
        const mid = midCents(m);
        if (mid != null) { e.lastMid = mid; e.lastCheckedAt = now; }
        const result = (m.result || "").toLowerCase();
        if (result === "yes" || result === "no") {
          const won = result === e.side;
          const fee = kalshiFeeCents(e.price || 1, 1, false);
          e.status = "settled";
          e.outcome = {
            settledAt: now, result,
            won,
            pnlCents: (won ? 100 - e.price : -e.price) - fee,
          };
          changed++;
          continue;
        }
      }
      if (e.closeTime && now > Date.parse(e.closeTime) + 48 * 3600_000) {
        e.status = "expired";
        changed++;
      }
    }
    return changed;
  }

  // Signed movement toward the prediction: positive = converging.
  // Direction: buying YES predicts up, buying NO predicts down.
  convergenceCents(e) {
    if (e.entryMid == null || e.lastMid == null) return null;
    const drift = e.lastMid - e.entryMid;
    const predictedUp = e.side === "yes";
    let c = predictedUp ? drift : -drift;
    // Cap at the distance to target when we know it — moving past the
    // target isn't extra credit for the convergence thesis.
    if (e.targetCents != null) {
      const maxUseful = Math.abs(e.targetCents - e.entryMid);
      c = Math.max(Math.min(c, maxUseful), -maxUseful || c);
    }
    return c;
  }

  list({ type = null, status = null } = {}) {
    return [...this.entries.values()]
      .filter(e => (!type || e.type === type) && (!status || e.status === status))
      .sort((a, b) => b.firstSeen - a.firstSeen);
  }

  // The learning table: per type/tier — how often signals converge,
  // and what settling on them actually paid.
  stats() {
    const groups = new Map();
    for (const e of this.entries.values()) {
      const g = `${e.type}${e.tier ? "/" + e.tier : ""}`;
      if (!groups.has(g)) groups.set(g, { group: g, n: 0, open: 0, settled: 0, expired: 0, wins: 0, pnlCents: 0, convSum: 0, convN: 0 });
      const s = groups.get(g);
      s.n++;
      if (e.status === "open") s.open++;
      else if (e.status === "expired") s.expired++;
      else if (e.status === "settled") {
        s.settled++;
        if (e.outcome?.won) s.wins++;
        s.pnlCents += e.outcome?.pnlCents || 0;
      }
      const c = this.convergenceCents(e);
      if (c != null) { s.convSum += c; s.convN++; }
    }
    return [...groups.values()].map(s => ({
      ...s,
      winRatePct: s.settled ? Math.round((s.wins / s.settled) * 100) : null,
      avgPnlCents: s.settled ? s.pnlCents / s.settled : null,
      avgConvergenceCents: s.convN ? s.convSum / s.convN : null,
    })).sort((a, b) => b.n - a.n);
  }

  toCSV() {
    const head = "first_seen,type,tier,sport,game,ticker,side,price,entry_mid,last_mid,target,convergence,edge,peak_edge,status,result,pnl_cents";
    const rows = this.list().map(e => [
      new Date(e.firstSeen).toISOString(), e.type, e.tier, e.sport,
      `"${(e.game || "").replace(/"/g, '""')}"`,
      e.ticker, e.side, e.price, e.entryMid ?? "", e.lastMid ?? "", e.targetCents ?? "",
      this.convergenceCents(e)?.toFixed(1) ?? "", e.edge.toFixed(1), e.peakEdge.toFixed(1),
      e.status, e.outcome?.result ?? "", e.outcome?.pnlCents ?? "",
    ].join(","));
    return [head, ...rows].join("\n");
  }

  _trim() {
    if (this.entries.size <= this.maxEntries) return;
    // Drop oldest non-open entries first, then oldest overall
    const all = [...this.entries.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    for (const e of all) {
      if (this.entries.size <= this.maxEntries) break;
      if (e.status !== "open") this.entries.delete(e.key);
    }
    for (const e of all) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(e.key);
    }
  }

  toJSON() { return { version: 1, entries: [...this.entries.values()] }; }
  static fromJSON(json, opts) {
    const j = new SignalJournal(opts);
    (json?.entries || []).forEach(e => j.entries.set(e.key, e));
    return j;
  }
}
