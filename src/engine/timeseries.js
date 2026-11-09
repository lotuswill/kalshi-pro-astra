// ═══════════════════════════════════════════════════════════════
// TIME-SERIES TRACKER — watch chosen markets/sports and record the
// YES/NO prices and transaction flow over time, the raw material for
// recognizing tradeable patterns (volume spikes before moves, taker
// imbalance, momentum runs).
//
// MarketRecorder is storage-agnostic and clock-injectable: the app
// feeds it market snapshots + trade prints on an interval and persists
// toJSON() wherever it likes (localStorage today).
// ═══════════════════════════════════════════════════════════════

export class MarketRecorder {
  constructor({ maxSamples = 1500, maxTape = 2000 } = {}) {
    this.maxSamples = maxSamples;
    this.maxTape = maxTape;
    this.data = new Map(); // ticker → { meta, samples[], tape[], tradeIds:Set }
  }

  _entry(ticker) {
    if (!this.data.has(ticker)) this.data.set(ticker, { meta: {}, samples: [], tape: [], tradeIds: new Set() });
    return this.data.get(ticker);
  }

  setMeta(ticker, meta) { Object.assign(this._entry(ticker).meta, meta || {}); }

  // One snapshot of the market's canonical (cents) shape.
  record(ticker, m, now = Date.now()) {
    if (!ticker || !m) return;
    const e = this._entry(ticker);
    const bid = m.yes_bid || 0, ask = m.yes_ask || 0;
    const prev = e.samples[e.samples.length - 1];
    const sample = {
      t: now,
      bid, ask,
      mid: bid && ask ? (bid + ask) / 2 : bid || ask || null,
      noBid: m.no_bid || (ask ? 100 - ask : 0),
      noAsk: m.no_ask || (bid ? 100 - bid : 0),
      last: m.last_price ?? null,
      vol: m.volume || 0,
      volDelta: prev ? Math.max(0, (m.volume || 0) - prev.vol) : 0,
      oi: m.open_interest || 0,
    };
    // Skip exact repeats to keep the buffer meaningful on quiet markets
    if (prev && prev.bid === sample.bid && prev.ask === sample.ask && prev.vol === sample.vol && now - prev.t < 5000) return;
    e.samples.push(sample);
    if (e.samples.length > this.maxSamples) e.samples.splice(0, e.samples.length - this.maxSamples);
  }

  // Trade prints (canonical: yes_price cents, count int, taker_side).
  recordTrades(ticker, trades) {
    if (!ticker || !trades?.length) return;
    const e = this._entry(ticker);
    for (const tr of trades) {
      const id = tr.trade_id || `${tr.created_time}|${tr.yes_price}|${tr.count}`;
      if (e.tradeIds.has(id)) continue;
      e.tradeIds.add(id);
      e.tape.push({
        id,
        t: Date.parse(tr.created_time || "") || Date.now(),
        price: tr.yes_price || 0,
        count: tr.count || 0,
        notionalCents: (tr.yes_price || 0) * (tr.count || 0),
        taker: tr.taker_side || tr.taker_outcome_side || "?",
      });
    }
    e.tape.sort((a, b) => a.t - b.t);
    if (e.tape.length > this.maxTape) {
      const dropped = e.tape.splice(0, e.tape.length - this.maxTape);
      // tradeIds set can only grow — rebuild occasionally to bound memory
      if (e.tradeIds.size > this.maxTape * 3) e.tradeIds = new Set(e.tape.map(x => x.id ?? `${x.t}|${x.price}|${x.count}`));
      void dropped;
    }
  }

  series(ticker) { return this.data.get(ticker) || { meta: {}, samples: [], tape: [], tradeIds: new Set() }; }
  tickers() { return [...this.data.keys()]; }
  remove(ticker) { this.data.delete(ticker); }

  toCSV(ticker) {
    const { samples } = this.series(ticker);
    const head = "time,yes_bid,yes_ask,mid,no_bid,no_ask,last,volume,volume_delta,open_interest";
    const rows = samples.map(s => [new Date(s.t).toISOString(), s.bid, s.ask, s.mid ?? "", s.noBid, s.noAsk, s.last ?? "", s.vol, s.volDelta, s.oi].join(","));
    return [head, ...rows].join("\n");
  }

