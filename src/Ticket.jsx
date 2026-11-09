// ═══════════════════════════════════════════════════════════════
// 🎫 ORDER TICKET — trade from the Book panel, two lanes:
//
//   BOOK — a classic limit order. Visible to everyone, snipeable
//   (penny-jumpers top a public bid by the minimum tick).
//
//   RFQ  — the hidden lane. Broadcast "quote me N shares" to makers;
//   quotes come back privately, nothing rests in the public book, and
//   nobody learns a price from us until a trade prints. Accepting the
//   NO side of the best quote = buying YES at (100¢ − no bid);
//   accepting the YES side = selling YES at the maker's yes bid.
//
// Mounted under the 📖 Book so every TRADE button lands somewhere
// that can actually trade.
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useCallback } from "react";
import { toV2Order, ordersV2CancelPath, orderIdOf, ORDERS_V2_PATH } from "./engine/orders.js";
import {
  RFQS_PATH, QUOTES_PATH, rfqDeletePath, quoteAcceptPath,
  normalizeQuote, toRfqBody, bestQuoteForBuyingYes, bestQuoteForSellingYes,
} from "./engine/rfq.js";

const cents = v => v == null ? "—" : `${v}¢`;

export function TicketModule({ S, Badge, Pulse, showToast, authFetch, mkt, ob }) {
  const [lane, setLane] = useState("rfq");         // "rfq" | "book" — hidden lane first
  const [side, setSide] = useState("yes");
  const [action, setAction] = useState("buy");
  const [priceC, setPriceC] = useState("");
  const [qty, setQty] = useState("100");
  const [ourOrder, setOurOrder] = useState(null);  // {order_id, desc}
  const [rfqId, setRfqId] = useState(null);
  const [rfqQuotes, setRfqQuotes] = useState([]);
  const [busy, setBusy] = useState(false);
  const lastTicker = useRef(null);

  // Reset per market; prefill price at the join (best same-side bid).
  useEffect(() => {
    if (!mkt?.ticker || mkt.ticker === lastTicker.current) return;
    lastTicker.current = mkt.ticker;
    setOurOrder(null); setRfqId(null); setRfqQuotes([]);
    const yb = ob?.orderbook?.yes?.[0]?.[0], nb = ob?.orderbook?.no?.[0]?.[0];
    setPriceC(String((side === "yes" ? yb : nb) || mkt.yes_bid || ""));
  }, [mkt?.ticker]); // eslint-disable-line

  // Poll quotes on our open RFQ (private negotiation loop).
  useEffect(() => {
    if (!rfqId) return;
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const d = await authFetch(`${QUOTES_PATH}?rfq_user_filter=self&status=open&limit=50`, "GET", null);
        setRfqQuotes((d.quotes || []).map(normalizeQuote).filter(q => q.rfqId === rfqId));
      } catch { /* transient */ }
    };
    poll();
    const iv = setInterval(poll, 6000);
    return () => { stop = true; clearInterval(iv); };
  }, [rfqId, authFetch]);

  const placeBook = useCallback(async () => {
    const p = parseInt(priceC), q = parseInt(qty);
    if (!mkt?.ticker) return;
    if (!(p >= 1 && p <= 99)) { showToast("Price must be 1–99¢", "error"); return; }
    if (!(q >= 1)) { showToast("Set a share quantity", "error"); return; }
    setBusy(true);
    try {
      const body = toV2Order({ ticker: mkt.ticker, side, action, type: "limit", count: q, [side === "yes" ? "yes_price" : "no_price"]: p });
      const resp = await authFetch(ORDERS_V2_PATH, "POST", body);
      const id = orderIdOf(resp);
      setOurOrder({ order_id: id, desc: `${action.toUpperCase()} ${q} ${side.toUpperCase()} @ ${p}¢` });
      showToast(`✓ Order resting: ${action} ${q} ${side} @ ${p}¢`);
    } catch (e) { showToast(`Order failed: ${e.message}`, "error"); }
    setBusy(false);
  }, [mkt, side, action, priceC, qty, authFetch, showToast]);

  const cancelBook = useCallback(async () => {
    if (ourOrder?.order_id) { try { await authFetch(ordersV2CancelPath(ourOrder.order_id), "DELETE", null); showToast("Order cancelled"); } catch (e) { showToast(`Cancel: ${e.message}`, "error"); } }
    setOurOrder(null);
  }, [ourOrder, authFetch, showToast]);

  const sendRfq = useCallback(async () => {
    const q = parseInt(qty);
    if (!mkt?.ticker) return;
    if (!(q >= 1)) { showToast("Set a share quantity", "error"); return; }
    setBusy(true);
    try {
      const resp = await authFetch(RFQS_PATH, "POST", toRfqBody({ ticker: mkt.ticker, contracts: q }));
      setRfqId(resp?.id || null); setRfqQuotes([]);
      showToast(`📡 RFQ out for ${q} shares — quotes arrive privately`);
    } catch (e) { showToast(`RFQ failed: ${e.message}`, "error"); }
    setBusy(false);
  }, [mkt, qty, authFetch, showToast]);

  const cancelRfq = useCallback(async () => {
    if (rfqId) { try { await authFetch(rfqDeletePath(rfqId), "DELETE", null); showToast("RFQ cancelled"); } catch (e) { showToast(`Cancel: ${e.message}`, "error"); } }
    setRfqId(null); setRfqQuotes([]);
  }, [rfqId, authFetch, showToast]);

  const accept = useCallback(async (quoteId, acceptedSide, label) => {
    try {
      await authFetch(quoteAcceptPath(rfqId, quoteId), "PUT", { accepted_side: acceptedSide });
      showToast(`✓ Accepted — ${label} (maker has 30s to confirm)`);
    } catch (e) { showToast(`Accept failed: ${e.message}`, "error"); }
  }, [rfqId, authFetch, showToast]);

  if (!mkt?.ticker) return null;
  const buyBest = bestQuoteForBuyingYes(rfqQuotes);
  const sellBest = bestQuoteForSellingYes(rfqQuotes);
  const p = parseInt(priceC) || 0, q = parseInt(qty) || 0;
  const inp = { ...S.inp, padding: "5px 8px", fontSize: 11 };
  const seg = (on, c = "#00e8a4") => ({ flex: 1, padding: "5px 0", fontSize: 10, fontWeight: 800, cursor: "pointer", borderRadius: 5, border: `1px solid ${on ? c + "50" : "#14203a"}`, background: on ? c + "18" : "transparent", color: on ? c : "#5a6f8f", ...S.m });

  return (
    <div style={{ flexShrink: 0, borderBottom: "1px solid #14203a", background: "#0d1320", padding: "8px 12px", maxHeight: 240, overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9, color: "#00e8a4", fontWeight: 800, letterSpacing: 1 }}>🎫 TICKET</span>
        <button onClick={() => setLane("rfq")} style={seg(lane === "rfq", "#22d3ee")}>📡 RFQ (hidden)</button>
        <button onClick={() => setLane("book")} style={seg(lane === "book", "#e8c547")}>📖 BOOK (public)</button>
      </div>

      {lane === "book" && <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setAction("buy")} style={seg(action === "buy")}>BUY</button>
          <button onClick={() => setAction("sell")} style={seg(action === "sell", "#ef4444")}>SELL</button>
          <button onClick={() => setSide("yes")} style={seg(side === "yes")}>YES</button>
          <button onClick={() => setSide("no")} style={seg(side === "no", "#ef4444")}>NO</button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label style={{ fontSize: 9, color: "#5a6f8f", flex: 1 }}>Price ¢<input value={priceC} onChange={e => setPriceC(e.target.value)} style={{ ...inp, width: "100%", marginTop: 2 }} /></label>
          <label style={{ fontSize: 9, color: "#5a6f8f", flex: 1 }}>Shares<input value={qty} onChange={e => setQty(e.target.value)} style={{ ...inp, width: "100%", marginTop: 2 }} /></label>
        </div>
        <div style={{ fontSize: 10, color: "#5a6f8f", ...S.m }}>
          {action === "buy" ? `cost ≤ $${((p * q) / 100).toFixed(2)}` : `proceeds ≤ $${((p * q) / 100).toFixed(2)}`} · payout ${q.toFixed(0)} if {side.toUpperCase()} settles
          <span style={{ color: "#f59e0b" }}> · visible to everyone — snipeable</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button disabled={busy} onClick={placeBook} style={{ flex: 1, background: "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 6, padding: "8px 0", color: "#050910", fontWeight: 800, fontSize: 11, cursor: "pointer", ...S.m }}>PLACE LIMIT ORDER</button>
          {ourOrder && <button onClick={cancelBook} style={{ background: "#ef444415", border: "1px solid #ef444430", borderRadius: 6, padding: "8px 10px", color: "#ef4444", fontWeight: 800, fontSize: 10, cursor: "pointer", ...S.m }}>CANCEL</button>}
        </div>
        {ourOrder && <div style={{ fontSize: 10, color: "#00e8a4", ...S.m }}>Resting: {ourOrder.desc} <span style={{ color: "#3a4f6f" }}>({(ourOrder.order_id || "").slice(0, 12)})</span></div>}
      </div>}

      {lane === "rfq" && <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {!rfqId ? <>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
            <label style={{ fontSize: 9, color: "#5a6f8f", flex: 1 }}>Shares<input value={qty} onChange={e => setQty(e.target.value)} style={{ ...inp, width: "100%", marginTop: 2 }} /></label>
            <button disabled={busy} onClick={sendRfq} style={{ flex: 2, background: "linear-gradient(135deg,#22d3ee,#0ea5e9)", border: "none", borderRadius: 6, padding: "8px 0", color: "#050910", fontWeight: 800, fontSize: 11, cursor: "pointer", ...S.m }}>📡 REQUEST QUOTES</button>
          </div>
          <div style={{ fontSize: 9, color: "#3a4f6f", lineHeight: 1.5 }}>Nothing rests in the public book — makers quote you privately, so there's no bid for anyone to top by 0.1¢. Accept a side only if the price beats what the book shows.</div>
        </> : <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pulse color="#22d3ee" sz={6} />
            <span style={{ fontSize: 10, color: "#22d3ee", fontWeight: 700, ...S.m }}>RFQ live — {qty} sh · {rfqQuotes.length} quote{rfqQuotes.length === 1 ? "" : "s"}</span>
            <button onClick={cancelRfq} style={{ marginLeft: "auto", background: "#ef444415", border: "1px solid #ef444430", borderRadius: 5, padding: "4px 10px", color: "#ef4444", fontWeight: 800, fontSize: 9, cursor: "pointer", ...S.m }}>✕ CANCEL RFQ</button>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button disabled={!buyBest} onClick={() => buyBest && accept(buyBest.quote.id, "no", `bought YES @ ${(buyBest.yesCostPerShare * 100).toFixed(1)}¢`)}
              style={{ flex: 1, background: buyBest ? "linear-gradient(135deg,#00e8a4,#00c48c)" : "#14203a", border: "none", borderRadius: 6, padding: "8px 0", color: buyBest ? "#050910" : "#3a4f6f", fontWeight: 800, fontSize: 10, cursor: buyBest ? "pointer" : "default", ...S.m }}>
              {buyBest ? `BUY YES @ ${(buyBest.yesCostPerShare * 100).toFixed(1)}¢` : "BUY YES — no quotes yet"}</button>
            <button disabled={!sellBest} onClick={() => sellBest && accept(sellBest.quote.id, "yes", `sold YES @ ${(sellBest.yesProceedsPerShare * 100).toFixed(1)}¢`)}
              style={{ flex: 1, background: sellBest ? "linear-gradient(135deg,#ef4444,#dc2626)" : "#14203a", border: "none", borderRadius: 6, padding: "8px 0", color: sellBest ? "#fff" : "#3a4f6f", fontWeight: 800, fontSize: 10, cursor: sellBest ? "pointer" : "default", ...S.m }}>
              {sellBest ? `SELL YES @ ${(sellBest.yesProceedsPerShare * 100).toFixed(1)}¢` : "SELL YES — no quotes yet"}</button>
          </div>
          <div style={{ fontSize: 9, color: "#3a4f6f", lineHeight: 1.4 }}>Book for reference: bid {cents(mkt.yes_bid)} / ask {cents(mkt.yes_ask)}. Accepting trades the maker's quote; they confirm within 30s.</div>
        </>}
      </div>}
    </div>
  );
}
