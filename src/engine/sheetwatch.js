// ═══════════════════════════════════════════════════════════════
// SHEET WATCH — track the mentor's Google Sheet over time. Each poll
// snapshots the published CSV; cell-level diffs against the previous
// snapshot become a timestamped modifications feed (what he changed,
// when) — the observable trace of his process.
// ═══════════════════════════════════════════════════════════════

function colLetter(i) {
  let s = "";
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

// Cell-level diff between two row-arrays (first row = headers).
export function diffSheets(prevRows, nextRows) {
  const changes = [];
  const prev = prevRows || [], next = nextRows || [];
  const headers = (next[0] || prev[0] || []);
  const rowMax = Math.max(prev.length, next.length);
  for (let r = 0; r < rowMax; r++) {
    const pr = prev[r], nr = next[r];
    if (!pr && nr) { changes.push({ kind: "row_added", row: r + 1, after: nr.filter(Boolean).slice(0, 6).join(" | ") }); continue; }
    if (pr && !nr) { changes.push({ kind: "row_removed", row: r + 1, before: pr.filter(Boolean).slice(0, 6).join(" | ") }); continue; }
    const colMax = Math.max(pr.length, nr.length);
    for (let c = 0; c < colMax; c++) {
      const before = pr[c] ?? "", after = nr[c] ?? "";
      if (before !== after) {
        changes.push({ kind: "cell_changed", row: r + 1, col: colLetter(c), cell: `${colLetter(c)}${r + 1}`, header: headers[c] || colLetter(c), before, after });
      }
    }
  }
  return changes;
}

export class SheetWatcher {
  constructor({ maxLog = 500 } = {}) {
    this.lastRows = null;
    this.lastPolledAt = null;
    this.log = []; // { time, changes: [...] }
    this.maxLog = maxLog;
  }

  ingest(rows, now = Date.now()) {
    let changes = [];
    if (this.lastRows) {
      changes = diffSheets(this.lastRows, rows);
      if (changes.length) {
        this.log.push({ time: now, changes });
        if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
      }
    }
    this.lastRows = rows;
    this.lastPolledAt = now;
    return changes;
  }

  recentChanges(n = 50) {
    const flat = [];
    for (let i = this.log.length - 1; i >= 0 && flat.length < n; i--) {
      for (const c of this.log[i].changes) {
        flat.push({ time: this.log[i].time, ...c });
        if (flat.length >= n) break;
      }
    }
    return flat;
  }

  toJSON() { return { version: 1, lastRows: this.lastRows, lastPolledAt: this.lastPolledAt, log: this.log }; }
  static fromJSON(json, opts) {
    const w = new SheetWatcher(opts);
    if (json) { w.lastRows = json.lastRows || null; w.lastPolledAt = json.lastPolledAt || null; w.log = json.log || []; }
    return w;
  }
}