  tapeCSV(ticker) {
    const { tape } = this.series(ticker);
    const head = "time,taker_side,yes_price,contracts,notional_dollars";
    const rows = tape.map(x => [new Date(x.t).toISOString(), x.taker, x.price, x.count, (x.notionalCents / 100).toFixed(2)].join(","));
    return [head, ...rows].join("\n");
  }

  toJSON() {
    const out = {};
    for (const [k, v] of this.data) out[k] = { meta: v.meta, samples: v.samples, tape: v.tape };
    return { version: 1, data: out };
  }

  static fromJSON(json, opts) {
    const r = new MarketRecorder(opts);
    if (json?.data) {
      for (const [k, v] of Object.entries(json.data)) {
        r.data.set(k, {
          meta: v.meta || {},
          samples: v.samples || [],
          tape: v.tape || [],
          tradeIds: new Set((v.tape || []).map(x => x.id ?? `${x.t}|${x.price}|${x.count}`)),
        });
      }
    }
    return r;
  }
}

// Nearest recorded sample to a point in time (for "what was this 24h ago").
MarketRecorder.prototype.sampleAt = function (ticker, atMs) {
  const { samples } = this.series(ticker);
  if (!samples.length) return null;
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.t - atMs) < Math.abs(best.t - atMs)) best = s;
  return best;
};

// ─── SnapshotStore: hourly market-wide price memory ──────────
// The recorder covers watched markets densely; the SnapshotStore covers
// EVERY loaded market sparsely (at most one snapshot per interval) so
// "what did this trade at 24 hours ago" works even for markets you
// weren't explicitly tracking. Compact: ticker → [mid, vol].
export class SnapshotStore {
  constructor({ minIntervalMs = 3600_000, maxAgeMs = 72 * 3600_000 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxAgeMs = maxAgeMs;
    this.snaps = []; // { t, m: { ticker: [mid, vol] } }
  }

  // markets: [{ ticker, mid, vol }] — skipped if the last snapshot is recent.
  add(markets, now = Date.now()) {
    const last = this.snaps[this.snaps.length - 1];
    if (last && now - last.t < this.minIntervalMs) return false;
    const m = {};
    (markets || []).forEach(x => { if (x.ticker && x.mid != null) m[x.ticker] = [Math.round(x.mid), Math.round(x.vol || 0)]; });
    if (!Object.keys(m).length) return false;
    this.snaps.push({ t: now, m });
    this.snaps = this.snaps.filter(s => now - s.t <= this.maxAgeMs);
    return true;
  }

  // Closest snapshot value for a ticker at a target time.
  at(ticker, atMs) {
    let best = null;
    for (const s of this.snaps) {
      if (!(ticker in s.m)) continue;
      if (!best || Math.abs(s.t - atMs) < Math.abs(best.t - atMs)) best = { t: s.t, mid: s.m[ticker][0], vol: s.m[ticker][1] };
    }
    return best;
  }

  history(ticker) {
    return this.snaps.filter(s => ticker in s.m).map(s => ({ t: s.t, mid: s.m[ticker][0], vol: s.m[ticker][1] }));
  }

  toJSON() { return { version: 1, snaps: this.snaps }; }
  static fromJSON(json, opts) {
    const s = new SnapshotStore(opts);
    if (json?.snaps) s.snaps = json.snaps;
    return s;
  }
}

// ─── Transaction amounts by time ─────────────────────────────
// Buckets trade prints into fixed windows: contracts, notional, VWAP,
// and taker imbalance (yes-taker vs no-taker flow) per bucket.
export function bucketTrades(tape, bucketMs = 60_000) {
  if (!tape?.length) return [];
  const buckets = new Map();
  for (const tr of tape) {
    const b = Math.floor(tr.t / bucketMs) * bucketMs;
    if (!buckets.has(b)) buckets.set(b, { t: b, trades: 0, contracts: 0, notionalCents: 0, yesTakerContracts: 0, noTakerContracts: 0, pxSum: 0 });
    const e = buckets.get(b);
    e.trades++;
    e.contracts += tr.count;
    e.notionalCents += tr.notionalCents;
    e.pxSum += tr.price * tr.count;
    if (tr.taker === "yes") e.yesTakerContracts += tr.count;
    else if (tr.taker === "no") e.noTakerContracts += tr.count;
  }
  return [...buckets.values()]
    .map(e => ({ ...e, vwapCents: e.contracts ? e.pxSum / e.contracts : null, imbalance: e.contracts ? (e.yesTakerContracts - e.noTakerContracts) / e.contracts : 0 }))
    .sort((a, b) => a.t - b.t);
}

// ─── Pattern detection over a recorded series ────────────────
// Emits { type, time, desc, strength } — the "watch for this" list.
export function detectPatterns({ samples = [], tape = [] } = {}, opts = {}) {
  const out = [];
  const bucketMs = opts.bucketMs ?? 60_000;
  const buckets = bucketTrades(tape, bucketMs);

  // 1. VOLUME SPIKE — a bucket trading ≥ spikeX × the median bucket
  if (buckets.length >= 4) {
    const sorted = buckets.map(b => b.contracts).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const spikeX = opts.spikeX ?? 4;
    buckets.forEach(b => {
      if (median > 0 && b.contracts >= median * spikeX && b.contracts >= (opts.minSpikeContracts ?? 50)) {
        out.push({ type: "VOLUME_SPIKE", time: b.t, strength: Math.min(99, Math.round(50 + (b.contracts / median) * 5)),
          desc: `${b.contracts.toLocaleString()} contracts in one ${bucketMs / 60000}min bucket (median ${median}) — ${(b.imbalance >= 0 ? "YES" : "NO")}-taker heavy (${Math.round(Math.abs(b.imbalance) * 100)}%)` });
      }
    });
  }

  // 2. PRICE JUMP — mid moved ≥ jumpCents between consecutive samples
  const jumpCents = opts.jumpCents ?? 8;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (a.mid == null || b.mid == null) continue;
    const d = b.mid - a.mid;
    if (Math.abs(d) >= jumpCents) {
      out.push({ type: "PRICE_JUMP", time: b.t, strength: Math.min(99, Math.round(40 + Math.abs(d) * 4)),
        desc: `Mid ${d > 0 ? "jumped" : "dropped"} ${Math.abs(d).toFixed(0)}¢ (${a.mid.toFixed(0)} → ${b.mid.toFixed(0)}) in ${Math.round((b.t - a.t) / 1000)}s — something happened` });
    }
  }

