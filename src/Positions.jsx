// ═══════════════════════════════════════════════════════════════
// 💼 POSITIONS — the live portfolio page.
//
// Balance + portfolio value up top, every open position marked to
// its EXIT price (YES → yes bid, NO → 1 − yes ask) with unrealized
// P&L against actual cost, plus all resting orders with one-click
// cancel. Combos are flagged — their mark is the thin combo book, so
// for postponement plays the payout math in ⏸ is the truer value.
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  BALANCE_PATH, POSITIONS_PATH, ORDERS_LIST_PATH,
  normalizeBalance, normalizePosition, markPosition, avgCost,
  portfolioSummary, normalizeOrder, orderLabel,
} from "./engine/portfolio.js";
import { ordersV2CancelPath } from "./engine/orders.js";

const $c = (v, dp = 1) => v == null ? "—" : `${(v * 100).toFixed(dp)}¢`;
const $d = v => v == null ? "—" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pnl = v => v == null ? "#5a6f8f" : v > 0 ? "#00e8a4" : v < 0 ? "#ef4444" : "#5a6f8f";
const fmtCount = v => v == null ? "—" : Math.round(v).toLocaleString();

async function jfetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function PositionsModule({ S, Badge, TBtn, Empty, Pulse, showToast, authFetch, apiBase }) {
  const [bal, setBal] = useState(null);
  const [positions, setPositions] = useState(null);   // normalized + marked rows
  const [orders, setOrders] = useState([]);
  const [marks, setMarks] = useState({});             // ticker -> market payload
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const timerRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Balance + positions + resting orders (all authenticated).
      const [bd, od] = await Promise.all([
        authFetch(BALANCE_PATH, "GET", null),
        authFetch(`${ORDERS_LIST_PATH}?status=resting&limit=200`, "GET", null),
      ]);
      setBal(normalizeBalance(bd));
      setOrders((od.orders || []).map(normalizeOrder).filter(o => o.id));
      let cursor = "", raw = [];
      for (let i = 0; i < 5; i++) {
        const pd = await authFetch(`${POSITIONS_PATH}?count_filter=position&limit=200${cursor ? `&cursor=${cursor}` : ""}`, "GET", null);
        raw.push(...(pd.market_positions || []));
        cursor = pd.cursor || "";
        if (!cursor) break;
      }
      const pos = raw.map(normalizePosition).filter(p => p.count > 0);
      // Mark every position off the public markets endpoint (batched).
      const tickers = [...new Set(pos.map(p => p.ticker))];
      const mk = {};
      for (let i = 0; i < tickers.length; i += 20) {
        try {
          const d = await jfetch(`${apiBase}/markets?tickers=${tickers.slice(i, i + 20).join(",")}&limit=20`);
          for (const m of d.markets || []) mk[m.ticker] = m;
        } catch { /* transient */ }
        if (i + 20 < tickers.length) await new Promise(r => setTimeout(r, 150));
      }
      setMarks(mk);
      setPositions(pos.map(p => ({ ...p, ...markPosition(p, mk[p.ticker]), avg: avgCost(p), title: mk[p.ticker]?.title || mk[p.ticker]?.yes_sub_title || "" })));
      setErr(null);
      setLastSync(new Date());
    } catch (e) {
      setErr(e.message);
      if (!/Key Vault|API Key/i.test(e.message)) showToast(`Portfolio refresh failed: ${e.message}`, "error");
    }
    setLoading(false);
  }, [authFetch, apiBase, showToast]);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 30000);
    return () => clearInterval(timerRef.current);
  }, []); // eslint-disable-line

  const cancelOrder = useCallback(async (o) => {
    try {
      // V2 orders cancel on the events path; legacy ones on the old path.
      try { await authFetch(ordersV2CancelPath(o.id), "DELETE", null); }
      catch { await authFetch(`${ORDERS_LIST_PATH}/${o.id}`, "DELETE", null); }
      showToast(`✕ Cancelled ${orderLabel(o)}`);
      setOrders(prev => prev.filter(x => x.id !== o.id));
    } catch (e) { showToast(`Cancel failed: ${e.message}`, "error"); }
  }, [authFetch, showToast]);

  const summary = useMemo(() => positions ? portfolioSummary(positions) : null, [positions]);
  const sorted = useMemo(() => positions ? [...positions].sort((a, b) => (b.value ?? b.exposure ?? 0) - (a.value ?? a.exposure ?? 0)) : null, [positions]);

  const th = { ...S.th }; const td = { ...S.td };
  const needKeys = err && /Key Vault|API Key/i.test(err);

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>💼 Positions</span>
          {summary && <Badge c="#00e8a4">{summary.open} OPEN</Badge>}
          {orders.length > 0 && <Badge c="#e8c547">{orders.length} RESTING</Badge>}
          {lastSync && <span style={{ fontSize: 9, color: "#3a4f6f", ...S.m }}>synced {lastSync.toLocaleTimeString()}</span>}
        </div>
        <TBtn onClick={refresh} active={loading}>{loading ? "SYNCING…" : "⟳ REFRESH"}</TBtn>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {needKeys ? <Empty icon="🔐" text={err} /> : <>

        {/* Summary cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 1, background: "#14203a", borderBottom: "1px solid #14203a" }}>
          {[
            { l: "CASH", v: $d(bal?.cash), c: "#00e8a4" },
            { l: "PORTFOLIO VALUE", v: $d(bal?.portfolioValue), c: "#e8c547" },
            { l: "AT-RISK (COST)", v: $d(summary?.exposure), c: "#6366f1" },
            { l: "MARKED VALUE", v: $d(summary?.value), c: "#22d3ee" },
            { l: "UNREALIZED P&L", v: $d(summary?.unrealized), c: pnl(summary?.unrealized) },
            { l: "REALIZED P&L", v: $d(summary?.realized), c: pnl(summary?.realized) },
          ].map((x, i) => (
            <div key={i} style={{ background: "#070c17", padding: "12px 14px" }}>
              <div style={{ fontSize: 8, color: "#3a4f6f", letterSpacing: 0.8 }}>{x.l}</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: x.c, ...S.m }}>{x.v}</div>
            </div>))}
        </div>

        {/* Open positions */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #14203a" }}>
          <div style={{ fontSize: 9, color: "#00e8a4", fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>OPEN POSITIONS — MARKED TO EXIT PRICE</div>
          {!sorted ? <Empty icon="⏳" text={loading ? "Syncing portfolio…" : "Refresh to load positions"} /> :
            !sorted.length ? <Empty icon="💼" text="No open positions" /> :
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>{["Market", "Side", "Qty", "Avg cost", "Mark", "Value", "Unrealized", "Realized", "Fees", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>{sorted.map(p => (
                  <tr key={p.ticker}>
                    <td style={{ ...td, maxWidth: 260 }}>
                      <div style={{ color: "#eaf0f6", fontWeight: 600, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || p.ticker}</div>
                      <div style={{ fontSize: 9, color: "#3a4f6f", ...S.m }}>{p.isCombo ? `…${p.ticker.slice(-14)}` : p.ticker}</div>
                    </td>
                    <td style={td}><Badge sm c={p.side === "yes" ? "#00e8a4" : "#ef4444"}>{p.side.toUpperCase()}</Badge>{p.isCombo && <Badge sm c="#6366f1"> 🧩</Badge>}</td>
                    <td style={{ ...td, ...S.m }}>{fmtCount(p.count)}</td>
                    <td style={{ ...td, ...S.m, color: "#5a6f8f" }}>{$c(p.avg, p.isCombo ? 1 : 0)}</td>
                    <td style={{ ...td, ...S.m, color: "#e8c547", fontWeight: 700 }}>{$c(p.mark, p.isCombo ? 1 : 0)}</td>
                    <td style={{ ...td, ...S.m }}>{$d(p.value)}</td>
                    <td style={{ ...td, ...S.m, color: pnl(p.unrealized), fontWeight: 800 }}>{p.unrealized != null ? `${p.unrealized > 0 ? "+" : ""}${$d(p.unrealized)}` : "—"}</td>
                    <td style={{ ...td, ...S.m, color: pnl(p.realized), fontSize: 11 }}>{$d(p.realized)}</td>
                    <td style={{ ...td, ...S.m, color: "#3a4f6f", fontSize: 10 }}>{$d(p.fees)}</td>
                    <td style={{ ...td, fontSize: 9, color: "#3a4f6f" }}>{marks[p.ticker]?.status === "active" ? "" : (marks[p.ticker]?.status || "")}</td>
                  </tr>))}</tbody>
              </table>}
          {sorted?.some(p => p.isCombo) && <div style={{ fontSize: 9, color: "#3a4f6f", marginTop: 6, lineHeight: 1.5 }}>🧩 Combo marks come from thin combo books — for postponement combos the payout math in the ⏸ tab is the truer value than the mark shown here.</div>}
        </div>

        {/* Resting orders */}
        <div style={{ padding: "10px 16px" }}>
          <div style={{ fontSize: 9, color: "#e8c547", fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>RESTING ORDERS</div>
          {!orders.length ? <Empty icon="📭" text="No resting orders" /> :
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Market", "Order", "Filled", "Age", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{orders.map(o => (
                <tr key={o.id}>
                  <td style={{ ...td, ...S.m, fontSize: 10, color: "#c8d6e5", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.isCombo ? `…${o.ticker.slice(-14)}` : o.ticker}{o.isCombo && " 🧩"}</td>
                  <td style={{ ...td, ...S.m, color: "#e8c547", fontWeight: 700, fontSize: 11 }}>{orderLabel(o)}</td>
                  <td style={{ ...td, ...S.m, fontSize: 10, color: "#5a6f8f" }}>{o.initial != null && o.remaining != null ? `${fmtCount(o.initial - o.remaining)}/${fmtCount(o.initial)}` : "—"}</td>
                  <td style={{ ...td, ...S.m, fontSize: 10, color: "#3a4f6f" }}>{o.createdMs ? `${Math.max(0, Math.round((Date.now() - o.createdMs) / 60000))}m` : "—"}</td>
                  <td style={td}><button onClick={() => cancelOrder(o)} style={{ background: "#ef444415", border: "1px solid #ef444430", borderRadius: 5, padding: "4px 10px", color: "#ef4444", fontWeight: 800, fontSize: 9, cursor: "pointer", ...S.m }}>✕ CANCEL</button></td>
                </tr>))}</tbody>
            </table>}
        </div>
        </>}
      </div>
    </div>
  );
}
