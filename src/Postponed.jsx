// ═══════════════════════════════════════════════════════════════
// ⏸ POSTPONED — postponement-arb workstation.
//
// 1. Lists games Kalshi has postponed (active market, expected
//    expiration passed, close extended to the settlement deadline),
//    with the price at the time of postponement (candlestick at the
//    scheduled start), the restart rule, and the deadline countdown.
// 2. Select games (checkboxes) → finds all still-open combos (MVE
//    parlays) carrying them as legs, via close-time-window queries,
//    sortable by volume or open interest.
// 3. Combo detail: per-leg settlement state, payout/share (product of
//    postponed legs' fair prices; overridable), live YES book in
//    deci-cents, best bid + size, and manual or automated bidding:
//    keep X shares resting at min(best bid + Y, payout − Z).
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { normalizeEvent } from "./engine/normalize.js";
import {
  isPostponedGameMarket, postponementDeadline, restartRule, scheduledStartFromTicker,
  priceAtPostponement, comboPayout, tickAtPrice, autoBidTarget, bestCompetingBid,
  sortCombos, deadlineWindows,
} from "./engine/postponements.js";
import { toV2OrderDollars, ordersV2CancelPath, orderIdOf, ORDERS_V2_PATH } from "./engine/orders.js";
import {
  RFQS_PATH, QUOTES_PATH, rfqDeletePath, quoteAcceptPath, quoteConfirmPath,
  normalizeRfq, normalizeQuote, filterRfqs, newRfqIds, quoteYesBid, rfqEdge,
  toRfqBody, toQuoteBody, needsConfirm, confirmSecondsLeft, bestQuoteForBuyingYes,
  shouldAutoQuote,
} from "./engine/rfq.js";