  // 3. MOMENTUM RUN — N consecutive same-direction mid moves
  const runLen = opts.runLen ?? 5;
  let run = 0, dir = 0, runStart = null;
  for (let i = 1; i < samples.length; i++) {
    const d = Math.sign((samples[i].mid ?? 0) - (samples[i - 1].mid ?? 0));
    if (d !== 0 && d === dir) { run++; }
    else { dir = d; run = d !== 0 ? 1 : 0; runStart = samples[i - 1]; }
    if (run === runLen && runStart) {
      out.push({ type: "MOMENTUM", time: samples[i].t, strength: 70,
        desc: `${runLen} consecutive ${dir > 0 ? "up" : "down"}ticks: ${runStart.mid?.toFixed(0)} → ${samples[i].mid?.toFixed(0)}¢` });
    }
  }

  // 4. FLOW IMBALANCE — sustained one-sided taker flow across recent buckets
  const recent = buckets.slice(-5);
  if (recent.length >= 3) {
    const contracts = recent.reduce((s, b) => s + b.contracts, 0);
    const net = recent.reduce((s, b) => s + b.yesTakerContracts - b.noTakerContracts, 0);
    if (contracts >= (opts.minSpikeContracts ?? 50) && Math.abs(net) / contracts >= (opts.imbalanceMin ?? 0.7)) {
      out.push({ type: "FLOW_IMBALANCE", time: recent[recent.length - 1].t, strength: 65,
        desc: `${Math.round(Math.abs(net) / contracts * 100)}% of recent taker flow is ${net > 0 ? "YES buying" : "NO buying"} (${contracts.toLocaleString()} contracts) — informed flow?` });
    }
  }

  out.sort((a, b) => b.time - a.time);
  return out;
}
