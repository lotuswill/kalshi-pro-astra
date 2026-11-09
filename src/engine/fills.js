// ═══════════════════════════════════════════════════════════════
// METHODOLOGY MIRROR — ingest the mentor's Kalshi fills and Google
// Sheet exports, and distill his trading patterns into a profile the
// scanner can compare its own signals against.
//
// analyzeFills(fills) works on canonical fills (integer cents — run
// normalizeFills first): { ticker, side, action, count, yes_price,
// no_price, is_taker, created_time }.
// ═══════════════════════════════════════════════════════════════

import { parseGameDate, getSeriesPrefix } from "./tickers.js";

const HOUR = 3600 * 1000;

function bucketOf(priceCents) {
  if (priceCents < 10) return "0-9¢";
  if (priceCents < 25) return "10-24¢";
  if (priceCents < 45) return "25-44¢";
  if (priceCents < 55) return "45-54¢";
  if (priceCents < 75) return "55-74¢";
  if (priceCents < 90) return "75-89¢";
  return "90-99¢";
}

// The price he actually paid for the contract he holds:
// buy yes → yes_price; buy no → no_price; sells are exits.
function entryPrice(f) {
  return f.side === "no" ? (f.no_price ?? (100 - (f.yes_price || 0))) : (f.yes_price || 0);
}

export function analyzeFills(fills) {
  const list = (fills || []).filter(f => f && f.ticker);
  if (!list.length) return { count: 0 };

  const bySeries = {};
  const priceBuckets = {};
  const hourOfDay = {};
  let takerCount = 0, buyCount = 0, yesCount = 0, totalContracts = 0;
  const hoursBeforeGame = [];

  list.forEach(f => {
    const series = getSeriesPrefix(f.ticker) || "?";
    bySeries[series] = (bySeries[series] || 0) + 1;
    const p = entryPrice(f);
    const b = bucketOf(p);
    priceBuckets[b] = (priceBuckets[b] || 0) + 1;
    if (f.is_taker) takerCount++;
    if (f.action === "buy") buyCount++;
    if (f.side === "yes") yesCount++;
    totalContracts += f.count || 0;
    const t = Date.parse(f.created_time || "");
    if (!isNaN(t)) {
      const h = new Date(t).getHours();
      hourOfDay[h] = (hourOfDay[h] || 0) + 1;
      const gd = parseGameDate(f.ticker);
      if (gd) hoursBeforeGame.push((gd.getTime() - t) / HOUR);
    }
  });

  // Round trips: buy → sell on the same ticker+side, FIFO
  const roundTrips = [];
  const open = new Map(); // ticker|side → [{price, count, time}]
  [...list].sort((a, b) => Date.parse(a.created_time || 0) - Date.parse(b.created_time || 0)).forEach(f => {
    const key = `${f.ticker}|${f.side}`;
    const p = entryPrice(f);
    if (f.action === "buy") {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push({ price: p, count: f.count || 0, time: Date.parse(f.created_time || 0) });
    } else if (f.action === "sell" && open.has(key)) {
      let remaining = f.count || 0;
      const q = open.get(key);
      while (remaining > 0 && q.length) {
        const lot = q[0];
        const used = Math.min(remaining, lot.count);
        roundTrips.push({
          ticker: f.ticker, side: f.side,
          entry: lot.price, exit: p,
          pnlCents: (p - lot.price) * used,
          contracts: used,
          holdHours: (Date.parse(f.created_time || 0) - lot.time) / HOUR,
        });
        lot.count -= used; remaining -= used;
        if (lot.count <= 0) q.shift();
      }
    }
  });

  const median = arr => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  return {
    count: list.length,
    totalContracts,
    takerPct: Math.round((takerCount / list.length) * 100),
    buyPct: Math.round((buyCount / list.length) * 100),
    yesPct: Math.round((yesCount / list.length) * 100),
    bySeries: Object.entries(bySeries).sort((a, b) => b[1] - a[1]),
    priceBuckets,
    medianEntryCents: median(list.filter(f => f.action === "buy").map(entryPrice)),
    hourOfDay,
    medianHoursBeforeGame: median(hoursBeforeGame.filter(h => h > 0)),
    roundTrips,
    realizedPnlCents: roundTrips.reduce((s, r) => s + r.pnlCents, 0),
    winRatePct: roundTrips.length ? Math.round((roundTrips.filter(r => r.pnlCents > 0).length / roundTrips.length) * 100) : null,
    medianHoldHours: median(roundTrips.map(r => r.holdHours)),
  };
}

// ─── Google Sheet ingestion (published-CSV path) ─────────────
// Handles quoted fields and commas-in-quotes; good enough for Sheets
// "publish to web → CSV" exports. Formula ingestion needs the Sheets
// API (OAuth) — see docs/METHODOLOGY_MIRROR.md.
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  const s = (text || "").replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ""));
}

// Column profile: which columns are numeric, their ranges — the raw
// material for reverse-engineering his sheet calculations.
export function summarizeSheet(rows) {
  if (!rows?.length) return { rows: 0, columns: [] };
  const headers = rows[0];
  const body = rows.slice(1);
  const columns = headers.map((h, i) => {
    const vals = body.map(r => r[i]).filter(v => v !== undefined && v !== "");
    const nums = vals.map(v => parseFloat(String(v).replace(/[$,%]/g, ""))).filter(n => isFinite(n));
    const numeric = vals.length > 0 && nums.length >= vals.length * 0.8;
    return {
      name: h || `col${i}`,
      filled: vals.length,
      numeric,
      min: numeric && nums.length ? Math.min(...nums) : null,
      max: numeric && nums.length ? Math.max(...nums) : null,
      mean: numeric && nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null,
      sample: vals[0] ?? "",
    };
  });
  return { rows: body.length, columns };
}