const MVE_SERIES = ["KXMVECROSSCATEGORY-SHARD1", "KXMVECROSSCATEGORY"];
const $ = (v, dp = 1) => v == null ? "—" : `${(v * 100).toFixed(dp)}¢`;
const fmtCount = v => v == null ? "—" : Math.round(v).toLocaleString();
const countdown = (ts, now) => {
  if (!ts) return "—";
  const s = Math.floor((ts - now) / 1000);
  if (s <= 0) return "EXPIRED";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

async function jfetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function PostponedModule({ S, Badge, TBtn, Empty, Pulse, showToast, authFetch, apiBase, kalshi }) {
  const [games, setGames] = useState([]);           // postponed game rows
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [leagueFilter, setLeagueFilter] = useState("ALL");
  const [winnerOnly, setWinnerOnly] = useState(true);
  const [combos, setCombos] = useState(null);       // null = not searched yet
  const [finding, setFinding] = useState(false);
  const [sortKey, setSortKey] = useState("volume");
  const [legInfo, setLegInfo] = useState({});       // legTicker -> {state, fair}
  const [fairOverride, setFairOverride] = useState({});
  const [sel, setSel] = useState(null);             // selected combo market
  const [book, setBook] = useState(null);           // yes levels (dollar pairs)
  const [bestAsk, setBestAsk] = useState(null);
  const [qty, setQty] = useState("3000");           // X
  const [stepDc, setStepDc] = useState("0.2");      // Y in deci-cents (0.2 = $0.002)
  const [marginC, setMarginC] = useState("8");      // Z in cents
  const [postOnly, setPostOnly] = useState(false);
  const [ourOrder, setOurOrder] = useState(null);   // {order_id, price, count}
  const [auto, setAuto] = useState(false);
  const [autoLog, setAutoLog] = useState([]);
  const [now, setNow] = useState(Date.now());
  const errStreak = useRef(0);
  // ── RFQ desk state ──
  const [rfqWatch, setRfqWatch] = useState(false);  // polling armed
  const [rfqs, setRfqs] = useState([]);             // incoming, watched combos only
  const [ourQuotes, setOurQuotes] = useState([]);   // our maker quotes
  const [ourRfqs, setOurRfqs] = useState([]);       // RFQs we created
  const [rfqQuotes, setRfqQuotes] = useState({});   // rfqId -> quotes on OUR rfqs
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [rfqQty, setRfqQty] = useState("3000");
  const [rfqErr, setRfqErr] = useState(null);
  const [rfqTick, setRfqTick] = useState(0);        // fast 1s tick for confirm countdowns
  const [responder, setResponder] = useState(false); // 🤖 auto-quote incoming RFQs
  const [respMax, setRespMax] = useState("5000");   // per-RFQ share cap
  const seenRfqIds = useRef(new Set());
  const quotedRfqIds = useRef(new Set());
  const confirmedIds = useRef(new Set());
  const respErrStreak = useRef(0);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const log = useCallback((m) => setAutoLog(p => [{ t: new Date().toLocaleTimeString(), m }, ...p].slice(0, 60)), []);

  // ── 1. Postponed-game scan ────────────────────────────────────
  const harvest = useCallback((events) => {
    const rows = [];
    for (const e of events || []) {
      for (const m of e.markets || []) {
        if (!isPostponedGameMarket(m)) continue;
        // ≥97¢/≤3¢ with a settled look = settlement lag, not postponement (Live tab's job)
        const lp = m.last_price || 0;
        if (lp >= 97 || (lp > 0 && lp <= 3)) continue;
        rows.push({
          ...m, eventTitle: e.title || e.sub_title || m.ticker, series: e.series_ticker || "",
          scheduled: scheduledStartFromTicker(m.ticker), deadline: postponementDeadline(m),
          rule: restartRule(e.series_ticker || m.ticker), pAtPost: null,
        });
      }
    }
    rows.sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
    return rows;
  }, []);

  // Rows render immediately with last-price as the provisional fair value;
  // the candlestick-derived price-at-postponement streams in per row.
  const scan = useCallback(async () => {
    setScanning(true);
    let rows = [];
    try {
      rows = harvest(kalshi);                        // from the dashboard's live scan
      setGames(rows);
      const provisional = {};
      rows.forEach(r => { provisional[r.ticker] = { state: "postponed", fair: (r.last_price || 0) / 100 || null }; });
      setLegInfo(p => ({ ...p, ...provisional }));
      showToast(`⏸ ${rows.length} postponed game${rows.length === 1 ? "" : "s"} found`);
    } catch (e) { showToast(`Scan failed: ${e.message}`, "error"); }
    setScanning(false);
    // Background: exact price at postponement from candlesticks.
    for (const r of rows) {
      if (!r.scheduled) continue;
      try {
        const st = Math.floor(r.scheduled / 1000);
        const d = await jfetch(`${apiBase}/series/${r.series || r.ticker.split("-")[0]}/markets/${r.ticker}/candlesticks?start_ts=${st - 6 * 3600}&end_ts=${st + 6 * 3600}&period_interval=60`);
        const fair = priceAtPostponement(d.candlesticks || [], r.scheduled);
        if (fair != null) {
          setGames(prev => prev.map(g => g.ticker === r.ticker ? { ...g, pAtPost: fair } : g));
          setLegInfo(p => ({ ...p, [r.ticker]: { state: "postponed", fair } }));
        } else {
          setGames(prev => prev.map(g => g.ticker === r.ticker ? { ...g, pAtPost: (g.last_price || 0) / 100 || null } : g));
        }
      } catch { setGames(prev => prev.map(g => g.ticker === r.ticker ? { ...g, pAtPost: g.pAtPost ?? ((g.last_price || 0) / 100 || null) } : g)); }
      await new Promise(res => setTimeout(res, 250));
    }
  }, [kalshi, harvest, apiBase, showToast]);

  useEffect(() => { if (kalshi?.length && !games.length && !scanning) scan(); }, [kalshi]); // eslint-disable-line

  const leagueOf = (g) => (g.series || "").replace(/^KX/, "").replace(/GAME$|SPREAD$|TOTAL$|RFI$|MATCH$|FIGHT$/, "") || "?";
  const isWinner = (g) => /GAME$|MATCH$|FIGHT$/.test(g.series || "");
  const leagues = useMemo(() => { const c = {}; games.forEach(g => { if (!winnerOnly || isWinner(g)) c[leagueOf(g)] = (c[leagueOf(g)] || 0) + 1; }); return c; }, [games, winnerOnly]);
  const visibleGames = useMemo(() => games.filter(g => (!winnerOnly || isWinner(g)) && (leagueFilter === "ALL" || leagueOf(g) === leagueFilter)), [games, winnerOnly, leagueFilter]);

  // ── 2. Combo discovery via close-window queries ───────────────
  const findCombos = useCallback(async () => {
    const chosen = games.filter(g => selected.has(g.ticker));
    if (!chosen.length) { showToast("Select at least one postponed game", "error"); return; }
    setFinding(true); setCombos(null); setSel(null); setBook(null);
    try {
      const windows = deadlineWindows(chosen, 90);
      const found = new Map();
      for (const w of windows) {
        for (const series of MVE_SERIES) {
          let cursor = "", pages = 0;
          while (pages < 8) {
            const d = await jfetch(`${apiBase}/markets?series_ticker=${series}&status=open&min_close_ts=${w.min_close_ts}&max_close_ts=${w.max_close_ts}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
            for (const m of d.markets || []) {
              const legs = m.mve_selected_legs || [];
              if (legs.some(l => selected.has(l.market_ticker))) found.set(m.ticker, m);
            }
            cursor = d.cursor || ""; pages++;
            if (!cursor) break;
            await new Promise(res => setTimeout(res, 250));
          }
        }
      }
      const list = sortCombos([...found.values()], sortKey);
      setCombos(list);
      // Resolve every leg of the top combos in batched lookups.
      const need = new Set();
      list.slice(0, 60).forEach(m => (m.mve_selected_legs || []).forEach(l => { if (!legInfo[l.market_ticker]) need.add(l.market_ticker); }));
      const info = {};
      const tickers = [...need];
      for (let i = 0; i < tickers.length; i += 20) {
        const chunk = tickers.slice(i, i + 20);
        try {
          const d = await jfetch(`${apiBase}/markets?tickers=${chunk.join(",")}&limit=${chunk.length}`);
          for (const m of d.markets || []) {
            if (m.result === "yes" || m.result === "no") info[m.ticker] = { state: m.result };
            else if (isPostponedGameMarket(m)) info[m.ticker] = { state: "postponed", fair: parseFloat(m.last_price_dollars || "") || null };
            else info[m.ticker] = { state: "open" };
          }
        } catch { /* transient */ }
        await new Promise(res => setTimeout(res, 250));
      }
      setLegInfo(p => ({ ...p, ...info }));
      showToast(`🧩 ${list.length} open combo${list.length === 1 ? "" : "s"} carry the selected game${chosen.length > 1 ? "s" : ""}`);
    } catch (e) { showToast(`Combo search failed: ${e.message}`, "error"); }
    setFinding(false);
  }, [games, selected, apiBase, sortKey, legInfo, showToast]);

  // ── 3. Combo detail: payout, book, bidding ────────────────────
  const effInfo = useMemo(() => {
    const out = { ...legInfo };
    for (const [t, v] of Object.entries(fairOverride)) {
      const f = parseFloat(v);
      if (isFinite(f) && f > 0 && f < 1) out[t] = { ...(out[t] || { state: "postponed" }), fair: f };
    }
    return out;
  }, [legInfo, fairOverride]);

  const payoutOf = useCallback((combo) => comboPayout(combo, effInfo), [effInfo]);
  const selPayout = sel ? payoutOf(sel) : null;
  // Band-aware tick, evaluated where our bid will actually land
  // (payout − Z): banded combos use 0.1¢ mid-range, 0.01¢ at edges.
  const tick = sel ? tickAtPrice(sel, selPayout?.payout != null ? Math.max(0.0001, selPayout.payout - (parseFloat(marginC) || 0) / 100) : 0.5) : 0.001;
  const best = useMemo(() => bestCompetingBid(book || [], ourOrder?.price ?? null, ourOrder?.count ?? 0), [book, ourOrder]);
  const target = useMemo(() => autoBidTarget({
    bestBid: best.price, payout: selPayout?.payout ?? null,
    step: (parseFloat(stepDc) || 0) / 1000, margin: (parseFloat(marginC) || 0) / 100, tick,
  }), [best, selPayout, stepDc, marginC, tick]);

  const refreshBook = useCallback(async (combo) => {
    const c = combo || sel;
    if (!c) return;
    try {
      const d = await jfetch(`${apiBase}/markets/${c.ticker}/orderbook?depth=12`);
      const fp = d.orderbook_fp || {};
      setBook(fp.yes_dollars || []);
      const noRows = (fp.no_dollars || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]).sort((a, b) => b[0] - a[0]);
      setBestAsk(noRows.length ? { price: Math.round((1 - noRows[0][0]) * 10000) / 10000, size: noRows[0][1] } : null);
      errStreak.current = 0;
    } catch (e) { errStreak.current++; if (errStreak.current > 4) { setAuto(false); log(`auto OFF — book fetch failing (${e.message})`); } }
  }, [sel, apiBase, log]);

  const openCombo = useCallback((m) => { setSel(m); setBook(null); setBestAsk(null); setOurOrder(null); setAuto(false); refreshBook(m); }, [refreshBook]);

  const placeBid = useCallback(async (price) => {
    if (!sel) return null;
    const q = parseInt(qty) || 0;
    if (q < 1) { showToast("Set a share quantity", "error"); return null; }
    const body = toV2OrderDollars({ ticker: sel.ticker, side: "bid", price, count: q, post_only: postOnly });
    const resp = await authFetch(ORDERS_V2_PATH, "POST", body);
    const id = orderIdOf(resp);
    setOurOrder({ order_id: id, price, count: q });
    return id;
  }, [sel, qty, postOnly, authFetch, showToast]);

  const cancelOur = useCallback(async () => {
    if (!ourOrder?.order_id) { setOurOrder(null); return; }
    try { await authFetch(ordersV2CancelPath(ourOrder.order_id), "DELETE", null); } catch (e) { log(`cancel: ${e.message}`); }
    setOurOrder(null);
  }, [ourOrder, authFetch, log]);

  const manualPlace = useCallback(async () => {
    if (target.price == null) { showToast(`No bid: ${target.reason}`, "error"); return; }
    try {
      if (ourOrder) await cancelOur();
      const id = await placeBid(target.price);
      showToast(`✓ Bid resting: ${qty} @ ${$(target.price, 2)} (${(id || "").slice(0, 12)})`);
      log(`manual bid ${qty} @ ${$(target.price, 2)}`);
      setTimeout(() => refreshBook(), 800);
    } catch (e) { showToast(`Bid failed: ${e.message}`, "error"); }
  }, [target, ourOrder, cancelOur, placeBid, qty, showToast, log, refreshBook]);

  // AUTO quoter: every 6s — refresh book, hold if we're best & under cap,
  // else cancel/replace at the target. Disarms on combo switch or errors.
  useEffect(() => {
    if (!auto || !sel) return;
    let stop = false;
    const cycle = async () => {
      if (stop) return;
      await refreshBook();
      try {
        const b = bestCompetingBid(book || [], ourOrder?.price ?? null, ourOrder?.count ?? 0);
        const t = autoBidTarget({ bestBid: b.price, payout: selPayout?.payout ?? null, step: (parseFloat(stepDc) || 0) / 1000, margin: (parseFloat(marginC) || 0) / 100, tick });
        if (t.price == null) { if (ourOrder) { await cancelOur(); log(`auto: pulled bid (${t.reason})`); } return; }
        const cap = t.price; // already ≤ payout − margin
        if (!ourOrder) { const id = await placeBid(cap); log(`auto: placed ${qty} @ ${$(cap, 2)} ${id ? "" : "(no id)"}`); }
        else if (ourOrder.price < b.price - 1e-9 || ourOrder.price > cap + 1e-9) {
          await cancelOur(); const id = await placeBid(cap); log(`auto: requoted ${$(ourOrder.price, 2)} → ${$(cap, 2)} ${id ? "" : "(no id)"}`);
        }
        errStreak.current = 0;
      } catch (e) {
        errStreak.current++; log(`auto error: ${e.message}`);
        if (errStreak.current > 3) { setAuto(false); log("auto OFF — repeated errors"); }
      }
    };
    cycle();
    const iv = setInterval(cycle, 6000);
    return () => { stop = true; clearInterval(iv); };
  }, [auto, sel]); // eslint-disable-line

  const sortedCombos = useMemo(() => combos ? sortCombos(combos, sortKey) : null, [combos, sortKey]);

  // ── 4. RFQ desk ───────────────────────────────────────────────
  // Watched tickers = every combo we found (plus the open one). Incoming
  // RFQs on these are the anxious cash-outers the whole strategy hunts.
  const watchedTickers = useMemo(() => {
    const s = new Set((sortedCombos || []).map(m => m.ticker));
    if (sel) s.add(sel.ticker);
    return s;
  }, [sortedCombos, sel]);
  const comboByTicker = useMemo(() => {
    const m = new Map((sortedCombos || []).map(c => [c.ticker, c]));
    if (sel) m.set(sel.ticker, sel);
    return m;
  }, [sortedCombos, sel]);

  // Suggested one-sided YES quote for an RFQ: payout − Z, floored to tick.
  const rfqSuggest = useCallback((r) => {
    const combo = comboByTicker.get(r.ticker);
    if (!combo) return { price: null, payout: null, reason: "combo not loaded" };
    const po = comboPayout(combo, effInfo);
    const mg = (parseFloat(marginC) || 0) / 100;
    const q = quoteYesBid({ payout: po.payout, margin: mg, tick: tickAtPrice(combo, po.payout != null ? Math.max(0.0001, po.payout - mg) : 0.5) });
    return { ...q, payout: po.payout };
  }, [comboByTicker, effInfo, marginC]);

  const confirmQuote = useCallback(async (q) => {
    try {
      await authFetch(quoteConfirmPath(q.rfqId, q.id), "PUT", null);
      confirmedIds.current.add(q.id);
      showToast(`✅ Quote confirmed — trade executing (${fmtCount(q.contracts)} sh)`);
      log(`RFQ: confirmed quote ${q.id.slice(0, 12)}`);
    } catch (e) { showToast(`Confirm failed: ${e.message}`, "error"); log(`RFQ confirm error: ${e.message}`); }
  }, [authFetch, showToast, log]);

  // Poll loop: incoming RFQs on watched combos + our quotes/RFQs lifecycle.
  useEffect(() => {
    if (!rfqWatch) return;
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        // Incoming open RFQs (client-filtered to watched combos).
        const rd = await authFetch(`${RFQS_PATH}?status=open&limit=100`, "GET", null);
        const all = (rd.rfqs || []).map(normalizeRfq);
        const watched = filterRfqs(all, watchedTickers);
        const fresh = newRfqIds(seenRfqIds.current, watched);
        watched.forEach(r => seenRfqIds.current.add(r.id));
        setRfqs(watched);
        if (fresh.length && seenRfqIds.current.size > fresh.length) {
          showToast(`📡 ${fresh.length} new RFQ${fresh.length > 1 ? "s" : ""} on your combos — someone wants out`, "info");
        }
        // 🤖 Responder bot: quote every qualifying RFQ at the payout − Z
        // floor. Quotes are private, so there's no price to leak and no
        // penny-jump race — just be there before the other responders.
        if (responder) {
          for (const r of watched) {
            const s = rfqSuggest(r);
            const g = shouldAutoQuote({ rfq: r, price: s.price, maxContracts: respMax, quotedIds: quotedRfqIds.current });
            if (!g.ok) continue;
            try {
              await authFetch(QUOTES_PATH, "POST", toQuoteBody({ rfq_id: r.id, yesBid: s.price }));
              quotedRfqIds.current.add(r.id);
              respErrStreak.current = 0;
              showToast(`🤖 Auto-quoted ${fmtCount(r.contracts)} sh @ ${$(s.price, 2)} (edge ~$${(rfqEdge({ payout: s.payout, yesBid: s.price, contracts: r.contracts }) ?? 0).toFixed(0)})`);
              log(`responder: quoted ${r.id.slice(0, 12)} — ${fmtCount(r.contracts)} sh @ ${$(s.price, 2)}`);
              await new Promise(res => setTimeout(res, 400));
            } catch (e) {
              respErrStreak.current++;
              log(`responder error: ${e.message}`);
              if (respErrStreak.current > 3) { setResponder(false); showToast("🤖 Responder OFF — repeated quote errors", "error"); break; }
            }
          }
        }
        setOurRfqs(filterRfqs(all, null, { openOnly: true, includeMine: true }).filter(r => r.mine));
        // Our maker quotes: watch for acceptance (30s confirm window).
        const qd = await authFetch(`${QUOTES_PATH}?user_filter=self&limit=100`, "GET", null);
        const mine = (qd.quotes || []).map(normalizeQuote);
        setOurQuotes(mine.filter(q => ["open", "accepted", "confirmed", "executed"].includes(q.status)).slice(0, 20));
        for (const q of mine) {
          if (needsConfirm(q) && !confirmedIds.current.has(q.id)) {
            // The responder implies auto-confirm — a bot that quotes but
            // lets the 30s window lapse would burn every fill it wins.
            if (autoConfirm || responder) { await confirmQuote(q); }
            else showToast(`⏰ Quote ACCEPTED — confirm within ${confirmSecondsLeft(q)}s or it dies!`, "error");
          }
        }
        // Quotes arriving on RFQs WE created.
        const qr = await authFetch(`${QUOTES_PATH}?rfq_user_filter=self&status=open&limit=100`, "GET", null);
        const grouped = {};
        (qr.quotes || []).map(normalizeQuote).forEach(q => { (grouped[q.rfqId] = grouped[q.rfqId] || []).push(q); });
        setRfqQuotes(grouped);
        setRfqErr(null);
      } catch (e) {
        setRfqErr(e.message);
        if (/Key Vault|API Key/i.test(e.message)) { setRfqWatch(false); }
      }
    };
    poll();
    const iv = setInterval(poll, 8000);
    return () => { stop = true; clearInterval(iv); };
  }, [rfqWatch, watchedTickers, autoConfirm, responder, respMax, rfqSuggest, authFetch, confirmQuote, showToast]); // eslint-disable-line

  // 1s ticker only while a confirm countdown is live.
  useEffect(() => {
    if (!ourQuotes.some(q => q.status === "accepted")) return;
    const iv = setInterval(() => setRfqTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, [ourQuotes]);

  const quoteRfq = useCallback(async (r) => {
    const s = rfqSuggest(r);
    if (s.price == null) { showToast(`No quote: ${s.reason}`, "error"); return; }
    try {
      const resp = await authFetch(QUOTES_PATH, "POST", toQuoteBody({ rfq_id: r.id, yesBid: s.price }));
      quotedRfqIds.current.add(r.id);
      showToast(`✓ Quoted ${fmtCount(r.contracts)} sh @ ${$(s.price, 2)} (edge ~$${(rfqEdge({ payout: s.payout, yesBid: s.price, contracts: r.contracts }) ?? 0).toFixed(0)})`);
      log(`RFQ: quoted ${r.id.slice(0, 12)} @ ${$(s.price, 2)} (${(resp?.id || "").slice(0, 12)})`);
    } catch (e) { showToast(`Quote failed: ${e.message}`, "error"); }
  }, [rfqSuggest, authFetch, showToast, log]);

  const sendRfq = useCallback(async () => {
    if (!sel) { showToast("Open a combo first — the RFQ is sent for it", "error"); return; }
    const n = parseInt(rfqQty) || 0;
    if (n < 1) { showToast("Set a share quantity", "error"); return; }
    try {
      const resp = await authFetch(RFQS_PATH, "POST", toRfqBody({ ticker: sel.ticker, contracts: n }));
      showToast(`📡 RFQ broadcast: ${fmtCount(n)} sh of …${sel.ticker.slice(-14)} (${(resp?.id || "").slice(0, 12)})`);
      log(`RFQ: sent for ${n} sh of ${sel.ticker}`);
    } catch (e) { showToast(`RFQ failed: ${e.message}`, "error"); }
  }, [sel, rfqQty, authFetch, showToast, log]);

  const cancelRfq = useCallback(async (id) => {
    try { await authFetch(rfqDeletePath(id), "DELETE", null); showToast("RFQ cancelled"); }
    catch (e) { showToast(`Cancel failed: ${e.message}`, "error"); }
  }, [authFetch, showToast]);

  // Accept the best quote on OUR RFQ to end up long YES: sell the NO
  // side at the maker's no_bid (cost per YES share = 1 − no_bid).
  const acceptBest = useCallback(async (rfqId) => {
    const best = bestQuoteForBuyingYes(rfqQuotes[rfqId] || []);
    if (!best) { showToast("No usable quotes on this RFQ yet", "error"); return; }
    try {
      await authFetch(quoteAcceptPath(rfqId, best.quote.id), "PUT", { accepted_side: "no" });
      showToast(`✓ Accepted — buying YES @ ${$(best.yesCostPerShare, 2)}/sh (maker has 30s to confirm)`);
      log(`RFQ: accepted quote ${best.quote.id.slice(0, 12)} → YES @ ${$(best.yesCostPerShare, 2)}`);
    } catch (e) { showToast(`Accept failed: ${e.message}`, "error"); }
  }, [rfqQuotes, authFetch, showToast, log]);

  // ── render ────────────────────────────────────────────────────
  const th = { ...S.th }; const td = { ...S.td };
  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>⏸ Postponed</span>
          <Badge c="#f59e0b">{visibleGames.length}/{games.length} MARKETS</Badge>
          {sortedCombos && <Badge c="#6366f1">{sortedCombos.length} COMBOS</Badge>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <TBtn onClick={scan} active={scanning}>{scanning ? "SCANNING…" : "⟳ RESCAN GAMES"}</TBtn>
          <TBtn onClick={findCombos} active={finding} color="#6366f1">{finding ? "SEARCHING…" : `🧩 FIND COMBOS (${selected.size})`}</TBtn>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>

        {/* Postponed games */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #14203a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 800, letterSpacing: 1 }}>POSTPONED GAMES — STILL UNSETTLED</span>
            <TBtn active={leagueFilter === "ALL"} onClick={() => setLeagueFilter("ALL")}>ALL</TBtn>
            {Object.entries(leagues).sort((a, b) => b[1] - a[1]).map(([lg, n]) => <TBtn key={lg} active={leagueFilter === lg} onClick={() => setLeagueFilter(lg)}>{lg} ({n})</TBtn>)}
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginLeft: 8, fontSize: 9, color: "#5a6f8f" }}>
              <input type="checkbox" checked={winnerOnly} onChange={e => setWinnerOnly(e.target.checked)} /> winner markets only</label>
          </div>
          {!visibleGames.length ? <Empty icon="✅" text={scanning ? "Scanning…" : games.length ? "No markets match the filter" : "No postponed games in the current scan"} /> :
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["", "Game", "League", "Scheduled", "P @ postponement", "Bid/Ask now", "Deadline", "Rule"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{visibleGames.map(g => (
                <tr key={g.ticker} style={{ background: selected.has(g.ticker) ? "#f59e0b08" : "transparent" }}>
                  <td style={{ ...td, width: 26 }}><input type="checkbox" checked={selected.has(g.ticker)} onChange={() => setSelected(p => { const n = new Set(p); n.has(g.ticker) ? n.delete(g.ticker) : n.add(g.ticker); return n; })} /></td>
                  <td style={{ ...td, color: "#eaf0f6", fontWeight: 600 }}>{g.yes_sub_title || g.title}<div style={{ fontSize: 9, color: "#3a4f6f" }}>{g.eventTitle}</div></td>
                  <td style={td}><Badge c="#6366f1" sm>{(g.series || "").replace(/^KX|GAME$|SPREAD$|TOTAL$|RFI$/g, "")}</Badge></td>
                  <td style={{ ...td, ...S.m, fontSize: 10, color: "#5a6f8f" }}>{g.scheduled ? new Date(g.scheduled).toLocaleString() : "—"}</td>
                  <td style={{ ...td, ...S.m, color: "#e8c547", fontWeight: 800 }}>{g.pAtPost != null ? $(g.pAtPost) : g.last_price ? `~${g.last_price}¢` : "…"}</td>
                  <td style={{ ...td, ...S.m, fontSize: 11 }}>{g.yes_bid}¢ / {g.yes_ask}¢</td>
                  <td style={{ ...td, ...S.m, color: (g.deadline - now) < 12 * 3600e3 ? "#ef4444" : "#00e8a4", fontWeight: 700 }}>{countdown(g.deadline, now)}</td>
                  <td style={{ ...td, fontSize: 9, color: "#5a6f8f" }}>{g.rule}</td>
                </tr>))}
              </tbody>
            </table>}
        </div>

        {/* Combos */}
        {sortedCombos && <div style={{ padding: "10px 16px", borderBottom: "1px solid #14203a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 9, color: "#6366f1", fontWeight: 800, letterSpacing: 1 }}>OPEN COMBOS WITH SELECTED LEGS</span>
            <TBtn active={sortKey === "volume"} onClick={() => setSortKey("volume")}>VOLUME</TBtn>
            <TBtn active={sortKey === "oi"} onClick={() => setSortKey("oi")}>OPEN INTEREST</TBtn>
          </div>
          {!sortedCombos.length ? <Empty icon="🧩" text="No open combos found for the selected games" /> :
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Combo", "Legs", "Payout/share", "Last", "Best bid", "Volume", "OI", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{sortedCombos.slice(0, 40).map(m => {
                const po = payoutOf(m);
                const legs = m.mve_selected_legs || [];
                const st = { yes: 0, no: 0, postponed: 0, open: 0 };
                po.legs.forEach(l => st[l.state] = (st[l.state] || 0) + 1);
                return <tr key={m.ticker} style={{ cursor: "pointer", background: sel?.ticker === m.ticker ? "#6366f10c" : "transparent" }} onClick={() => openCombo(m)}>
                  <td style={{ ...td, ...S.m, fontSize: 10, color: "#c8d6e5" }}>…{m.ticker.slice(-14)}</td>
                  <td style={{ ...td, fontSize: 10 }}>{legs.length} <span style={{ color: "#00e8a4" }}>✓{st.yes}</span> <span style={{ color: "#ef4444" }}>✗{st.no}</span> <span style={{ color: "#f59e0b" }}>⏸{st.postponed}</span>{st.open ? <span style={{ color: "#5a6f8f" }}> ○{st.open}</span> : null}</td>
                  <td style={{ ...td, ...S.m, color: po.payout != null ? "#00e8a4" : "#5a6f8f", fontWeight: 800 }}>{po.payout != null ? $(po.payout) : (st.no ? "0¢" : "pending")}</td>
                  <td style={{ ...td, ...S.m }}>{$(parseFloat(m.last_price_dollars))}</td>
                  <td style={{ ...td, ...S.m }}>{$(parseFloat(m.yes_bid_dollars))}</td>
                  <td style={{ ...td, ...S.m, fontSize: 11 }}>{fmtCount(parseFloat(m.volume_fp))}</td>
                  <td style={{ ...td, ...S.m, fontSize: 11 }}>{fmtCount(parseFloat(m.open_interest_fp))}</td>
                  <td style={td}><Badge c="#6366f1" sm>OPEN ▸</Badge></td>
                </tr>;
              })}</tbody>
            </table>}
        </div>}

        {/* Detail + bidding */}
        {sel && <div style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
          <div>
            <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>LEGS — {sel.ticker}</div>
            {selPayout.legs.map(l => (
              <div key={l.market_ticker} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #0f1728", fontSize: 10, ...S.m }}>
                <Badge sm c={l.state === "yes" ? "#00e8a4" : l.state === "no" ? "#ef4444" : l.state === "postponed" ? "#f59e0b" : "#5a6f8f"}>{l.state === "postponed" ? "⏸" : l.state === "yes" ? "✓" : l.state === "no" ? "✗" : "○"}</Badge>
                <span style={{ flex: 1, color: "#c8d6e5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.market_ticker}{l.side === "no" ? " (NO)" : ""}</span>
                {l.state === "postponed" && <>
                  <span style={{ color: "#f59e0b" }}>fair</span>
                  <input value={fairOverride[l.market_ticker] ?? (l.fair != null ? String(l.fair) : "")} onChange={e => setFairOverride(p => ({ ...p, [l.market_ticker]: e.target.value }))}
                    style={{ ...S.inp, width: 64, padding: "3px 6px", fontSize: 10 }} placeholder="0.58" />
                </>}
                {l.p != null && l.state !== "postponed" && <span style={{ color: "#5a6f8f" }}>{l.p}</span>}
              </div>))}
            <div style={{ marginTop: 10, padding: "10px 12px", background: "#0a1020", border: "1px solid #14203a", borderRadius: 8, display: "flex", gap: 18, ...S.m }}>
              <div><div style={{ fontSize: 8, color: "#5a6f8f" }}>PAYOUT / SHARE</div><div style={{ fontSize: 18, fontWeight: 800, color: selPayout.payout != null ? "#00e8a4" : "#5a6f8f" }}>{selPayout.payout != null ? $(selPayout.payout) : "pending"}</div></div>
              <div><div style={{ fontSize: 8, color: "#5a6f8f" }}>BEST BID (not ours)</div><div style={{ fontSize: 18, fontWeight: 800, color: "#e8c547" }}>{$(best.price)} <span style={{ fontSize: 10, color: "#5a6f8f" }}>× {fmtCount(best.size)}</span></div></div>
              <div><div style={{ fontSize: 8, color: "#5a6f8f" }}>BEST ASK</div><div style={{ fontSize: 18, fontWeight: 800, color: "#ef4444" }}>{bestAsk ? $(bestAsk.price) : "—"} <span style={{ fontSize: 10, color: "#5a6f8f" }}>{bestAsk ? `× ${fmtCount(bestAsk.size)}` : ""}</span></div></div>
              <div><div style={{ fontSize: 8, color: "#5a6f8f" }}>EDGE @ BEST BID</div><div style={{ fontSize: 18, fontWeight: 800, color: "#6366f1" }}>{selPayout.payout != null && best.price ? $(selPayout.payout - best.price) : "—"}</div></div>
            </div>
            <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "10px 0 4px" }}>YES BOOK (deci-cent)</div>
            <table style={{ borderCollapse: "collapse", width: "100%" }}><tbody>
              {(book || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]).sort((a, b) => b[0] - a[0]).slice(0, 8).map(([p, q]) => (
                <tr key={p}><td style={{ ...td, ...S.m, color: ourOrder && Math.abs(ourOrder.price - p) < 1e-9 ? "#00e8a4" : "#e8c547", fontWeight: 700, width: 80 }}>{$(p, 2)}{ourOrder && Math.abs(ourOrder.price - p) < 1e-9 ? " ◂ us" : ""}</td>
                  <td style={{ ...td, ...S.m, color: "#5a6f8f" }}>{fmtCount(q)}</td></tr>))}
              {!book?.length && <tr><td style={td} colSpan={2}><Empty icon="📖" text="No resting bids" /></td></tr>}
            </tbody></table>
          </div>

          <div>
            <div style={{ fontSize: 9, color: "#00e8a4", fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>OFFER ENGINE</div>
            <div style={{ background: "#0a1020", border: "1px solid #14203a", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: 10, color: "#5a6f8f" }}>X — shares to keep resting
                <input value={qty} onChange={e => setQty(e.target.value)} style={{ ...S.inp, marginTop: 3 }} /></label>
              <label style={{ fontSize: 10, color: "#5a6f8f" }}>Y — deci-cents above best bid (0.2 = $0.002)
                <input value={stepDc} onChange={e => setStepDc(e.target.value)} style={{ ...S.inp, marginTop: 3 }} /></label>
              <label style={{ fontSize: 10, color: "#5a6f8f" }}>Z — minimum cents below payout (edge floor)
                <input value={marginC} onChange={e => setMarginC(e.target.value)} style={{ ...S.inp, marginTop: 3 }} /></label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: "#5a6f8f", cursor: "pointer" }}>
                <input type="checkbox" checked={postOnly} onChange={e => setPostOnly(e.target.checked)} /> post-only (never lift cheap asks)</label>
              <div style={{ padding: "8px 10px", background: "#070c17", borderRadius: 6, ...S.m, fontSize: 11 }}>
                Target bid: <b style={{ color: target.price != null ? "#00e8a4" : "#ef4444" }}>{target.price != null ? $(target.price, 2) : "—"}</b>
                <span style={{ color: "#3a4f6f" }}> · {target.reason}</span>
                {target.price != null && selPayout.payout != null && <div style={{ color: "#5a6f8f", fontSize: 10 }}>edge if filled: {$(selPayout.payout - target.price, 2)} × {parseInt(qty) || 0} sh = ${(((selPayout.payout - target.price) * (parseInt(qty) || 0)) || 0).toFixed(0)}</div>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={manualPlace} style={{ flex: 1, background: "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 6, padding: "9px 0", color: "#050910", fontWeight: 800, fontSize: 11, cursor: "pointer", ...S.m }}>PLACE / REPLACE BID</button>
                <button onClick={cancelOur} style={{ background: "#ef444415", border: "1px solid #ef444430", borderRadius: 6, padding: "9px 12px", color: "#ef4444", fontWeight: 800, fontSize: 11, cursor: "pointer", ...S.m }}>CANCEL</button>
              </div>
              <button onClick={() => setAuto(a => !a)} style={{ background: auto ? "#ef444415" : "#6366f115", border: `1px solid ${auto ? "#ef444440" : "#6366f140"}`, borderRadius: 6, padding: "9px 0", color: auto ? "#ef4444" : "#6366f1", fontWeight: 800, fontSize: 11, cursor: "pointer", ...S.m }}>
                {auto ? <>⏹ AUTO QUOTER ON — CLICK TO STOP <Pulse color="#ef4444" sz={6} /></> : "▶ ARM AUTO QUOTER"}
              </button>
              <div style={{ fontSize: 9, color: "#3a4f6f", lineHeight: 1.5 }}>Auto re-quotes every 6s: stays {stepDc || "Y"} dc above the best competing bid, never above payout − {marginC || "Z"}¢. Pulls the bid if the edge disappears. Stops on errors or when you leave this combo.</div>
              {ourOrder && <div style={{ fontSize: 10, color: "#00e8a4", ...S.m }}>Resting: {fmtCount(ourOrder.count)} @ {$(ourOrder.price, 2)} <span style={{ color: "#3a4f6f" }}>({(ourOrder.order_id || "").slice(0, 14)})</span></div>}
            </div>
            {autoLog.length > 0 && <div style={{ marginTop: 8, maxHeight: 140, overflow: "auto", background: "#070c17", border: "1px solid #14203a", borderRadius: 6, padding: 8 }}>
              {autoLog.map((l, i) => <div key={i} style={{ fontSize: 9, color: "#7a8faa", ...S.m }}><span style={{ color: "#3a4f6f" }}>{l.t}</span> {l.m}</div>)}
            </div>}
          </div>
        </div>}

        {/* RFQ desk */}
        {sortedCombos && <div style={{ padding: "12px 16px", borderTop: "1px solid #14203a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 9, color: "#22d3ee", fontWeight: 800, letterSpacing: 1 }}>📡 RFQ DESK — PRIVATE QUOTES ON WATCHED COMBOS</span>
            <Badge c="#22d3ee">{watchedTickers.size} WATCHED</Badge>
            <button onClick={() => { setRfqErr(null); setRfqWatch(w => !w); }} style={{ background: rfqWatch ? "#ef444415" : "#22d3ee15", border: `1px solid ${rfqWatch ? "#ef444440" : "#22d3ee40"}`, borderRadius: 6, padding: "5px 12px", color: rfqWatch ? "#ef4444" : "#22d3ee", fontWeight: 800, fontSize: 10, cursor: "pointer", ...S.m }}>
              {rfqWatch ? <>⏹ WATCHING <Pulse color="#22d3ee" sz={6} /></> : "▶ START WATCHING"}
            </button>
            <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 10, color: "#5a6f8f", cursor: "pointer" }}>
              <input type="checkbox" checked={autoConfirm || responder} disabled={responder} onChange={e => setAutoConfirm(e.target.checked)} />
              auto-confirm accepted quotes (30s window)</label>
            <button onClick={() => { setResponder(r => { const on = !r; if (on) { setRfqWatch(true); setRfqErr(null); respErrStreak.current = 0; } return on; }); }}
              style={{ background: responder ? "#ef444415" : "#a855f715", border: `1px solid ${responder ? "#ef444440" : "#a855f740"}`, borderRadius: 6, padding: "5px 12px", color: responder ? "#ef4444" : "#a855f7", fontWeight: 800, fontSize: 10, cursor: "pointer", ...S.m }}>
              {responder ? <>⏹ 🤖 RESPONDER ON <Pulse color="#a855f7" sz={6} /></> : "🤖 ARM RESPONDER"}
            </button>
            <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 10, color: "#5a6f8f" }}>
              max sh/RFQ <input value={respMax} onChange={e => setRespMax(e.target.value)} style={{ ...S.inp, width: 64, padding: "3px 6px", fontSize: 10 }} /></label>
            {rfqErr && <span style={{ fontSize: 10, color: "#ef4444" }}>⚠ {rfqErr}</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
            <div>
              <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>INCOMING — HOLDERS ASKING FOR A PRICE</div>
              {!rfqs.length ? <Empty icon="📡" text={rfqWatch ? "No open RFQs on watched combos — alerts fire the moment one lands" : "Arm the watcher to poll for RFQs (needs API key)"} /> :
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Age", "Combo", "Shares", "Payout", "Our quote", "Edge", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>{rfqs.slice(0, 12).map(r => {
                    const s = rfqSuggest(r);
                    const edge = rfqEdge({ payout: s.payout, yesBid: s.price, contracts: r.contracts });
                    const quoted = quotedRfqIds.current.has(r.id);
                    return <tr key={r.id}>
                      <td style={{ ...td, ...S.m, fontSize: 10, color: "#5a6f8f" }}>{Math.max(0, Math.round((now - r.createdMs) / 60000))}m</td>
                      <td style={{ ...td, ...S.m, fontSize: 10, color: "#c8d6e5" }}>…{r.ticker.slice(-14)}</td>
                      <td style={{ ...td, ...S.m }}>{fmtCount(r.contracts)}</td>
                      <td style={{ ...td, ...S.m, color: "#00e8a4", fontWeight: 700 }}>{s.payout != null ? $(s.payout) : "?"}</td>
                      <td style={{ ...td, ...S.m, color: "#e8c547", fontWeight: 700 }}>{s.price != null ? $(s.price, 2) : "—"}</td>
                      <td style={{ ...td, ...S.m, color: "#6366f1" }}>{edge != null ? `$${edge.toFixed(0)}` : "—"}</td>
                      <td style={td}>{quoted ? <Badge sm c="#5a6f8f">QUOTED</Badge> :
                        <button onClick={() => quoteRfq(r)} disabled={s.price == null} style={{ background: s.price != null ? "linear-gradient(135deg,#22d3ee,#0ea5e9)" : "#14203a", border: "none", borderRadius: 5, padding: "4px 10px", color: s.price != null ? "#050910" : "#3a4f6f", fontWeight: 800, fontSize: 9, cursor: s.price != null ? "pointer" : "default", ...S.m }}>QUOTE IT</button>}</td>
                    </tr>;
                  })}</tbody>
                </table>}
              {ourQuotes.length > 0 && <>
                <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "10px 0 4px" }}>OUR QUOTES OUT</div>
                {ourQuotes.map(q => {
                  const secs = q.status === "accepted" ? confirmSecondsLeft(q) : null;
                  return <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #0f1728", fontSize: 10, ...S.m }} data-tick={rfqTick}>
                    <Badge sm c={q.status === "executed" ? "#00e8a4" : q.status === "accepted" ? "#ef4444" : q.status === "confirmed" ? "#e8c547" : "#22d3ee"}>{q.status.toUpperCase()}</Badge>
                    <span style={{ flex: 1, color: "#c8d6e5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>…{q.ticker.slice(-14)}</span>
                    <span style={{ color: "#e8c547" }}>{fmtCount(q.contracts)} @ {q.yesBid ? $(q.yesBid, 2) : $(1 - q.noBid, 2)}</span>
                    {q.status === "accepted" && needsConfirm(q) &&
                      <button onClick={() => confirmQuote(q)} style={{ background: "linear-gradient(135deg,#ef4444,#dc2626)", border: "none", borderRadius: 5, padding: "4px 10px", color: "#fff", fontWeight: 800, fontSize: 9, cursor: "pointer", ...S.m }}>CONFIRM — {secs}s LEFT</button>}
                  </div>;
                })}
              </>}
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>SEND OUR OWN RFQ {sel ? `— …${sel.ticker.slice(-14)}` : "— open a combo first"}</div>
              <div style={{ background: "#0a1020", border: "1px solid #14203a", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 10, color: "#5a6f8f" }}>Shares to request quotes for
                  <input value={rfqQty} onChange={e => setRfqQty(e.target.value)} style={{ ...S.inp, marginTop: 3 }} /></label>
                <button onClick={sendRfq} disabled={!sel} style={{ background: sel ? "linear-gradient(135deg,#22d3ee,#0ea5e9)" : "#14203a", border: "none", borderRadius: 6, padding: "9px 0", color: sel ? "#050910" : "#3a4f6f", fontWeight: 800, fontSize: 11, cursor: sel ? "pointer" : "default", ...S.m }}>📡 BROADCAST RFQ TO MAKERS</button>
                <div style={{ fontSize: 9, color: "#3a4f6f", lineHeight: 1.5 }}>Shakes loose holders who never watch the book. Accepting a quote sells its NO side, leaving you long YES at (100¢ − no bid). The maker then has 30s to confirm.</div>
                <div style={{ fontSize: 9, color: "#a855f7", lineHeight: 1.5, borderTop: "1px solid #14203a", paddingTop: 6 }}>🤖 <b>Responder</b>: Kalshi's cash-out screen fires an RFQ automatically, so most combo sell flow lands here — not in the book. Armed, it quotes every incoming RFQ on watched combos at payout − {marginC || "Z"}¢ (up to {respMax || "∞"} sh/RFQ) and auto-confirms fills. Quotes are private: nothing for book-watchers to top by 0.1¢. Pair it with one big resting book bid to catch the rest.</div>
              </div>
              {ourRfqs.length > 0 && <>
                <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "10px 0 4px" }}>OUR OPEN RFQs</div>
                {ourRfqs.map(r => {
                  const qs = rfqQuotes[r.id] || [];
                  const best = bestQuoteForBuyingYes(qs);
                  return <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid #0f1728", fontSize: 10, ...S.m }}>
                    <span style={{ flex: 1, color: "#c8d6e5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>…{r.ticker.slice(-14)}</span>
                    <span style={{ color: "#5a6f8f" }}>{fmtCount(r.contracts)} sh · {qs.length} quote{qs.length === 1 ? "" : "s"}</span>
                    {best && <button onClick={() => acceptBest(r.id)} style={{ background: "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 5, padding: "4px 10px", color: "#050910", fontWeight: 800, fontSize: 9, cursor: "pointer", ...S.m }}>BUY YES @ {$(best.yesCostPerShare, 2)}</button>}
                    <button onClick={() => cancelRfq(r.id)} style={{ background: "#ef444415", border: "1px solid #ef444430", borderRadius: 5, padding: "4px 8px", color: "#ef4444", fontWeight: 800, fontSize: 9, cursor: "pointer", ...S.m }}>✕</button>
                  </div>;
                })}
              </>}
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}
