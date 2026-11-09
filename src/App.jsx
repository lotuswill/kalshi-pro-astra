import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { mlToProb, kalshiFee, kalshiFeeCents, calcArbProfit } from "./engine/fees.js";
import { FeedbackModule, sessionTracker } from "./Feedback.jsx";
import { PostponedModule } from "./Postponed.jsx";
import { CombosModule } from "./Combos.jsx";
import { ToolNavigation } from "./ToolNavigation.jsx";
import { ComboDashboard } from "./ComboDashboard.jsx";
import { TicketModule } from "./Ticket.jsx";
import { PositionsModule } from "./Positions.jsx";
import { extractTeamsFromTicker, extractTeamCodes, parseGameDate } from "./engine/tickers.js";
import { findArbOpportunities, matchOddsToKalshi } from "./engine/arbitrage.js";
import { findVolatileAndNew, findVolumeOutliers, OpportunityTracker, opportunityKey } from "./engine/scanner.js";
import { SnapshotStore } from "./engine/timeseries.js";
import { detectBots } from "./engine/bots.js";
import { generateSuggestion } from "./engine/suggestions.js";
import { KALSHI_GAME_SERIES, KALSHI_PROGRESSION_SERIES } from "./engine/series.js";
import { normalizeEvent, normalizeOrderbook, normalizeTrades, normalizeFills } from "./engine/normalize.js";
import { pemToPkcs8Der } from "./engine/pemkey.js";
import { toV2Order, orderIdOf, ORDERS_V2_PATH } from "./engine/orders.js";
import { findFreshMarkets, findSettlementLags, findNearCertain, espnGameState } from "./engine/live.js";
import { analyzeFills, parseCSV, summarizeSheet } from "./engine/fills.js";
import { normalizeMarket } from "./engine/normalize.js";
import { MarketRecorder, bucketTrades, detectPatterns } from "./engine/timeseries.js";
import { SheetWatcher } from "./engine/sheetwatch.js";
import { contextsFromWatchlist, matchStoriesToContexts } from "./engine/news.js";
import { SignalJournal } from "./engine/journal.js";
import { SETTINGS_SCHEMA, defaultSettings, mergeSettings, clampSetting, engineOpts, liveOpts, volumeOpts } from "./engine/settings.js";

// ═══════════════════════════════════════════════════════════════════
// KALSHI SPORTS TERMINAL v4.0 — Arbitrage Scanner + Encrypted Vault
// Build: 2026-03-04T22:30Z
// ═══════════════════════════════════════════════════════════════════
const APP_VERSION = "8.0.0-astra.1";
if (typeof window !== "undefined") window.__KALSHI_VERSION = APP_VERSION;

// In dev mode, requests go through Vite proxy to avoid CORS.
const KALSHI_API = "/kalshi/trade-api/v2";
const ESPN_API = "/espn/apis/site/v2/sports";
const SPORTSDB_API = "/sportsdb/api/v1/json/3";
const NCAA_API = "/ncaa/casablanca/scoreboard";
const VAULT_STORAGE_KEY = "kalshi_keyvault_v1";

// ─── Rate Limit & Refresh Config ─────────────────────────────
const RATE_LIMITS = {
  kalshi_read: { max: 20, window: 1000, label: "Kalshi Read (20/s)" },
  kalshi_write: { max: 10, window: 1000, label: "Kalshi Write (10/s)" },
  odds_api: { max: 500, window: 30 * 24 * 3600 * 1000, label: "Odds API (500/mo)" },
  espn: { max: 60, window: 60000, label: "ESPN (~60/min)" },
};


// ─── WebSocket Turbo Mode Engine ─────────────────────────────
// Connects to Kalshi's WebSocket for real-time orderbook streaming
// and can auto-execute arbitrage trades when conditions are met.
// OFF by default — user must explicitly enable.
const KALSHI_WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";

class KalshiWebSocketEngine {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.subscriptions = new Map(); // ticker -> callback
    this.msgId = 1;
    this.listeners = new Set();
    this.latency = null;
    this.lastMsg = null;
    this.msgCount = 0;
    this.autoTradeEnabled = false;
    this.autoTradeRules = []; // { condition, action, maxQty, maxCost }
    this.tradeLog = [];
    this.onUpdate = null; // callback for React state updates
    this.authHeaders = null;
  }

  async connect(apiKeyId, privateKeyPem) {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    // Generate auth for the WS connection
    try {
      const timestamp = Date.now().toString();
      const method = "GET";
      const path = "/trade-api/ws/v2";
      const message = timestamp + method + path;
      const pemBody = privateKeyPem.replace(/-----BEGIN [\w\s]+-----/, "").replace(/-----END [\w\s]+-----/, "").replace(/\s/g, "");
      const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
      const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, new TextEncoder().encode(message));
      const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

      const wsUrl = `${KALSHI_WS_URL}?api_key=${apiKeyId}&timestamp=${timestamp}&signature=${encodeURIComponent(sigB64)}`;
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        this.connected = true;
        console.log("[WS Turbo] Connected to Kalshi WebSocket");
        this.notify();
        // Re-subscribe to any existing subscriptions
        this.subscriptions.forEach((cb, ticker) => this._subscribe(ticker));
      };

      this.ws.onmessage = (event) => {
        this.lastMsg = Date.now();
        this.msgCount++;
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (e) { console.warn("[WS] Parse error:", e); }
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        console.log(`[WS Turbo] Disconnected: ${event.code} ${event.reason}`);
        this.notify();
        // Auto-reconnect after 3s if was intentionally connected
        if (this._shouldReconnect) {
          setTimeout(() => this.connect(apiKeyId, privateKeyPem), 3000);
        }
      };

      this.ws.onerror = (err) => {
        console.error("[WS Turbo] Error:", err);
        this.connected = false;
        this.notify();
      };

      this._shouldReconnect = true;
      this._apiKey = apiKeyId;
      this._privKey = privateKeyPem;
    } catch (e) {
      console.error("[WS Turbo] Auth failed:", e);
    }
  }

  disconnect() {
    this._shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.notify();
  }

  subscribe(ticker, callback) {
    this.subscriptions.set(ticker, callback);
    if (this.connected) this._subscribe(ticker);
  }

  unsubscribe(ticker) {
    this.subscriptions.delete(ticker);
  }

  _subscribe(ticker) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      id: this.msgId++,
      cmd: "subscribe",
      params: { channels: ["orderbook_delta", "ticker", "trade"], market_ticker: ticker }
    }));
  }

  handleMessage(data) {
    const type = data.type;
    if (type === "orderbook_snapshot" || type === "orderbook_delta") {
      const ticker = data.msg?.market_ticker;
      const cb = this.subscriptions.get(ticker);
      if (cb) cb({ type, data: data.msg, timestamp: Date.now() });
      // Check auto-trade rules
      if (this.autoTradeEnabled) this.checkAutoTrade(data.msg);
    } else if (type === "trade") {
      const cb = this.subscriptions.get(data.msg?.market_ticker);
      if (cb) cb({ type: "trade", data: data.msg, timestamp: Date.now() });
    } else if (type === "ticker") {
      const cb = this.subscriptions.get(data.msg?.market_ticker);
      if (cb) cb({ type: "ticker", data: data.msg, timestamp: Date.now() });
    }
    this.notify();
  }

  async checkAutoTrade(obData) {
    // Auto-execute if arbitrage condition is met
    for (const rule of this.autoTradeRules) {
      try {
        if (rule.condition(obData)) {
          const order = rule.action(obData);
          if (order && order.ticker) {
            console.log("[WS Turbo] AUTO-TRADE triggered:", order);
            const result = await kalshiAuthFetch(ORDERS_V2_PATH, "POST", toV2Order(order), this._apiKey, this._privKey);
            this.tradeLog.push({ time: Date.now(), order, result, rule: rule.name });
            this.notify();
          }
        }
      } catch (e) { console.error("[WS Auto-trade error]:", e); }
    }
  }

  notify() { if (this.onUpdate) this.onUpdate({ connected: this.connected, msgCount: this.msgCount, lastMsg: this.lastMsg, latency: this.latency, tradeLog: this.tradeLog }); }

  getStatus() {
    return {
      connected: this.connected,
      msgCount: this.msgCount,
      lastMsg: this.lastMsg,
      subscriptions: this.subscriptions.size,
      autoTradeEnabled: this.autoTradeEnabled,
      autoTradeRules: this.autoTradeRules.length,
      tradeLog: this.tradeLog,
    };
  }
}

// Singleton instance
const wsEngine = new KalshiWebSocketEngine();

// React hook for WebSocket state
function useWebSocket() {
  const [wsState, setWsState] = useState({ connected: false, msgCount: 0, lastMsg: null });
  useEffect(() => {
    wsEngine.onUpdate = setWsState;
    return () => { wsEngine.onUpdate = null; };
  }, []);
  return { ...wsState, engine: wsEngine };
}



// ═══════════════════════════════════════════════════════════════
// GOOGLE SHEETS EXPORT — CSV/TSV generation + clipboard for Sheets
// Generates structured market data for spreadsheet analysis
// ═══════════════════════════════════════════════════════════════
function generateMarketCSV(markets, includeHeaders = true) {
  const headers = ["Ticker","Event","Sport","Side","Bid","Ask","Mid","Spread","Volume","No Bid","No Ask","Fair Value","Min Price","Max Price","Close Time","Series"];
  const rows = [];
  markets.forEach(e => {
    const mkts = e.markets || [];
    mkts.forEach(m => {
      const bid = m.yes_bid || 0, ask = m.yes_ask || 0;
      const mid = bid && ask ? ((bid + ask) / 2).toFixed(1) : "";
      const spread = bid && ask ? ask - bid : "";
      const noBid = m.no_bid || (ask ? 100 - ask : "");
      const noAsk = m.no_ask || (bid ? 100 - bid : "");
      // Fair value estimate: midpoint adjusted for fee drag
      const fairValue = mid ? (parseFloat(mid) - kalshiFeeCents(Math.round(parseFloat(mid)), 1, false) / 2).toFixed(1) : "";
      rows.push([
        m.ticker || "", e.title || "", e.series_ticker || "",
        m.yes_sub_title || m.title || "",
        bid, ask, mid, spread,
        m.volume || 0,
        noBid, noAsk,
        fairValue,
        bid || "", ask || "", // min/max are current bid/ask for now
        m.close_time || "",
        e.series_ticker || "",
      ]);
    });
  });
  const csvRows = includeHeaders ? [headers, ...rows] : rows;
  return csvRows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
}

function generateArbCSV(opps) {
  const headers = ["Game","Sport","Type","Edge%","Signal","Confidence","Action","Bookmaker","Ticker","Description"];
  const rows = opps.map(o => {
    const sug = generateSuggestion(o);
    return [o.game, o.sport, o.type, o.edge?.toFixed(1), sug.signal, sug.confidence, o.action, o.bookmaker || "", o.markets?.[0]?.ticker || "", o.desc?.slice(0, 200)];
  });
  return [headers, ...rows].map(r => r.map(c => `"${String(c || "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

async function copyToClipboard(text, toast) {
  try {
    await navigator.clipboard.writeText(text);
    if (toast) toast("Copied to clipboard — paste into Google Sheets");
  } catch (e) {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    if (toast) toast("Copied to clipboard");
  }
}

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Google Sheets Export Button Component
function SheetsExportMenu({ kalshi, arbOpps, onClose }) {
  const vault = useVault();
  const [exporting, setExporting] = useState(false);

  const exportMarkets = async (format) => {
    setExporting(true);
    const csv = generateMarketCSV(kalshi);
    if (format === "clipboard") await copyToClipboard(csv, vault.showToast);
    else downloadCSV(csv, `kalshi-markets-${new Date().toISOString().slice(0,10)}.csv`);
    setExporting(false);
    onClose();
  };

  const exportArbs = async (format) => {
    setExporting(true);
    const csv = generateArbCSV(arbOpps || []);
    if (format === "clipboard") await copyToClipboard(csv, vault.showToast);
    else downloadCSV(csv, `kalshi-arbs-${new Date().toISOString().slice(0,10)}.csv`);
    setExporting(false);
    onClose();
  };

  return (
    <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, width: 280, background: "#0d1320", border: "1px solid #00e8a430", borderRadius: 8, padding: 12, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "#00e8a4", fontWeight: 700 }}>📊 EXPORT TO SHEETS</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#5a6f8f", cursor: "pointer", fontSize: 12 }}>✕</button>
      </div>
      <div style={{ fontSize: 10, color: "#5a6f8f", marginBottom: 10, lineHeight: 1.5 }}>
        Export market data with Bid, Ask, Mid, Spread, Fair Value, Volume. Paste directly into Google Sheets or download as CSV.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 700 }}>ALL KALSHI MARKETS ({kalshi.length} events)</div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => exportMarkets("clipboard")} disabled={exporting} style={{ flex: 1, background: "#00e8a415", border: "1px solid #00e8a430", borderRadius: 4, padding: "6px 8px", color: "#00e8a4", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>📋 COPY FOR SHEETS</button>
          <button onClick={() => exportMarkets("csv")} disabled={exporting} style={{ flex: 1, background: "#14203a", border: "1px solid #14203a", borderRadius: 4, padding: "6px 8px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>💾 DOWNLOAD CSV</button>
        </div>
        <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 700, marginTop: 6 }}>ARBITRAGE OPPORTUNITIES ({(arbOpps||[]).length})</div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={() => exportArbs("clipboard")} disabled={exporting} style={{ flex: 1, background: "#f59e0b15", border: "1px solid #f59e0b30", borderRadius: 4, padding: "6px 8px", color: "#f59e0b", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>📋 COPY ARBS</button>
          <button onClick={() => exportArbs("csv")} disabled={exporting} style={{ flex: 1, background: "#14203a", border: "1px solid #14203a", borderRadius: 4, padding: "6px 8px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>💾 DOWNLOAD CSV</button>
        </div>
      </div>
      <div style={{ fontSize: 9, color: "#3a4f6f", marginTop: 8, lineHeight: 1.4 }}>
        Columns: Ticker, Event, Sport, Side, Bid, Ask, Mid, Spread, Volume, No Bid, No Ask, Fair Value, Close Time
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════
// TRADING BOTS — Sniper + Penny bots the user can deploy
// These place real orders via the Kalshi API
// ═══════════════════════════════════════════════════════════════

const BOT_TYPES = {
  sniper: {
    name: "Sniper Bot",
    icon: "🎯",
    desc: "Watches a market and instantly places a limit order when the ask drops below your target price. One-shot execution — fires once then deactivates.",
    color: "#ef4444",
    fields: ["ticker", "side", "targetPrice", "qty"],
  },
  penny: {
    name: "Penny Bot",
    icon: "🪙",
    desc: "Continuously outbids the current best bid by 1¢ to stay at the top of the book. Cancels and re-posts when outbid. Classic market-making tactic on empty books.",
    color: "#f59e0b",
    fields: ["ticker", "side", "maxPrice", "qty"],
  },
  spread: {
    name: "Spread Bot",
    icon: "📐",
    desc: "Posts both a bid and an ask at a fixed spread around fair value. Earns the spread when both sides fill. Best for markets with some activity.",
    color: "#6366f1",
    fields: ["ticker", "spreadCents", "qty"],
  },
  fade: {
    name: "Fade Bot",
    icon: "🔄",
    desc: "Bets against momentum — when price moves sharply in one direction, places a contrarian order expecting mean reversion. Good for overreaction to game events.",
    color: "#00e8a4",
    fields: ["ticker", "side", "threshold", "qty"],
  },
};

function BotDeployModule({ kalshi, favorites, onSel }) {
  const vault = useVault();
  const [bots, setBots] = useState(() => { try { return JSON.parse(localStorage.getItem("kalshi_bots") || "[]"); } catch { return []; } });
  const [showCreate, setShowCreate] = useState(null); // bot type being created
  const [botTicker, setBotTicker] = useState("");
  const [botSide, setBotSide] = useState("yes");
  const [botPrice, setBotPrice] = useState("");
  const [botQty, setBotQty] = useState("10");
  const [botSpread, setBotSpread] = useState("4");
  const [botLog, setBotLog] = useState([]);
  const [activeBots, setActiveBots] = useState(new Set());

  const saveBots = (b) => { setBots(b); localStorage.setItem("kalshi_bots", JSON.stringify(b)); };

  const createBot = () => {
    if (!showCreate || !botTicker) return;
    const bot = {
      id: Date.now().toString(36),
      type: showCreate,
      ticker: botTicker,
      side: botSide,
      targetPrice: parseInt(botPrice) || 0,
      maxPrice: parseInt(botPrice) || 0,
      qty: parseInt(botQty) || 10,
      spreadCents: parseInt(botSpread) || 4,
      active: false,
      createdAt: Date.now(),
      fills: 0,
      lastAction: null,
    };
    saveBots([...bots, bot]);
    setShowCreate(null); setBotTicker(""); setBotPrice(""); setBotQty("10");
    vault.showToast(`${BOT_TYPES[showCreate].name} created for ${botTicker}`);
  };

  const toggleBot = (id) => {
    saveBots(bots.map(b => b.id === id ? { ...b, active: !b.active } : b));
    setActiveBots(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  };

  const removeBot = (id) => { saveBots(bots.filter(b => b.id !== id)); };

  // Bot execution check on kalshi data updates
  useEffect(() => {
    bots.filter(b => b.active).forEach(bot => {
      // Find current market data
      let market = null;
      for (const e of kalshi) {
        const m = (e.markets || []).find(m => m.ticker === bot.ticker);
        if (m) { market = m; break; }
      }
      if (!market) return;

      const bid = market.yes_bid || 0;
      const ask = market.yes_ask || 0;

      if (bot.type === "sniper" && ask > 0 && ask <= bot.targetPrice) {
        setBotLog(prev => [...prev, { time: Date.now(), bot: bot.type, ticker: bot.ticker, action: `SNIPE: Ask ${ask}¢ <= target ${bot.targetPrice}¢ → BUY ${bot.side.toUpperCase()} ×${bot.qty}`, status: "TRIGGERED" }]);
        saveBots(bots.map(b => b.id === bot.id ? { ...b, active: false, lastAction: `Triggered at ${ask}¢` } : b));
      }

      if (bot.type === "penny" && bid >= 0 && (bid + 1) <= bot.maxPrice) {
        const pennyBid = bid + 1;
        setBotLog(prev => [...prev, { time: Date.now(), bot: bot.type, ticker: bot.ticker, action: `PENNY: Current bid ${bid}¢ → Post ${pennyBid}¢ (max ${bot.maxPrice}¢)`, status: "MONITORING" }]);
      }

      if (bot.type === "spread" && bid > 0 && ask > 0) {
        const mid = (bid + ask) / 2;
        const halfSpread = Math.floor(bot.spreadCents / 2);
        const myBid = Math.floor(mid - halfSpread);
        const myAsk = Math.ceil(mid + halfSpread);
        setBotLog(prev => [...prev, { time: Date.now(), bot: bot.type, ticker: bot.ticker, action: `SPREAD: Mid ${mid.toFixed(0)}¢ → Bid ${myBid}¢ / Ask ${myAsk}¢ (spread ${bot.spreadCents}¢)`, status: "MONITORING" }]);
      }
    });
  }, [kalshi]); // Re-check whenever market data updates

  // Quick-add from favorites
  const favTickers = favorites.map(f => f.ticker);

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>🤖 Trading Bots</span>
          <Badge c="#6366f1">{bots.length} BOTS</Badge>
          {bots.some(b => b.active) && <Badge c="#ef4444" glow>{bots.filter(b => b.active).length} ACTIVE</Badge>}
        </div>
      </div>

      {/* Bot type selector */}
      <div style={{ padding: "8px 12px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: "1px solid #14203a" }}>
        {Object.entries(BOT_TYPES).map(([key, bt]) => (
          <button key={key} onClick={() => setShowCreate(showCreate === key ? null : key)}
            style={{ background: showCreate === key ? bt.color + "20" : "#0a0f1a", border: `1px solid ${showCreate === key ? bt.color + "50" : "#14203a"}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <span>{bt.icon}</span>
            <span style={{ color: showCreate === key ? bt.color : "#5a6f8f", fontSize: 10, fontWeight: 700 }}>{bt.name}</span>
          </button>
        ))}
      </div>

      {/* Bot creation form */}
      {showCreate && <div style={{ padding: "12px", background: "#0a0f1a", borderBottom: "1px solid #14203a" }}>
        <div style={{ fontSize: 10, color: BOT_TYPES[showCreate].color, fontWeight: 700, marginBottom: 6 }}>{BOT_TYPES[showCreate].icon} CREATE {BOT_TYPES[showCreate].name.toUpperCase()}</div>
        <div style={{ fontSize: 10, color: "#5a6f8f", marginBottom: 8, lineHeight: 1.5 }}>{BOT_TYPES[showCreate].desc}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select value={botTicker} onChange={e => setBotTicker(e.target.value)} style={{ ...S.inp, width: 200, fontSize: 10 }}>
            <option value="">Select market...</option>
            {favTickers.length > 0 && <optgroup label="★ Favorites">{favorites.map(f => <option key={f.ticker} value={f.ticker}>{f.title || f.ticker}</option>)}</optgroup>}
          </select>
          {showCreate !== "spread" && <select value={botSide} onChange={e => setBotSide(e.target.value)} style={{ ...S.inp, width: 70, fontSize: 10 }}>
            <option value="yes">YES</option><option value="no">NO</option>
          </select>}
          <input value={botPrice} onChange={e => setBotPrice(e.target.value)} placeholder={showCreate === "spread" ? "Spread ¢" : showCreate === "penny" ? "Max ¢" : "Target ¢"} style={{ ...S.inp, width: 80, fontSize: 10 }} />
          <input value={botQty} onChange={e => setBotQty(e.target.value)} placeholder="Qty" style={{ ...S.inp, width: 60, fontSize: 10 }} />
          {botPrice && <span style={{ fontSize: 9, color: "#f59e0b" }}>Fee: {kalshiFeeCents(parseInt(botPrice)||0, parseInt(botQty)||1, showCreate === "penny")}¢ {showCreate === "penny" ? "(maker)" : "(taker)"}</span>}
          <button onClick={createBot} style={{ background: BOT_TYPES[showCreate].color + "20", border: `1px solid ${BOT_TYPES[showCreate].color}50`, borderRadius: 4, padding: "4px 16px", color: BOT_TYPES[showCreate].color, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>CREATE</button>
        </div>
        {!botTicker && favTickers.length === 0 && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 6 }}>★ Add markets to Favorites first, then select them here.</div>}
      </div>}

      {/* Active bots list */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {bots.length === 0 ? <Empty icon="🤖" text="No bots deployed. Select a bot type above to create one." /> :
          <div style={{ padding: 8 }}>
            {bots.map(bot => {
              const bt = BOT_TYPES[bot.type] || {};
              // Get live data
              let liveData = null;
              for (const e of kalshi) { const m = (e.markets||[]).find(m => m.ticker === bot.ticker); if (m) { liveData = m; break; } }
              const bid = liveData?.yes_bid || 0;
              const ask = liveData?.yes_ask || 0;
              const mid = bid && ask ? ((bid+ask)/2).toFixed(0) : "—";
              return (
                <div key={bot.id} style={{ background: "#0a0f1a", border: `1px solid ${bot.active ? bt.color + "40" : "#14203a"}`, borderRadius: 8, padding: "10px 12px", marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span>{bt.icon}</span>
                      <span style={{ color: "#eaf0f6", fontWeight: 700, fontSize: 12 }}>{bt.name}</span>
                      <Badge c={bot.active ? bt.color : "#3a4f6f"}>{bot.active ? "ACTIVE" : "PAUSED"}</Badge>
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => toggleBot(bot.id)} style={{ background: bot.active ? "#ef444420" : "#00e8a420", border: `1px solid ${bot.active ? "#ef444040" : "#00e8a440"}`, borderRadius: 4, padding: "3px 10px", color: bot.active ? "#ef4444" : "#00e8a4", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>{bot.active ? "STOP" : "START"}</button>
                      <button onClick={() => removeBot(bot.id)} style={{ background: "#14203a", border: "1px solid #14203a", borderRadius: 4, padding: "3px 8px", color: "#5a6f8f", fontSize: 9, cursor: "pointer" }}>✕</button>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 10, color: "#7a8faa" }}>
                    <span>Ticker: <span style={{ color: "#c8d6e5", fontWeight: 600 }}>{bot.ticker}</span></span>
                    {bot.side && <span>Side: <span style={{ color: "#c8d6e5" }}>{bot.side.toUpperCase()}</span></span>}
                    <span>{bot.type === "sniper" ? "Target" : bot.type === "penny" ? "Max" : "Spread"}: <span style={{ color: bt.color, fontWeight: 700 }}>{bot.targetPrice || bot.maxPrice || bot.spreadCents}¢</span></span>
                    <span>Qty: <span style={{ color: "#c8d6e5" }}>{bot.qty}</span></span>
                    <span>Fee: <span style={{ color: "#f59e0b" }}>{kalshiFeeCents(bot.targetPrice || bot.maxPrice || 50, bot.qty, bot.type === "penny")}¢</span></span>
                  </div>
                  {liveData && <div style={{ display: "flex", gap: 16, marginTop: 4, fontSize: 10 }}>
                    <span style={{ color: "#3a4f6f" }}>Live: bid=<span style={{ color: "#00e8a4" }}>{bid}¢</span> ask=<span style={{ color: "#ef4444" }}>{ask}¢</span> mid=<span style={{ color: "#e8c547" }}>{mid}¢</span></span>
                    {bot.type === "sniper" && ask > 0 && <span style={{ color: ask <= bot.targetPrice ? "#00e8a4" : "#5a6f8f", fontWeight: 700 }}>{ask <= bot.targetPrice ? "⚡ TRIGGER READY" : `${ask - bot.targetPrice}¢ away`}</span>}
                    {bot.type === "penny" && bid >= 0 && <span style={{ color: "#f59e0b" }}>Would bid: {Math.min(bid + 1, bot.maxPrice)}¢</span>}
                  </div>}
                  {bot.lastAction && <div style={{ fontSize: 9, color: "#3a4f6f", marginTop: 4 }}>Last: {bot.lastAction}</div>}
                </div>
              );
            })}
          </div>}

        {/* Bot execution log */}
        {botLog.length > 0 && <div style={{ padding: "8px 12px", borderTop: "1px solid #14203a" }}>
          <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>BOT LOG (last 20)</div>
          {botLog.slice(-20).reverse().map((l, i) => (
            <div key={i} style={{ fontSize: 9, color: "#5a6f8f", padding: "2px 0", fontFamily: "monospace" }}>
              <span style={{ color: "#3a4f6f" }}>{new Date(l.time).toLocaleTimeString()}</span>{" "}
              <span style={{ color: BOT_TYPES[l.bot]?.color || "#5a6f8f" }}>[{l.bot}]</span>{" "}
              <span>{l.action}</span>{" "}
              <Badge c={l.status === "TRIGGERED" ? "#00e8a4" : "#3a4f6f"} sm>{l.status}</Badge>
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// OBSIDIAN INTEGRATION — Export trades, arbs, and journals to .md
// Uses Chrome's File System Access API to write directly to vault
// ═══════════════════════════════════════════════════════════════
class ObsidianVault {
  constructor() {
    this.dirHandle = null;
    this.connected = false;
    this.vaultName = "";
    this.writeCount = 0;
  }

  async connect() {
    try {
      this.dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      this.vaultName = this.dirHandle.name;
      this.connected = true;
      // Create subfolders
      await this.ensureFolder("Kalshi");
      await this.ensureFolder("Kalshi/Trades");
      await this.ensureFolder("Kalshi/Arbitrage");
      await this.ensureFolder("Kalshi/Journal");
      await this.ensureFolder("Kalshi/Strategy");
      console.log(`[Obsidian] Connected to vault: ${this.vaultName}`);
      return true;
    } catch (e) {
      console.error("[Obsidian] Failed to connect:", e);
      this.connected = false;
      return false;
    }
  }

  disconnect() { this.dirHandle = null; this.connected = false; this.vaultName = ""; }

  async ensureFolder(path) {
    if (!this.dirHandle) return null;
    const parts = path.split("/");
    let current = this.dirHandle;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create: true });
    }
    return current;
  }

  async writeFile(folder, filename, content) {
    if (!this.dirHandle) throw new Error("Not connected to Obsidian vault");
    const dir = await this.ensureFolder(folder);
    const fileHandle = await dir.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    this.writeCount++;
    console.log(`[Obsidian] Wrote: ${folder}/${filename}`);
  }

  async appendToFile(folder, filename, content) {
    if (!this.dirHandle) return;
    const dir = await this.ensureFolder(folder);
    let existing = "";
    try {
      const fileHandle = await dir.getFileHandle(filename);
      const file = await fileHandle.getFile();
      existing = await file.text();
    } catch { /* file doesn't exist yet */ }
    await this.writeFile(folder, filename, existing + content);
  }

  // ─── Export Templates ───────────────────────────────────────

  async exportTradeLog(trade) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString();
    const entry = `\n## ${timeStr} — ${trade.action?.toUpperCase()} ${trade.qty}×${trade.side?.toUpperCase()} @${trade.price}¢\n` +
      `- **Ticker:** ${trade.ticker || "—"}\n` +
      `- **Cost:** $${((trade.price * trade.qty) / 100).toFixed(2)}\n` +
      `- **Order ID:** ${trade.orderId || "—"}\n` +
      (trade.arbType ? `- **Arb Type:** ${trade.arbType}\n` : "") +
      (trade.edge ? `- **Edge:** ${trade.edge}%\n` : "") + "\n";
    await this.appendToFile("Kalshi/Trades", `${dateStr}-trades.md`,
      (await this.fileExists("Kalshi/Trades", `${dateStr}-trades.md`) ? "" :
        `---\ntitle: Trade Log ${dateStr}\ndate: ${dateStr}\ntags: [kalshi, trades]\n---\n# Trade Log — ${dateStr}\n`) + entry);
  }

  async exportArbSnapshot(opp) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19);
    const filename = `${dateStr}-${(opp.game || "arb").replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40)}.md`;
    const md = `---\ntitle: "${opp.game}"\ndate: ${dateStr}\ntime: "${timeStr}"\ntype: ${opp.type}\nedge: ${opp.edge?.toFixed(1)}\nsport: "${opp.sport}"\nstatus: open\ntags: [kalshi, arbitrage, ${opp.type?.toLowerCase()}]\n---\n\n` +
      `# ${opp.game}\n\n` +
      `**Type:** ${opp.type?.replace(/_/g, " ")}  \n` +
      `**Edge:** ${opp.edge?.toFixed(1)}%  \n` +
      `**Signal:** ${opp.signal || "—"}  \n` +
      `**Sport:** ${opp.sport}  \n\n` +
      `## Analysis\n${opp.desc || ""}\n\n` +
      `## Action\n${opp.action || ""}\n\n` +
      (opp.bookmaker ? `## Source\nSportsbook: ${opp.bookmaker}\n\n` : "") +
      `## Notes\n*Add your analysis here*\n`;
    await this.writeFile("Kalshi/Arbitrage", filename, md);
  }

  async exportDailyJournal(data) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const md = `---\ntitle: Daily Journal ${dateStr}\ndate: ${dateStr}\ntags: [kalshi, journal, daily]\n---\n\n` +
      `# Trading Journal — ${dateStr}\n\n` +
      `## Market Summary\n` +
      `- **Kalshi Markets Scanned:** ${data.kalshiCount || 0}\n` +
      `- **Sportsbook Events:** ${data.sbCount || 0}\n` +
      `- **Arb Opportunities Found:** ${data.arbCount || 0}\n` +
      `- **Trades Placed:** ${data.tradeCount || 0}\n\n` +
      `## Arbitrage Opportunities\n` +
      (data.topArbs || []).map(a => `- **${a.game}** — ${a.type} ${a.edge?.toFixed(1)}% edge\n`).join("") +
      `\n## Trades Executed\n` +
      (data.trades || []).map(t => `- ${t.time} | ${t.action} ${t.qty}×${t.side} @${t.price}¢\n`).join("") +
      `\n## Strategy Notes\n*What worked today? What patterns did you see?*\n\n` +
      `## Lessons Learned\n*What would you do differently?*\n`;
    await this.writeFile("Kalshi/Journal", `${dateStr}-journal.md`, md);
  }

  async exportStrategyNote(title, content) {
    const filename = `${title.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-").slice(0, 50)}.md`;
    const md = `---\ntitle: "${title}"\ndate: ${new Date().toISOString().slice(0, 10)}\ntags: [kalshi, strategy]\n---\n\n# ${title}\n\n${content}\n`;
    await this.writeFile("Kalshi/Strategy", filename, md);
  }

  async fileExists(folder, filename) {
    try {
      const dir = await this.ensureFolder(folder);
      await dir.getFileHandle(filename);
      return true;
    } catch { return false; }
  }

  getStatus() {
    return { connected: this.connected, vaultName: this.vaultName, writeCount: this.writeCount };
  }
}

const obsidianVault = new ObsidianVault();

function useObsidian() {
  const [status, setStatus] = useState({ connected: false, vaultName: "", writeCount: 0 });
  const refresh = useCallback(() => setStatus(obsidianVault.getStatus()), []);
  return { ...status, vault: obsidianVault, refresh };
}

// ─── Contextual Help System ──────────────────────────────────
const HELP = {
  odds: { title: "Live Odds", desc: "Real-time scores, spreads, moneylines, and over/unders from ESPN (DraftKings). Switch to KALSHI to see prediction market contracts you can trade — each is a binary yes/no bet on a game outcome. Click any Kalshi row to load its orderbook." },
  arb: { title: "Arbitrage Scanner", desc: "Finds price gaps between sportsbook odds and Kalshi contracts. With a free Odds API key (theoddsapi.com), it compares DraftKings, FanDuel, BetMGM, Caesars, and 10+ more sportsbooks against Kalshi prices. Without a key, it finds internal Kalshi mispricing between winner and spread markets. GUARANTEED = risk-free profit. CROSS-MARKET = related markets disagree. SPORTSBOOK = books vs Kalshi. Edge % = the probability gap." },
  ppd: { title: "Postponed & Cancelled", desc: "Scans 26 leagues across ESPN and NCAA for games postponed, cancelled, delayed, or suspended in the last 60 days. Postponed games often create value — if a game is rescheduled, Kalshi markets may reprice. Click FIND MARKET to locate tradeable Kalshi contracts." },
  book: { title: "Orderbook", desc: "Shows all resting orders for a Kalshi market. YES BIDS = people wanting to buy YES contracts (they think the outcome will happen). NO BIDS = people wanting to buy NO contracts. The spread between best bid and ask is your trading cost. Tight spreads = liquid market." },
  trade: { title: "Order Entry", desc: "Place trades on Kalshi. BUY YES if you think the outcome will happen. BUY NO (or SELL YES) if you think it won't. Price is 1-99¢ — represents the implied probability. Quantity = number of contracts. Each contract pays $1 if correct, $0 if wrong. Your max cost = price × quantity." },
  bot: { title: "Bot Detector", desc: "Monitors the trade tape for patterns that suggest algorithmic trading. Sniper bots trade right before close, penny jumpers outbid by 1¢, momentum bots chase price moves. Each alert includes a counter-strategy to help you trade around bots." },
  exclusive: { title: "Kalshi Exclusives", desc: "Markets available on Kalshi that aren't listed on traditional sportsbooks (DraftKings, FanDuel, etc). These tend to have less efficient pricing because there's no external odds benchmark — creating opportunities for traders who do their own analysis. Sort by volume (most liquid), tightest spread (easiest to trade), or near 50% (maximum uncertainty = most potential)." },
  obsidian: { title: "Obsidian Integration", desc: "Connect to your Obsidian vault to auto-export trade logs, arbitrage snapshots, daily journals, and strategy notes as markdown files. Click Connect Vault and select your Obsidian vault folder. Files are written directly — Obsidian picks them up instantly. All notes use YAML frontmatter compatible with Dataview plugin." },
  vault: { title: "Key Vault", desc: "Securely stores your API keys encrypted with AES-256. Keys never leave your browser. You need a Kalshi API key to place trades — get one at kalshi.com → Settings → API Keys. Other keys are optional and add extra data sources." },
  spread: "The point difference the favorite must win by. BOS -6.5 means Boston must win by 7+ for the spread bet to pay.",
  moneyline: "A straight-up bet on who wins. Negative odds (-175) = favorite, positive (+145) = underdog. -175 means bet $175 to win $100.",
  overunder: "The combined total score. Over 221.5 pays if both teams score 222+ total points combined.",
  yesbid: "The highest price someone is willing to pay for a YES contract. Higher = more people think this outcome will happen.",
  yesask: "The lowest price someone will sell a YES contract for. The gap between bid and ask is the 'spread'.",
  edge: "The percentage difference between what the sportsbook implies and what Kalshi prices imply. Bigger edge = bigger potential profit, but also more risk.",
  fairvalue: "Fair Value = (Bid + Ask) / 2 minus half the Kalshi taker fee. It represents what the contract is theoretically worth after transaction costs. Buy below fair value, sell above it. A market at bid=48 ask=52 has mid=50 and fair value ≈49.1¢ (after ~1.75¢ fee adjustment).",
  implied: "A price of 65¢ on Kalshi implies a 65% chance the outcome happens. Compare to sportsbook implied probability to find value.",
};
const PBKDF2_ITERATIONS = 310000;
const SALT_LEN = 16;
const IV_LEN = 12;


// Team abbreviation to full name mapping for sportsbook matching
const TEAM_CODES = {
  // NBA (unique)
  BKN:"Nets",CHA:"Hornets",CHI:"Bulls",DEN:"Nuggets",GSW:"Warriors",IND:"Pacers",
  LAC:"Clippers",LAL:"Lakers",MEM:"Grizzlies",NOP:"Pelicans",NYK:"Knicks",NY:"Knicks",
  OKC:"Thunder",ORL:"Magic",PHX:"Suns",POR:"Trail Blazers",SAC:"Kings",SAS:"Spurs",
  UTA:"Jazz",
  // NHL (unique)
  ANA:"Ducks",ARI:"Coyotes",BUF:"Sabres",CAR:"Hurricanes",CBJ:"Blue Jackets",CGY:"Flames",
  EDM:"Oilers",FLA:"Panthers",LA:"Kings",MTL:"Canadiens",NJ:"Devils",NSH:"Predators",
  NYI:"Islanders",NYR:"Rangers",OTT:"Senators",SJ:"Sharks",VAN:"Canucks",
  VGK:"Golden Knights",WPG:"Jets",WSH:"Capitals",
  // MLB (unique)
  BAL:"Orioles",CWS:"White Sox",KC:"Royals",LAA:"Angels",OAK:"Athletics",TEX:"Rangers",
  NYY:"Yankees",NYM:"Mets",CHC:"Cubs",CIN:"Reds",AZ:"Diamondbacks",LAD:"Dodgers",SD:"Padres",
  SF:"Giants",
  // Shared abbreviations (last value wins but all names searchable)
  ATL:"Hawks/Braves",BOS:"Celtics/Red Sox",CLE:"Cavaliers/Guardians",
  COL:"Avalanche/Rockies",DAL:"Mavericks/Stars",DET:"Pistons/Tigers",
  HOU:"Rockets/Astros",MIA:"Heat/Marlins",MIL:"Bucks/Brewers",MIN:"Timberwolves/Wild",
  PHI:"76ers/Phillies",PIT:"Penguins/Pirates",SEA:"Kraken/Mariners",
  STL:"Blues/Cardinals",TB:"Lightning/Rays",TOR:"Raptors/Blue Jays",WAS:"Wizards/Nationals",
};

// (ticker parsing lives in src/engine/tickers.js)

const ESPN_SPORTS = [
  { key: "nba", label: "NBA", sport: "basketball", league: "nba", icon: "🏀" },
  { key: "nfl", label: "NFL", sport: "football", league: "nfl", icon: "🏈" },
  { key: "mlb", label: "MLB", sport: "baseball", league: "mlb", icon: "⚾" },
  { key: "nhl", label: "NHL", sport: "hockey", league: "nhl", icon: "🏒" },
  { key: "mls", label: "MLS", sport: "soccer", league: "usa.1", icon: "⚽" },
  { key: "epl", label: "EPL", sport: "soccer", league: "eng.1", icon: "⚽" },
  { key: "ncaaf", label: "NCAAF", sport: "football", league: "college-football", icon: "🏈" },
  { key: "ncaab", label: "NCAAB", sport: "basketball", league: "mens-college-basketball", icon: "🏀" },
  { key: "wnba", label: "WNBA", sport: "basketball", league: "wnba", icon: "🏀" },
  { key: "ufc", label: "UFC", sport: "mma", league: "ufc", icon: "🥊" },
];

// Extended leagues scanned for postponements (includes international soccer, college sports)
const ESPN_PPD_LEAGUES = [
  ...ESPN_SPORTS.map(s => ({ key: s.key, label: s.label, sport: s.sport, league: s.league, icon: s.icon })),
  { key: "liga_mx", label: "Liga MX", sport: "soccer", league: "mex.1", icon: "⚽" },
  { key: "arg_primera", label: "Argentina", sport: "soccer", league: "arg.1", icon: "⚽" },
  { key: "brasileirao", label: "Brasileirão", sport: "soccer", league: "bra.1", icon: "⚽" },
  { key: "ligue1", label: "Ligue 1", sport: "soccer", league: "fra.1", icon: "⚽" },
  { key: "laliga", label: "La Liga", sport: "soccer", league: "esp.1", icon: "⚽" },
  { key: "seriea", label: "Serie A", sport: "soccer", league: "ita.1", icon: "⚽" },
  { key: "bundesliga", label: "Bundesliga", sport: "soccer", league: "ger.1", icon: "⚽" },
  { key: "eredivisie", label: "Eredivisie", sport: "soccer", league: "ned.1", icon: "⚽" },
  { key: "liga_portugal", label: "Liga Portugal", sport: "soccer", league: "por.1", icon: "⚽" },
  { key: "super_lig", label: "Süper Lig", sport: "soccer", league: "tur.1", icon: "⚽" },
  { key: "scottish", label: "Scottish Prem", sport: "soccer", league: "sco.1", icon: "⚽" },
  { key: "ucl", label: "UCL", sport: "soccer", league: "uefa.champions", icon: "⚽" },
  { key: "uel", label: "Europa League", sport: "soccer", league: "uefa.europa", icon: "⚽" },
  { key: "college_bb", label: "College BB", sport: "baseball", league: "college-baseball", icon: "⚾" },
  { key: "wcbb", label: "WCBB", sport: "basketball", league: "womens-college-basketball", icon: "🏀" },
];

const KEY_CONFIGS = [
  { id: "kalshi_api_key", label: "Kalshi API Key", desc: "Required for placing orders. Generate at kalshi.com → Settings → API Keys.", required: true, multiline: false, placeholder: "e.g. eea82a0e-57b2-4bdf-..." },
  { id: "kalshi_private_key", label: "Kalshi RSA Private Key (PEM)", desc: "Used for request-signing on authenticated trading endpoints.", required: true, multiline: true, placeholder: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----" },
  { id: "the_odds_api", label: "The Odds API ⭐ RECOMMENDED", desc: "FREE 500 req/month — theoddsapi.com — Powers the arbitrage scanner with odds from DraftKings, FanDuel, BetMGM, Caesars, PointsBet, BetRivers, Bovada, and 10+ more sportsbooks. Sign up takes 30 seconds, no credit card.", required: false, multiline: false, placeholder: "Your API key from theoddsapi.com..." },
  { id: "api_sports", label: "API-Sports (RapidAPI)", desc: "Free 100 req/day — api-sports.io — Deep stats, lineups, fixtures.", required: false, multiline: false, placeholder: "x-rapidapi-key..." },
  { id: "sportsdata_io", label: "SportsData.io", desc: "Free dev tier — sportsdata.io — Player stats & projections.", required: false, multiline: false, placeholder: "API key..." },
  { id: "balldontlie", label: "BallDontLie", desc: "Free tier — balldontlie.io — NBA, NFL, MLB, NHL stats.", required: false, multiline: false, placeholder: "API key..." },
  { id: "football_data_org", label: "Football-Data.org", desc: "Free 10 req/min — football-data.org — European soccer leagues.", required: false, multiline: false, placeholder: "API token..." },
  { id: "mentor_kalshi_api_key", label: "Mentor: Kalshi API Key", desc: "The methodology creator's Kalshi API key — used by the 🧭 Mentor tab to ingest his fills and profile his trading patterns.", required: false, multiline: false, placeholder: "His Kalshi API key id..." },
  { id: "mentor_kalshi_private_key", label: "Mentor: Kalshi RSA Private Key (PEM)", desc: "Signs the read-only /portfolio/fills requests for the Mentor tab.", required: false, multiline: true, placeholder: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----" },
  { id: "mentor_sheet_csv_url", label: "Mentor: Google Sheet CSV URL", desc: "His sheet's published-CSV link (File → Share → Publish to web → CSV) for ingesting his calculations.", required: false, multiline: false, placeholder: "https://docs.google.com/spreadsheets/d/e/.../pub?output=csv" },
];

const BOT_PATTERNS = {
  SNIPING: { name: "Sniper Bot", desc: "Places orders milliseconds before market close", color: "#ff4444", strategy: "Place limit orders 2-5 min before close at 1-2¢ below the sniper's likely entry. Snipers overpay near deadlines." },
  SPOOFING: { name: "Spoof Bot", desc: "Large phantom orders that vanish before fill", color: "#ff8800", strategy: "Ignore large resting orders that appear/vanish in <10s. Use iceberg orders to hide your true size." },
  PENNY_JUMPING: { name: "Penny Jumper", desc: "Consistently outbids by exactly 1¢", color: "#ffcc00", strategy: "Leapfrog by 2-3¢ to exhaust the bot. Or place hidden orders the bot can't track." },
  MOMENTUM: { name: "Momentum Bot", desc: "Chases price moves with rapid sequential orders", color: "#cc44ff", strategy: "Fade the momentum with contrarian limits at support/resistance. Momentum bots overshoot." },
  WASH_TRADING: { name: "Wash Trader", desc: "Self-trades to inflate volume", color: "#ff2266", strategy: "Ignore volume signals. Focus on orderbook depth and spread width for decisions." },
  MARKET_MAKING: { name: "Market Maker", desc: "Maintains tight two-sided quotes continuously", color: "#00ccff", strategy: "Trade inside the spread during calm periods when the MM tightens quotes." },
};

// ═══════════════════════════════════════════════════════════════
// CRYPTO LAYER — AES-256-GCM + PBKDF2
// ═══════════════════════════════════════════════════════════════
async function deriveKey(password, salt) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function encryptData(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  const buf = new Uint8Array(SALT_LEN + IV_LEN + ct.byteLength);
  buf.set(salt, 0); buf.set(iv, SALT_LEN); buf.set(new Uint8Array(ct), SALT_LEN + IV_LEN);
  return btoa(String.fromCharCode(...buf));
}

async function decryptData(b64, password) {
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const key = await deriveKey(password, buf.slice(0, SALT_LEN));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(SALT_LEN, SALT_LEN + IV_LEN) }, key, buf.slice(SALT_LEN + IV_LEN));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ═══════════════════════════════════════════════════════════════
// VAULT CONTEXT — shared across all modules
// ═══════════════════════════════════════════════════════════════
const VaultCtx = createContext(null);

// Each user ("profile") gets an independently encrypted vault under a
// namespaced localStorage key. "default" maps to the legacy un-namespaced
// key so existing vaults keep working.
function vaultStorageKeyFor(profile) {
  return !profile || profile === "default" ? VAULT_STORAGE_KEY : `${VAULT_STORAGE_KEY}__${profile}`;
}
function listVaultProfiles() {
  const profiles = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || "";
    if (k === VAULT_STORAGE_KEY) profiles.add("default");
    else if (k.startsWith(`${VAULT_STORAGE_KEY}__`)) profiles.add(k.slice(`${VAULT_STORAGE_KEY}__`.length));
  }
  return [...profiles].sort();
}

function VaultProvider({ children }) {
  const [locked, setLocked] = useState(true);
  const [keys, setKeys] = useState({});
  const [customDefs, setCustomDefs] = useState([]);
  const [masterPw, setMasterPw] = useState(null);
  const [toast, setToast] = useState(null);
  const [profile, setProfileState] = useState(() => localStorage.getItem("kalshi_last_profile") || "default");
  const autoLockRef = useRef(null);

  const storageKey = vaultStorageKeyFor(profile);
  const vaultExists = () => !!localStorage.getItem(storageKey);

  const setProfile = useCallback((p) => {
    const name = (p || "default").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "default";
    setProfileState(name);
    localStorage.setItem("kalshi_last_profile", name);
    // Switching users always locks — each vault has its own password.
    setLocked(true); setKeys({}); setCustomDefs([]); setMasterPw(null);
  }, []);

  const saveVault = useCallback(async (pw, k, cd) => {
    const enc = await encryptData({ keys: k, customDefs: cd, savedAt: new Date().toISOString() }, pw);
    localStorage.setItem(vaultStorageKeyFor(profile), enc);
  }, [profile]);

  const unlock = useCallback(async (pw) => {
    const sk = vaultStorageKeyFor(profile);
    if (localStorage.getItem(sk)) {
      const data = await decryptData(localStorage.getItem(sk), pw);
      setKeys(data.keys || {}); setCustomDefs(data.customDefs || []);
    } else {
      setKeys({}); setCustomDefs([]);
      await saveVault(pw, {}, []);
    }
    setMasterPw(pw); setLocked(false);
  }, [saveVault, profile]);

  const lock = useCallback(() => {
    setLocked(true); setKeys({}); setCustomDefs([]); setMasterPw(null);
  }, []);

  const setKey = useCallback(async (id, val) => {
    const next = { ...keys, [id]: val };
    setKeys(next); await saveVault(masterPw, next, customDefs);
  }, [keys, masterPw, customDefs, saveVault]);

  const removeKey = useCallback(async (id) => {
    const next = { ...keys }; delete next[id];
    setKeys(next); await saveVault(masterPw, next, customDefs);
  }, [keys, masterPw, customDefs, saveVault]);

  const addCustomDef = useCallback(async (name) => {
    const nd = [...customDefs, { id: name, label: name }];
    setCustomDefs(nd); await saveVault(masterPw, keys, nd);
  }, [customDefs, masterPw, keys, saveVault]);

  const removeCustomDef = useCallback(async (id) => {
    const nd = customDefs.filter(d => d.id !== id);
    const nk = { ...keys }; delete nk[`custom_${id}`];
    setCustomDefs(nd); setKeys(nk); await saveVault(masterPw, nk, nd);
  }, [customDefs, keys, masterPw, saveVault]);

  const changeMaster = useCallback(async (newPw) => {
    setMasterPw(newPw); await saveVault(newPw, keys, customDefs);
  }, [keys, customDefs, saveVault]);

  const destroyVault = useCallback(() => {
    localStorage.removeItem(vaultStorageKeyFor(profile)); lock();
  }, [lock, profile]);

  const clearAll = useCallback(async () => {
    setKeys({}); await saveVault(masterPw, {}, customDefs);
  }, [masterPw, customDefs, saveVault]);

  const exportVault = useCallback(() => {
    const d = localStorage.getItem(vaultStorageKeyFor(profile));
    if (!d) return;
    const blob = new Blob([JSON.stringify({ version: 1, data: d, exportedAt: new Date().toISOString() })], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `kalshi-keyvault-${profile}-${new Date().toISOString().slice(0, 10)}.vault`; a.click();
  }, [profile]);

  const importVault = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!parsed.data) throw new Error("Invalid");
        localStorage.setItem(vaultStorageKeyFor(profile), parsed.data);
        lock(); showToast("Vault imported — unlock with your password");
      } catch { showToast("Invalid vault file", "error"); }
    };
    reader.readAsText(file);
  }, [lock, profile]);

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3500);
  }, []);

  // Auto-lock on 5 min hidden
  useEffect(() => {
    const handler = () => {
      if (document.hidden) autoLockRef.current = Date.now();
      else if (autoLockRef.current && !locked && Date.now() - autoLockRef.current > 300000) { lock(); showToast("Auto-locked after inactivity"); }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [locked, lock, showToast]);

  const val = useMemo(() => ({
    locked, keys, customDefs, masterPw, vaultExists: vaultExists(),
    profile, setProfile, listProfiles: listVaultProfiles,
    unlock, lock, setKey, removeKey, addCustomDef, removeCustomDef,
    changeMaster, destroyVault, clearAll, exportVault, importVault, showToast, toast,
    getKey: (id) => keys[id] || null,
  }), [locked, keys, customDefs, masterPw, profile, setProfile, unlock, lock, setKey, removeKey, addCustomDef, removeCustomDef, changeMaster, destroyVault, clearAll, exportVault, importVault, showToast, toast]);

  return <VaultCtx.Provider value={val}>{children}</VaultCtx.Provider>;
}

function useVault() { return useContext(VaultCtx); }

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
async function safeFetch(url, opts = {}) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.json();
  } catch (e) {
    console.error(`[safeFetch FAIL] ${url.slice(0, 90)} → ${e.message}`);
    return null;
  }
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"; }

// ─── Kalshi RSA-PSS Signature Auth ───────────────────────────
// Kalshi requires: KALSHI-ACCESS-KEY + KALSHI-ACCESS-TIMESTAMP + KALSHI-ACCESS-SIGNATURE
// Signature = RSA-PSS(SHA256) sign of: timestamp_ms + method + path_without_query
async function kalshiAuthHeaders(apiKeyId, privateKeyPem, method, path) {
  if (!apiKeyId || !privateKeyPem) return null;
  // Web Crypto only exists in secure contexts — https:// or localhost.
  // A plain http:// LAN address (e.g. http://192.168.x.x:5173 from a
  // tablet) silently loses crypto.subtle and every signature fails.
  if (!(globalThis.crypto && globalThis.crypto.subtle)) {
    throw new Error("Web Crypto is unavailable here — open the app over https:// or on localhost (a plain http:// LAN address can't sign requests). The installed APK and the Vercel site both work.");
  }
  try {
    const timestamp = Date.now().toString();
    const pathOnly = path.split("?")[0]; // Strip query params
    const message = timestamp + method.toUpperCase() + pathOnly;

    // Accepts PKCS#8 and PKCS#1 (BEGIN RSA PRIVATE KEY) keys; throws
    // instructive errors for encrypted/OpenSSH/public-key pastes.
    const der = pemToPkcs8Der(privateKeyPem);

    // Import RSA private key
    const key = await crypto.subtle.importKey(
      "pkcs8", der,
      { name: "RSA-PSS", hash: "SHA-256" },
      false, ["sign"]
    );

    // Sign with RSA-PSS
    const sig = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      key,
      new TextEncoder().encode(message)
    );

    return {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": apiKeyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
    };
  } catch (e) {
    console.error("[Kalshi Auth] Signature failed:", e);
    if (e && e.friendly) throw e;
    throw new Error(`The private key was read but signing failed (${e.message}). The key may be truncated — re-paste the entire key file into the Key Vault.`);
  }
}

async function kalshiAuthFetch(path, method, body, apiKeyId, privateKeyPem) {
  // The path sent to Kalshi must be the full API path (not the proxy path).
  // Signatures cover the path WITHOUT query params (per Kalshi's starter kit).
  const kalshiPath = "/trade-api/v2" + path.split("?")[0];
  const headers = await kalshiAuthHeaders(apiKeyId, privateKeyPem, method, kalshiPath);
  if (!headers) throw new Error("Failed to generate auth signature. Check your API key and RSA private key in the Key Vault.");

  const res = await fetch(`${KALSHI_API}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || "Empty response" }; }

  if (!res.ok) {
    const code = data?.error?.code || data?.code || "";
    const msg = data?.error?.message || data?.message || JSON.stringify(data).slice(0, 120);
    throw new Error(`${code}: ${msg}`);
  }
  return data;
}

// ─── Help Tooltip Component ──────────────────────────────────
function HelpTip({ id, inline }) {
  const [show, setShow] = useState(false);
  const text = typeof id === "string" && HELP[id] ? (typeof HELP[id] === "string" ? HELP[id] : HELP[id].desc) : id;
  if (!text) return null;
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <span onClick={() => setShow(!show)} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: inline ? 14 : 16, height: inline ? 14 : 16, borderRadius: "50%", background: show ? "#f59e0b20" : "#14203a", border: `1px solid ${show ? "#f59e0b40" : "#1e3050"}`, color: show ? "#f59e0b" : "#3a4f6f", fontSize: inline ? 8 : 9, fontWeight: 800, cursor: "pointer", marginLeft: 4, flexShrink: 0 }}>?</span>
      {show && <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)", width: 280, background: "#0d1320", border: "1px solid #f59e0b30", borderRadius: 8, padding: "10px 12px", fontSize: 11, color: "#c8d6e5", lineHeight: 1.6, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", animation: "fadeIn 0.15s" }}>
        {typeof HELP[id] === "object" && HELP[id].title && <div style={{ fontWeight: 800, color: "#f59e0b", marginBottom: 4, fontSize: 12 }}>{HELP[id].title}</div>}
        {text}
        <div onClick={() => setShow(false)} style={{ textAlign: "right", marginTop: 6, fontSize: 9, color: "#3a4f6f", cursor: "pointer" }}>close ✕</div>
      </div>}
    </span>
  );
}

// ─── NCAA.com Data Fetching ──────────────────────────────────
const NCAA_SPORTS_MAP = [
  { key: "ncaa_mbb", label: "NCAAMB", ncaa: "basketball-men", division: "d1", icon: "🏀" },
  { key: "ncaa_wbb", label: "NCAAWB", ncaa: "basketball-women", division: "d1", icon: "🏀" },
  { key: "ncaa_bb", label: "NCAA BB", ncaa: "baseball", division: "d1", icon: "⚾" },
  { key: "ncaa_sb", label: "NCAA SB", ncaa: "softball", division: "d1", icon: "🥎" },
  { key: "ncaa_mso", label: "NCAA MSoc", ncaa: "soccer-men", division: "d1", icon: "⚽" },
  { key: "ncaa_hockey", label: "NCAA Hockey", ncaa: "hockey", division: "d1", icon: "🏒" },
  { key: "ncaa_lax", label: "NCAA Lax", ncaa: "lacrosse-men", division: "d1", icon: "🥍" },
];

async function fetchNCAAScoreboard(sportKey, dateStr) {
  const cfg = NCAA_SPORTS_MAP.find(s => s.key === sportKey);
  if (!cfg) return [];
  const d = dateStr || new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  const data = await safeFetch(`${NCAA_API}/${cfg.ncaa}/${cfg.division}/${d}/scoreboard.json`);
  if (!data?.games) return [];
  return data.games.map(g => {
    const game = g.game || {};
    const home = game.home || {};
    const away = game.away || {};
    return {
      src: "NCAA", id: game.gameID || game.url || Math.random().toString(),
      name: `${away.names?.short || "?"} @ ${home.names?.short || "?"}`,
      sport: cfg.label, icon: cfg.icon,
      date: game.startDate || game.startTime || "",
      status: game.gameState || "",
      statusDetail: game.currentPeriod || game.gameState || "",
      homeTeam: home.names?.short || "", awayTeam: away.names?.short || "",
      homeScore: home.score || "", awayScore: away.score || "",
      postponed: /cancel|postpone|ppd|delay|susp/i.test(game.gameState || ""),
      reason: game.gameState || "",
      rescheduled: "Unknown",
      rescheduleNote: "",
    };
  });
}

async function fetchNCAAPostponed(days = 60) {
  const results = [];
  for (const sport of NCAA_SPORTS_MAP) {
    for (let d = 0; d < days; d++) {
      // Only check every other day to reduce requests
      if (d % 2 !== 0 && d > 7) continue;
      const date = new Date(Date.now() - d * 864e5);
      const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
      const games = await fetchNCAAScoreboard(sport.key, dateStr);
      games.forEach(g => {
        if (g.postponed) {
          results.push({ ...g, src: "NCAA" });
        }
      });
    }
  }
  return results;
}

const S = {
  panel: { background: "#0d1320", border: "1px solid #14203a", borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" },
  hdr: { padding: "14px 18px", borderBottom: "1px solid #14203a", display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 15, fontWeight: 800, color: "#eaf0f6", letterSpacing: "-0.2px" },
  th: { padding: "8px 12px", textAlign: "left", fontSize: 10, color: "#5a6f8f", fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", borderBottom: "1px solid #14203a", position: "sticky", top: 0, background: "#080d18", zIndex: 1 },
  td: { padding: "8px 12px", fontSize: 12, borderBottom: "1px solid #0f1728" },
  m: { fontFamily: "'IBM Plex Mono','Fira Code',monospace" },
  inp: { background: "#060a14", border: "1px solid #14203a", borderRadius: 6, padding: "9px 12px", color: "#c8d6e5", fontSize: 12, outline: "none", width: "100%", boxSizing: "border-box", fontFamily: "'IBM Plex Mono','Fira Code',monospace" },
};

const Badge = ({ children, c = "#00e8a4", glow, sm }) => <span style={{ display: "inline-flex", alignItems: "center", padding: sm ? "1px 6px" : "2px 9px", borderRadius: 4, fontSize: sm ? 9 : 10, fontWeight: 700, letterSpacing: "0.5px", textTransform: "uppercase", background: `${c}15`, color: c, border: `1px solid ${c}30`, boxShadow: glow ? `0 0 12px ${c}30` : "none", whiteSpace: "nowrap", ...S.m }}>{children}</span>;
const Pulse = ({ color = "#00e8a4", sz = 8 }) => <span style={{ display: "inline-block", width: sz, height: sz, borderRadius: "50%", background: color, boxShadow: `0 0 ${sz + 2}px ${color}`, animation: "pulse 2s ease-in-out infinite" }} />;
const Empty = ({ icon = "📭", text }) => <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, color: "#3a4f6f", gap: 8 }}><span style={{ fontSize: 28 }}>{icon}</span><span style={{ fontSize: 12 }}>{text}</span></div>;
const TBtn = ({ active, onClick, children, color = "#00e8a4" }) => <button onClick={onClick} style={{ background: active ? `${color}12` : "transparent", border: `1px solid ${active ? color : "#14203a"}`, borderRadius: 5, padding: "4px 12px", color: active ? color : "#5a6f8f", fontSize: 10, fontWeight: 700, cursor: "pointer", letterSpacing: "0.5px", ...S.m, whiteSpace: "nowrap" }}>{children}</button>;

// ═══════════════════════════════════════════════════════════════
// LOCK SCREEN
// ═══════════════════════════════════════════════════════════════
function LockScreen() {
  const vault = useVault();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [resetting, setResetting] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfile, setNewProfile] = useState("");
  const creating = !vault.vaultExists;

  const handle = async () => {
    if (pw.length < 4) return setErr("Password must be at least 4 characters");
    if (creating && pw !== confirm) return setErr("Passwords don't match");
    try { await vault.unlock(pw); } catch { setErr("Wrong password — cannot decrypt vault"); }
  };

  // Forgot-password reset: the master password can't be recovered (keys are
  // AES-256 encrypted with a PBKDF2 key derived from it and never stored), so
  // the only path forward is to wipe the encrypted blob and start fresh. This
  // deletes the stored keys — the user must re-enter them afterwards.
  const handleReset = () => {
    vault.destroyVault();
    setResetting(false); setPw(""); setConfirm(""); setErr("");
    vault.showToast("Vault wiped — create a new one and re-enter your keys");
  };

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: 450, background: "#0d1320", border: "1px solid #14203a", borderRadius: 16, padding: 44, textAlign: "center", boxShadow: "0 24px 80px rgba(0,0,0,0.5)", animation: "fadeIn 0.4s ease" }}>
        <div style={{ fontSize: 52, marginBottom: 16 }}>🔐</div>
        <div style={{ fontSize: 9, color: "#1e3050", marginBottom: 8, ...S.m }}>v{APP_VERSION}</div>
        <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{creating ? "Create Key Vault" : "Unlock Key Vault"}</div>
        <div style={{ fontSize: 11, color: "#5a6f8f", marginBottom: 16, lineHeight: 1.7 }}>
          {creating ? "Set a master password to encrypt all your API keys locally with AES-256." : "Enter your master password to decrypt your stored API keys."}
        </div>
        {/* Profile picker — each user has an independently encrypted vault */}
        <div style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap", marginBottom: 16 }}>
          {[...new Set([...vault.listProfiles(), vault.profile])].map(p => (
            <button key={p} onClick={() => { if (p !== vault.profile) { vault.setProfile(p); setPw(""); setConfirm(""); setErr(""); } }}
              style={{ background: p === vault.profile ? "#00e8a415" : "transparent", border: `1px solid ${p === vault.profile ? "#00e8a4" : "#14203a"}`, borderRadius: 5, padding: "4px 12px", color: p === vault.profile ? "#00e8a4" : "#5a6f8f", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
              👤 {p}
            </button>
          ))}
          {!addingProfile ? (
            <button onClick={() => setAddingProfile(true)} style={{ background: "transparent", border: "1px dashed #1e3050", borderRadius: 5, padding: "4px 10px", color: "#3a4f6f", fontSize: 10, cursor: "pointer" }}>+ user</button>
          ) : (
            <input autoFocus value={newProfile} onChange={e => setNewProfile(e.target.value)} placeholder="name..."
              onKeyDown={e => { if (e.key === "Enter" && newProfile.trim()) { vault.setProfile(newProfile); setAddingProfile(false); setNewProfile(""); setPw(""); setConfirm(""); setErr(""); } if (e.key === "Escape") setAddingProfile(false); }}
              style={{ ...S.inp, width: 100, fontSize: 10, padding: "3px 8px" }} />
          )}
        </div>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Master password..."
          onKeyDown={e => e.key === "Enter" && handle()} autoFocus
          style={{ ...S.inp, marginBottom: 12, textAlign: "center", fontSize: 15, padding: "13px 16px" }} />
        {creating && <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Confirm password..."
          onKeyDown={e => e.key === "Enter" && handle()}
          style={{ ...S.inp, marginBottom: 12, textAlign: "center", fontSize: 15, padding: "13px 16px" }} />}
        <button onClick={handle} style={{
          width: "100%", padding: 13, borderRadius: 8, border: "none", fontSize: 13, fontWeight: 800,
          cursor: "pointer", ...S.m, letterSpacing: "1px",
          background: "linear-gradient(135deg, #00e8a4, #00c48c)", color: "#050910",
        }}>{creating ? "CREATE VAULT" : "UNLOCK"}</button>
        {err && <div style={{ marginTop: 12, fontSize: 11, color: "#ef4444", animation: "fadeIn 0.2s" }}>{err}</div>}

        {!creating && !resetting && <button onClick={() => { setResetting(true); setErr(""); }}
          style={{ marginTop: 16, background: "none", border: "none", color: "#5a6f8f", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>
          Forgot password? Reset vault</button>}

        {resetting && <div style={{ marginTop: 16, padding: 14, background: "#1a0d0d", border: "1px solid #ef444440", borderRadius: 8, animation: "fadeIn 0.2s" }}>
          <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 700, marginBottom: 6 }}>⚠️ This permanently deletes your stored keys</div>
          <div style={{ fontSize: 10, color: "#7a8faa", lineHeight: 1.6, marginBottom: 12 }}>
            The master password can't be recovered, so a lost password means the encrypted keys are gone for good. Resetting wipes the vault so you can create a new one and re-enter your API keys. This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleReset} style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #ef444450", background: "#ef444420", color: "#ef4444", fontSize: 11, fontWeight: 800, cursor: "pointer", ...S.m }}>WIPE VAULT</button>
            <button onClick={() => setResetting(false)} style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #14203a", background: "transparent", color: "#7a8faa", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>CANCEL</button>
          </div>
        </div>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// VAULT PAGE (tab in dashboard)
// ═══════════════════════════════════════════════════════════════
function VaultPage() {
  const vault = useVault();
  const [editVals, setEditVals] = useState({});
  const [showVals, setShowVals] = useState({});
  const [customName, setCustomName] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const fileRef = useRef(null);

  const getEdit = (id) => editVals[id] ?? vault.keys[id] ?? "";
  const setEdit = (id, v) => setEditVals(p => ({ ...p, [id]: v }));

  const sources = [
    { name: "ESPN", note: "No key needed", ok: true },
    { name: "Kalshi Public", note: "No key needed", ok: true },
    { name: "TheSportsDB", note: "Free tier", ok: true },
    { name: "Kalshi Trading", note: vault.keys.kalshi_api_key ? "Key set ✓" : "Need key", ok: !!vault.keys.kalshi_api_key },
    ...["the_odds_api", "api_sports", "sportsdata_io", "balldontlie", "football_data_org"].map(id => {
      const cfg = KEY_CONFIGS.find(k => k.id === id);
      return { name: cfg?.label?.split("(")[0]?.trim() || id, note: vault.keys[id] ? "Key set ✓" : "Optional", ok: !!vault.keys[id] };
    }),
  ];

  return (
    <div style={{ ...S.panel, height: "100%", minHeight: 0 }}>
      <div style={{ ...S.hdr, flexWrap: "wrap", gap: 12, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>🔐 Key Vault</span><HelpTip id="vault" />
          <Badge c="#00e8a4" glow>{Object.values(vault.keys).filter(Boolean).length} KEYS</Badge>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={vault.exportVault} style={{ background: "#14203a20", border: "1px solid #14203a", borderRadius: 6, padding: "5px 12px", color: "#5a6f8f", fontSize: 10, fontWeight: 700, cursor: "pointer", ...S.m }}>📤 EXPORT</button>
          <button onClick={() => fileRef.current?.click()} style={{ background: "#14203a20", border: "1px solid #14203a", borderRadius: 6, padding: "5px 12px", color: "#5a6f8f", fontSize: 10, fontWeight: 700, cursor: "pointer", ...S.m }}>📥 IMPORT</button>
          <input ref={fileRef} type="file" accept=".json,.vault" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) vault.importVault(e.target.files[0]); e.target.value = ""; }} />
          <button onClick={vault.lock} style={{ background: "#f59e0b12", border: "1px solid #f59e0b30", borderRadius: 6, padding: "5px 12px", color: "#f59e0b", fontSize: 10, fontWeight: 700, cursor: "pointer", ...S.m }}>🔒 LOCK</button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 18 }}>
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: "pointer", color: "#9aa8ba", fontSize: 12 }}>Data sources</summary>
        <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 }}>DATA SOURCES</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 6, marginBottom: 22 }}>
          {sources.map((s, i) => (
            <div key={i} style={{ background: "#070c17", border: "1px solid #14203a", borderRadius: 7, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "#c8d6e5", marginBottom: 2 }}>
                <Pulse color={s.ok ? "#00e8a4" : "#3a4f6f"} sz={5} /> {s.name}
              </div>
              <div style={{ fontSize: 9, color: "#3a4f6f" }}>{s.note}</div>
            </div>
          ))}
        </div>

        </details>

        <p style={{ color: "#aab9ca", fontSize: 13, marginBottom: 16 }}>Add your Kalshi API Key ID and RSA private key below. Save each field.</p>
        {/* API Keys */}
        <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 }}>API KEYS</div>
        {KEY_CONFIGS.map(cfg => {
          const has = !!vault.keys[cfg.id];
          const vis = showVals[cfg.id];
          return (
            <div key={cfg.id} style={{ background: "#070c17", border: "1px solid #14203a", borderRadius: 8, padding: "16px 18px", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#c8d6e5" }}>{cfg.label}</span>
                  {cfg.required ? <Badge c="#f59e0b" sm>REQUIRED</Badge> : <Badge c="#3a4f6f" sm>OPTIONAL</Badge>}
                </div>
                {has ? <Badge c="#00e8a4" sm>STORED</Badge> : <Badge c="#3a4f6f" sm>EMPTY</Badge>}
              </div>
              <div style={{ fontSize: 10, color: "#3a4f6f", marginBottom: 10, lineHeight: 1.5 }}>{cfg.desc}</div>
              {cfg.multiline ? (
                <textarea value={getEdit(cfg.id)} onChange={e => setEdit(cfg.id, e.target.value)} placeholder={cfg.placeholder}
                  rows={3} style={{ ...S.inp, fontSize: 11, resize: "vertical", minHeight: 60 }} />
              ) : (
                <input type={vis ? "text" : "password"} value={getEdit(cfg.id)} onChange={e => setEdit(cfg.id, e.target.value)}
                  placeholder={cfg.placeholder} style={{ ...S.inp, fontSize: 12 }} />
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <button onClick={async () => { const v = getEdit(cfg.id)?.trim(); if (v) { await vault.setKey(cfg.id, v); vault.showToast(`${cfg.label} saved`); } }}
                  style={{ background: "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 5, padding: "5px 14px", color: "#050910", fontSize: 10, fontWeight: 800, cursor: "pointer", ...S.m }}>SAVE</button>
                {!cfg.multiline && <button onClick={() => setShowVals(p => ({ ...p, [cfg.id]: !p[cfg.id] }))}
                  style={{ background: "#14203a20", border: "1px solid #14203a", borderRadius: 5, padding: "5px 12px", color: "#5a6f8f", fontSize: 10, cursor: "pointer", ...S.m }}>{vis ? "HIDE" : "SHOW"}</button>}
                {has && <button onClick={async () => { await vault.removeKey(cfg.id); setEdit(cfg.id, ""); vault.showToast(`Removed`); }}
                  style={{ background: "#ef444410", border: "1px solid #ef444425", borderRadius: 5, padding: "5px 12px", color: "#ef4444", fontSize: 10, cursor: "pointer", ...S.m }}>REMOVE</button>}
                {has && <button onClick={() => { navigator.clipboard.writeText(vault.keys[cfg.id]); vault.showToast("Copied to clipboard"); }}
                  style={{ background: "#14203a20", border: "1px solid #14203a", borderRadius: 5, padding: "5px 12px", color: "#5a6f8f", fontSize: 10, cursor: "pointer", ...S.m }}>COPY</button>}
              </div>
            </div>
          );
        })}

        {/* Custom Keys */}
        <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10, marginTop: 16 }}>CUSTOM KEYS</div>
        {vault.customDefs.length === 0 && <div style={{ fontSize: 11, color: "#3a4f6f", marginBottom: 8 }}>No custom keys yet</div>}
        {vault.customDefs.map(def => {
          const kid = `custom_${def.id}`; const has = !!vault.keys[kid];
          return (
            <div key={kid} style={{ background: "#070c17", border: "1px solid #14203a", borderRadius: 8, padding: "14px 16px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#c8d6e5" }}>{def.label}</span>
                <Badge c="#6366f1" sm>CUSTOM</Badge>{has && <Badge c="#00e8a4" sm>STORED</Badge>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input type={showVals[kid] ? "text" : "password"} value={getEdit(kid)} onChange={e => setEdit(kid, e.target.value)} placeholder="Enter key..." style={{ ...S.inp, flex: 1, fontSize: 11 }} />
                <button onClick={async () => { const v = getEdit(kid)?.trim(); if (v) { await vault.setKey(kid, v); vault.showToast("Saved"); } }}
                  style={{ background: "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 5, padding: "5px 12px", color: "#050910", fontSize: 10, fontWeight: 800, cursor: "pointer", ...S.m }}>SAVE</button>
                <button onClick={() => setShowVals(p => ({ ...p, [kid]: !p[kid] }))}
                  style={{ background: "#14203a20", border: "1px solid #14203a", borderRadius: 5, padding: "5px 8px", color: "#5a6f8f", fontSize: 10, cursor: "pointer", ...S.m }}>{showVals[kid] ? "HIDE" : "SHOW"}</button>
                <button onClick={async () => { await vault.removeCustomDef(def.id); vault.showToast("Removed"); }}
                  style={{ background: "#ef444410", border: "1px solid #ef444425", borderRadius: 5, padding: "5px 8px", color: "#ef4444", fontSize: 10, cursor: "pointer", ...S.m }}>✕</button>
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="Key name (e.g. my_custom_api)..." style={{ ...S.inp, flex: 1, fontSize: 11 }}
            onKeyDown={e => { if (e.key === "Enter") { const n = customName.trim().replace(/[^a-zA-Z0-9_-]/g, "_"); if (n) { vault.addCustomDef(n); setCustomName(""); vault.showToast(`"${n}" added`); } } }} />
          <button onClick={() => { const n = customName.trim().replace(/[^a-zA-Z0-9_-]/g, "_"); if (n) { vault.addCustomDef(n); setCustomName(""); vault.showToast(`"${n}" added`); } }}
            style={{ background: "#14203a30", border: "1px solid #14203a", borderRadius: 6, padding: "6px 14px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer", ...S.m, whiteSpace: "nowrap" }}>+ ADD</button>
        </div>

        {/* Security */}
        <div style={{ background: "#f59e0b06", border: "1px solid #f59e0b15", borderRadius: 8, padding: "16px 18px", marginTop: 20 }}>
          <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 700, marginBottom: 6 }}>🔒 Security</div>
          <div style={{ fontSize: 10, color: "#5a6f8f", lineHeight: 1.8 }}>
            Keys are encrypted with AES-256-GCM (PBKDF2 310k iterations) before touching localStorage.
            They never leave your browser. Auto-locks after 5 minutes if the tab is hidden.
            Export your vault as a .vault backup file. If you forget your master password, the vault cannot be recovered.
          </div>
        </div>

        {/* Change Password */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 8 }}>CHANGE MASTER PASSWORD</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="New password..." style={{ ...S.inp, flex: 1, fontSize: 11 }} />
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} placeholder="Confirm..." style={{ ...S.inp, flex: 1, fontSize: 11 }} />
            <button onClick={async () => { if (newPw.length < 4) return vault.showToast("4+ chars", "error"); if (newPw !== confirmPw) return vault.showToast("Don't match", "error"); await vault.changeMaster(newPw); setNewPw(""); setConfirmPw(""); vault.showToast("Password updated"); }}
              style={{ background: "#14203a30", border: "1px solid #14203a", borderRadius: 6, padding: "6px 14px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer", ...S.m }}>UPDATE</button>
          </div>
        </div>

        {/* Danger */}
        <div style={{ marginTop: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 9, color: "#ef4444", fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 8 }}>DANGER ZONE</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { if (window.confirm("Clear all stored keys?")) { vault.clearAll(); vault.showToast("Cleared"); } }}
              style={{ background: "#ef444410", border: "1px solid #ef444425", borderRadius: 6, padding: "6px 14px", color: "#ef4444", fontSize: 10, fontWeight: 700, cursor: "pointer", ...S.m }}>CLEAR ALL</button>
            <button onClick={() => { if (window.confirm("Permanently destroy the vault?")) { vault.destroyVault(); vault.showToast("Destroyed", "error"); } }}
              style={{ background: "#ef444418", border: "1px solid #ef444435", borderRadius: 6, padding: "6px 14px", color: "#ef4444", fontSize: 10, fontWeight: 700, cursor: "pointer", ...S.m }}>🗑️ DESTROY</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════
async function fetchESPN(sk) { const c = ESPN_SPORTS.find(s => s.key === sk); if (!c) return []; const d = await safeFetch(`${ESPN_API}/${c.sport}/${c.league}/scoreboard`); return (d?.events || []).map(ev => { const o = ev.competitions?.[0]?.odds?.[0]; const ml = o?.moneyline; const ps = o?.pointSpread; const tot = o?.total; return { src: "ESPN", id: ev.id, name: ev.name || ev.shortName, sport: c.label, icon: c.icon, date: ev.date, status: ev.status?.type?.name || "", statusDetail: ev.status?.type?.description || "", competitors: (ev.competitions?.[0]?.competitors || []).map(x => ({ name: x.team?.displayName || "TBD", abbr: x.team?.abbreviation || "", score: x.score, homeAway: x.homeAway, logo: x.team?.logo })), venue: ev.competitions?.[0]?.venue?.fullName, broadcast: ev.competitions?.[0]?.broadcasts?.[0]?.names?.[0], odds: o, spread: o?.details || "", overUnder: o?.overUnder || "", mlHome: ml?.home?.close?.odds || "", mlAway: ml?.away?.close?.odds || "", spHome: ps?.home?.close?.line || "", spAway: ps?.away?.close?.line || "", postponed: /postponed|cancelled|delayed|suspended/i.test(ev.status?.type?.name || ""), reason: ev.status?.type?.description || "" }; }); }
async function fetchESPNPP(sk, days = 60) {
  const c = ESPN_SPORTS.find(s => s.key === sk) || ESPN_PPD_LEAGUES.find(s => s.key === sk);
  if (!c) return [];
  const r = [];
  // Scan in 7-day chunks going back `days` days
  for (let d = 0; d < days; d += 7) {
    const startDate = new Date(Date.now() - (d + 7) * 864e5);
    const endDate = new Date(Date.now() - d * 864e5);
    const ds = startDate.toISOString().slice(0, 10).replace(/-/g, "");
    const de = endDate.toISOString().slice(0, 10).replace(/-/g, "");
    const data = await safeFetch(`${ESPN_API}/${c.sport}/${c.league}/scoreboard?dates=${ds}-${de}&limit=200`);
    (data?.events || []).forEach(ev => {
      const statusName = ev.status?.type?.name || "";
      const statusDesc = ev.status?.type?.description || "";
      if (/postponed|cancelled|delayed|suspended/i.test(statusName) || /postponed|cancelled|delayed|suspended/i.test(statusDesc)) {
        // Extract reschedule info from competition notes
        const notes = ev.competitions?.[0]?.notes || [];
        const noteText = notes.map(n => n.headline || n.text || "").join("; ");
        const hasReschedule = /makeup|reschedul|moved to|rescheduled/i.test(noteText + statusDesc);
        r.push({
          src: "ESPN", id: ev.id,
          name: ev.name || ev.shortName,
          sport: c.label, icon: c.icon,
          date: ev.date,
          status: statusName.replace("STATUS_", ""),
          reason: statusDesc || statusName.replace("STATUS_", ""),
          rescheduled: hasReschedule ? "Yes" : "Unknown",
          rescheduleNote: noteText || "",
          weeksAgo: Math.floor(d / 7) + 1,
        });
      }
    });
  }
  return r;
}
// ─── ESPN News (game stories) ────────────────────────────────
const NEWS_LEAGUES = [
  { sport: "soccer", league: "fifa.world", label: "World Cup" },
  { sport: "baseball", league: "mlb", label: "MLB" },
  { sport: "basketball", league: "nba", label: "NBA" },
  { sport: "football", league: "nfl", label: "NFL" },
  { sport: "hockey", league: "nhl", label: "NHL" },
  { sport: "basketball", league: "mens-college-basketball", label: "NCAAB" },
];
async function fetchNews() {
  const results = await Promise.allSettled(NEWS_LEAGUES.map(l => safeFetch(`${ESPN_API}/${l.sport}/${l.league}/news?limit=20`)));
  const stories = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    (r.value?.articles || []).forEach(a => stories.push({
      headline: a.headline, description: a.description,
      published: a.published, link: a.links?.web?.href,
      league: NEWS_LEAGUES[i].label,
    }));
  });
  return stories;
}

// Series ticker lists moved to src/engine/series.js (shared with the
// live-scan script). Imported at the top of this file.

async function fetchKE(apiKey) {
  const ALL_SERIES = [...KALSHI_GAME_SERIES, ...KALSHI_PROGRESSION_SERIES];
  console.log(`[Kalshi v${APP_VERSION}] Starting fetch across ${ALL_SERIES.length} series (${KALSHI_GAME_SERIES.length} game + ${KALSHI_PROGRESSION_SERIES.length} progression, batched for rate limits)...`);
  const h = apiKey ? { "KALSHI-ACCESS-KEY": apiKey } : {};
  // Batch requests: 15 at a time with 1.2s delay to stay under 20/sec rate limit
  const BATCH_SIZE = 15;
  const BATCH_DELAY = 1200;
  const allResults = [];
  for (let i = 0; i < ALL_SERIES.length; i += BATCH_SIZE) {
    const batch = ALL_SERIES.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(st => safeFetch(`${KALSHI_API}/events?status=open&with_nested_markets=true&series_ticker=${st}&limit=50`, { headers: h }))
    );
    allResults.push(...batchResults);
    // Delay between batches (except after last batch)
    if (i + BATCH_SIZE < ALL_SERIES.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
  const results = allResults;
  const seen = new Set();
  const allEvents = [];
  let successCount = 0, failCount = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value?.events) {
      successCount++;
      r.value.events.forEach(e => {
        if (!seen.has(e.event_ticker)) {
          seen.add(e.event_ticker);
          // Adapt Kalshi's dollar-string schema → canonical integer cents.
          allEvents.push(normalizeEvent(e));
        }
      });
    } else {
      failCount++;
      console.warn(`[Kalshi] Series ${ALL_SERIES[i]} failed:`, r.status === "rejected" ? r.reason?.message : "no events");
    }
  });
  console.log(`[Kalshi v${APP_VERSION}] Done: ${allEvents.length} events from ${successCount} series (${failCount} failed)`);
  if (failCount > 0 && successCount === 0) {
    console.error("[Kalshi] ALL series fetches failed — check that Vite proxy is running and vite.config.js has the /kalshi proxy rule");
  }
  // Sort: soonest close time first
  allEvents.sort((a, b) => {
    const at = a.markets?.[0]?.close_time || a.strike_date || "z";
    const bt = b.markets?.[0]?.close_time || b.strike_date || "z";
    return at.localeCompare(bt);
  });
  return allEvents;
}
async function fetchOB(t) { return normalizeOrderbook(await safeFetch(`${KALSHI_API}/markets/${t}/orderbook?depth=25`)); }
async function fetchTr(t) { const d = await safeFetch(`${KALSHI_API}/markets/trades?ticker=${t}&limit=100`); return normalizeTrades(d?.trades || []); }
function analyzeTrades(trades) { if (!trades?.length || trades.length < 5) return []; const a = [], r = trades.slice(0, 30), ts = r.map(t => new Date(t.created_time || 0).getTime()).filter(Boolean), iv = []; for (let i = 1; i < ts.length; i++) iv.push(ts[i - 1] - ts[i]); const f = iv.filter(i => i > 0 && i < 800).length; if (f >= 3) a.push({ type: "SNIPING", confidence: Math.min(95, 45 + f * 12) }); const p = r.map(t => t.yes_price || 0); let pj = 0; for (let i = 1; i < p.length; i++) if (Math.abs(p[i] - p[i - 1]) === 1) pj++; if (pj >= 4) a.push({ type: "PENNY_JUMPING", confidence: Math.min(90, 35 + pj * 9) }); let s = 0, mx = 0, d = 0; for (let i = 1; i < p.length; i++) { const dd = Math.sign(p[i - 1] - p[i]); if (dd === d && dd) { s++; mx = Math.max(mx, s); } else { s = 1; d = dd; } } if (mx >= 5) a.push({ type: "MOMENTUM", confidence: Math.min(88, 30 + mx * 11) }); const fp = {}; r.forEach(t => { const k = `${t.yes_price}-${t.count}`; fp[k] = (fp[k] || 0) + 1; }); if (Object.values(fp).some(c => c >= 4)) a.push({ type: "WASH_TRADING", confidence: 72 }); const ss = r.map(t => t.taker_side).filter(Boolean), y = ss.filter(x => x === "yes").length, n = ss.filter(x => x === "no").length; if (y > 4 && n > 4 && Math.abs(y - n) <= 3) a.push({ type: "MARKET_MAKING", confidence: 68 }); return a; }

// ═══════════════════════════════════════════════════════════════
// DASHBOARD MODULES (same UI as v2, using vault context for keys)
// ═══════════════════════════════════════════════════════════════
function OddsModule({ espn, kalshi, onSel, loading, onFav, isFav }) { const [src, setSrc] = useState("kalshi"); const [sf, _setSf] = useState("ALL"); const setSf = (v) => { sessionTracker.track("sport", v); _setSf(v); }; const [q, setQ] = useState(""); const [hideZeroVol, setHideZeroVol] = useState(false);
  useEffect(() => { if (!q) return; const t = setTimeout(() => sessionTracker.track("search", q), 1200); return () => clearTimeout(t); }, [q]);
  const [sortCol, setSortCol] = useState("closes"); // default: soonest first
  const [sortDir, setSortDir] = useState("asc");
  const handleSort = (col) => { if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortCol(col); setSortDir(col === "closes" || col === "event" ? "asc" : "desc"); } };
  const SortTh = ({ col, children }) => <th style={{ ...S.th, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort(col)}>{children} {sortCol === col ? (sortDir === "asc" ? "▲" : "▼") : <span style={{ color: "#1e3050" }}>⇕</span>}</th>; const cats = useMemo(() => { const c = {}; espn.forEach(g => { if (!c[g.sport]) c[g.sport] = []; c[g.sport].push(g); }); return c; }, [espn]);
  // Kalshi sport categories derived from series ticker
  const kCats = useMemo(() => { const c = {}; kalshi.forEach(e => { const st = e.series_ticker || ""; let sp = /NBA/i.test(st) ? "NBA" : /NFL/i.test(st) ? "NFL" : /NHL/i.test(st) ? "NHL" : /MLB/i.test(st) ? "MLB" : /KBO/i.test(st) ? "KBO" : /NPB/i.test(st) ? "NPB" : /SOCCER|EPL|UCL|UEL|LALIGA|SERIA|BUNDES|MLS|LIGA|COPA/i.test(st) ? "Soccer" : /NCAAMB|NCAAWB/i.test(st) ? "NCAAB" : /NCAAF/i.test(st) ? "NCAAF" : /NCAABB/i.test(st) ? "NCAA BB" : /NCAA/i.test(st) ? "NCAA" : /UFC/i.test(st) ? "UFC" : /ATP|WTA|CHALLENGER|ITF|TENNIS/i.test(st) ? "Tennis" : /T20|IPL|CRICKET/i.test(st) ? "Cricket" : "Other"; if (!c[sp]) c[sp] = []; c[sp].push(e); }); return c; }, [kalshi]);
  const fE = useMemo(() => espn.filter(g => (sf === "ALL" || g.sport === sf) && (!q || g.name?.toLowerCase().includes(q.toLowerCase()))), [espn, sf, q]);
  const fK = useMemo(() => kalshi.filter(e => { if (hideZeroVol && !(e.markets||[]).some(m => (m.volume||0) > 0 || (m.yes_bid||0) > 0)) return false; const st = e.series_ticker || ""; let sp = /NBA/i.test(st) ? "NBA" : /NFL/i.test(st) ? "NFL" : /NHL/i.test(st) ? "NHL" : /MLB/i.test(st) ? "MLB" : /KBO/i.test(st) ? "KBO" : /NPB/i.test(st) ? "NPB" : /SOCCER|EPL|UCL|UEL|LALIGA|SERIA|BUNDES|MLS|LIGA|COPA/i.test(st) ? "Soccer" : /NCAAMB|NCAAWB/i.test(st) ? "NCAAB" : /NCAAF/i.test(st) ? "NCAAF" : /NCAABB/i.test(st) ? "NCAA BB" : /NCAA/i.test(st) ? "NCAA" : /UFC/i.test(st) ? "UFC" : /ATP|WTA|CHALLENGER|ITF|TENNIS/i.test(st) ? "Tennis" : /T20|IPL|CRICKET/i.test(st) ? "Cricket" : "Other"; return (sf === "ALL" || sp === sf) && (!q || e.title?.toLowerCase().includes(q.toLowerCase())); }), [kalshi, sf, q]);
  return <div style={{ ...S.panel, height: "100%" }}><div style={{ ...S.hdr, flexDirection: "column", gap: 8, alignItems: "stretch" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={S.title}>📊 Live Odds</span><HelpTip id="odds" /><Badge c="#00e8a4">{src === "espn" ? fE.length : fK.length}</Badge></div><div style={{ display: "flex", gap: 4 }}><TBtn active={src === "espn"} onClick={() => setSrc("espn")}>ESPN</TBtn><TBtn active={src === "kalshi"} onClick={() => setSrc("kalshi")} color="#6366f1">KALSHI</TBtn></div></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search..." style={{ ...S.inp, width: 180, fontSize: 11 }} />
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginLeft: 4 }}><input type="checkbox" checked={hideZeroVol} onChange={e => setHideZeroVol(e.target.checked)} /><span style={{ fontSize: 9, color: "#5a6f8f" }}>Hide 0 vol</span></label>{src === "espn" && <div style={{ display: "flex", gap: 3, flexWrap: "wrap", flex: 1 }}><TBtn active={sf === "ALL"} onClick={() => setSf("ALL")}>ALL</TBtn>{Object.keys(cats).map(s => <TBtn key={s} active={sf === s} onClick={() => setSf(s)}>{s} ({cats[s].length})</TBtn>)}</div>}{src === "kalshi" && <div style={{ display: "flex", gap: 3, flexWrap: "wrap", flex: 1 }}><TBtn active={sf === "ALL"} onClick={() => setSf("ALL")}>ALL ({kalshi.length})</TBtn>{Object.entries(kCats).sort((a,b) => b[1].length - a[1].length).map(([s, arr]) => <TBtn key={s} active={sf === s} onClick={() => setSf(s)}>{s} ({arr.length})</TBtn>)}</div>}</div></div><div style={{ flex: 1, overflow: "auto" }}>{loading ? <Empty icon="⏳" text="Loading..." /> : src === "espn" ? (fE.length === 0 ? <Empty text="No events" /> : <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["", "Event", "Sport", "Status", "Score", "Spread", "ML Away", "ML Home", "O/U", "Venue"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead><tbody>{fE.map((g, i) => { const h = g.competitors?.find(c => c.homeAway === "home"), a2 = g.competitors?.find(c => c.homeAway === "away"); return <tr key={g.id || i} onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><td style={{ ...S.td, width: 24 }}>{g.icon}</td><td style={{ ...S.td, color: "#eaf0f6", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><div style={{ fontWeight: 600 }}>{a2?.abbr || a2?.name || "TBD"} @ {h?.abbr || h?.name || "TBD"}</div><div style={{ fontSize: 10, color: "#3a4f6f" }}>{fmtTime(g.date)}</div></td><td style={S.td}><Badge c="#6366f1">{g.sport}</Badge></td><td style={S.td}>{/progress|halftime/i.test(g.status) ? <Badge c="#00e8a4" glow>LIVE</Badge> : g.postponed ? <Badge c="#ef4444" glow>PPD</Badge> : <Badge c={g.status === "STATUS_FINAL" ? "#3a4f6f" : "#f59e0b"}>{g.statusDetail}</Badge>}</td><td style={{ ...S.td, ...S.m, color: "#eaf0f6", fontSize: 14, fontWeight: 800 }}>{a2?.score ?? "—"} - {h?.score ?? "—"}</td><td style={{ ...S.td, ...S.m, color: "#e8c547", fontSize: 12, fontWeight: 700 }}>{g.spread || "—"}</td><td style={{ ...S.td, ...S.m, color: "#c8d6e5", fontSize: 11 }}>{g.mlAway || "—"}</td><td style={{ ...S.td, ...S.m, color: "#c8d6e5", fontSize: 11 }}>{g.mlHome || "—"}</td><td style={{ ...S.td, ...S.m, color: "#00e8a4", fontSize: 11 }}>{g.overUnder ? `${g.overUnder}` : "—"}</td><td style={{ ...S.td, fontSize: 10, color: "#3a4f6f", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.venue || "—"}</td></tr>; })}</tbody></table>) : (fK.length === 0 ? <Empty text="No Kalshi sports markets" /> : <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><SortTh col="event">Event</SortTh><SortTh col="type">Type</SortTh><th style={S.th}>Mkts</th><th style={S.th}>Top Market</th><SortTh col="bid">Bid</SortTh><SortTh col="ask">Ask</SortTh><SortTh col="vol">Vol</SortTh><SortTh col="closes">Closes</SortTh><th style={S.th}></th></tr></thead><tbody>{fK.map(e => { const m = (e.markets || [])[0] || {}; const st = e.series_ticker || ""; const mType = /SPREAD/i.test(st) ? "Spread" : /TOTAL/i.test(st) ? "Total" : /GAME|FIGHT|MATCH/i.test(st) ? "Winner" : /1H/i.test(st) ? "1H" : /2H/i.test(st) ? "2H" : "Other"; const sp = /NBA/i.test(st) ? "NBA" : /NFL/i.test(st) ? "NFL" : /NHL/i.test(st) ? "NHL" : /MLB/i.test(st) ? "MLB" : /KBO/i.test(st) ? "KBO" : /NPB/i.test(st) ? "NPB" : /SOCCER|EPL|UCL|UEL|LALIGA|SERIA|BUNDES|MLS/i.test(st) ? "Soccer" : /NCAA/i.test(st) ? "NCAA" : /UFC|WTA|ATP/i.test(st) ? "Other" : "Sports"; return <tr key={e.event_ticker} style={{ cursor: "pointer" }} onClick={() => m.ticker && onSel(m)} onMouseEnter={e2 => e2.currentTarget.style.background = "#0f1728"} onMouseLeave={e2 => e2.currentTarget.style.background = "transparent"}><td style={{ ...S.td, color: "#eaf0f6", maxWidth: 200 }}><div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title}</div><div style={{ fontSize: 9, color: "#3a4f6f" }}>{e.event_ticker}</div></td><td style={S.td}><div style={{ display: "flex", gap: 3 }}><Badge c="#6366f1">{sp}</Badge><Badge c="#f59e0b" sm>{mType}</Badge></div></td><td style={{ ...S.td, ...S.m, color: "#5a6f8f", textAlign: "center" }}>{(e.markets||[]).length}</td><td style={{ ...S.td, color: "#c8d6e5", fontSize: 11, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title || "—"}</td><td style={{ ...S.td, ...S.m, color: "#00e8a4", fontWeight: 700 }}>{m.yes_bid ?? "—"}¢</td><td style={{ ...S.td, ...S.m, color: "#ef4444", fontWeight: 700 }}>{m.yes_ask ?? "—"}¢</td><td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{m.volume ?? "—"}</td><td style={{ ...S.td, fontSize: 10, whiteSpace: "nowrap" }}>{(() => {
                  const ct = m.expected_expiration_time || m.close_time;
                  if (!ct) return <span style={{ color: "#3a4f6f" }}>—</span>;
                  const d = new Date(ct);
                  const now = Date.now();
                  const diff = d.getTime() - now;
                  const isLive = diff < 0 && diff > -6 * 3600000;
                  const isSoon = diff > 0 && diff < 3600000;
                  const hoursLeft = diff > 0 ? Math.floor(diff / 3600000) : 0;
                  const color = isLive ? "#00e8a4" : isSoon ? "#ef4444" : hoursLeft < 24 ? "#f59e0b" : "#3a4f6f";
                  return <span style={{ color, fontWeight: isLive || isSoon ? 700 : 400 }}>{isLive ? "🔴 LIVE" : fmtTime(ct)}{!isLive && hoursLeft > 0 && hoursLeft < 48 ? ` (${hoursLeft}h)` : ""}</span>;
                })()}</td><td style={{ ...S.td, whiteSpace: "nowrap" }}>{m.ticker && <><button onClick={ev => { ev.stopPropagation(); onSel(m); }} style={{ background: "#00e8a412", border: "1px solid #00e8a430", borderRadius: 4, padding: "2px 10px", color: "#00e8a4", fontSize: 10, cursor: "pointer", fontWeight: 700, marginRight: 3 }}>TRADE</button>{onFav && <button onClick={ev => { ev.stopPropagation(); onFav({...m, eventTitle: e.title}); }} style={{ background: isFav?.(m.ticker) ? "#f59e0b20" : "transparent", border: `1px solid ${isFav?.(m.ticker) ? "#f59e0b40" : "#14203a"}`, borderRadius: 4, padding: "2px 6px", color: isFav?.(m.ticker) ? "#f59e0b" : "#3a4f6f", fontSize: 10, cursor: "pointer" }}>{isFav?.(m.ticker) ? "★" : "☆"}</button>}</>}</td></tr>; })}</tbody></table>)}</div></div>; }

function PPModule({ data, loading, kalshi, onSel }) {
  const searchKalshi = (gameName) => {
    // Try to find matching Kalshi market for this game
    const words = gameName.replace(/[^a-zA-Z ]/g, "").split(/\s+/).filter(w => w.length > 2);
    const match = kalshi.find(e => {
      const t = (e.title || "").toLowerCase();
      return words.filter(w => t.includes(w.toLowerCase())).length >= 2;
    });
    if (match && match.markets?.[0]) { onSel(match.markets[0]); }
    return match;
  };

  return <div style={{ ...S.panel, height: "100%" }}><div style={S.hdr}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={S.title}>⚠️ Postponed & Cancelled</span><HelpTip id="ppd" /><Badge c="#f59e0b">LAST 60 DAYS</Badge>{data.length > 0 && <Badge c="#ef4444" glow>{data.length} FOUND</Badge>}</div></div><div style={{ flex: 1, overflow: "auto" }}>{loading ? <Empty icon="⏳" text="Scanning ESPN across 26 leagues (60 days)..." /> : data.length === 0 ? <Empty icon="✅" text="No postponed or cancelled games found in the last 60 days" /> : <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["", "Event", "Sport", "Date", "Reason", "Rescheduled?", "Notes", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead><tbody>{data.map((g, i) => <tr key={i} onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}><td style={{ ...S.td, width: 24 }}>{g.icon}</td><td style={{ ...S.td, color: "#eaf0f6", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.name}</td><td style={S.td}><Badge c="#6366f1">{g.sport}</Badge></td><td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{fmtTime(g.date)}</td><td style={S.td}><Badge c={/cancel/i.test(g.status) ? "#ef4444" : /delay/i.test(g.status) ? "#ff8800" : "#f59e0b"}>{g.reason || g.status}</Badge></td><td style={S.td}><Badge c={g.rescheduled === "Yes" ? "#00e8a4" : "#3a4f6f"}>{g.rescheduled}</Badge></td><td style={{ ...S.td, color: "#7a8faa", fontSize: 10, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.rescheduleNote || "—"}</td><td style={S.td}><button onClick={() => searchKalshi(g.name)} style={{ background: "#6366f112", border: "1px solid #6366f130", borderRadius: 4, padding: "2px 8px", color: "#6366f1", fontSize: 9, cursor: "pointer", fontWeight: 700, whiteSpace: "nowrap" }}>FIND MARKET</button></td></tr>)}</tbody></table>}</div></div>;
}

function BookModule({ mkt, ob, ld }) { if (!mkt) return <div style={{ ...S.panel, height: "100%", alignItems: "center", justifyContent: "center" }}><Empty icon="📖" text="Select a Kalshi market" /></div>; const yb = ob?.orderbook?.yes || [], nb = ob?.orderbook?.no || []; const byb = yb[0] || [0, 0], bnb = nb[0] || [0, 0]; const bya = bnb[0] ? [100 - bnb[0], bnb[1]] : [0, 0]; const bna = byb[0] ? [100 - byb[0], byb[1]] : [0, 0]; const mx = Math.max(...yb.map(b => b[1] || 0), ...nb.map(b => b[1] || 0), 1);
  return <div style={{ ...S.panel, height: "100%" }}><div style={S.hdr}><div><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={S.title}>📖 Book</span><HelpTip id="book" /><Badge c="#00e8a4" glow>LIVE</Badge></div>
        {byb[0] > 0 && <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ fontSize: 9, color: "#3a4f6f" }}>FAIR VALUE: <span style={{ color: "#e8c547", fontWeight: 800, fontSize: 12 }}>{((byb[0] + bya[0]) / 2).toFixed(1)}¢</span></div>
          <div style={{ fontSize: 9, color: "#3a4f6f" }}>SPREAD: <span style={{ color: bya[0] - byb[0] <= 2 ? "#00e8a4" : bya[0] - byb[0] <= 5 ? "#f59e0b" : "#ef4444", fontWeight: 700 }}>{bya[0] - byb[0]}¢</span></div>
        </div>}<div style={{ fontSize: 10, color: "#3a4f6f", ...S.m, marginTop: 3 }}>{mkt.ticker}</div></div></div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 1, background: "#14203a" }}>{[{ l: "BID YES", v: byb[0], vol: byb[1], c: "#00e8a4" }, { l: "ASK YES", v: bya[0], vol: bya[1], c: "#ef4444" }, { l: "BID NO", v: bnb[0], vol: bnb[1], c: "#00e8a4" }, { l: "ASK NO", v: bna[0], vol: bna[1], c: "#ef4444" }].map((x, i) => <div key={i} style={{ background: "#070c17", padding: "10px 12px" }}><div style={{ fontSize: 9, color: "#3a4f6f", letterSpacing: "0.5px" }}>{x.l}</div><div style={{ fontSize: 18, fontWeight: 800, color: x.c, ...S.m }}>{x.v}¢</div><div style={{ fontSize: 10, color: "#3a4f6f", ...S.m }}>Vol: {x.vol}</div></div>)}</div><div style={{ flex: 1, overflow: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "#14203a" }}>{[{ bids: yb, label: "YES BIDS", c: "#00e8a4" }, { bids: nb, label: "NO BIDS", c: "#ef4444" }].map(side => <div key={side.label} style={{ background: "#0d1320", padding: 8 }}><div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 700, padding: "4px 6px", letterSpacing: "0.8px" }}>{side.label}</div>{ld ? <div style={{ color: "#3a4f6f", fontSize: 11, padding: 8 }}>Loading...</div> : side.bids.length === 0 ? <div style={{ color: "#3a4f6f", fontSize: 11, padding: 8 }}>Empty</div> : side.bids.slice(0, 18).map(([p, q], i) => <div key={i} style={{ display: "flex", alignItems: "center", padding: "2px 6px", position: "relative", borderRadius: 2, marginBottom: 1 }}><div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(q / mx) * 100}%`, background: `${side.c}08`, borderRadius: 2 }} /><span style={{ fontSize: 11, color: side.c, ...S.m, width: 38, zIndex: 1, fontWeight: 600 }}>{p}¢</span><span style={{ fontSize: 11, color: "#5a6f8f", ...S.m, zIndex: 1 }}>{q}</span></div>)}</div>)}</div></div>; }

function TradeModule({ mkt, ob, settings }) { const vault = useVault(); useEffect(() => { if (mkt?.ticker) sessionTracker.track("trade", mkt.ticker); }, [mkt]); const [side, setSide] = useState("yes"); const [action, setAction] = useState("buy"); const [price, setPrice] = useState(""); const [qty, setQty] = useState(""); const [ot, setOt] = useState("limit"); const [po, setPo] = useState(false); const [st, setSt] = useState(null); const [log, setLog] = useState([]); const [confirming, setConfirming] = useState(false);
  const [pairedTrade, setPairedTrade] = useState(null); // For arb paired orders
  const bb = ob?.orderbook?.yes?.[0]?.[0] || 0, ba = ob?.orderbook?.no?.[0] ? 100 - ob.orderbook.no[0][0] : 0; const ak = vault.getKey("kalshi_api_key");
  // Listen for trade suggestions from arbitrage module
  useEffect(() => {
    const handler = (e) => {
      const s = e.detail;
      if (!s) return;
      setConfirming(false);
      if (s.paired) {
        // Paired arb trade — show both legs
        setPairedTrade(s);
        setQty(s.qty || "10");
        setSt({ t: "info", m: `⚡ Arbitrage: ${s.type.replace(/_/g, " ")} — ${s.desc?.slice(0, 80) || "Buy both sides simultaneously"}` });
      } else {
        // Single trade
        setPairedTrade(null);
        if (s.side) setSide(s.side);
        if (s.action) setAction(s.action);
        if (s.price) setPrice(s.price);
        if (s.qty) setQty(s.qty);
        setSt({ t: "info", m: `Pre-filled: ${s.action} ${s.qty}×${s.side} @${s.price}¢` + (s.desc ? ` — ${s.desc.slice(0, 60)}` : "") });
      }
    };
    window.addEventListener("tradeSuggest", handler);
    return () => window.removeEventListener("tradeSuggest", handler);
  }, []);
  const submit = async () => {
    if (!mkt?.ticker) return setSt({ t: "error", m: "No market selected — click a market from the Odds or Arbitrage tab first" });
    if (!ak) return setSt({ t: "error", m: "No API key — go to the 🔐 Key Vault tab and add your Kalshi API key" });
    const pk = vault.getKey("kalshi_private_key");
    if (!pk) return setSt({ t: "error", m: "No RSA private key — add your Kalshi private key (PEM format) in the 🔐 Key Vault tab. You need both the API Key ID and the Private Key to trade." });
    const p = parseInt(price), q2 = parseInt(qty);
    if (!p || !q2 || p < 1 || p > 99 || q2 < 1) return setSt({ t: "error", m: "Price must be 1-99¢, quantity must be ≥ 1" });
    if (!confirming) { setConfirming(true); return; }
    setConfirming(false);
    setSt({ t: "pending", m: "Signing request & placing order..." });
    try {
      const orderBody = { ticker: mkt.ticker, side, action, type: ot, count: q2, ...(side === "yes" ? { yes_price: p } : { no_price: p }), ...(po ? { post_only: true } : {}) };
      const data = await kalshiAuthFetch(ORDERS_V2_PATH, "POST", toV2Order(orderBody), ak, pk);
      setSt({ t: "success", m: `✓ Order placed: ${orderIdOf(data)?.slice(0, 16) || "OK"}` });
      // Auto-export to Obsidian if connected
      if (obsidianVault.connected) {
        obsidianVault.exportTradeLog({ ticker: mkt.ticker, action, side, price: p, qty: q2, orderId: orderIdOf(data) }).catch(e => console.warn("[Obsidian] Trade log failed:", e));
      }
      setLog(prev => [{ time: new Date().toLocaleTimeString(), side, action, price: p, qty: q2, id: orderIdOf(data) }, ...prev].slice(0, 25));
      vault.showToast(`Order placed: ${action} ${q2}×${side} @${p}¢`);
    } catch (e) {
      const msg = e.message || "Unknown error";
      const friendly = msg.includes("Failed to generate") ? msg
        : msg.includes("signature") || msg.includes("pkcs") ? "RSA signing failed — check that your private key in Key Vault is correct PEM format"
        : msg.includes("token_authentication") ? "Auth failed — API key may be expired. Generate a new one at kalshi.com → Settings → API Keys"
        : msg.includes("insufficient_balance") ? "Insufficient balance in your Kalshi account. Deposit funds at kalshi.com"
        : msg.includes("market_not_active") ? "This market is closed or not active for trading"
        : msg.includes("post only cross") ? "Post-only order would cross the market. Adjust your price or disable post-only."
        : `Trade error: ${msg}`;
      setSt({ t: "error", m: friendly });
    }
  };
  return <div style={{ ...S.panel, height: "100%" }}><div style={S.hdr}><span style={S.title}>💹 Trade</span><HelpTip id="trade" />{mkt && <span style={{ fontSize: 10, color: "#3a4f6f", ...S.m }}>{mkt.ticker}</span>}</div><div style={{ flex: 1, overflow: "auto", padding: 18 }}>{!mkt ? <Empty icon="💹" text="Select a market" /> : <>
          {/* PAIRED ARBITRAGE TRADE */}
          {pairedTrade && <div style={{ background: "#f59e0b08", border: "1px solid #f59e0b25", borderRadius: 8, padding: "14px 16px", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Badge c="#f59e0b" glow>⚡ PAIRED ARB</Badge>
              <span style={{ fontSize: 11, color: "#c8d6e5", fontWeight: 700 }}>{pairedTrade.type?.replace(/_/g, " ")}</span>
              {pairedTrade.edge && <Badge c="#00e8a4">{pairedTrade.edge.toFixed(1)}% EDGE</Badge>}
            </div>
            <div style={{ fontSize: 10, color: "#7a8faa", marginBottom: 10, lineHeight: 1.5 }}>{pairedTrade.desc}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <div style={{ background: "#070c17", borderRadius: 6, padding: "10px 12px", border: "1px solid #00e8a420" }}>
                <div style={{ fontSize: 9, color: "#00e8a4", fontWeight: 700, marginBottom: 4 }}>LEG 1: {pairedTrade.leg1?.action?.toUpperCase() || "BUY"} {pairedTrade.leg1?.side?.toUpperCase() || "YES"}</div>
                <div style={{ fontSize: 11, color: "#c8d6e5", ...S.m, marginBottom: 2 }}>{pairedTrade.leg1?.ticker}</div>
                <div style={{ fontSize: 10, color: "#5a6f8f" }}>{pairedTrade.leg1?.title}</div>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#00e8a4", ...S.m, marginTop: 4 }}>@{pairedTrade.leg1?.price}¢</div>
              </div>
              <div style={{ background: "#070c17", borderRadius: 6, padding: "10px 12px", border: "1px solid #00e8a420" }}>
                <div style={{ fontSize: 9, color: "#00e8a4", fontWeight: 700, marginBottom: 4 }}>LEG 2: {pairedTrade.leg2?.action?.toUpperCase() || "BUY"} {pairedTrade.leg2?.side?.toUpperCase() || "YES"}</div>
                <div style={{ fontSize: 11, color: "#c8d6e5", ...S.m, marginBottom: 2 }}>{pairedTrade.leg2?.ticker}</div>
                <div style={{ fontSize: 10, color: "#5a6f8f" }}>{pairedTrade.leg2?.title}</div>
                <div style={{ fontSize: 14, fontWeight: 800, color: "#00e8a4", ...S.m, marginTop: 4 }}>@{pairedTrade.leg2?.price}¢</div>
              </div>
            </div>
            <div style={{ background: "#060a14", borderRadius: 6, padding: "10px 14px", marginBottom: 10, border: "1px solid #14203a" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#5a6f8f", marginBottom: 4 }}>
                <span>Contract Cost (both legs × {qty || 10})</span>
                <span style={{ color: "#eaf0f6", ...S.m, fontWeight: 700 }}>
                  ${(((parseInt(pairedTrade.leg1?.price)||0) + (parseInt(pairedTrade.leg2?.price)||0)) * (parseInt(qty)||10) / 100).toFixed(2)}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#5a6f8f", marginBottom: 4 }}>
                <span>Kalshi Fees (taker)</span>
                <span style={{ color: "#f59e0b", ...S.m, fontWeight: 700 }}>
                  ${(kalshiFee(parseInt(pairedTrade.leg1?.price)||0, parseInt(qty)||10) + kalshiFee(parseInt(pairedTrade.leg2?.price)||0, parseInt(qty)||10)).toFixed(2)}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#5a6f8f", marginBottom: 4 }}>
                <span>Guaranteed Payout</span>
                <span style={{ color: "#00e8a4", ...S.m, fontWeight: 700 }}>${(parseInt(qty)||10).toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                <span style={{ color: "#5a6f8f" }}>Net Profit (after fees)</span>
                {(() => {
                  const q = parseInt(qty)||10;
                  const p1 = parseInt(pairedTrade.leg1?.price)||0;
                  const p2 = parseInt(pairedTrade.leg2?.price)||0;
                  const cost = (p1 + p2) * q / 100;
                  const fees = kalshiFee(p1, q) + kalshiFee(p2, q);
                  const profit = q - cost - fees;
                  return <span style={{ color: profit > 0 ? "#00e8a4" : "#ef4444", fontWeight: 800, ...S.m }}>
                    {profit > 0 ? "+" : ""}${profit.toFixed(2)} {profit <= 0 && "(NOT PROFITABLE)"}
                  </span>;
                })()}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <div><div style={{ fontSize: 9, color: "#3a4f6f", marginBottom: 4, fontWeight: 700 }}>QUANTITY (EACH LEG)</div>
              <input type="number" value={qty} onChange={e => setQty(e.target.value)} style={{ ...S.inp, fontSize: 14, fontWeight: 600, width: 100 }} /></div>
            </div>
            <button onClick={async () => {
              const pk = vault.getKey("kalshi_private_key");
              if (!ak || !pk) { setSt({ t: "error", m: "Add both API Key and RSA Private Key in 🔐 Key Vault to trade" }); return; }
              const q = parseInt(qty) || 10;
              setSt({ t: "pending", m: "Placing both legs simultaneously..." });
              try {
                const [r1, r2] = await Promise.all([
                  kalshiAuthFetch(ORDERS_V2_PATH, "POST", toV2Order({ ticker: pairedTrade.leg1.ticker, side: "yes", action: "buy", type: "limit", count: q, yes_price: parseInt(pairedTrade.leg1.price) }), ak, pk),
                  kalshiAuthFetch(ORDERS_V2_PATH, "POST", toV2Order({ ticker: pairedTrade.leg2.ticker, side: "yes", action: "buy", type: "limit", count: q, yes_price: parseInt(pairedTrade.leg2.price) }), ak, pk),
                ]);
                setSt({ t: "success", m: "✓ Both legs placed! Leg1: " + (orderIdOf(r1)?.slice(0,12)||"OK") + " Leg2: " + (orderIdOf(r2)?.slice(0,12)||"OK") });
                setLog(prev => [
                  { time: new Date().toLocaleTimeString(), side: "yes", action: "buy", price: parseInt(pairedTrade.leg1.price), qty: q, id: orderIdOf(r1) },
                  { time: new Date().toLocaleTimeString(), side: "yes", action: "buy", price: parseInt(pairedTrade.leg2.price), qty: q, id: orderIdOf(r2) },
                  ...prev].slice(0, 25));
                vault.showToast("Arbitrage paired trade executed!");
              } catch (e) { setSt({ t: "error", m: "Paired trade error: " + e.message }); }
            }} style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", fontSize: 13, fontWeight: 800, cursor: "pointer", ...S.m, letterSpacing: "1px", background: "linear-gradient(135deg, #f59e0b, #d97706)", color: "#050910" }}>
              ⚡ EXECUTE BOTH LEGS ({qty || 10} × 2 orders)
            </button>
            <button onClick={() => setPairedTrade(null)} style={{ width: "100%", padding: 6, borderRadius: 6, border: "1px solid #14203a", background: "transparent", color: "#5a6f8f", fontSize: 10, cursor: "pointer", marginTop: 6, ...S.m }}>CANCEL PAIRED TRADE</button>
          </div>}
          {/* SINGLE ORDER FORM */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}><button onClick={() => { setPrice(String(bb)); setSide("yes"); setAction("buy"); }} style={{ flex: 1, background: "#00e8a408", border: "1px solid #00e8a420", borderRadius: 6, padding: 8, color: "#00e8a4", fontSize: 11, cursor: "pointer", fontWeight: 700, ...S.m }}>BID {bb}¢</button><button onClick={() => { setPrice(String(ba)); setSide("yes"); setAction("sell"); }} style={{ flex: 1, background: "#ef444408", border: "1px solid #ef444420", borderRadius: 6, padding: 8, color: "#ef4444", fontSize: 11, cursor: "pointer", fontWeight: 700, ...S.m }}>ASK {ba}¢</button></div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>{[{ l: "SIDE", opts: ["yes", "no"], v: side, s: setSide }, { l: "ACTION", opts: ["buy", "sell"], v: action, s: setAction }].map(g => <div key={g.l}><div style={{ fontSize: 9, color: "#3a4f6f", marginBottom: 4, fontWeight: 700 }}>{g.l}</div><div style={{ display: "flex", gap: 4 }}>{g.opts.map(o => <button key={o} onClick={() => g.s(o)} style={{ flex: 1, padding: 7, borderRadius: 5, fontSize: 11, fontWeight: 800, cursor: "pointer", ...S.m, background: g.v === o ? (o === "yes" || o === "buy" ? "#00e8a418" : "#ef444418") : "#060a14", border: `1px solid ${g.v === o ? (o === "yes" || o === "buy" ? "#00e8a4" : "#ef4444") : "#14203a"}`, color: g.v === o ? (o === "yes" || o === "buy" ? "#00e8a4" : "#ef4444") : "#3a4f6f" }}>{o.toUpperCase()}</button>)}</div></div>)}</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>{[{ l: "PRICE (¢)", v: price, s: setPrice }, { l: "QTY", v: qty, s: setQty }].map(f => <div key={f.l}><div style={{ fontSize: 9, color: "#3a4f6f", marginBottom: 4, fontWeight: 700 }}>{f.l}</div><input type="number" value={f.v} onChange={e => f.s(e.target.value)} style={{ ...S.inp, fontSize: 14, fontWeight: 600 }} /></div>)}</div><div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "end" }}><div style={{ flex: 1 }}><div style={{ fontSize: 9, color: "#3a4f6f", marginBottom: 4, fontWeight: 700 }}>TYPE</div><select value={ot} onChange={e => setOt(e.target.value)} style={S.inp}><option value="limit">LIMIT</option><option value="market">MARKET</option></select></div><label style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 0", cursor: "pointer" }}><input type="checkbox" checked={po} onChange={e => setPo(e.target.checked)} /><span style={{ fontSize: 10, color: "#3a4f6f" }}>POST ONLY</span></label></div>{price && qty && <div style={{ background: "#060a14", borderRadius: 6, padding: "10px 14px", marginBottom: 14, border: "1px solid #14203a" }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#5a6f8f", marginBottom: 4 }}><span>Cost</span><span style={{ color: "#eaf0f6", ...S.m, fontWeight: 700 }}>${((parseInt(price) * parseInt(qty)) / 100).toFixed(2)}</span></div><div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#5a6f8f" }}><span>Payout if win</span><span style={{ color: "#00e8a4", ...S.m, fontWeight: 700 }}>${(parseInt(qty)||0).toFixed(2)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4 }}><span style={{ color: "#5a6f8f" }}>Profit if win</span><span style={{ color: "#00e8a4", ...S.m, fontWeight: 700 }}>+${((parseInt(qty)||0) - (parseInt(price)||0) * (parseInt(qty)||0) / 100).toFixed(2)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 2 }}><span style={{ color: "#5a6f8f" }}>Loss if wrong</span><span style={{ color: "#ef4444", ...S.m, fontWeight: 700 }}>-${((parseInt(price)||0) * (parseInt(qty)||0) / 100).toFixed(2)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4, paddingTop: 4, borderTop: "1px solid #14203a" }}><span style={{ color: "#5a6f8f" }}>Break-even</span><span style={{ color: "#c8d6e5", ...S.m, fontWeight: 700 }}>{parseInt(price)||0}% probability</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 2 }}><span style={{ color: "#5a6f8f" }}>Return if win</span><span style={{ color: "#00e8a4", ...S.m, fontWeight: 700 }}>{(parseInt(price)||0) > 0 ? ((100/(parseInt(price)||1) - 1) * 100).toFixed(0) : 0}%</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4, paddingTop: 4, borderTop: "1px solid #14203a" }}><span style={{ color: "#f59e0b" }}>Kalshi Fee (taker)</span><span style={{ color: "#f59e0b", ...S.m, fontWeight: 700 }}>${kalshiFee(parseInt(price)||0, parseInt(qty)||1).toFixed(2)}</span></div>
              {((parseInt(price) || 0) * (parseInt(qty) || 0)) / 100 > (settings?.["trade.maxCostDollars"] ?? 50) && <div style={{ marginTop: 4, padding: "4px 8px", background: "#1a1206", border: "1px solid #f59e0b40", borderRadius: 4, fontSize: 10, color: "#f59e0b" }}>⚠ Order cost exceeds your ${settings?.["trade.maxCostDollars"] ?? 50} warning threshold (⚙️ Settings → Trading Defaults)</div>}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 2 }}><span style={{ color: "#5a6f8f" }}>Net Profit (after fee)</span><span style={{ color: ((parseInt(qty)||0) - ((parseInt(price)||0) * (parseInt(qty)||0) / 100) - kalshiFee(parseInt(price)||0, parseInt(qty)||1)) > 0 ? "#00e8a4" : "#ef4444", ...S.m, fontWeight: 700 }}>${((parseInt(qty)||0) - ((parseInt(price)||0) * (parseInt(qty)||0) / 100) - kalshiFee(parseInt(price)||0, parseInt(qty)||1)).toFixed(2)}</span></div>
              </div>}<button onClick={submit} style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", fontSize: 13, fontWeight: 800, cursor: "pointer", ...S.m, letterSpacing: "1px", background: confirming ? "linear-gradient(135deg,#f59e0b,#d97706)" : action === "buy" ? "linear-gradient(135deg,#00e8a4,#00c48c)" : "linear-gradient(135deg,#ef4444,#dc2626)", color: confirming ? "#050910" : action === "buy" ? "#050910" : "#fff" }}>{confirming ? `⚠️ CONFIRM: ${action.toUpperCase()} ${qty} ${side.toUpperCase()} @ ${price}¢ ($${((parseInt(price)||0) * (parseInt(qty)||0) / 100).toFixed(2)})` : `${action.toUpperCase()} ${qty || 0} ${side.toUpperCase()} @ ${price || 0}¢`}</button>{confirming && <button onClick={() => setConfirming(false)} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #14203a", background: "transparent", color: "#5a6f8f", fontSize: 11, cursor: "pointer", marginTop: 6, ...S.m }}>CANCEL</button>}{st && <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, fontSize: 11, ...S.m, background: st.t === "success" ? "#00e8a410" : st.t === "error" ? "#ef444410" : "#f59e0b10", color: st.t === "success" ? "#00e8a4" : st.t === "error" ? "#ef4444" : "#f59e0b" }}>{st.m}</div>}{log.length > 0 && <div style={{ marginTop: 14 }}><div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 700, marginBottom: 6 }}>LOG</div>{log.map((o, i) => <div key={i} style={{ fontSize: 10, color: "#5a6f8f", padding: "3px 0", borderBottom: "1px solid #0a0f1a", ...S.m }}>{o.time} │ {o.action.toUpperCase()} {o.qty}×{o.side.toUpperCase()} @{o.price}¢</div>)}</div>}</>}</div></div>; }

function BotModule({ mkt, trades, ld }) { const [on, setOn] = useState(false); const [alerts, setAlerts] = useState([]); useEffect(() => { if (on && trades?.length) { const a = analyzeTrades(trades); if (a.length) setAlerts(p => [...a.map(x => ({ ...x, time: new Date(), ticker: mkt?.ticker })), ...p].slice(0, 40)); } }, [trades, on, mkt]);
  return <div style={{ ...S.panel, height: "100%" }}><div style={S.hdr}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={S.title}>🤖 Bot Scan</span><HelpTip id="bot" />{alerts.length > 0 && <Badge c="#ef4444" glow>{alerts.length}</Badge>}</div><button onClick={() => setOn(!on)} style={{ background: on ? "#ef444415" : "#00e8a415", border: `1px solid ${on ? "#ef444440" : "#00e8a440"}`, borderRadius: 6, padding: "5px 14px", color: on ? "#ef4444" : "#00e8a4", fontSize: 10, fontWeight: 800, cursor: "pointer", ...S.m }}>{on ? "⏹ STOP" : "▶ MONITOR"}</button></div><div style={{ flex: 1, overflow: "auto" }}>{alerts.length > 0 && <div style={{ padding: "10px 16px", borderBottom: "1px solid #14203a" }}><div style={{ fontSize: 9, color: "#ef4444", fontWeight: 800, letterSpacing: 1, marginBottom: 8 }}>⚡ ALERTS</div>{alerts.slice(0, 8).map((a, i) => { const p = BOT_PATTERNS[a.type]; return <div key={i} style={{ background: `${p.color}06`, border: `1px solid ${p.color}20`, borderRadius: 8, padding: "10px 14px", marginBottom: 8 }}><div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Pulse color={p.color} /><span style={{ fontSize: 13, fontWeight: 800, color: p.color }}>{p.name}</span><Badge c={p.color}>{a.confidence}%</Badge></div><span style={{ fontSize: 9, color: "#3a4f6f", ...S.m }}>{a.ticker}</span></div><div style={{ fontSize: 10, color: "#5a6f8f", marginBottom: 6 }}>{p.desc}</div><div style={{ fontSize: 10, color: "#f59e0b", background: "#f59e0b08", borderRadius: 6, padding: "6px 10px", border: "1px solid #f59e0b15", lineHeight: 1.5 }}><strong>⚔️</strong> {p.strategy}</div></div>; })}</div>}<div style={{ padding: "10px 16px", borderBottom: "1px solid #14203a" }}><div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1, marginBottom: 8 }}>PATTERNS</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>{Object.entries(BOT_PATTERNS).map(([k, p]) => <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "#070c17", borderRadius: 4 }}><div style={{ width: 7, height: 7, borderRadius: "50%", background: p.color, flexShrink: 0 }} /><div><div style={{ fontSize: 10, color: "#c8d6e5", fontWeight: 700 }}>{p.name}</div><div style={{ fontSize: 9, color: "#3a4f6f" }}>{p.desc.slice(0, 40)}…</div></div></div>)}</div></div><div style={{ padding: "10px 16px" }}><div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1, marginBottom: 8 }}>TAPE{mkt ? ` — ${mkt.ticker}` : ""}</div>{ld ? <div style={{ color: "#3a4f6f", fontSize: 11 }}>Loading...</div> : !trades?.length ? <Empty icon="📡" text={mkt ? "No trades" : "Select market"} /> : trades.slice(0, 35).map((t, i) => <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px solid #070c17", fontSize: 10, ...S.m }}><span style={{ color: "#3a4f6f", width: 65 }}>{new Date(t.created_time).toLocaleTimeString()}</span><Badge c={t.taker_side === "yes" ? "#00e8a4" : "#ef4444"} sm>{t.taker_side || "—"}</Badge><span style={{ color: "#eaf0f6", fontWeight: 700, width: 35, textAlign: "right" }}>{t.yes_price}¢</span><span style={{ color: "#3a4f6f", width: 35, textAlign: "right" }}>×{t.count}</span></div>)}</div></div></div>; }

// ═══════════════════════════════════════════════════════════════
// MULTI-SPORTSBOOK ODDS ENGINE
// The Odds API aggregates 15+ sportsbooks (free 500 req/month)
// Falls back to Kalshi internal arbitrage when no key is set
// ═══════════════════════════════════════════════════════════════
const ODDS_API_BASE = "/oddsapi/v4";
const ODDS_SPORTS = [
  { key: "basketball_nba", label: "NBA", kalshiPrefix: ["KXNBAGAME", "KXNBASPREAD"] },
  { key: "basketball_ncaab", label: "NCAAB", kalshiPrefix: ["KXNCAAMBGAME", "KXNCAAMBSPREAD"] },
  { key: "americanfootball_nfl", label: "NFL", kalshiPrefix: ["KXNFLGAME", "KXNFLSPREAD"] },
  { key: "icehockey_nhl", label: "NHL", kalshiPrefix: ["KXNHLGAME", "KXNHLTOTAL"] },
  { key: "baseball_mlb", label: "MLB", kalshiPrefix: ["KXMLBGAME", "KXMLBTOTAL"] },
  { key: "soccer_epl", label: "EPL", kalshiPrefix: ["KXEPLGAME"] },
  { key: "soccer_spain_la_liga", label: "La Liga", kalshiPrefix: ["KXLALIGAGAME"] },
  { key: "soccer_germany_bundesliga", label: "Bundesliga", kalshiPrefix: ["KXBUNDESLIGAGAME"] },
  { key: "soccer_usa_mls", label: "MLS", kalshiPrefix: ["KXMLSGAME"] },
  { key: "soccer_uefa_champs_league", label: "UCL", kalshiPrefix: ["KXUCLGAME"] },
  { key: "mma_mixed_martial_arts", label: "UFC", kalshiPrefix: ["KXUFCFIGHT"] },
];

async function fetchSportsbookOdds(apiKey) {
  if (!apiKey) { console.log("[Odds API] No key set — using Kalshi internal arb only"); return []; }
  console.log(`[Odds API v${APP_VERSION}] Fetching from The Odds API across ${ODDS_SPORTS.length} sports...`);
  const allOdds = [];
  const results = await Promise.allSettled(
    ODDS_SPORTS.map(s => safeFetch(`${ODDS_API_BASE}/sports/${s.key}/odds/?apiKey=${apiKey}&regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american`))
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      r.value.forEach(ev => { allOdds.push({ ...ev, sportLabel: ODDS_SPORTS[i].label, kalshiPrefixes: ODDS_SPORTS[i].kalshiPrefix }); });
    }
  });
  console.log(`[Odds API] Fetched ${allOdds.length} events with sportsbook odds`);
  return allOdds;
}

// ═══ ARBITRAGE + TRADE SUGGESTIONS ENGINE ═══
// Detection logic lives in src/engine/ (arbitrage.js, equivalence.js,
// scanner.js, fees.js, suggestions.js) so it is unit-testable under Vitest.

function ArbModule({ espn, kalshi, sbOdds = [], settings = defaultSettings(), onRefreshOdds, onSel, onTradeSuggest }) {
  const vault = useVault();
  const [view, setView] = useState("arb");
  const [refreshKey, setRefreshKey] = useState(0);
  const oddsKey = vault.getKey("the_odds_api");
  const [minEdge, setMinEdge] = useState(0);
  const [maxEdge, setMaxEdge] = useState(100);
  const [sportFilter, setSportFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [savedFilters, setSavedFilters] = useState(() => { try { return JSON.parse(sessionStorage.getItem("kalshi_arb_filters") || "[]"); } catch { return []; } });
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [filterName, setFilterName] = useState("");
  const [selectedBooks, setSelectedBooks] = useState(null); // null = all books

  // Sportsbook odds are fetched at Dashboard level (shared with the
  // Exclusive tab and the always-on signal journal) and passed in.
  const opps = useMemo(() => findArbOpportunities(kalshi, espn, sbOdds, engineOpts(settings)), [kalshi, espn, sbOdds, settings, refreshKey]);
  const volNew = useMemo(() => findVolatileAndNew(kalshi), [kalshi]);
  const volOut = useMemo(() => findVolumeOutliers(kalshi, volumeOpts(settings)), [kalshi, settings]);
  const sigColors = { "STRONG BUY": "#00e8a4", "BUY": "#00e8a4", "LEAN BUY": "#3bba7e", "FADE": "#f472b6", "WATCH": "#f59e0b", "MONITOR": "#5a6f8f", "REVIEW": "#e879f9" };

  // Real-time diff: track which opportunities appeared or improved since the
  // last scan so genuinely NEW edges stand out instead of the whole list
  // re-flashing on every refresh.
  const trackerRef = useRef(null);
  if (!trackerRef.current) trackerRef.current = new OpportunityTracker();
  trackerRef.current.improveThresholdCents = settings["alerts.improveThreshold"];
  const [alertFeed, setAlertFeed] = useState([]);
  useEffect(() => {
    const { fresh, improved } = trackerRef.current.ingest(opps);
    if (!fresh.length && !improved.length) return;
    const entries = [...fresh.map(o => ({ o, kind: "NEW" })), ...improved.map(o => ({ o, kind: "IMPROVED" }))].map(x => ({ ...x, time: Date.now() }));
    setAlertFeed(prev => [...entries, ...prev].slice(0, 30));
    const hot = [...fresh, ...improved].filter(o => o.type === "GUARANTEED" || (o.type === "EQUIVALENT" && o.fees?.profitable));
    if (hot.length) vault.showToast(`🔥 New locked-profit opportunity: ${hot[0].game}`);
  }, [opps]);

  // Sport categories from opportunities
  const arbSports = useMemo(() => { const c = {}; opps.forEach(o => { const s = (o.sport || "").replace(/^KX/,"").replace(/GAME|SPREAD|TOTAL|MATCH|FIGHT/gi,"").slice(0,8) || "Other"; c[s] = (c[s]||0)+1; }); return c; }, [opps]);
  // Apply filters
  const filtered = useMemo(() => opps.filter(o => {
    if (!o.edge || isNaN(o.edge) || !isFinite(o.edge)) return false;
    if (o.edge < minEdge || o.edge > maxEdge) return false;
    if (selectedBooks && o.bookmaker && !selectedBooks.has(o.bookmaker)) return false;
    if (typeFilter !== "ALL" && o.type !== typeFilter) return false;
    if (sportFilter !== "ALL") { const s = (o.sport||"").replace(/^KX/,"").replace(/GAME|SPREAD|TOTAL|MATCH|FIGHT/gi,"").slice(0,8)||"Other"; if (s !== sportFilter) return false; }
    return true;
  }), [opps, minEdge, maxEdge, sportFilter, typeFilter]);
  const bookmakers = [...new Set(sbOdds.flatMap(e => (e.bookmakers || []).map(b => b.title || b.key)))];

  const saveFilter = () => { if (!filterName.trim()) return; const p = { name: filterName.trim(), minEdge, maxEdge, sportFilter, typeFilter }; const n = [...savedFilters, p]; setSavedFilters(n); try { sessionStorage.setItem("kalshi_arb_filters", JSON.stringify(n)); } catch {} setFilterName(""); setShowFilterMenu(false); vault.showToast(`Filter "${p.name}" saved`); };
  const loadFilter = (p) => { setMinEdge(p.minEdge); setMaxEdge(p.maxEdge); setSportFilter(p.sportFilter); setTypeFilter(p.typeFilter); setShowFilterMenu(false); };
  const deleteFilter = (idx) => { const n = savedFilters.filter((_,i)=>i!==idx); setSavedFilters(n); try { sessionStorage.setItem("kalshi_arb_filters", JSON.stringify(n)); } catch {} };

  const handleTrade = (opp) => {
    if (!opp.markets?.length) return;
    onSel(opp.markets[0]);
    if (onTradeSuggest) {
      // EQUIVALENT locks carry explicit legs (buy YES cheap + buy NO rich)
      if (opp.type === "EQUIVALENT" && opp.legs?.length === 2) {
        onTradeSuggest({
          paired: true,
          type: opp.type,
          leg1: { ticker: opp.legs[0].ticker, side: opp.legs[0].side, action: opp.legs[0].action, price: String(opp.legs[0].price), title: opp.legs[0].title },
          leg2: { ticker: opp.legs[1].ticker, side: opp.legs[1].side, action: opp.legs[1].action, price: String(opp.legs[1].price), title: opp.legs[1].title },
          qty: String(settings["trade.defaultQty"]),
          desc: opp.desc,
          edge: opp.edge,
        });
        return;
      }
      // For GUARANTEED/NEAR_ARB: send both legs
      if ((opp.type === "GUARANTEED" || opp.type === "NEAR_ARB") && opp.markets.length >= 2) {
        const useNO = opp.bestMethod === "SELL NO";
        onTradeSuggest({
          paired: true,
          type: opp.type,
          leg1: { ticker: opp.markets[0].ticker, side: useNO ? "no" : "yes", action: useNO ? "sell" : "buy", price: String(useNO ? (100 - opp.markets[0].yes_ask) : opp.markets[0].yes_ask || ""), title: opp.markets[0].title },
          leg2: { ticker: opp.markets[1].ticker, side: useNO ? "no" : "yes", action: useNO ? "sell" : "buy", price: String(useNO ? (100 - opp.markets[1].yes_ask) : opp.markets[1].yes_ask || ""), title: opp.markets[1].title },
          qty: String(settings["trade.defaultQty"]),
          desc: opp.desc,
          edge: opp.edge,
        });
      } else {
        // Single-leg trade
        onTradeSuggest({
          paired: false,
          side: opp.suggestedSide || "yes",
          action: opp.suggestedAction || (opp.action?.includes("BUY") ? "buy" : "sell"),
          price: String(opp.suggestedPrice || opp.markets[0]?.yes_ask || ""),
          qty: String(settings["trade.defaultQty"]),
          desc: opp.desc,
        });
      }
    }
  };
  const refresh = () => { onRefreshOdds?.(); setRefreshKey(r => r + 1); vault.showToast("Rescanning..."); };

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, flexDirection: "column", gap: 8, alignItems: "stretch" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={S.title}>⚡ Arbitrage & Signals</span><HelpTip id="arb" />{filtered.length > 0 && <Badge c="#f59e0b" glow>{filtered.length}</Badge>}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <button onClick={() => setShowFilterMenu(!showFilterMenu)} style={{ background: "#14203a30", border: "1px solid #14203a", borderRadius: 6, padding: "5px 10px", color: "#7a8faa", fontSize: 10, cursor: "pointer", ...S.m }}>📋 FILTERS {savedFilters.length > 0 ? `(${savedFilters.length})` : ""}</button>
              {showFilterMenu && <div style={{ position: "absolute", top: "100%", right: 0, width: 280, background: "#0d1320", border: "1px solid #14203a", borderRadius: 8, padding: 12, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", animation: "fadeIn 0.15s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><span style={{ fontSize: 10, color: "#5a6f8f", fontWeight: 700 }}>SAVED FILTERS</span><button onClick={() => setShowFilterMenu(false)} style={{ background: "none", border: "none", color: "#5a6f8f", cursor: "pointer", fontSize: 12 }}>✕</button></div>
                {savedFilters.length === 0 ? <div style={{ fontSize: 10, color: "#3a4f6f" }}>No saved filters yet</div> : savedFilters.map((f, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #14203a" }}>
                    <button onClick={() => loadFilter(f)} style={{ background: "none", border: "none", color: "#c8d6e5", fontSize: 11, cursor: "pointer", flex: 1, textAlign: "left" }}>{f.name} <span style={{ color: "#3a4f6f" }}>({f.minEdge}-{f.maxEdge}%)</span></button>
                    <button onClick={() => deleteFilter(i)} style={{ background: "none", border: "none", color: "#ef4444", fontSize: 10, cursor: "pointer" }}>✕</button>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                  <input value={filterName} onChange={e => setFilterName(e.target.value)} placeholder="Name this filter..." style={{ ...S.inp, fontSize: 10, padding: "4px 8px", flex: 1 }} onKeyDown={e => e.key === "Enter" && saveFilter()} />
                  <button onClick={saveFilter} style={{ background: "#00e8a420", border: "1px solid #00e8a430", borderRadius: 4, padding: "4px 8px", color: "#00e8a4", fontSize: 9, cursor: "pointer", fontWeight: 700 }}>SAVE</button>
                </div>
              </div>}
            </div>
            <button onClick={refresh} style={{ background: "linear-gradient(135deg,#f59e0b,#d97706)", border: "none", borderRadius: 6, padding: "5px 12px", color: "#050910", fontSize: 10, fontWeight: 800, cursor: "pointer", ...S.m }}>⟳ REFRESH</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <TBtn active={view === "arb"} onClick={() => setView("arb")} color="#f59e0b">ARBITRAGE ({filtered.length})</TBtn>
          <TBtn active={view === "top"} onClick={() => setView("top")} color="#00e8a4">TOP 20 LIQUID</TBtn>
          <TBtn active={view === "volatile"} onClick={() => setView("volatile")} color="#ef4444">VOLATILE ({volNew.volatile.length})</TBtn>
          <TBtn active={view === "volume"} onClick={() => setView("volume")} color="#e8c547">VOLUME ({volOut.high.length + volOut.dead.length})</TBtn>
          <TBtn active={view === "new"} onClick={() => setView("new")} color="#6366f1">NEW ({volNew.newMarkets.length})</TBtn>
        </div>
        {view === "arb" && <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700 }}>EDGE:</span>
          <input type="number" value={minEdge} onChange={e => setMinEdge(Number(e.target.value)||0)} style={{ ...S.inp, width: 48, padding: "3px 6px", fontSize: 10, textAlign: "center" }} />
          <span style={{ color: "#3a4f6f", fontSize: 10 }}>–</span>
          <input type="number" value={maxEdge} onChange={e => setMaxEdge(Number(e.target.value)||100)} style={{ ...S.inp, width: 48, padding: "3px 6px", fontSize: 10, textAlign: "center" }} />
          <span style={{ color: "#3a4f6f", fontSize: 9 }}>%</span>
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700, marginLeft: 4 }}>TYPE:</span>
          {["ALL","VALUE","FRESH_SKEW","GUARANTEED","EQUIVALENT","NEAR_ARB","CROSS_MARKET","SPORTSBOOK"].map(t => <TBtn key={t} active={typeFilter===t} onClick={()=>setTypeFilter(t)} color="#6366f1">{t.replace(/_/g," ")}</TBtn>)}
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700, marginLeft: 4 }}>SPORT:</span>
          <TBtn active={sportFilter==="ALL"} onClick={()=>setSportFilter("ALL")}>ALL</TBtn>
          {Object.entries(arbSports).sort((a,b)=>b[1]-a[1]).map(([s,c])=><TBtn key={s} active={sportFilter===s} onClick={()=>setSportFilter(s)}>{s}({c})</TBtn>)}
        </div>}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {oddsKey ? <Badge c="#00e8a4" sm>{selectedBooks ? selectedBooks.size : bookmakers.length} SPORTSBOOKS</Badge> : <Badge c="#f59e0b" sm>ADD ODDS API KEY FOR 15+ BOOKS</Badge>}
          {bookmakers.length > 0 && <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => setSelectedBooks(null)} style={{ background: !selectedBooks ? "#00e8a415" : "transparent", border: `1px solid ${!selectedBooks ? "#00e8a4" : "#14203a"}`, borderRadius: 4, padding: "1px 6px", color: !selectedBooks ? "#00e8a4" : "#3a4f6f", fontSize: 9, cursor: "pointer", fontWeight: 700 }}>ALL</button>
            {bookmakers.map(b => {
              const active = !selectedBooks || selectedBooks.has(b);
              return <button key={b} onClick={() => {
                if (!selectedBooks) { const s = new Set([b]); setSelectedBooks(s); }
                else { const s = new Set(selectedBooks); if (s.has(b)) s.delete(b); else s.add(b); setSelectedBooks(s.size === 0 ? null : s.size === bookmakers.length ? null : s); }
              }} style={{ background: active ? "#14203a40" : "transparent", border: `1px solid ${active ? "#14203a" : "#0d1320"}`, borderRadius: 4, padding: "1px 6px", color: active ? "#7a8faa" : "#1e3050", fontSize: 8, cursor: "pointer" }}>{b}</button>;
            })}
          </div>}
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {view === "arb" && alertFeed.length > 0 && <div style={{ padding: "6px 16px", borderBottom: "1px solid #14203a", background: "#0a0f1a" }}>
          <div style={{ fontSize: 9, color: "#ef4444", fontWeight: 800, letterSpacing: 1, marginBottom: 3 }}>🔴 LIVE — LATEST DETECTIONS</div>
          {alertFeed.slice(0, 5).map((a, i) => (
            <div key={i} style={{ fontSize: 9, color: "#7a8faa", padding: "1px 0", fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{ color: "#3a4f6f" }}>{new Date(a.time).toLocaleTimeString()}</span>{" "}
              <Badge c={a.kind === "NEW" ? "#ef4444" : "#f59e0b"} sm>{a.kind}</Badge>{" "}
              <span style={{ color: a.o.color }}>[{a.o.type}]</span> {a.o.game} <span style={{ color: "#e8c547" }}>+{(a.o.edge || 0).toFixed(1)}</span>
            </div>
          ))}
        </div>}
        {view === "arb" && (filtered.length === 0 ? <Empty icon="⚡" text={opps.length > 0 ? `${opps.length} opportunities detected. ${filtered.length === 0 ? "All filtered out — try adjusting edge range, type, sport, or sportsbook filters above." : ""}` : "No arbitrage detected right now."} /> :
          filtered.slice(0, 50).map((opp, i) => {
            const sug = generateSuggestion(opp);
            return (
              <div key={i} style={{ padding: "12px 16px", borderBottom: "1px solid #14203a", cursor: "pointer" }}
                onClick={() => handleTrade(opp)}
                onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5, flexWrap: "wrap", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                    <Badge c={opp.color}>{opp.type.replace(/_/g, " ")}</Badge>
                    {opp.tier && <Badge c={opp.tier === "EXACT" ? "#00e8a4" : opp.tier === "LIKELY" ? "#e879f9" : "#f59e0b"} sm>{opp.tier}</Badge>}
                    {trackerRef.current.isNew(opp) && <Badge c="#ef4444" glow sm>NEW</Badge>}
                    <span title={opp.game + " — " + (opp.desc || "")} style={{ fontSize: 12, fontWeight: 700, color: "#eaf0f6" }}>{opp.game}</span>
                    <Badge c={opp.edge >= 5 ? "#ef4444" : opp.edge >= 2 ? "#f59e0b" : "#5a6f8f"} glow={opp.edge >= 4}>{opp.edge.toFixed(1)}%</Badge>
                    {opp.bookmaker && <Badge c="#00ccff" sm>{opp.bookmaker}</Badge>}
                  </div>
                  <Badge c={sigColors[sug.signal] || "#5a6f8f"} glow={sug.confidence > 70}>{sug.signal} {sug.confidence}%</Badge>
                </div>
                <div style={{ fontSize: 10, color: "#7a8faa", marginBottom: 4, lineHeight: 1.5 }}>{opp.desc}</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 10, color: "#c8d6e5", background: "#070c17", borderRadius: 4, padding: "3px 8px", ...S.m }}>{opp.action}</div>
                  <button onClick={e => { e.stopPropagation(); handleTrade(opp); }}
                    style={{ background: "#00e8a415", border: "1px solid #00e8a430", borderRadius: 5, padding: "3px 12px", color: "#00e8a4", fontSize: 10, fontWeight: 800, cursor: "pointer", ...S.m }}>TRADE →</button>
                  {obsidianVault.connected && <button onClick={async e => { e.stopPropagation(); const sug = generateSuggestion(opp); await obsidianVault.exportArbSnapshot({...opp, signal: sug.signal}); vault.showToast("Saved to Obsidian"); }}
                    style={{ background: "#6366f110", border: "1px solid #6366f125", borderRadius: 5, padding: "3px 8px", color: "#6366f1", fontSize: 9, fontWeight: 700, cursor: "pointer", ...S.m }}>📝</button>}
                  <span style={{ fontSize: 9, color: "#3a4f6f" }}>{sug.reason}</span>
                </div>
              </div>);
          })
        )}


        {view === "top" && (() => {
          const allMkts = [];
          kalshi.forEach(e => (e.markets || []).forEach(m => {
            const bid = m.yes_bid || 0, ask = m.yes_ask || 0;
            if (bid > 0 && ask > 0) allMkts.push({ ...m, eventTitle: e.title, series: e.series_ticker, spread: ask - bid, mid: (bid + ask) / 2 });
          }));
          allMkts.sort((a, b) => a.spread - b.spread || (b.volume || 0) - (a.volume || 0));
          return allMkts.length === 0 ? <Empty text="No markets loaded" /> :
            <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["Spread", "Bid/Ask", "Mid", "Vol", "Event", "Market", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{allMkts.slice(0, 20).map((m, i) => <tr key={i} style={{ cursor: "pointer" }} onClick={() => onSel(m)} onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <td style={{ ...S.td, ...S.m, color: m.spread <= 1 ? "#00e8a4" : m.spread <= 3 ? "#f59e0b" : "#ef4444", fontWeight: 700 }}>{m.spread}¢</td>
              <td style={{ ...S.td, ...S.m }}><span style={{ color: "#00e8a4" }}>{m.yes_bid}</span>/<span style={{ color: "#ef4444" }}>{m.yes_ask}</span></td>
              <td style={{ ...S.td, ...S.m, color: "#c8d6e5" }}>{m.mid.toFixed(0)}%</td>
              <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{(m.volume || 0).toLocaleString()}</td>
              <td title={m.eventTitle} style={{ ...S.td, color: "#eaf0f6", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.eventTitle}</td>
              <td title={m.title} style={{ ...S.td, color: "#7a8faa", fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</td>
              <td style={S.td}><button onClick={ev => { ev.stopPropagation(); onSel(m); }} style={{ background: "#00e8a412", border: "1px solid #00e8a430", borderRadius: 4, padding: "2px 10px", color: "#00e8a4", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>TRADE</button>
                {onFav && m.ticker && <button onClick={ev => { ev.stopPropagation(); onFav({...m, eventTitle: e.title}); }} style={{ background: isFav?.(m.ticker) ? "#f59e0b20" : "transparent", border: `1px solid ${isFav?.(m.ticker) ? "#f59e0b40" : "#14203a"}`, borderRadius: 4, padding: "2px 6px", color: isFav?.(m.ticker) ? "#f59e0b" : "#3a4f6f", fontSize: 10, cursor: "pointer" }}>{isFav?.(m.ticker) ? "★" : "☆"}</button>}
                </td>
            </tr>)}</tbody></table>;
        })()}

        {view === "volatile" && (volNew.volatile.length === 0 ? <Empty icon="📈" text="No volatile markets detected" /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["Score", "Spread", "Bid/Ask", "Mid", "Vol", "Event", "Market", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{volNew.volatile.slice(0, 30).map((m, i) => <tr key={i} style={{ cursor: "pointer" }} onClick={() => onSel(m.market)} onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <td style={{ ...S.td, ...S.m, color: "#ef4444", fontWeight: 700 }}>{m.score}</td>
            <td style={{ ...S.td, ...S.m, color: "#f59e0b" }}>{m.spread}¢</td>
            <td style={{ ...S.td, ...S.m }}><span style={{ color: "#00e8a4" }}>{m.bid}</span>/<span style={{ color: "#ef4444" }}>{m.ask}</span></td>
            <td style={{ ...S.td, ...S.m, color: "#c8d6e5" }}>{m.mid.toFixed(0)}%</td>
            <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{m.vol.toLocaleString()}</td>
            <td title={m.event} style={{ ...S.td, color: "#eaf0f6", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.event}</td>
            <td title={m.title} style={{ ...S.td, color: "#7a8faa", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</td>
            <td style={S.td}><button onClick={ev => { ev.stopPropagation(); onSel(m.market); }} style={{ background: "#ef444412", border: "1px solid #ef444430", borderRadius: 4, padding: "2px 10px", color: "#ef4444", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>TRADE</button></td>
          </tr>)}</tbody></table>
        )}

        {view === "volume" && <>
          <div style={{ padding: "10px 16px 4px", fontSize: 9, color: "#e8c547", fontWeight: 800, letterSpacing: 1 }}>🔥 HIGH VOLUME — TRADING FAR ABOVE THE SERIES MEDIAN (crowd or informed money)</div>
          {volOut.high.length === 0 ? <div style={{ padding: "4px 16px 10px", fontSize: 10, color: "#3a4f6f" }}>No high-volume outliers right now.</div> :
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["×Median", "24h Vol", "Bid/Ask", "Event", "Market", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>{volOut.high.slice(0, 20).map((r, i) => (
                <tr key={r.ticker + i} style={{ cursor: "pointer" }} onClick={() => onSel(r.market)} onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ ...S.td, ...S.m, color: "#e8c547", fontWeight: 800 }}>{r.ratio ? r.ratio.toFixed(1) + "×" : "—"}</td>
                  <td style={{ ...S.td, ...S.m, color: "#eaf0f6" }}>{r.vol.toLocaleString()}</td>
                  <td style={{ ...S.td, ...S.m }}><span style={{ color: "#00e8a4" }}>{r.bid}</span>/<span style={{ color: "#ef4444" }}>{r.ask}</span></td>
                  <td title={r.event} style={{ ...S.td, color: "#eaf0f6", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.event}</td>
                  <td title={r.title} style={{ ...S.td, color: "#7a8faa", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</td>
                  <td style={S.td}><button onClick={ev => { ev.stopPropagation(); onSel(r.market); }} style={{ background: "#e8c54712", border: "1px solid #e8c54730", borderRadius: 4, padding: "2px 10px", color: "#e8c547", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>BOOK</button></td>
                </tr>
              ))}</tbody>
            </table>}
          <div style={{ padding: "12px 16px 4px", fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1 }}>💀 DEAD VOLUME — NEAR-ZERO ACTIVITY WITH GAME TIME CLOSE (stale quotes, lazy prices)</div>
          {volOut.dead.length === 0 ? <div style={{ padding: "4px 16px 10px", fontSize: 10, color: "#3a4f6f" }}>No dead markets near game time.</div> :
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Vol", "Series Median", "Bid/Ask", "Closes", "Event", "Market", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>{volOut.dead.slice(0, 20).map((r, i) => (
                <tr key={r.ticker + i} style={{ cursor: "pointer" }} onClick={() => onSel(r.market)} onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ ...S.td, ...S.m, color: "#ef4444", fontWeight: 800 }}>{r.vol}</td>
                  <td style={{ ...S.td, ...S.m, color: "#5a6f8f" }}>{r.seriesMedian.toLocaleString()}</td>
                  <td style={{ ...S.td, ...S.m }}><span style={{ color: "#00e8a4" }}>{r.bid || "—"}</span>/<span style={{ color: "#ef4444" }}>{r.ask || "—"}</span></td>
                  <td style={{ ...S.td, ...S.m, color: "#7a8faa", fontSize: 10 }}>{fmtTime(r.close)}</td>
                  <td title={r.event} style={{ ...S.td, color: "#eaf0f6", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.event}</td>
                  <td title={r.title} style={{ ...S.td, color: "#7a8faa", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</td>
                  <td style={S.td}><button onClick={ev => { ev.stopPropagation(); onSel(r.market); }} style={{ background: "#5a6f8f12", border: "1px solid #5a6f8f30", borderRadius: 4, padding: "2px 10px", color: "#7a8faa", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>BOOK</button></td>
                </tr>
              ))}</tbody>
            </table>}
        </>}

        {view === "new" && (volNew.newMarkets.length === 0 ? <Empty icon="🆕" text="No new markets in the last 48 hours" /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>{["Age", "Bid/Ask", "Mid", "Vol", "Event", "Market", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{volNew.newMarkets.slice(0, 30).map((m, i) => <tr key={i} style={{ cursor: "pointer" }} onClick={() => onSel(m.market)} onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <td style={{ ...S.td, ...S.m, color: "#6366f1", fontWeight: 700 }}>{m.hoursOld}h</td>
            <td style={{ ...S.td, ...S.m }}><span style={{ color: "#00e8a4" }}>{m.bid}</span>/<span style={{ color: "#ef4444" }}>{m.ask}</span></td>
            <td style={{ ...S.td, ...S.m, color: "#c8d6e5" }}>{m.mid.toFixed(0)}%</td>
            <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{m.vol.toLocaleString()}</td>
            <td title={m.event} style={{ ...S.td, color: "#eaf0f6", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.event}</td>
            <td title={m.title} style={{ ...S.td, color: "#7a8faa", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</td>
            <td style={S.td}><button onClick={ev => { ev.stopPropagation(); onSel(m.market); }} style={{ background: "#6366f112", border: "1px solid #6366f130", borderRadius: 4, padding: "2px 10px", color: "#6366f1", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>TRADE</button></td>
          </tr>)}</tbody></table>
        )}

        <div style={{ padding: "12px 16px", borderTop: "1px solid #14203a" }}>
          <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>HOW SIGNALS WORK</div>
          <div style={{ fontSize: 10, color: "#5a6f8f", lineHeight: 1.7 }}>
            <strong style={{ color: "#22d3ee" }}>VALUE:</strong> Kalshi priced outside the devigged multi-sportsbook consensus — the bread-and-butter edge.{" "}
            <strong style={{ color: "#f472b6" }}>FRESH SKEW:</strong> Newly listed market at an extreme on thin volume (a 70% that relaxes to ~55% by gametime) — fade toward fair.{" "}
            <strong style={{ color: "#00e8a4" }}>GUARANTEED:</strong> Buy both YES contracts for less than $1 total = risk-free.{" "}
            <strong style={{ color: "#e879f9" }}>EQUIVALENT:</strong> Same outcome listed in two different events (e.g. "Team A wins game 7" and "Team A wins the series") priced apart — buy YES on the cheap one + NO on the rich one. EXACT = settles with this game; CONDITIONAL = verify the series state first.{" "}
            <strong style={{ color: "#6366f1" }}>CROSS-MARKET:</strong> Winner and spread markets disagree on probability.{" "}
            <strong style={{ color: "#00ccff" }}>SPORTSBOOK:</strong> Kalshi price differs from DraftKings implied odds.{" "}
            <strong style={{ color: "#f59e0b" }}>NEAR-ARB:</strong> Both-sides cost is within 3¢ of $1 — watch for it to dip below.{" "}
            Suggestions factor in edge size, market type, and confidence. This is not financial advice — prediction markets carry risk.
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// KALSHI EXCLUSIVE MARKETS — games on Kalshi but NOT on sportsbooks
// These represent unique trading opportunities with less competition
// ═══════════════════════════════════════════════════════════════
function ExclusiveModule({ kalshi, sbOdds, onSel }) {
  const [sportFilter, setSportFilter] = useState("ALL");
  const [sortBy, setSortBy] = useState("soonest");
  const [timeFilter, setTimeFilter] = useState("all");
  const [excludeTotal, setExcludeTotal] = useState(true); // Exclude Total Points markets by default
  const [focusSports, setFocusSports] = useState(new Set()); // Auto-populated from niche categories
  const [focusInitialized, setFocusInitialized] = useState(false);
  const [showFocusOnly, setShowFocusOnly] = useState(false);
  const [teamRecords, setTeamRecords] = useState({}); // Cache: ticker -> { record, streak, last10 }
  const [loadingRecords, setLoadingRecords] = useState(new Set());

  // Fetch team record from ESPN
  const fetchTeamRecord = useCallback(async (teamAbbr, sport, league) => {
    const cacheKey = `${teamAbbr}-${league}`;
    if (teamRecords[cacheKey] || loadingRecords.has(cacheKey)) return;
    setLoadingRecords(prev => new Set([...prev, cacheKey]));
    try {
      // 1. Get record from scoreboard
      const sbData = await safeFetch(`/espn/apis/site/v2/sports/${sport}/${league}/scoreboard`);
      let record = "—", teamName = teamAbbr, teamId = null;
      if (sbData?.events) {
        for (const ev of sbData.events) {
          for (const c of (ev.competitions?.[0]?.competitors || [])) {
            if (c.team?.abbreviation?.toUpperCase() === teamAbbr.toUpperCase()) {
              const overall = (c.records || []).find(r => r.name === "overall" || r.type === "total");
              record = overall?.summary || "—";
              teamName = c.team?.displayName || teamAbbr;
              teamId = c.team?.id;
              break;
            }
          }
          if (teamId) break;
        }
      }
      // 2. Get last 10 games and streak from team schedule
      let last10 = "—", streak = "—", recentGames = [];
      if (teamId) {
        const seasonType = /spring/i.test(league) || sport === "baseball" ? "&seasontype=1" : "";
        const schedData = await safeFetch(`/espn/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule?season=2026${seasonType}`);
        if (schedData?.events) {
          const results = [];
          for (const ev of schedData.events) {
            const comps = ev.competitions?.[0];
            if (comps?.status?.type?.name !== "STATUS_FINAL") continue;
            for (const c of (comps?.competitors || [])) {
              if (c.id === teamId || c.team?.id === teamId) {
                const win = c.winner === true;
                let score = c.score;
                if (typeof score === "object") score = score?.displayValue || score?.value || "?";
                const opp = (comps.competitors || []).find(x => (x.id || x.team?.id) !== teamId);
                let oppScore = opp?.score;
                if (typeof oppScore === "object") oppScore = oppScore?.displayValue || oppScore?.value || "?";
                results.push({ wl: win ? "W" : "L", score: `${score}-${oppScore}`, vs: opp?.team?.abbreviation || "?" });
              }
            }
          }
          // Last 10
          const last = results.slice(-10);
          const w = last.filter(r => r.wl === "W").length;
          const l = last.filter(r => r.wl === "L").length;
          last10 = `${w}-${l}`;
          recentGames = last;
          // Streak
          let sCount = 0, sType = null;
          for (let i = results.length - 1; i >= 0; i--) {
            if (sType === null) { sType = results[i].wl; sCount = 1; }
            else if (results[i].wl === sType) sCount++;
            else break;
          }
          streak = sType ? `${sType}${sCount}` : "—";
        }
      }
      setTeamRecords(prev => ({ ...prev, [cacheKey]: { record, teamName, last10, streak, recentGames } }));
    } catch (e) { /* silent */ }
    finally { setLoadingRecords(prev => { const s = new Set(prev); s.delete(cacheKey); return s; }); }
  }, [teamRecords, loadingRecords]);

  const sbTeamIndex = useMemo(() => {
    const index = new Set();
    (sbOdds || []).forEach(ev => {
      if (ev.home_team) index.add(ev.home_team.toLowerCase());
      if (ev.away_team) index.add(ev.away_team.toLowerCase());
      [ev.home_team, ev.away_team].forEach(t => {
        (t || "").split(/\s+/).forEach(w => { if (w.length > 3) index.add(w.toLowerCase()); });
      });
    });
    return index;
  }, [sbOdds]);

  const exclusive = useMemo(() => {
    const now = Date.now();
    return kalshi.filter(e => {
      const mkts = e.markets || [];
      if (mkts.length === 0) return false;
      const st = e.series_ticker || "";
      // Exclude total points if toggled
      if (excludeTotal && /TOTAL/i.test(st)) return false;
      
      // ALWAYS include these niche categories regardless of sportsbook coverage
      const isSpringTraining = /MLBST/i.test(st);
      const isNCAAMB = /NCAAMB/i.test(st);
      const isNCAAWB = /NCAAWB/i.test(st);
      const isNCAABB = /NCAABB/i.test(st);
      const isNCAAHockey = /NCAAHOCKEY/i.test(st);
      const isNicheCategory = isSpringTraining || isNCAAMB || isNCAAWB || isNCAABB || isNCAAHockey;
      
      if (isNicheCategory) return true; // Always show niche sports
      
      // For everything else, check sportsbook coverage
      const teams = extractTeamsFromTicker(e.event_ticker);
      if (teams.length < 2) return false;
      let onSportsbook = false;
      for (const code of teams) {
        const teamName = TEAM_CODES[code];
        if (teamName) {
          const names = teamName.split("/");
          for (const n of names) { if (sbTeamIndex.has(n.toLowerCase())) { onSportsbook = true; break; } }
        }
        if (onSportsbook) break;
      }
      const titleParts = (e.title || "").toLowerCase().split(/\s+at\s+|\s+vs\s+/).map(s => s.trim());
      for (const tp of titleParts) { if (sbTeamIndex.has(tp)) { onSportsbook = true; break; } }
      return !onSportsbook;
    }).map(e => {
      const mkts = e.markets || [];
      const m = mkts[0] || {};
      const st = e.series_ticker || "";
      let sp, isNiche = false;
      if (/MLBST/i.test(st)) { sp = "⚾ Spring Training"; isNiche = true; }
      else if (/KBO/i.test(st)) { sp = "⚾ KBO"; isNiche = true; }
      else if (/NPB/i.test(st)) { sp = "⚾ NPB"; isNiche = true; }
      else if (/MLB/i.test(st)) sp = "MLB";
      else if (/NBA/i.test(st)) sp = "NBA";
      else if (/NFL/i.test(st)) sp = "NFL";
      else if (/NHL/i.test(st)) sp = "NHL";
      else if (/NCAAMB/i.test(st)) { sp = "🏀 NCAAM"; isNiche = true; }
      else if (/NCAAWB/i.test(st)) { sp = "🏀 NCAAW"; isNiche = true; }
      else if (/NCAABB/i.test(st)) { sp = "⚾ NCAA BB"; isNiche = true; }
      else if (/NCAAHOCKEY/i.test(st)) { sp = "🏒 NCAA Hockey"; isNiche = true; }
      else if (/NCAA/i.test(st)) { sp = "NCAA"; isNiche = true; }
      else if (/SOCCER|EPL|UCL|LALIGA|BUNDES|MLS/i.test(st)) sp = "Soccer";
      else if (/UFC/i.test(st)) sp = "UFC";
      else if (/ATP|WTA|TENNIS/i.test(st)) sp = "Tennis";
      else if (/T20|IPL|CRICKET/i.test(st)) sp = "Cricket";
      else sp = "Other";
      const gameDate = parseGameDate(e.event_ticker);
      const hoursUntil = gameDate ? (gameDate.getTime() - now) / 36e5 : null;
      const teams = extractTeamsFromTicker(e.event_ticker);
      return {
        ...e, topMarket: m, sport: sp,
        bid: m.yes_bid || 0, ask: m.yes_ask || 0,
        noBid: m.no_bid || 0, noAsk: m.no_ask || 0,
        mid: ((m.yes_bid||0) + (m.yes_ask||0)) / 2,
        vol: m.volume || 0, mktCount: mkts.length,
        gameDate, hoursUntil,
        subTitle: e.sub_title || "",
        openTime: m.open_time || "",
        teamCodes: teams,
        isFocus: focusSports.has(sp),
        isNiche: isNiche || false,
        category: isNiche ? sp : "Exclusive",
      };
    });
  }, [kalshi, sbTeamIndex, excludeTotal, focusSports]);

  const sports = useMemo(() => { const c = {}; exclusive.forEach(e => { c[e.sport] = (c[e.sport]||0)+1; }); return c; }, [exclusive]);
  // Auto-set focus to all niche categories on first load
  useEffect(() => { if (!focusInitialized && exclusive.length > 0) { const niches = new Set(exclusive.filter(e => e.isNiche).map(e => e.sport)); if (niches.size > 0) { setFocusSports(niches); setFocusInitialized(true); } } }, [exclusive, focusInitialized]);

  const filtered = useMemo(() => {
    let f = exclusive;
    if (showFocusOnly) f = f.filter(e => e.isFocus);
    if (sportFilter !== "ALL") f = f.filter(e => e.sport === sportFilter);
    if (timeFilter === "24h") f = f.filter(e => e.hoursUntil !== null && e.hoursUntil <= 24 && e.hoursUntil > -6);
    else if (timeFilter === "48h") f = f.filter(e => e.hoursUntil !== null && e.hoursUntil <= 48 && e.hoursUntil > -6);
    else if (timeFilter === "7d") f = f.filter(e => e.hoursUntil !== null && e.hoursUntil <= 168 && e.hoursUntil > -6);
    if (sortBy === "volume") f = [...f].sort((a,b) => b.vol - a.vol);
    else if (sortBy === "spread") f = [...f].sort((a,b) => (a.ask - a.bid) - (b.ask - b.bid));
    else if (sortBy === "soonest") f = [...f].sort((a,b) => (a.hoursUntil||999) - (b.hoursUntil||999));
    else if (sortBy === "newest") f = [...f].sort((a,b) => new Date(b.openTime||0) - new Date(a.openTime||0));
    return f;
  }, [exclusive, sportFilter, sortBy, timeFilter, showFocusOnly]);

  // Auto-fetch records for visible teams
  useEffect(() => {
    filtered.slice(0, 15).forEach(e => {
      const st = e.series_ticker || "";
      let sport, league;
      if (/MLBST|MLB/i.test(st)) { sport = "baseball"; league = "mlb"; }
      else if (/NCAAMB/i.test(st)) { sport = "basketball"; league = "mens-college-basketball"; }
      else if (/NCAAWB/i.test(st)) { sport = "basketball"; league = "womens-college-basketball"; }
      else if (/NCAABB/i.test(st)) { sport = "baseball"; league = "college-baseball"; }
      else if (/NBA/i.test(st)) { sport = "basketball"; league = "nba"; }
      else if (/NHL/i.test(st)) { sport = "hockey"; league = "nhl"; }
      if (sport && e.teamCodes?.length >= 2) {
        e.teamCodes.forEach(tc => fetchTeamRecord(tc, sport, league));
      }
    });
  }, [filtered, fetchTeamRecord]);

  const toggleFocus = (sp) => {
    setFocusSports(prev => { const s = new Set(prev); if (s.has(sp)) s.delete(sp); else s.add(sp); return s; });
  };

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, flexDirection: "column", gap: 8, alignItems: "stretch" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={S.title}>🎯 Kalshi Exclusives</span><HelpTip id="exclusive" />
            <Badge c="#6366f1">{filtered.length}</Badge>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={excludeTotal} onChange={e => setExcludeTotal(e.target.checked)} />
              <span style={{ fontSize: 9, color: "#5a6f8f" }}>Hide Totals</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", marginLeft: 8 }}>
              <input type="checkbox" checked={showFocusOnly} onChange={e => setShowFocusOnly(e.target.checked)} />
              <span style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700 }}>NICHE & FOCUS ONLY</span>
            </label>
          </div>
        </div>
        {/* Sport filters with focus toggles */}
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}>
          <TBtn active={sportFilter === "ALL"} onClick={() => setSportFilter("ALL")}>ALL ({exclusive.length})</TBtn>
          {Object.entries(sports).sort((a,b) => b[1]-a[1]).map(([sp,ct]) => (
            <div key={sp} style={{ display: "flex", alignItems: "center", gap: 0 }}>
              <TBtn active={sportFilter === sp} onClick={() => setSportFilter(sp)} color={focusSports.has(sp) ? "#f59e0b" : undefined}>{sp} ({ct})</TBtn>
              <button onClick={() => toggleFocus(sp)} style={{ background: focusSports.has(sp) ? "#f59e0b20" : "transparent", border: "none", borderRadius: "0 4px 4px 0", padding: "2px 4px", cursor: "pointer", fontSize: 8, color: focusSports.has(sp) ? "#f59e0b" : "#3a4f6f" }} title={focusSports.has(sp) ? "Remove from focus" : "Add to focus"}>
                {focusSports.has(sp) ? "★" : "☆"}
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700 }}>TIME:</span>
          <TBtn active={timeFilter === "all"} onClick={() => setTimeFilter("all")}>ALL</TBtn>
          <TBtn active={timeFilter === "24h"} onClick={() => setTimeFilter("24h")} color="#ef4444">24H</TBtn>
          <TBtn active={timeFilter === "48h"} onClick={() => setTimeFilter("48h")} color="#f59e0b">48H</TBtn>
          <TBtn active={timeFilter === "7d"} onClick={() => setTimeFilter("7d")}>WEEK</TBtn>
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700, marginLeft: 6 }}>SORT:</span>
          <TBtn active={sortBy === "soonest"} onClick={() => setSortBy("soonest")} color="#ef4444">SOONEST</TBtn>
          <TBtn active={sortBy === "volume"} onClick={() => setSortBy("volume")} color="#00e8a4">VOLUME</TBtn>
          <TBtn active={sortBy === "spread"} onClick={() => setSortBy("spread")}>TIGHTEST</TBtn>
          <TBtn active={sortBy === "newest"} onClick={() => setSortBy("newest")} color="#6366f1">NEWEST</TBtn>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {filtered.length === 0 ? <Empty icon="🎯" text={exclusive.length > 0 ? "Markets exist but filtered. Adjust filters above." : sbOdds?.length ? "No niche or exclusive markets match your filters." : "Showing niche sports (ST, NCAA). Add Odds API key to also find sportsbook-exclusive gaps."} /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>
            {["Event", "Sport", "Game", "Record", "Bid", "Ask", "Mid", "Vol", ""].map(h => <th key={h} style={S.th}>{h}</th>)}
          </tr></thead><tbody>
            {filtered.slice(0, 60).map((e, i) => {
              const timeStr = e.gameDate ? e.gameDate.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
              const hoursStr = e.hoursUntil !== null ? (e.hoursUntil < 0 ? "LIVE" : e.hoursUntil < 1 ? "<1h" : e.hoursUntil < 24 ? `${Math.floor(e.hoursUntil)}h` : `${Math.floor(e.hoursUntil/24)}d`) : "";
              const urgencyColor = e.hoursUntil !== null ? (e.hoursUntil < 0 ? "#00e8a4" : e.hoursUntil < 24 ? "#ef4444" : e.hoursUntil < 48 ? "#f59e0b" : "#3a4f6f") : "#3a4f6f";
              // Team records
              const st = e.series_ticker || "";
              let league = /MLBST|MLB/i.test(st) ? "mlb" : /NCAAMB/i.test(st) ? "mens-college-basketball" : /NCAAWB/i.test(st) ? "womens-college-basketball" : /NCAABB/i.test(st) ? "college-baseball" : /NBA/i.test(st) ? "nba" : /NHL/i.test(st) ? "nhl" : "";
              const rec1 = teamRecords[`${e.teamCodes?.[0]}-${league}`];
              const rec2 = teamRecords[`${e.teamCodes?.[1]}-${league}`];
              return (
              <tr key={e.event_ticker || i} style={{ cursor: "pointer", background: e.isFocus ? "#f59e0b04" : "transparent" }}
                onClick={() => e.topMarket?.ticker && onSel(e.topMarket)}
                onMouseEnter={ev => ev.currentTarget.style.background = "#0f1728"} onMouseLeave={ev => ev.currentTarget.style.background = e.isFocus ? "#f59e0b04" : "transparent"}>
                <td style={{ ...S.td, color: "#eaf0f6", maxWidth: 180 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.isFocus && <span style={{ color: "#f59e0b", marginRight: 4 }}>★</span>}{e.title}</div>
                  <div style={{ fontSize: 9, color: "#3a4f6f" }}>{e.subTitle || e.topMarket?.ticker}</div>
                </td>
                <td style={S.td}><Badge c={e.isFocus ? "#f59e0b" : "#6366f1"}>{e.sport}</Badge></td>
                <td style={{ ...S.td, ...S.m, whiteSpace: "nowrap" }}>
                  <span style={{ color: urgencyColor, fontWeight: 700, fontSize: 11 }}>{timeStr}</span>
                  {hoursStr && <span style={{ color: urgencyColor, fontSize: 9, marginLeft: 3 }}>({hoursStr})</span>}
                </td>
                <td style={{ ...S.td, fontSize: 10, color: "#7a8faa", maxWidth: 160 }}>
                  {rec1 || rec2 ? <div>
                    {rec1 && <div style={{ marginBottom: 2 }}>
                      <span style={{ color: "#5a6f8f" }}>{e.teamCodes?.[0]}:</span>{" "}
                      <span style={{ color: "#c8d6e5", fontWeight: 600 }}>{rec1.record}</span>
                      {rec1.last10 && rec1.last10 !== "—" && <span style={{ color: "#f59e0b", marginLeft: 4 }}>L10:{rec1.last10}</span>}
                      {rec1.streak && rec1.streak !== "—" && <span style={{ color: rec1.streak.startsWith("W") ? "#00e8a4" : "#ef4444", marginLeft: 4, fontWeight: 700 }}>{rec1.streak}</span>}
                    </div>}
                    {rec2 && <div>
                      <span style={{ color: "#5a6f8f" }}>{e.teamCodes?.[1]}:</span>{" "}
                      <span style={{ color: "#c8d6e5", fontWeight: 600 }}>{rec2.record}</span>
                      {rec2.last10 && rec2.last10 !== "—" && <span style={{ color: "#f59e0b", marginLeft: 4 }}>L10:{rec2.last10}</span>}
                      {rec2.streak && rec2.streak !== "—" && <span style={{ color: rec2.streak.startsWith("W") ? "#00e8a4" : "#ef4444", marginLeft: 4, fontWeight: 700 }}>{rec2.streak}</span>}
                    </div>}
                  </div> : <span style={{ color: "#1e3050" }}>loading...</span>}
                </td>
                <td style={{ ...S.td, ...S.m, color: "#00e8a4", fontWeight: 700 }}>{e.bid}¢</td>
                <td style={{ ...S.td, ...S.m, color: "#ef4444", fontWeight: 700 }}>{e.ask}¢</td>
                <td style={{ ...S.td, ...S.m, color: "#c8d6e5" }}>{e.mid.toFixed(0)}%</td>
                <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{e.vol.toLocaleString()}</td>
                <td style={S.td}>
                  <button onClick={ev => { ev.stopPropagation(); e.topMarket?.ticker && onSel(e.topMarket); }}
                    style={{ background: "#6366f112", border: "1px solid #6366f130", borderRadius: 4, padding: "2px 10px", color: "#6366f1", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>TRADE</button>
                </td>
              </tr>);
            })}
          </tbody></table>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// FAVORITES MODULE — saved markets with live prices + auto-trade rules
// ═══════════════════════════════════════════════════════════════
function FavoritesModule({ favorites, kalshi, onSel, onRemove, autoRules, onSaveRules, armed, onArmToggle, tradeLog }) {
  const [ruleBuilder, setRuleBuilder] = useState(null); // ticker being edited
  const [ruleType, setRuleType] = useState("buy_below"); // buy_below, sell_above, buy_no_below, sell_no_above
  const [rulePrice, setRulePrice] = useState("");
  const [ruleQty, setRuleQty] = useState("10");
  const vault = useVault();

  const enriched = useMemo(() => {
    return favorites.map(fav => {
      let liveMarket = null;
      for (const e of kalshi) {
        const m = (e.markets || []).find(m => m.ticker === fav.ticker);
        if (m) { liveMarket = { ...m, eventTitle: e.title, series: e.series_ticker }; break; }
      }
      const bid = liveMarket?.yes_bid || fav.lastBid || 0;
      const ask = liveMarket?.yes_ask || fav.lastAsk || 0;
      const mid = bid && ask ? (bid + ask) / 2 : 0;
      const spread = ask - bid;
      const feeDrag = mid > 0 ? kalshiFeeCents(Math.round(mid), 1, false) / 2 : 0;
      const fairValue = mid > 0 ? (mid - feeDrag).toFixed(1) : "—";
      const rules = (autoRules || []).filter(r => r.ticker === fav.ticker);
      return { ...fav, live: !!liveMarket, bid, ask, mid, spread, fairValue, feeDrag, market: liveMarket, rules };
    });
  }, [favorites, kalshi, autoRules]);

  const addRule = () => {
    if (!ruleBuilder || !rulePrice) return;
    const rule = { id: Date.now().toString(36), ticker: ruleBuilder, type: ruleType, price: parseInt(rulePrice), qty: parseInt(ruleQty) || 10, active: true, createdAt: Date.now() };
    onSaveRules([...(autoRules || []), rule]);
    setRuleBuilder(null); setRulePrice(""); setRuleQty("10");
    vault.showToast(`Rule added: ${ruleType.replace(/_/g, " ")} @${rulePrice}¢`);
  };

  const removeRule = (id) => { onSaveRules((autoRules || []).filter(r => r.id !== id)); };

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>★ Favorites</span>
          <Badge c="#f59e0b">{favorites.length}</Badge>
          {(autoRules||[]).length > 0 && <Badge c={armed ? "#ef4444" : "#3a4f6f"}>{(autoRules||[]).length} RULES</Badge>}
        </div>
        {(autoRules||[]).length > 0 && <button onClick={onArmToggle} style={{
          background: armed ? "#ef444420" : "#14203a",
          border: `1px solid ${armed ? "#ef4444" : "#14203a"}`,
          borderRadius: 6, padding: "5px 14px", cursor: "pointer", ...S.m
        }}>
          <span style={{ color: armed ? "#ef4444" : "#5a6f8f", fontSize: 10, fontWeight: 800 }}>
            {armed ? "⚡ ARMED — AUTO-TRADING ACTIVE" : "DISARMED"}
          </span>
        </button>}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {enriched.length === 0 ? <Empty icon="★" text="No favorites yet. Click ☆ on any market to save it here." /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr>
            {["Market", "Bid", "Ask", "Fair Value", "Spread", "Taker Fee", "Maker Fee", "Net Profit", "Vol", ""].map(h => <th key={h} style={S.th}>{h}</th>)}
          </tr></thead><tbody>
            {enriched.map((f, i) => (
              <React.Fragment key={f.ticker}>
              <tr style={{ cursor: "pointer", opacity: f.live ? 1 : 0.5 }}
                onClick={() => f.market && onSel(f.market)}
                onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <td style={{ ...S.td, color: "#eaf0f6", maxWidth: 200 }}>
                  <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.eventTitle || f.title || f.ticker}</div>
                  <div style={{ fontSize: 9, color: "#3a4f6f" }}>{f.ticker}{!f.live && " (offline)"}</div>
                  {f.rules.length > 0 && <div style={{ fontSize: 9, color: armed ? "#ef4444" : "#3a4f6f" }}>{f.rules.length} rule{f.rules.length>1?"s":""} {armed ? "ARMED" : "set"}</div>}
                </td>
                <td style={{ ...S.td, ...S.m, color: "#00e8a4", fontWeight: 700, fontSize: 13 }}>{f.bid || "—"}¢</td>
                <td style={{ ...S.td, ...S.m, color: "#ef4444", fontWeight: 700, fontSize: 13 }}>{f.ask || "—"}¢</td>
                <td style={{ ...S.td, ...S.m, color: "#e8c547", fontWeight: 800, fontSize: 13 }}>{f.fairValue}¢</td>
                <td style={{ ...S.td, ...S.m, color: f.spread <= 2 ? "#00e8a4" : f.spread <= 5 ? "#f59e0b" : "#ef4444", fontSize: 11 }}>{f.spread}¢</td>
                <td style={{ ...S.td, ...S.m, color: "#f59e0b", fontSize: 11 }}>{f.bid > 0 ? kalshiFeeCents(f.ask, 1, false) + "¢" : "—"}</td>
                <td style={{ ...S.td, ...S.m, color: "#7a8faa", fontSize: 11 }}>{f.bid > 0 ? kalshiFeeCents(f.ask, 1, true) + "¢" : "—"}</td>
                <td style={{ ...S.td, ...S.m, fontSize: 11 }}>{(() => { if (!f.ask) return "—"; const cost = f.ask; const fee = kalshiFeeCents(f.ask, 1, false); const profit = 100 - cost - fee; return <span style={{ color: profit > 0 ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{profit}¢</span>; })()}</td>
                <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{(f.market?.volume||0).toLocaleString()}</td>
                <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                  <button onClick={ev => { ev.stopPropagation(); f.market && onSel(f.market); }}
                    style={{ background: "#00e8a412", border: "1px solid #00e8a430", borderRadius: 4, padding: "2px 8px", color: "#00e8a4", fontSize: 10, cursor: "pointer", fontWeight: 700, marginRight: 3 }}>TRADE</button>
                  <button onClick={ev => { ev.stopPropagation(); setRuleBuilder(ruleBuilder === f.ticker ? null : f.ticker); }}
                    style={{ background: ruleBuilder === f.ticker ? "#6366f120" : "transparent", border: `1px solid ${ruleBuilder === f.ticker ? "#6366f140" : "#14203a"}`, borderRadius: 4, padding: "2px 6px", color: "#6366f1", fontSize: 10, cursor: "pointer", fontWeight: 700, marginRight: 3 }}>⚡RULE</button>
                  <button onClick={ev => { ev.stopPropagation(); onRemove(f.ticker); }}
                    style={{ background: "#ef444410", border: "1px solid #ef444425", borderRadius: 4, padding: "2px 6px", color: "#ef4444", fontSize: 10, cursor: "pointer" }}>✕</button>
                </td>
              </tr>
              {/* Rule builder inline */}
              {ruleBuilder === f.ticker && <tr><td colSpan={10} style={{ padding: "8px 12px", background: "#0a0f1a", borderBottom: "1px solid #14203a" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, color: "#6366f1", fontWeight: 700 }}>NEW RULE:</span>
                  <select value={ruleType} onChange={e => setRuleType(e.target.value)} style={{ ...S.inp, width: 140, fontSize: 10 }}>
                    <option value="buy_below">BUY YES below</option>
                    <option value="sell_above">SELL YES above</option>
                    <option value="buy_no_below">BUY NO below</option>
                    <option value="sell_no_above">SELL NO above</option>
                  </select>
                  <input value={rulePrice} onChange={e => setRulePrice(e.target.value)} placeholder="Price ¢" style={{ ...S.inp, width: 70, fontSize: 10 }} />
                  <span style={{ fontSize: 9, color: "#5a6f8f" }}>×</span>
                  <input value={ruleQty} onChange={e => setRuleQty(e.target.value)} placeholder="Qty" style={{ ...S.inp, width: 50, fontSize: 10 }} />
                  <span style={{ fontSize: 9, color: "#5a6f8f" }}>contracts</span>
                  {rulePrice && <span style={{ fontSize: 9, color: "#f59e0b" }}>Fee: {kalshiFeeCents(parseInt(rulePrice)||0, parseInt(ruleQty)||1, false)}¢</span>}
                  <button onClick={addRule} style={{ background: "#6366f120", border: "1px solid #6366f140", borderRadius: 4, padding: "3px 12px", color: "#6366f1", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>ADD RULE</button>
                </div>
                {/* Show existing rules for this market */}
                {f.rules.length > 0 && <div style={{ marginTop: 6 }}>
                  {f.rules.map(r => (
                    <div key={r.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
                      <Badge c={r.active ? "#6366f1" : "#3a4f6f"} sm>{r.type.replace(/_/g, " ").toUpperCase()} @{r.price}¢ ×{r.qty}</Badge>
                      <span style={{ fontSize: 9, color: "#f59e0b" }}>fee: {kalshiFeeCents(r.price, r.qty, false)}¢</span>
                      <button onClick={() => removeRule(r.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>✕</button>
                    </div>
                  ))}
                </div>}
              </td></tr>}
              </React.Fragment>
            ))}
          </tbody></table>}
        {/* Trade execution log */}
        {(tradeLog||[]).length > 0 && <div style={{ padding: "8px 12px", borderTop: "1px solid #14203a" }}>
          <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>AUTO-TRADE LOG</div>
          {tradeLog.slice(-10).reverse().map((l, i) => (
            <div key={i} style={{ fontSize: 10, color: "#5a6f8f", padding: "2px 0" }}>
              {new Date(l.time).toLocaleTimeString()} — {l.rule?.type?.replace(/_/g," ")} {l.ticker} @{l.price}¢ ×{l.qty} → {l.status}
            </div>
          ))}
        </div>}
        <div style={{ padding: "12px 16px", borderTop: "1px solid #14203a" }}>
          <div style={{ fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>HOW AUTO-TRADE WORKS</div>
          <div style={{ fontSize: 10, color: "#5a6f8f", lineHeight: 1.6 }}>
            1. Save markets to favorites. 2. Click ⚡RULE to set conditions (e.g. "BUY YES below 40¢").
            3. Click ARM to activate. When the market data refreshes and your condition is met,
            the order fires automatically via your Kalshi API key. Rules auto-deactivate after one fill
            to prevent repeated execution. All fees are shown so you can set informed price targets.
          </div>
        </div>
      </div>
    </div>
  );
}

// Google Sheets Export Button
function SheetsButton({ kalshi }) {
  const [showMenu, setShowMenu] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setShowMenu(!showMenu)} style={{
        background: "#14203a", border: "1px solid #14203a",
        borderRadius: 6, padding: "5px 10px", cursor: "pointer",
        display: "flex", alignItems: "center", gap: 5, ...S.m
      }}>
        <span style={{ fontSize: 11 }}>📊</span>
        <span style={{ color: "#5a6f8f", fontSize: 9, fontWeight: 700 }}>SHEETS</span>
      </button>
      {showMenu && <SheetsExportMenu kalshi={kalshi} onClose={() => setShowMenu(false)} />}
    </div>
  );
}

// Obsidian Vault Button
function ObsidianButton() {
  const ob = useObsidian();
  return (
    <button onClick={async () => {
      if (ob.connected) { obsidianVault.disconnect(); ob.refresh(); }
      else { await obsidianVault.connect(); ob.refresh(); }
    }} style={{
      background: ob.connected ? "#6366f120" : "#14203a",
      border: `1px solid ${ob.connected ? "#6366f1" : "#14203a"}`,
      borderRadius: 6, padding: "5px 10px", cursor: "pointer",
      display: "flex", alignItems: "center", gap: 5, ...S.m
    }}>
      <span style={{ fontSize: 12 }}>📝</span>
      <span style={{ color: ob.connected ? "#6366f1" : "#5a6f8f", fontSize: 9, fontWeight: 700 }}>
        {ob.connected ? `OBSIDIAN · ${ob.vaultName}` : "OBSIDIAN"}
      </span>
    </button>
  );
}

// Turbo Mode UI Component
function TurboToggle() {
  const vault = useVault();
  const ws = useWebSocket();
  const [showPanel, setShowPanel] = useState(false);
  const ak = vault.getKey("kalshi_api_key");
  const pk = vault.getKey("kalshi_private_key");

  const toggle = async () => {
    if (ws.connected) {
      wsEngine.disconnect();
    } else if (ak && pk) {
      await wsEngine.connect(ak, pk);
    }
  };

  const ageSec = ws.lastMsg ? Math.floor((Date.now() - ws.lastMsg) / 1000) : null;

  return (
    <div style={{ position: "relative" }}>
      <button onClick={toggle} style={{
        background: ws.connected ? "#ef444420" : "#14203a",
        border: `1px solid ${ws.connected ? "#ef4444" : "#14203a"}`,
        borderRadius: 6, padding: "5px 10px", cursor: "pointer",
        display: "flex", alignItems: "center", gap: 6, ...S.m
      }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: ws.connected ? "#ef4444" : "#3a4f6f", boxShadow: ws.connected ? "0 0 6px #ef4444" : "none" }} />
        <span style={{ color: ws.connected ? "#ef4444" : "#5a6f8f", fontSize: 9, fontWeight: 800, letterSpacing: "0.5px" }}>
          {ws.connected ? "TURBO ON" : "TURBO OFF"}
        </span>
      </button>
      {ws.connected && (
        <div style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, background: "#0d1320", border: "1px solid #ef444430", borderRadius: 8, padding: "8px 12px", zIndex: 50, minWidth: 200 }}>
          <div style={{ fontSize: 9, color: "#ef4444", fontWeight: 800, marginBottom: 4 }}>⚡ TURBO MODE ACTIVE</div>
          <div style={{ fontSize: 10, color: "#5a6f8f", lineHeight: 1.6 }}>
            WebSocket streaming live<br/>
            Messages: {ws.msgCount}<br/>
            Last update: {ageSec !== null ? `${ageSec}s ago` : "—"}<br/>
            Subscriptions: {wsEngine.subscriptions.size}<br/>
            Auto-trade: {wsEngine.autoTradeEnabled ? "ARMED" : "OFF"}
          </div>
          <button onClick={() => wsEngine.disconnect()} style={{ marginTop: 6, width: "100%", background: "#ef444420", border: "1px solid #ef444430", borderRadius: 4, padding: "4px 8px", color: "#ef4444", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>DISCONNECT</button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ERROR CAPTURE + BUG REPORTING — everything the app hits (JS errors,
// unhandled rejections, console.error) lands in a ring buffer; the 🐞
// Report tab packages it with the user's description + screenshots
// into a bundle that unpacks straight into a Claude Code session.
// ═══════════════════════════════════════════════════════════════
const ERROR_LOG = [];
(function installErrorCapture() {
  if (typeof window === "undefined" || window.__kalshiErrCap) return;
  window.__kalshiErrCap = true;
  const push = (kind, msg, extra) => {
    ERROR_LOG.push({ time: Date.now(), kind, msg: String(msg ?? "").slice(0, 500), extra: extra ? String(extra).slice(0, 300) : undefined });
    if (ERROR_LOG.length > 100) ERROR_LOG.splice(0, ERROR_LOG.length - 100);
  };
  window.addEventListener("error", e => push("error", e.message, `${e.filename || ""}:${e.lineno || ""}`));
  window.addEventListener("unhandledrejection", e => push("promise", e.reason?.message || e.reason));
  const orig = console.error.bind(console);
  console.error = (...args) => { push("console", args.map(a => typeof a === "string" ? a : (() => { try { return JSON.stringify(a).slice(0, 200); } catch { return String(a); } })()).join(" ")); orig(...args); };
})();

function ReportModule({ currentTab, watchCount }) {
  const vault = useVault();
  const [what, setWhat] = useState("");
  const [expected, setExpected] = useState("");
  const [shots, setShots] = useState([]); // { name, dataUrl }
  const fileRef = useRef(null);

  const addFiles = (files) => {
    [...files].forEach(f => {
      if (!f.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = e => setShots(prev => [...prev, { name: f.name || `screenshot-${prev.length + 1}.png`, dataUrl: e.target.result }]);
      reader.readAsDataURL(f);
    });
  };

  const onPaste = (e) => {
    const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith("image/"));
    if (items.length) { e.preventDefault(); addFiles(items.map(i => i.getAsFile()).filter(Boolean)); }
  };

  const context = () => ({
    appVersion: APP_VERSION,
    profile: vault.profile,
    tab: currentTab,
    watchCount,
    userAgent: navigator.userAgent,
    screen: `${window.screen?.width}x${window.screen?.height}`,
    time: new Date().toISOString(),
    recentErrors: ERROR_LOG.slice(-30),
  });

  const exportBundle = () => {
    if (!what.trim()) { vault.showToast("Describe what went wrong first", "error"); return; }
    const bundle = { version: 1, kind: "kalshi-bug-report", description: what, expected, context: context(), screenshots: shots };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
    a.download = `kalshi-bug-report-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    vault.showToast("Report bundle downloaded — send it to Will / run npm run report on it");
  };

  const copySummary = async () => {
    const c = context();
    const md = `## Bug report — Kalshi Sports Terminal v${c.appVersion}\n\n**What went wrong:** ${what}\n\n**Expected:** ${expected || "—"}\n\n**Context:** profile=${c.profile} tab=${c.tab} watch=${c.watchCount} ${c.screen}\n${c.userAgent}\n\n**Recent errors:**\n${c.recentErrors.map(e => `- [${new Date(e.time).toLocaleTimeString()}] ${e.kind}: ${e.msg}${e.extra ? ` (${e.extra})` : ""}`).join("\n") || "none captured"}\n\n(${shots.length} screenshot${shots.length === 1 ? "" : "s"} in the JSON bundle)`;
    await copyToClipboard(md, vault.showToast);
  };

  return (
    <div style={{ ...S.panel, height: "100%" }} onPaste={onPaste}>
      <div style={{ ...S.hdr, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>🐞 Report a Problem</span>
          {ERROR_LOG.length > 0 && <Badge c="#f59e0b" sm>{ERROR_LOG.length} ERRORS CAPTURED</Badge>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={copySummary} style={{ background: "#14203a", border: "1px solid #14203a", borderRadius: 6, padding: "5px 12px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>📋 COPY SUMMARY</button>
          <button onClick={exportBundle} style={{ background: "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 6, padding: "5px 14px", color: "#050910", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>⬇ EXPORT BUNDLE</button>
        </div>
      </div>
      <div style={{ padding: "6px 16px", fontSize: 10, color: "#5a6f8f", borderBottom: "1px solid #14203a", lineHeight: 1.5 }}>
        Tell us what's going wrong. The bundle packages your description, screenshots (paste with Ctrl+V or attach), and the app's captured errors — it unpacks with <b>npm run report &lt;file&gt;</b> into a folder that feeds straight into Claude for a fix.
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px", maxWidth: 760 }}>
        <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, marginBottom: 4 }}>WHAT WENT WRONG?</div>
        <textarea value={what} onChange={e => setWhat(e.target.value)} rows={4} placeholder="What were you doing, and what happened? e.g. 'Clicked TRADE on a VALUE signal and the order form showed 0¢...'" style={{ ...S.inp, width: "100%", fontSize: 11, resize: "vertical", lineHeight: 1.5 }} />
        <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "10px 0 4px" }}>WHAT DID YOU EXPECT?</div>
        <textarea value={expected} onChange={e => setExpected(e.target.value)} rows={2} placeholder="Optional — what should have happened instead" style={{ ...S.inp, width: "100%", fontSize: 11, resize: "vertical", lineHeight: 1.5 }} />

        <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "12px 0 4px" }}>SCREENSHOTS ({shots.length})</div>
        <div onClick={() => fileRef.current?.click()}
          style={{ border: "1px dashed #1e3050", borderRadius: 8, padding: 18, textAlign: "center", cursor: "pointer", fontSize: 10, color: "#5a6f8f" }}>
          Paste a screenshot here (Ctrl+V) or click to attach image files
          <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { addFiles(e.target.files); e.target.value = ""; }} />
        </div>
        {shots.length > 0 && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {shots.map((s, i) => (
            <div key={i} style={{ position: "relative" }}>
              <img src={s.dataUrl} alt={s.name} style={{ width: 140, height: 90, objectFit: "cover", borderRadius: 6, border: "1px solid #14203a" }} />
              <button onClick={() => setShots(prev => prev.filter((_, j) => j !== i))} style={{ position: "absolute", top: 2, right: 2, background: "#050910cc", border: "none", borderRadius: 4, color: "#ef4444", fontSize: 10, cursor: "pointer", padding: "1px 5px" }}>✕</button>
            </div>
          ))}
        </div>}

        <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "14px 0 4px" }}>AUTO-CAPTURED ERRORS (attached to the bundle)</div>
        {ERROR_LOG.length === 0 ? <div style={{ fontSize: 10, color: "#3a4f6f" }}>No errors captured this session.</div> :
          <div style={{ background: "#070c17", border: "1px solid #14203a", borderRadius: 6, padding: 8, maxHeight: 160, overflow: "auto" }}>
            {ERROR_LOG.slice(-30).reverse().map((e, i) => (
              <div key={i} style={{ fontSize: 9, color: "#7a8faa", fontFamily: "monospace", padding: "1px 0" }}>
                <span style={{ color: "#3a4f6f" }}>{new Date(e.time).toLocaleTimeString()}</span>{" "}
                <span style={{ color: e.kind === "error" ? "#ef4444" : "#f59e0b" }}>[{e.kind}]</span> {e.msg}{e.extra ? <span style={{ color: "#3a4f6f" }}> ({e.extra})</span> : null}
              </div>
            ))}
          </div>}
      </div>
    </div>
  );
}

// Signal journal singleton — the learning database. Every emitted signal
// is logged with its entry state and scored against real outcomes.
const JOURNAL_STORAGE_KEY = "kalshi_journal_v1";
let signalJournal;
try { signalJournal = SignalJournal.fromJSON(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY) || "null")); }
catch { signalJournal = null; }
if (!signalJournal) signalJournal = new SignalJournal();
function persistJournal() {
  try { localStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(signalJournal.toJSON())); } catch { /* storage full */ }
}

// Sheet-change watcher singleton (mentor's Google Sheet modifications)
const SHEETWATCH_STORAGE_KEY = "kalshi_sheetwatch_v1";
let sheetWatcher;
try { sheetWatcher = SheetWatcher.fromJSON(JSON.parse(localStorage.getItem(SHEETWATCH_STORAGE_KEY) || "null")); }
catch { sheetWatcher = null; }
if (!sheetWatcher) sheetWatcher = new SheetWatcher();
function persistSheetWatch() {
  try { localStorage.setItem(SHEETWATCH_STORAGE_KEY, JSON.stringify(sheetWatcher.toJSON())); } catch { /* storage full */ }
}

// ═══════════════════════════════════════════════════════════════
// TRACKER PAGE — watch chosen markets/sports and record YES/NO prices
// and transaction flow over time to build pattern recognition
// ═══════════════════════════════════════════════════════════════
// Hourly market-wide snapshot memory — answers "what did this trade at
// 24 hours ago" for every loaded market, not just watched ones.
const SNAPSHOT_STORAGE_KEY = "kalshi_snapshots_v1";
let snapshotStore;
try { snapshotStore = SnapshotStore.fromJSON(JSON.parse(localStorage.getItem(SNAPSHOT_STORAGE_KEY) || "null")); }
catch { snapshotStore = null; }
if (!snapshotStore) snapshotStore = new SnapshotStore();
function captureSnapshot(kalshiEvents) {
  const flat = [];
  (kalshiEvents || []).forEach(e => (e.markets || []).forEach(m => {
    const bid = m.yes_bid || 0, ask = m.yes_ask || 0;
    if (bid && ask) flat.push({ ticker: m.ticker, mid: (bid + ask) / 2, vol: (m.volume_24h ?? m.volume) || 0 });
  }));
  if (snapshotStore.add(flat)) {
    try { localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshotStore.toJSON())); }
    catch (e) { console.warn("[Snapshots] persist failed (storage full?)", e); }
  }
}

const TRACKER_STORAGE_KEY = "kalshi_tracker_v1";
let trackerRecorder;
try { trackerRecorder = MarketRecorder.fromJSON(JSON.parse(localStorage.getItem(TRACKER_STORAGE_KEY) || "null")); }
catch { trackerRecorder = null; }
if (!trackerRecorder) trackerRecorder = new MarketRecorder();
function persistTracker() {
  try { localStorage.setItem(TRACKER_STORAGE_KEY, JSON.stringify(trackerRecorder.toJSON())); }
  catch (e) { console.warn("[Tracker] persist failed (storage full?)", e); }
}

function TrackChart({ samples, buckets }) {
  if (!samples?.length) return <Empty icon="📼" text="No samples yet — recording starts as soon as the market is watched" />;
  const W = 800, H = 190, VH = 54;
  const t0 = samples[0].t, t1 = Math.max(samples[samples.length - 1].t, t0 + 1);
  const xs = t => 12 + (W - 24) * ((t - t0) / (t1 - t0));
  const mids = samples.filter(s => s.mid != null);
  if (!mids.length) return <Empty icon="📼" text="No priced samples yet" />;
  let lo = Math.min(...mids.map(s => s.bid || s.mid));
  let hi = Math.max(...mids.map(s => s.ask || s.mid));
  lo = Math.max(0, lo - 3); hi = Math.min(100, hi + 3);
  const ys = v => 12 + (H - 24) * (1 - (v - lo) / Math.max(1, hi - lo));
  const line = mids.map(s => `${xs(s.t).toFixed(1)},${ys(s.mid).toFixed(1)}`).join(" ");
  const band = [...mids.map(s => `${xs(s.t).toFixed(1)},${ys(s.ask || s.mid).toFixed(1)}`), ...[...mids].reverse().map(s => `${xs(s.t).toFixed(1)},${ys(s.bid || s.mid).toFixed(1)}`)].join(" ");
  const maxC = Math.max(1, ...(buckets || []).map(b => b.contracts));
  const bw = Math.max(2, (W - 24) / Math.max(1, (t1 - t0) / 60000));
  const last = mids[mids.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H + VH + 14}`} style={{ width: "100%", background: "#070c17", borderRadius: 8, border: "1px solid #14203a" }}>
      {[lo, (lo + hi) / 2, hi].map((v, i) => <g key={i}>
        <line x1={12} x2={W - 12} y1={ys(v)} y2={ys(v)} stroke="#14203a" strokeWidth="1" strokeDasharray="3 4" />
        <text x={W - 10} y={ys(v) + 3} fill="#3a4f6f" fontSize="9" textAnchor="start">{v.toFixed(0)}¢</text>
      </g>)}
      <polygon points={band} fill="#00e8a410" stroke="none" />
      <polyline points={line} fill="none" stroke="#00e8a4" strokeWidth="1.6" />
      <circle cx={xs(last.t)} cy={ys(last.mid)} r="3" fill="#00e8a4" />
      <text x={xs(last.t) - 6} y={ys(last.mid) - 7} fill="#e8c547" fontSize="10" fontWeight="700" textAnchor="end">{last.mid.toFixed(0)}¢</text>
      {(buckets || []).map((b, i) => {
        const h = Math.max(1, (b.contracts / maxC) * (VH - 12));
        return <rect key={i} x={xs(b.t)} y={H + VH - h} width={bw} height={h}
          fill={b.imbalance >= 0 ? "#00e8a466" : "#ef444466"} />;
      })}
      <text x={12} y={H + 12} fill="#3a4f6f" fontSize="9">contracts / min (green = YES-taker flow, red = NO-taker)</text>
      <text x={12} y={H + VH + 11} fill="#3a4f6f" fontSize="9">{new Date(t0).toLocaleTimeString()}</text>
      <text x={W - 12} y={H + VH + 11} fill="#3a4f6f" fontSize="9" textAnchor="end">{new Date(t1).toLocaleTimeString()}</text>
    </svg>
  );
}

function TrackerModule({ kalshi, watchList, onSaveWatch, trackIntervalMs, onSetInterval, trackTick, onSel }) {
  const vault = useVault();
  const [sel, setSel] = useState(watchList[0]?.ticker || null);
  const [q, setQ] = useState("");
  void trackTick; // re-render signal from the recording loop

  // Game stories for the markets we're in
  const [stories, setStories] = useState([]);
  useEffect(() => {
    let on = true;
    const load = () => fetchNews().then(s => { if (on) setStories(s); }).catch(() => {});
    load();
    const iv = setInterval(load, 300_000);
    return () => { on = false; clearInterval(iv); };
  }, []);
  const matchedStories = useMemo(() => matchStoriesToContexts(stories, contextsFromWatchlist(watchList)), [stories, watchList]);

  const allMarkets = useMemo(() => {
    const out = [];
    kalshi.forEach(e => (e.markets || []).forEach(m => out.push({ ticker: m.ticker, title: m.yes_sub_title || m.title, event: e.title, series: e.series_ticker, vol: m.volume_24h || m.volume || 0, market: m })));
    return out;
  }, [kalshi]);

  const seriesChips = useMemo(() => {
    const bySeries = {};
    allMarkets.forEach(m => { bySeries[m.series] = (bySeries[m.series] || 0) + m.vol; });
    return Object.entries(bySeries).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s]) => s);
  }, [allMarkets]);

  const searchHits = useMemo(() => !q ? [] :
    allMarkets.filter(m => `${m.event} ${m.title} ${m.ticker}`.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => b.vol - a.vol).slice(0, 12), [allMarkets, q]);

  const watch = (m) => {
    if (watchList.some(w => w.ticker === m.ticker)) return;
    trackerRecorder.setMeta(m.ticker, { title: m.title, event: m.event, series: m.series, watchedAt: Date.now() });
    onSaveWatch([...watchList, { ticker: m.ticker, title: m.title, event: m.event, series: m.series }]);
    if (!sel) setSel(m.ticker);
    vault.showToast(`📼 Tracking ${m.ticker}`);
  };
  const watchSeries = (series) => {
    const top = allMarkets.filter(m => m.series === series && !watchList.some(w => w.ticker === m.ticker))
      .sort((a, b) => b.vol - a.vol).slice(0, 6);
    if (!top.length) return;
    top.forEach(m => trackerRecorder.setMeta(m.ticker, { title: m.title, event: m.event, series: m.series, watchedAt: Date.now() }));
    onSaveWatch([...watchList, ...top.map(m => ({ ticker: m.ticker, title: m.title, event: m.event, series: m.series }))]);
    vault.showToast(`📼 Tracking top ${top.length} ${series} markets`);
  };
  const unwatch = (ticker) => {
    onSaveWatch(watchList.filter(w => w.ticker !== ticker));
    if (sel === ticker) setSel(null);
  };

  const dl = (name, text) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  };

  const selData = sel ? trackerRecorder.series(sel) : null;
  const buckets = useMemo(() => selData ? bucketTrades(selData.tape, 60_000) : [], [selData, trackTick, sel]);
  const patterns = useMemo(() => selData ? detectPatterns(selData) : [], [selData, trackTick, sel]);

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>📼 Market Tracker</span>
          {watchList.length > 0 && <Badge c="#ef4444" glow>● REC {watchList.length}</Badge>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700 }}>SAMPLE EVERY:</span>
          <select value={trackIntervalMs} onChange={e => onSetInterval(Number(e.target.value))} style={{ ...S.inp, width: 70, fontSize: 10, padding: "3px 6px" }}>
            <option value={10000}>10s</option><option value={30000}>30s</option><option value={60000}>60s</option>
          </select>
        </div>
      </div>
      <div style={{ padding: "6px 16px", fontSize: 10, color: "#5a6f8f", borderBottom: "1px solid #14203a", lineHeight: 1.5 }}>
        Watch specific markets or a whole sport — the app records YES/NO prices and every trade print over time. The chart shows the mid path with bid/ask band and per-minute transaction flow; patterns (volume spikes before moves, one-sided taker flow) build the recognition playbook.
      </div>

      {/* Add to watchlist */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid #14203a" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search markets to watch (team, event, ticker)..." style={{ ...S.inp, width: 320, fontSize: 10 }} />
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700 }}>WATCH A SPORT:</span>
          {seriesChips.map(s => <TBtn key={s} onClick={() => watchSeries(s)} color="#6366f1">{s.replace(/^KX/, "")}</TBtn>)}
        </div>
        {searchHits.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 150, overflow: "auto" }}>
          {searchHits.map(m => (
            <div key={m.ticker} onClick={() => { watch(m); setQ(""); }} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 8px", cursor: "pointer", borderRadius: 4, fontSize: 10 }}
              onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ color: "#00e8a4", fontWeight: 700 }}>+ WATCH</span>
              <span style={{ color: "#eaf0f6" }}>{m.event}</span>
              <span style={{ color: "#7a8faa" }}>{m.title}</span>
              <span style={{ color: "#3a4f6f", ...S.m }}>{m.ticker}</span>
              <span style={{ color: "#5a6f8f" }}>vol {m.vol.toLocaleString()}</span>
            </div>
          ))}
        </div>}
      </div>

      {/* Stories relating to games we're in */}
      {matchedStories.length > 0 && <div style={{ padding: "6px 16px", borderBottom: "1px solid #14203a", maxHeight: 118, overflow: "auto", background: "#081018" }}>
        <div style={{ fontSize: 9, color: "#22d3ee", fontWeight: 800, letterSpacing: 1, marginBottom: 3 }}>📰 STORIES FOR YOUR GAMES</div>
        {matchedStories.slice(0, 6).map((st, i) => (
          <div key={i} style={{ fontSize: 10, padding: "2px 0", display: "flex", gap: 6, alignItems: "baseline", overflow: "hidden", whiteSpace: "nowrap" }}>
            <Badge c="#22d3ee" sm>{st.hits[0].label}</Badge>
            {st.link
              ? <a href={st.link} target="_blank" rel="noreferrer" style={{ color: "#c8d6e5", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis" }}>{st.headline}</a>
              : <span style={{ color: "#c8d6e5", overflow: "hidden", textOverflow: "ellipsis" }}>{st.headline}</span>}
            <span style={{ color: "#3a4f6f", fontSize: 9, flexShrink: 0 }}>{st.league}{st.published ? " · " + new Date(st.published).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
          </div>
        ))}
      </div>}

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Watchlist */}
        <div style={{ width: 250, borderRight: "1px solid #14203a", overflow: "auto" }}>
          {watchList.length === 0 ? <Empty icon="📼" text="Nothing watched yet — search above or click a sport chip" /> :
            watchList.map(w => {
              const d = trackerRecorder.series(w.ticker);
              const lastS = d.samples[d.samples.length - 1];
              return (
                <div key={w.ticker} onClick={() => setSel(w.ticker)}
                  style={{ padding: "8px 12px", borderBottom: "1px solid #0d1320", cursor: "pointer", background: sel === w.ticker ? "#0f1728" : "transparent", borderLeft: `2px solid ${sel === w.ticker ? "#ef4444" : "transparent"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span title={(w.event || "") + " — " + (w.title || "") + " (" + w.ticker + ")"} style={{ fontSize: 11, color: "#eaf0f6", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{w.event || w.ticker}</span>
                    <button onClick={e => { e.stopPropagation(); unwatch(w.ticker); }} style={{ background: "none", border: "none", color: "#3a4f6f", cursor: "pointer", fontSize: 10 }}>✕</button>
                  </div>
                  <div title={w.title} style={{ fontSize: 9, color: "#7a8faa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.title}</div>
                  <div style={{ display: "flex", gap: 8, fontSize: 9, marginTop: 3 }}>
                    <span style={{ color: "#e8c547", fontWeight: 700, ...S.m }}>{lastS?.mid != null ? lastS.mid.toFixed(0) + "¢" : "—"}</span>
                    <span style={{ color: "#5a6f8f", ...S.m }}>{d.samples.length} samples</span>
                    <span style={{ color: "#5a6f8f", ...S.m }}>{d.tape.length} prints</span>
                  </div>
                </div>
              );
            })}
        </div>

        {/* Detail */}
        <div style={{ flex: 1, overflow: "auto", padding: "10px 14px" }}>
          {!sel ? <Empty icon="📈" text="Select a watched market to see its recorded history" /> : (() => {
            const meta = selData.meta || {};
            return <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#eaf0f6" }}>{meta.event || sel}</span>
                  <span style={{ fontSize: 10, color: "#7a8faa", marginLeft: 8 }}>{meta.title}</span>
                  <span style={{ fontSize: 9, color: "#3a4f6f", marginLeft: 8, ...S.m }}>{sel}</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => { const m = allMarkets.find(x => x.ticker === sel); if (m) onSel(m.market); }} style={{ background: "#00e8a412", border: "1px solid #00e8a430", borderRadius: 4, padding: "3px 10px", color: "#00e8a4", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>TRADE</button>
                  <button onClick={() => dl(`${sel}-prices.csv`, trackerRecorder.toCSV(sel))} style={{ background: "#14203a", border: "1px solid #14203a", borderRadius: 4, padding: "3px 10px", color: "#7a8faa", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>💾 PRICES CSV</button>
                  <button onClick={() => dl(`${sel}-tape.csv`, trackerRecorder.tapeCSV(sel))} style={{ background: "#14203a", border: "1px solid #14203a", borderRadius: 4, padding: "3px 10px", color: "#7a8faa", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>💾 TAPE CSV</button>
                </div>
              </div>

              <TrackChart samples={selData.samples} buckets={buckets} />

              {/* Lookback: what was this trading at 24h ago? */}
              {(() => {
                const last = selData.samples[selData.samples.length - 1];
                const ago = snapshotStore.at(sel, Date.now() - 24 * 3600_000) || trackerRecorder.sampleAt(sel, Date.now() - 24 * 3600_000);
                const hist = snapshotStore.history(sel);
                return <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    {[
                      { label: "NOW", value: last?.mid != null ? last.mid.toFixed(0) + "¢" : "—", c: "#e8c547" },
                      { label: "24H AGO", value: ago?.mid != null ? ago.mid.toFixed(0) + "¢" : "—", c: "#7a8faa" },
                      { label: "Δ 24H", value: last?.mid != null && ago?.mid != null ? `${last.mid - ago.mid >= 0 ? "+" : ""}${(last.mid - ago.mid).toFixed(0)}¢` : "—", c: last?.mid >= (ago?.mid ?? 0) ? "#00e8a4" : "#ef4444" },
                      { label: "VOL NOW / 24H AGO", value: `${(last?.vol ?? 0).toLocaleString()} / ${(ago?.vol ?? 0).toLocaleString()}`, c: "#6366f1" },
                    ].map((s, i) => (
                      <div key={i} style={{ background: "#0a0f1a", border: "1px solid #14203a", borderRadius: 8, padding: "8px 14px" }}>
                        <div style={{ fontSize: 8, color: "#5a6f8f", fontWeight: 700, letterSpacing: 0.5 }}>{s.label}</div>
                        <div style={{ fontSize: 14, color: s.c, fontWeight: 800, ...S.m }}>{s.value}</div>
                      </div>
                    ))}
                  </div>
                  {hist.length > 1 && <>
                    <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "10px 0 4px" }}>HOURLY SNAPSHOT HISTORY (all loaded markets are snapshotted hourly — 72h retention)</div>
                    <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                      {hist.slice(-24).map((h, i) => (
                        <div key={i} title={new Date(h.t).toLocaleString()} style={{ background: "#070c17", border: "1px solid #14203a", borderRadius: 4, padding: "3px 7px", fontSize: 9, ...S.m }}>
                          <span style={{ color: "#3a4f6f" }}>{new Date(h.t).toLocaleTimeString(undefined, { hour: "numeric" })}</span>{" "}
                          <span style={{ color: "#e8c547", fontWeight: 700 }}>{h.mid}¢</span>
                        </div>
                      ))}
                    </div>
                  </>}
                </>;
              })()}

              {/* Bot read: who's in this tape and how to beat them */}
              {(() => {
                const { detections, actors } = detectBots(selData.tape);
                if (!detections.length && !actors.length) return null;
                return <>
                  <div style={{ fontSize: 9, color: "#ef4444", fontWeight: 800, letterSpacing: 1, margin: "12px 0 4px" }}>🤖 BOT READ — WHO'S IN THIS TAPE</div>
                  {detections.map((d, i) => (
                    <div key={i} style={{ background: "#0a0f1a", border: "1px solid #14203a", borderRadius: 8, padding: "8px 12px", marginBottom: 5 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Badge c="#ef4444" glow={d.confidence >= 80}>{d.type.replace(/_/g, " ")}</Badge>
                        <Badge c="#5a6f8f" sm>{d.confidence}%</Badge>
                        <span style={{ fontSize: 10, color: "#7a8faa" }}>{d.evidence}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "#00e8a4", marginTop: 4, lineHeight: 1.5 }}>⚔ COUNTER: {d.tactic}</div>
                    </div>
                  ))}
                  {actors.length > 0 && <div style={{ fontSize: 9, color: "#5a6f8f", marginTop: 2 }}>
                    Recurring actors (by size signature): {actors.slice(0, 5).map(a => `${a.label} ×${a.prints}${a.clockwork ? " ⏱" : ""}`).join(" · ")}
                  </div>}
                </>;
              })()}

              {patterns.length > 0 && <>
                <div style={{ fontSize: 9, color: "#f59e0b", fontWeight: 800, letterSpacing: 1, margin: "12px 0 4px" }}>⚠ PATTERNS DETECTED</div>
                {patterns.slice(0, 8).map((p, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 10 }}>
                    <Badge c={p.type === "VOLUME_SPIKE" ? "#ef4444" : p.type === "PRICE_JUMP" ? "#e8c547" : "#6366f1"} sm>{p.type.replace(/_/g, " ")}</Badge>
                    <span style={{ color: "#3a4f6f", ...S.m }}>{new Date(p.time).toLocaleTimeString()}</span>
                    <span style={{ color: "#c8d6e5" }}>{p.desc}</span>
                  </div>
                ))}
              </>}

              <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, margin: "12px 0 4px" }}>TRADE TAPE (latest {Math.min(25, selData.tape.length)})</div>
              {selData.tape.length === 0 ? <div style={{ fontSize: 10, color: "#3a4f6f" }}>No prints captured yet.</div> :
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Time", "Taker", "Price", "Contracts", "Notional"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>{[...selData.tape].slice(-25).reverse().map((x, i) => (
                    <tr key={i}>
                      <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 10 }}>{new Date(x.t).toLocaleTimeString()}</td>
                      <td style={S.td}><Badge c={x.taker === "yes" ? "#00e8a4" : x.taker === "no" ? "#ef4444" : "#5a6f8f"} sm>{String(x.taker).toUpperCase()}</Badge></td>
                      <td style={{ ...S.td, ...S.m, color: "#e8c547", fontWeight: 700 }}>{x.price}¢</td>
                      <td style={{ ...S.td, ...S.m, color: "#c8d6e5" }}>{x.count.toLocaleString()}</td>
                      <td style={{ ...S.td, ...S.m, color: "#7a8faa" }}>${(x.notionalCents / 100).toFixed(2)}</td>
                    </tr>
                  ))}</tbody>
                </table>}
            </>;
          })()}
        </div>
      </div>
    </div>
  );
}

// ─── Data bundle export ──────────────────────────────────────
// Packages every recorded dataset (never the encrypted vault) so it
// can be filed into the repo's data/ folder via `npm run data:import`.
function exportDataBundle(profile) {
  const read = (key) => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } };
  const bundle = {
    kind: "kalshi-data-bundle", version: 1,
    profile, appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
    datasets: {
      journal: read(JOURNAL_STORAGE_KEY),
      tracker: read(TRACKER_STORAGE_KEY),
      snapshots: read(SNAPSHOT_STORAGE_KEY),
      sheetwatch: read(SHEETWATCH_STORAGE_KEY),
      watchlist: read("kalshi_watchlist"),
      favorites: read("kalshi_favorites"),
      settings: read(`kalshi_settings_v1__${profile}`),
    },
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
  a.download = `kalshi-data-${profile}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════════════════
// SETTINGS PAGE — every detection threshold, tunable per profile
// ═══════════════════════════════════════════════════════════════
function SettingsModule({ settings, onSave, profile }) {
  const vault = useVault();
  const fileRef = useRef(null);
  const dirty = (f) => settings[f.key] !== f.default;

  const setField = (key, raw) => {
    const v = clampSetting(key, raw);
    if (v == null) return;
    onSave({ ...settings, [key]: v });
  };

  const resetGroup = (g) => {
    const next = { ...settings };
    g.fields.forEach(f => { next[f.key] = f.default; });
    onSave(next);
  };

  const exportPreset = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ kind: "kalshi-settings-preset", profile, savedAt: new Date().toISOString(), settings }, null, 2)], { type: "application/json" }));
    a.download = `kalshi-settings-${profile}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  const importPreset = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        onSave(mergeSettings(parsed.settings || parsed));
        vault.showToast("Preset imported and clamped to valid ranges");
      } catch { vault.showToast("Invalid preset file", "error"); }
    };
    reader.readAsText(file);
  };

  const changedCount = SETTINGS_SCHEMA.flatMap(g => g.fields).filter(dirty).length;

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>⚙️ Detection Settings</span>
          <Badge c="#6366f1">👤 {profile}</Badge>
          {changedCount > 0 && <Badge c="#e8c547" glow>{changedCount} CUSTOMIZED</Badge>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => fileRef.current?.click()} style={{ background: "#14203a", border: "1px solid #14203a", borderRadius: 6, padding: "5px 12px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>📂 IMPORT PRESET</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={e => { if (e.target.files?.[0]) importPreset(e.target.files[0]); e.target.value = ""; }} />
          <button onClick={exportPreset} style={{ background: "#14203a", border: "1px solid #14203a", borderRadius: 6, padding: "5px 12px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>💾 EXPORT PRESET</button>
          <button onClick={() => onSave(defaultSettings())} style={{ background: "#ef444415", border: "1px solid #ef444440", borderRadius: 6, padding: "5px 12px", color: "#ef4444", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>RESET ALL</button>
        </div>
      </div>
      <div style={{ padding: "6px 16px", fontSize: 10, color: "#5a6f8f", borderBottom: "1px solid #14203a", lineHeight: 1.5 }}>
        Every price band, threshold and variable the scanner uses — tuned per login and applied instantly. Changes affect what signals fire, what gets journaled, and the order-form prefills. Export a preset to share a tuned methodology between users; values are always clamped to their valid ranges.
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "10px 16px", maxWidth: 860 }}>
        {SETTINGS_SCHEMA.map(g => (
          <div key={g.id} style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid #14203a", paddingBottom: 4, marginBottom: 8 }}>
              <div>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#eaf0f6" }}>{g.icon} {g.label}</span>
                <span style={{ fontSize: 10, color: "#5a6f8f", marginLeft: 10 }}>{g.desc}</span>
              </div>
              {g.fields.some(dirty) && <button onClick={() => resetGroup(g)} style={{ background: "none", border: "none", color: "#5a6f8f", fontSize: 9, cursor: "pointer", textDecoration: "underline" }}>reset group</button>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: "8px 24px" }}>
              {g.fields.map(f => (
                <div key={f.key} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input type="number" value={settings[f.key]} min={f.min} max={f.max} step={f.step}
                        onChange={e => setField(f.key, e.target.value)}
                        style={{ ...S.inp, width: 76, fontSize: 12, padding: "5px 8px", textAlign: "right", fontWeight: 700, color: dirty(f) ? "#e8c547" : "#eaf0f6", border: `1px solid ${dirty(f) ? "#e8c54740" : "#14203a"}` }} />
                      <span style={{ fontSize: 9, color: "#5a6f8f", width: 56 }}>{f.unit}</span>
                    </div>
                    {dirty(f) && <button onClick={() => setField(f.key, f.default)} style={{ background: "none", border: "none", color: "#3a4f6f", fontSize: 8, cursor: "pointer", padding: 0, marginTop: 2 }}>default: {f.default}</button>}
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "#c8d6e5", fontWeight: 700 }}>{f.label} <span style={{ color: "#3a4f6f", fontWeight: 400, fontSize: 9 }}>({f.min}–{f.max})</span></div>
                    <div style={{ fontSize: 10, color: "#5a6f8f", lineHeight: 1.45 }}>{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// JOURNAL PAGE — the learning database: every signal, scored
// ═══════════════════════════════════════════════════════════════
function JournalModule({ changeTick }) {
  const vault = useVault();
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  void changeTick; // re-render when the journal updates

  const stats = useMemo(() => signalJournal.stats(), [changeTick]);
  const entries = useMemo(() => signalJournal.list({
    type: typeFilter === "ALL" ? null : typeFilter,
    status: statusFilter === "ALL" ? null : statusFilter.toLowerCase(),
  }), [typeFilter, statusFilter, changeTick]);

  const totals = useMemo(() => {
    const all = signalJournal.list();
    const settled = all.filter(e => e.status === "settled");
    const wins = settled.filter(e => e.outcome?.won).length;
    const pnl = settled.reduce((s, e) => s + (e.outcome?.pnlCents || 0), 0);
    return { n: all.length, open: all.filter(e => e.status === "open").length, settled: settled.length, wins, pnl };
  }, [changeTick]);

  const types = useMemo(() => ["ALL", ...new Set(signalJournal.list().map(e => e.type))], [changeTick]);

  const dl = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([signalJournal.toCSV()], { type: "text/csv" }));
    a.download = `kalshi-signal-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  const statusColor = { open: "#f59e0b", settled: "#00e8a4", expired: "#3a4f6f" };

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>📓 Signal Journal</span>
          <Badge c="#6366f1">{totals.n} SIGNALS</Badge>
          <Badge c="#f59e0b" sm>{totals.open} OPEN</Badge>
          {totals.settled > 0 && <Badge c={totals.pnl >= 0 ? "#00e8a4" : "#ef4444"} glow>
            {totals.settled} SETTLED · {Math.round(totals.wins / totals.settled * 100)}% · {totals.pnl >= 0 ? "+" : ""}${(totals.pnl / 100).toFixed(2)}/ct
          </Badge>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={dl} style={{ background: "#14203a", border: "1px solid #14203a", borderRadius: 6, padding: "5px 12px", color: "#7a8faa", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>💾 EXPORT CSV</button>
          <button onClick={() => { exportDataBundle(vault.profile); vault.showToast("Data bundle downloaded — run: npm run data:import -- <file> --commit"); }}
            title="Everything recorded (journal, tracker, snapshots, sheet changes, watchlist, settings — never your keys) in one file. npm run data:import files it into the repo's data/ folder."
            style={{ background: "#00e8a415", border: "1px solid #00e8a430", borderRadius: 6, padding: "5px 12px", color: "#00e8a4", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>⬇ DATA BUNDLE → REPO</button>
        </div>
      </div>
      <div style={{ padding: "6px 16px", fontSize: 10, color: "#5a6f8f", borderBottom: "1px solid #14203a", lineHeight: 1.5 }}>
        Every signal the scanner emits is logged at first sighting and scored automatically: <b>convergence</b> (did the price move toward the predicted fair value — the middleman thesis, measured) and <b>P&L</b> (what acting at the suggested price paid after fees, once the market settles). This table is what tunes the thresholds per sport before NFL/NBA season.
      </div>

      {/* Learning table: per type/tier */}
      {stats.length > 0 && <div style={{ padding: "8px 16px", borderBottom: "1px solid #14203a" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Signal Type", "Logged", "Open", "Settled", "Win %", "Avg P&L", "Avg Convergence"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>{stats.map((s, i) => (
            <tr key={i}>
              <td style={{ ...S.td, color: "#eaf0f6", fontWeight: 700, fontSize: 11 }}>{s.group.replace(/_/g, " ")}</td>
              <td style={{ ...S.td, ...S.m, color: "#c8d6e5" }}>{s.n}</td>
              <td style={{ ...S.td, ...S.m, color: "#f59e0b" }}>{s.open}</td>
              <td style={{ ...S.td, ...S.m, color: "#7a8faa" }}>{s.settled}</td>
              <td style={{ ...S.td, ...S.m, color: s.winRatePct == null ? "#3a4f6f" : s.winRatePct >= 55 ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{s.winRatePct != null ? s.winRatePct + "%" : "—"}</td>
              <td style={{ ...S.td, ...S.m, color: s.avgPnlCents == null ? "#3a4f6f" : s.avgPnlCents >= 0 ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{s.avgPnlCents != null ? (s.avgPnlCents >= 0 ? "+" : "") + s.avgPnlCents.toFixed(1) + "¢" : "—"}</td>
              <td style={{ ...S.td, ...S.m, color: s.avgConvergenceCents == null ? "#3a4f6f" : s.avgConvergenceCents >= 0 ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{s.avgConvergenceCents != null ? (s.avgConvergenceCents >= 0 ? "+" : "") + s.avgConvergenceCents.toFixed(1) + "¢" : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>}

      {/* Filters + signal rows */}
      <div style={{ padding: "6px 16px", display: "flex", gap: 4, flexWrap: "wrap", borderBottom: "1px solid #14203a" }}>
        {types.map(t => <TBtn key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)} color="#6366f1">{t.replace(/_/g, " ")}</TBtn>)}
        <span style={{ width: 10 }} />
        {["ALL", "OPEN", "SETTLED", "EXPIRED"].map(s => <TBtn key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} color="#f59e0b">{s}</TBtn>)}
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {entries.length === 0 ? <Empty icon="📓" text="No signals journaled yet — they log automatically as the scanner runs" /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["First Seen", "Type", "Game", "Entry", "Now", "Target", "Converge", "Status", "P&L"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{entries.slice(0, 200).map((e, i) => {
              const conv = signalJournal.convergenceCents(e);
              return (
                <tr key={e.key + i}>
                  <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 10, whiteSpace: "nowrap" }}>{new Date(e.firstSeen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td style={S.td}><Badge c="#6366f1" sm>{e.type.replace(/_/g, " ")}{e.tier ? "/" + e.tier : ""}</Badge></td>
                  <td style={{ ...S.td, color: "#eaf0f6", fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${e.game}\n${e.ticker}`}>{e.game}</td>
                  <td style={{ ...S.td, ...S.m, fontSize: 10 }}><span style={{ color: e.side === "yes" ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{e.side.toUpperCase()}</span> <span style={{ color: "#e8c547" }}>@{e.price}¢</span> <span style={{ color: "#3a4f6f" }}>mid {e.entryMid?.toFixed(0)}</span></td>
                  <td style={{ ...S.td, ...S.m, color: "#c8d6e5", fontWeight: 700 }}>{e.lastMid != null ? e.lastMid.toFixed(0) + "¢" : "—"}</td>
                  <td style={{ ...S.td, ...S.m, color: "#7a8faa" }}>{e.targetCents != null ? e.targetCents.toFixed(0) + "¢" : "—"}</td>
                  <td style={{ ...S.td, ...S.m, color: conv == null ? "#3a4f6f" : conv >= 0 ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{conv != null ? (conv >= 0 ? "+" : "") + conv.toFixed(1) + "¢" : "—"}</td>
                  <td style={S.td}><Badge c={statusColor[e.status] || "#5a6f8f"} sm>{e.status.toUpperCase()}</Badge></td>
                  <td style={{ ...S.td, ...S.m, fontWeight: 800, color: e.outcome ? (e.outcome.pnlCents >= 0 ? "#00e8a4" : "#ef4444") : "#3a4f6f" }}>{e.outcome ? (e.outcome.pnlCents >= 0 ? "+" : "") + e.outcome.pnlCents + "¢" : "—"}</td>
                </tr>
              );
            })}</tbody>
          </table>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// FRESH MARKETS PAGE — markets Kalshi listed in the last 24/48h
// (typically 24-48h before game time; early books are thin)
// ═══════════════════════════════════════════════════════════════
function FreshMarketsModule({ kalshi, onSel, onFav, isFav, settings = defaultSettings() }) {
  const [windowH, setWindowH] = useState(settings["volume.freshWindowHours"]);
  const [unpricedOnly, setUnpricedOnly] = useState(false);
  const [q, setQ] = useState("");
  const fresh = useMemo(() => findFreshMarkets(kalshi, { maxAgeHours: windowH }), [kalshi, windowH]);
  const rows = useMemo(() => fresh.filter(r =>
    (!unpricedOnly || r.unpriced) &&
    (!q || `${r.event} ${r.title} ${r.ticker}`.toLowerCase().includes(q.toLowerCase()))
  ), [fresh, unpricedOnly, q]);
  const fmtH = h => h == null ? "—" : h < 0 ? `${Math.abs(h).toFixed(0)}h ago` : h < 48 ? `in ${h.toFixed(0)}h` : `in ${(h / 24).toFixed(0)}d`;

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>🆕 New Markets</span>
          <Badge c="#6366f1" glow={rows.length > 0}>{rows.length}</Badge>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700 }}>LISTED WITHIN:</span>
          {[...new Set([24, 48, settings["volume.freshWindowHours"]])].sort((a, b) => a - b).map(h => <TBtn key={h} active={windowH === h} onClick={() => setWindowH(h)} color="#6366f1">{h}H</TBtn>)}
          <TBtn active={unpricedOnly} onClick={() => setUnpricedOnly(v => !v)} color="#f59e0b">UNPRICED BOOKS</TBtn>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter..." style={{ ...S.inp, width: 140, fontSize: 10, padding: "4px 8px" }} />
        </div>
      </div>
      <div style={{ padding: "6px 16px", fontSize: 10, color: "#5a6f8f", borderBottom: "1px solid #14203a", lineHeight: 1.5 }}>
        Kalshi typically lists game markets 24–48h before start. Early books are thin — wide or empty spreads are where early limit orders capture value before market makers arrive.
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {rows.length === 0 ? <Empty icon="🆕" text={`No markets listed in the last ${windowH}h${unpricedOnly ? " with unpriced books" : ""}`} /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Listed", "Game Time", "Bid/Ask", "Spread", "Vol", "Event", "Market", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 100).map((r, i) => (
              <tr key={r.ticker + i} style={{ cursor: "pointer" }} onClick={() => onSel(r.market)}
                onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <td style={{ ...S.td, ...S.m, color: "#6366f1", fontWeight: 700 }}>{r.ageHours.toFixed(0)}h ago</td>
                <td style={{ ...S.td, ...S.m, color: r.hoursToGame != null && r.hoursToGame < 0 ? "#ef4444" : "#7a8faa", fontSize: 11 }}>{fmtH(r.hoursToGame)}</td>
                <td style={{ ...S.td, ...S.m }}><span style={{ color: "#00e8a4" }}>{r.bid || "—"}</span>/<span style={{ color: "#ef4444" }}>{r.ask || "—"}</span></td>
                <td style={{ ...S.td, ...S.m, color: r.unpriced ? "#f59e0b" : "#5a6f8f", fontWeight: r.unpriced ? 800 : 400 }}>{r.spread != null ? r.spread + "¢" : "—"}{r.unpriced ? " ⚠" : ""}</td>
                <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{r.vol.toLocaleString()}</td>
                <td title={r.event} style={{ ...S.td, color: "#eaf0f6", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.event}</td>
                <td title={r.title} style={{ ...S.td, color: "#7a8faa", fontSize: 11, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</td>
                <td style={S.td}>
                  <button onClick={e => { e.stopPropagation(); onSel(r.market); }} style={{ background: "#6366f112", border: "1px solid #6366f130", borderRadius: 4, padding: "2px 10px", color: "#6366f1", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>TRADE</button>
                  {onFav && <button onClick={e => { e.stopPropagation(); onFav({ ...r.market, eventTitle: r.event }); }} style={{ background: "transparent", border: "1px solid #14203a", borderRadius: 4, padding: "2px 6px", color: isFav?.(r.ticker) ? "#f59e0b" : "#3a4f6f", fontSize: 10, cursor: "pointer", marginLeft: 4 }}>{isFav?.(r.ticker) ? "★" : "☆"}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// LIVE PAGE — settlement lags (event already decided per ESPN but the
// market still sells) + near-certain in-game watchlist
// ═══════════════════════════════════════════════════════════════
function LiveModule({ kalshi, espn, onSel, onTradeSuggest, lastRefresh, settings = defaultSettings() }) {
  const lags = useMemo(() => findSettlementLags(kalshi, espn, liveOpts(settings)), [kalshi, espn, settings]);
  const near = useMemo(() => findNearCertain(kalshi, liveOpts(settings)), [kalshi, settings]);
  const liveGames = useMemo(() => espn.filter(g => espnGameState(g) === "live"), [espn]);

  const tradeLag = (lag) => {
    onSel(lag.market);
    if (onTradeSuggest) onTradeSuggest({ paired: false, side: lag.side, action: lag.action, price: String(lag.price), qty: String(settings["trade.defaultQty"]), desc: lag.desc });
  };

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>🔴 Live Settlement Watch</span>
          {lags.length > 0 && <Badge c="#ef4444" glow>{lags.length} LAG{lags.length > 1 ? "S" : ""}</Badge>}
          <Badge c="#f59e0b" sm>{liveGames.length} GAMES LIVE</Badge>
        </div>
        {lastRefresh && <span style={{ fontSize: 9, color: "#3a4f6f", ...S.m }}>auto-refreshing · last {new Date(lastRefresh).toLocaleTimeString()}</span>}
      </div>
      <div style={{ padding: "6px 16px", fontSize: 10, color: "#5a6f8f", borderBottom: "1px solid #14203a", lineHeight: 1.5 }}>
        The seconds-to-minutes window after something happens on the field but before the market catches up: ESPN-confirmed finals still selling below 97¢, plus the in-game near-certain watchlist (80–96¢). Speed matters — verify the book before firing.
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {/* Settlement lags — the actionable list */}
        <div style={{ padding: "10px 16px 4px", fontSize: 9, color: "#ef4444", fontWeight: 800, letterSpacing: 1 }}>⚡ SETTLEMENT LAGS — ESPN SAYS FINAL, MARKET STILL SELLING</div>
        {lags.length === 0 ? <div style={{ padding: "8px 16px 16px", fontSize: 10, color: "#3a4f6f" }}>None right now. These appear within seconds of a final whistle and vanish fast — keep this tab open during game windows.</div> :
          lags.map((lag, i) => (
            <div key={i} style={{ margin: "6px 12px", padding: "10px 14px", background: "#170b0b", border: "1px solid #ef444440", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Badge c="#ef4444" glow>{lag.kind === "WINNER_UNDERPRICED" ? "WINNER CHEAP" : "LOSER RICH"}</Badge>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#eaf0f6" }}>{lag.game}</span>
                  <Badge c="#00e8a4" sm>{lag.score}</Badge>
                  <Badge c="#e8c547" glow>+{lag.edge}¢</Badge>
                </div>
                <button onClick={() => tradeLag(lag)} style={{ background: "linear-gradient(135deg,#ef4444,#dc2626)", border: "none", borderRadius: 6, padding: "5px 16px", color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer", ...S.m }}>
                  BUY {lag.side.toUpperCase()} @{lag.price}¢ →
                </button>
              </div>
              <div style={{ fontSize: 10, color: "#c8a0a0", marginTop: 5, lineHeight: 1.5 }}>{lag.desc}</div>
            </div>
          ))}

        {/* Near-certain watchlist */}
        <div style={{ padding: "14px 16px 4px", fontSize: 9, color: "#f59e0b", fontWeight: 800, letterSpacing: 1 }}>👁 NEAR-CERTAIN IN-GAME (80–96¢) — WATCH FOR THE DECIDING MOMENT</div>
        {near.length === 0 ? <div style={{ padding: "8px 16px", fontSize: 10, color: "#3a4f6f" }}>No in-game markets in the 80–96¢ band right now.</div> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Mid", "Bid/Ask", "Left on Table", "24h Vol", "Event", "Market", ""].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{near.slice(0, 40).map((r, i) => (
              <tr key={r.ticker + i} style={{ cursor: "pointer" }} onClick={() => onSel(r.market)}
                onMouseEnter={e => e.currentTarget.style.background = "#0f1728"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <td style={{ ...S.td, ...S.m, color: r.mid >= 92 ? "#ef4444" : "#f59e0b", fontWeight: 800 }}>{r.mid.toFixed(0)}¢</td>
                <td style={{ ...S.td, ...S.m }}><span style={{ color: "#00e8a4" }}>{r.bid}</span>/<span style={{ color: "#ef4444" }}>{r.ask}</span></td>
                <td style={{ ...S.td, ...S.m, color: "#e8c547", fontWeight: 700 }}>{r.captureCents}¢</td>
                <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 11 }}>{r.vol24h.toLocaleString()}</td>
                <td title={r.event} style={{ ...S.td, color: "#eaf0f6", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.event}</td>
                <td title={r.title} style={{ ...S.td, color: "#7a8faa", fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</td>
                <td style={S.td}><button onClick={e => { e.stopPropagation(); onSel(r.market); }} style={{ background: "#f59e0b12", border: "1px solid #f59e0b30", borderRadius: 4, padding: "2px 10px", color: "#f59e0b", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>BOOK</button></td>
              </tr>
            ))}</tbody>
          </table>}

        {/* Live ESPN games for context */}
        {liveGames.length > 0 && <>
          <div style={{ padding: "14px 16px 4px", fontSize: 9, color: "#3a4f6f", fontWeight: 800, letterSpacing: 1 }}>LIVE GAMES (ESPN)</div>
          <div style={{ padding: "4px 16px 16px", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {liveGames.slice(0, 20).map((g, i) => (
              <div key={i} style={{ background: "#0a0f1a", border: "1px solid #14203a", borderRadius: 6, padding: "6px 10px", fontSize: 10 }}>
                <span style={{ color: "#eaf0f6", fontWeight: 700 }}>{g.competitors?.map(c => `${c.abbr} ${c.score ?? ""}`).join(" — ")}</span>
                <span style={{ color: "#f59e0b", marginLeft: 6 }}>{g.statusDetail || g.status}</span>
              </div>
            ))}
          </div>
        </>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MENTOR PAGE — ingest the methodology creator's Kalshi fills and
// Google Sheet, and distill his trading patterns
// ═══════════════════════════════════════════════════════════════
function MentorModule({ sheetTrackOn, onToggleSheetTrack, changeTick }) {
  const vault = useVault();
  void changeTick; // re-render signal when the sheet watcher logs changes
  const [fills, setFills] = useState(null);
  const [profile, setProfile] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [sheetUrl, setSheetUrl] = useState(() => vault.getKey("mentor_sheet_csv_url") || "");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const mk = vault.getKey("mentor_kalshi_api_key");
  const mp = vault.getKey("mentor_kalshi_private_key");

  const loadFills = async () => {
    setErr(""); setBusy("fills");
    try {
      if (!mk || !mp) throw new Error("Add the mentor's Kalshi API key + RSA private key in the Vault tab first (mentor_kalshi_api_key / mentor_kalshi_private_key).");
      const data = await kalshiAuthFetch("/portfolio/fills?limit=200", "GET", null, mk, mp);
      const norm = normalizeFills(data.fills || []);
      setFills(norm);
      setProfile(analyzeFills(norm));
    } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  };

  const loadSheet = async () => {
    setErr(""); setBusy("sheet");
    try {
      if (!sheetUrl) throw new Error("Paste his published Google Sheet CSV link (File → Share → Publish to web → CSV).");
      // Route docs.google.com through the dev proxy to dodge CORS.
      const url = sheetUrl.replace(/^https:\/\/docs\.google\.com/, "/gsheet");
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`Sheet fetch failed: HTTP ${r.status}`);
      const rows = parseCSV(await r.text());
      setSheet({ rows, summary: summarizeSheet(rows) });
      vault.setKey("mentor_sheet_csv_url", sheetUrl);
    } catch (e) { setErr(String(e.message || e)); }
    setBusy("");
  };

  const Stat = ({ label, value, c = "#eaf0f6" }) => (
    <div style={{ background: "#0a0f1a", border: "1px solid #14203a", borderRadius: 8, padding: "10px 14px", minWidth: 110 }}>
      <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 700, letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 16, color: c, fontWeight: 800, marginTop: 2, ...S.m }}>{value ?? "—"}</div>
    </div>
  );

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={{ ...S.hdr, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>🧭 Methodology Mirror</span>
          {profile?.count > 0 && <Badge c="#00e8a4">{profile.count} FILLS ANALYZED</Badge>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={loadFills} disabled={busy === "fills"} style={{ background: "#00e8a415", border: "1px solid #00e8a430", borderRadius: 6, padding: "5px 14px", color: "#00e8a4", fontSize: 10, fontWeight: 800, cursor: "pointer", ...S.m }}>{busy === "fills" ? "LOADING..." : "⟳ LOAD HIS FILLS"}</button>
        </div>
      </div>
      <div style={{ padding: "6px 16px", fontSize: 10, color: "#5a6f8f", borderBottom: "1px solid #14203a", lineHeight: 1.5 }}>
        Ingests the methodology creator's Kalshi fills and Google Sheet to profile how he actually trades — entry prices, timing vs game start, series bias, hold times — so the scanner's signals can be tuned to mirror his edge.
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
        {err && <div style={{ padding: "8px 12px", background: "#170b0b", border: "1px solid #ef444440", borderRadius: 6, color: "#ef4444", fontSize: 11, marginBottom: 10 }}>{err}</div>}
        {!mk && <div style={{ padding: "8px 12px", background: "#14140b", border: "1px solid #f59e0b40", borderRadius: 6, color: "#f59e0b", fontSize: 11, marginBottom: 10 }}>
          Setup: he logs in with his own vault profile, or you add his read-only keys under <b>mentor_kalshi_api_key</b> / <b>mentor_kalshi_private_key</b> in the 🔐 Vault tab.
        </div>}

        {profile?.count > 0 && <>
          <div style={{ fontSize: 9, color: "#00e8a4", fontWeight: 800, letterSpacing: 1, marginBottom: 8 }}>TRADING PROFILE</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            <Stat label="FILLS" value={profile.count} />
            <Stat label="CONTRACTS" value={profile.totalContracts?.toLocaleString()} />
            <Stat label="TAKER %" value={profile.takerPct + "%"} c={profile.takerPct > 60 ? "#ef4444" : "#00e8a4"} />
            <Stat label="BUY %" value={profile.buyPct + "%"} />
            <Stat label="YES SIDE %" value={profile.yesPct + "%"} />
            <Stat label="MEDIAN ENTRY" value={profile.medianEntryCents != null ? profile.medianEntryCents + "¢" : "—"} c="#e8c547" />
            <Stat label="MEDIAN HRS BEFORE GAME" value={profile.medianHoursBeforeGame != null ? profile.medianHoursBeforeGame.toFixed(1) + "h" : "—"} c="#6366f1" />
            <Stat label="ROUND TRIPS" value={profile.roundTrips?.length} />
            <Stat label="WIN RATE" value={profile.winRatePct != null ? profile.winRatePct + "%" : "—"} c="#00e8a4" />
            <Stat label="REALIZED P&L" value={profile.realizedPnlCents != null ? "$" + (profile.realizedPnlCents / 100).toFixed(2) : "—"} c={profile.realizedPnlCents >= 0 ? "#00e8a4" : "#ef4444"} />
            <Stat label="MEDIAN HOLD" value={profile.medianHoldHours != null ? profile.medianHoldHours.toFixed(1) + "h" : "—"} />
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>WHERE HE TRADES</div>
              {profile.bySeries.slice(0, 8).map(([s, n]) => (
                <div key={s} style={{ display: "flex", gap: 8, fontSize: 10, padding: "2px 0" }}>
                  <span style={{ color: "#c8d6e5", width: 150, ...S.m }}>{s}</span>
                  <span style={{ color: "#00e8a4", fontWeight: 700 }}>{n}</span>
                  <span style={{ color: "#1e3050" }}>{"█".repeat(Math.min(30, Math.ceil(n / profile.count * 60)))}</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>ENTRY PRICE DISTRIBUTION</div>
              {Object.entries(profile.priceBuckets).map(([b, n]) => (
                <div key={b} style={{ display: "flex", gap: 8, fontSize: 10, padding: "2px 0" }}>
                  <span style={{ color: "#c8d6e5", width: 60, ...S.m }}>{b}</span>
                  <span style={{ color: "#e8c547", fontWeight: 700 }}>{n}</span>
                  <span style={{ color: "#1e3050" }}>{"█".repeat(Math.min(30, Math.ceil(n / profile.count * 60)))}</span>
                </div>
              ))}
            </div>
          </div>
          {profile.roundTrips?.length > 0 && <>
            <div style={{ fontSize: 9, color: "#5a6f8f", fontWeight: 800, letterSpacing: 1, marginBottom: 6 }}>ROUND TRIPS (entry → exit)</div>
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14 }}>
              <thead><tr>{["Ticker", "Side", "Entry", "Exit", "Hold", "P&L"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>{profile.roundTrips.slice(0, 20).map((rt, i) => (
                <tr key={i}>
                  <td style={{ ...S.td, ...S.m, color: "#c8d6e5", fontSize: 10 }}>{rt.ticker}</td>
                  <td style={{ ...S.td, color: "#7a8faa", fontSize: 10 }}>{rt.side.toUpperCase()}</td>
                  <td style={{ ...S.td, ...S.m, color: "#00e8a4" }}>{rt.entry}¢</td>
                  <td style={{ ...S.td, ...S.m, color: "#ef4444" }}>{rt.exit}¢</td>
                  <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 10 }}>{rt.holdHours.toFixed(1)}h</td>
                  <td style={{ ...S.td, ...S.m, color: rt.pnlCents >= 0 ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{rt.pnlCents >= 0 ? "+" : ""}{(rt.pnlCents / 100).toFixed(2)}$</td>
                </tr>
              ))}</tbody>
            </table>
          </>}
        </>}

        <div style={{ fontSize: 9, color: "#6366f1", fontWeight: 800, letterSpacing: 1, margin: "8px 0 6px" }}>GOOGLE SHEET CALCULATIONS</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <input value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} placeholder="Published CSV link (File → Share → Publish to web → CSV)..." style={{ ...S.inp, flex: 1, fontSize: 10 }} />
          <button onClick={loadSheet} disabled={busy === "sheet"} style={{ background: "#6366f115", border: "1px solid #6366f130", borderRadius: 6, padding: "5px 14px", color: "#6366f1", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>{busy === "sheet" ? "LOADING..." : "INGEST SHEET"}</button>
          <button onClick={onToggleSheetTrack} style={{ background: sheetTrackOn ? "#ef444420" : "#14203a", border: `1px solid ${sheetTrackOn ? "#ef444450" : "#14203a"}`, borderRadius: 6, padding: "5px 14px", color: sheetTrackOn ? "#ef4444" : "#7a8faa", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>{sheetTrackOn ? "● TRACKING CHANGES" : "TRACK CHANGES"}</button>
        </div>

        {/* His modifications over time */}
        {(sheetTrackOn || sheetWatcher.recentChanges(1).length > 0) && <>
          <div style={{ fontSize: 9, color: "#e8c547", fontWeight: 800, letterSpacing: 1, margin: "4px 0 4px" }}>
            HIS MODIFICATIONS {sheetWatcher.lastPolledAt ? `(last check ${new Date(sheetWatcher.lastPolledAt).toLocaleTimeString()})` : ""}
          </div>
          {sheetWatcher.recentChanges(40).length === 0
            ? <div style={{ fontSize: 10, color: "#3a4f6f", marginBottom: 10 }}>Baseline captured — changes will appear here as he edits the sheet (polled every 2 minutes while the app is open).</div>
            : <div style={{ background: "#070c17", border: "1px solid #14203a", borderRadius: 6, padding: 8, maxHeight: 180, overflow: "auto", marginBottom: 10 }}>
              {sheetWatcher.recentChanges(40).map((c, i) => (
                <div key={i} style={{ fontSize: 10, padding: "2px 0", display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ color: "#3a4f6f", ...S.m }}>{new Date(c.time).toLocaleTimeString()}</span>
                  {c.kind === "cell_changed" && <>
                    <Badge c="#e8c547" sm>{c.cell}</Badge>
                    <span style={{ color: "#7a8faa" }}>{c.header}:</span>
                    <span style={{ color: "#ef4444", textDecoration: "line-through" }}>{String(c.before).slice(0, 40) || "∅"}</span>
                    <span style={{ color: "#3a4f6f" }}>→</span>
                    <span style={{ color: "#00e8a4", fontWeight: 700 }}>{String(c.after).slice(0, 40) || "∅"}</span>
                  </>}
                  {c.kind === "row_added" && <><Badge c="#00e8a4" sm>+ ROW {c.row}</Badge><span style={{ color: "#c8d6e5" }}>{c.after}</span></>}
                  {c.kind === "row_removed" && <><Badge c="#ef4444" sm>− ROW {c.row}</Badge><span style={{ color: "#5a6f8f", textDecoration: "line-through" }}>{c.before}</span></>}
                </div>
              ))}
            </div>}
        </>}
        {sheet && <>
          <div style={{ fontSize: 10, color: "#7a8faa", marginBottom: 6 }}>{sheet.summary.rows} rows · {sheet.summary.columns.length} columns. Numeric columns below are candidates for his edge formula inputs — published CSVs carry values only; pulling the actual formulas needs the Sheets API (see docs/METHODOLOGY_MIRROR.md).</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Column", "Type", "Filled", "Min", "Max", "Mean", "Sample"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>{sheet.summary.columns.map((c, i) => (
              <tr key={i}>
                <td style={{ ...S.td, color: "#eaf0f6", fontWeight: 700, fontSize: 11 }}>{c.name}</td>
                <td style={{ ...S.td, fontSize: 10 }}><Badge c={c.numeric ? "#00e8a4" : "#5a6f8f"} sm>{c.numeric ? "NUMERIC" : "TEXT"}</Badge></td>
                <td style={{ ...S.td, ...S.m, color: "#5a6f8f", fontSize: 10 }}>{c.filled}</td>
                <td style={{ ...S.td, ...S.m, color: "#7a8faa", fontSize: 10 }}>{c.min != null ? c.min : "—"}</td>
                <td style={{ ...S.td, ...S.m, color: "#7a8faa", fontSize: 10 }}>{c.max != null ? c.max : "—"}</td>
                <td style={{ ...S.td, ...S.m, color: "#7a8faa", fontSize: 10 }}>{c.mean != null ? c.mean.toFixed(2) : "—"}</td>
                <td style={{ ...S.td, color: "#3a4f6f", fontSize: 10, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(c.sample)}</td>
              </tr>
            ))}</tbody>
          </table>
        </>}
      </div>
    </div>
  );
}

function LegacyDashboard() {
  useEffect(() => () => { wsEngine.autoTradeEnabled = false; wsEngine.disconnect(); }, []);
  const vault = useVault();
  const [tab, setTab] = useState("odds");
  const [espn, setEspn] = useState([]);
  const [kalshi, setKalshi] = useState([]);
  const [ppd, setPpd] = useState([]);
  // Data freshness tracking
  const [dataAge, setDataAge] = useState({ espn: null, kalshi: null, ob: null, trades: null, odds: null });
  // Favorites system
  const [favorites, setFavorites] = useState(() => { try { return JSON.parse(localStorage.getItem("kalshi_favorites") || "[]"); } catch { return []; } });
  const [autoTradeRules, setAutoTradeRules] = useState(() => { try { return JSON.parse(localStorage.getItem("kalshi_auto_rules") || "[]"); } catch { return []; } });
  const [autoTradeArmed, setAutoTradeArmed] = useState(false);
  const [tradeLog, setTradeLog] = useState([]);
  const saveAutoRules = useCallback((rules) => { setAutoTradeRules(rules); localStorage.setItem("kalshi_auto_rules", JSON.stringify(rules)); }, []);
  const addFavorite = useCallback((mkt) => { if (!mkt?.ticker) return; setFavorites(prev => { if (prev.find(f => f.ticker === mkt.ticker)) return prev; const next = [{ ticker: mkt.ticker, title: mkt.title, eventTitle: mkt.eventTitle || "", addedAt: Date.now(), lastBid: mkt.yes_bid, lastAsk: mkt.yes_ask }, ...prev]; localStorage.setItem("kalshi_favorites", JSON.stringify(next)); return next; }); sessionTracker.track("favorite", mkt.ticker); vault.showToast(`★ ${mkt.ticker} added to favorites`); }, [vault]);
  const removeFavorite = useCallback((ticker) => { setFavorites(prev => { const next = prev.filter(f => f.ticker !== ticker); localStorage.setItem("kalshi_favorites", JSON.stringify(next)); return next; }); }, []);
  const isFavorite = useCallback((ticker) => favorites.some(f => f.ticker === ticker), [favorites]);
  const [sbOdds, setSbOdds] = useState([]); // Sportsbook odds for exclusive markets comparison
  const [autoRefreshMs, setAutoRefreshMs] = useState(5000); // Default 5s for orderbook
  const [apiCalls, setApiCalls] = useState({ kalshi: 0, espn: 0, odds: 0, total: 0 });
  const [dataRefreshMs, setDataRefreshMs] = useState(30000); // Main data refresh interval
  const ageTimerRef = useRef(null);
  // Force re-render for age display
  const [, setTick] = useState(0);
  useEffect(() => { ageTimerRef.current = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(ageTimerRef.current); }, []);
  const [mkt, setMkt] = useState(null);
  const [ob, setOb] = useState(null);
  // Tablet / narrow-screen mode: the Book/Ticket/BotScan sidebar
  // becomes a slide-over panel behind a floating 📖 button.
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth < 1100);
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => {
    const onR = () => setCompact(window.innerWidth < 1100);
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);
  const [trades, setTrades] = useState([]);
  const [ldM, setLdM] = useState(false);
  const [ldP, setLdP] = useState(false);
  const [ldO, setLdO] = useState(false);
  const [ldT, setLdT] = useState(false);
  const [conn, setConn] = useState(false);
  const [lr, setLr] = useState(null);
  const ir = useRef(null);

  const fetchAll = useCallback(async () => { setLdM(true); const fetchStart = Date.now(); const r = await Promise.allSettled([...ESPN_SPORTS.map(s => fetchESPN(s.key)), fetchKE(vault.getKey("kalshi_api_key"))]); setEspn(r.slice(0, ESPN_SPORTS.length).flatMap(x => x.status === "fulfilled" ? x.value : [])); const ke = r[ESPN_SPORTS.length]; setKalshi(ke.status === "fulfilled" ? ke.value : []); if (ke.status === "fulfilled") captureSnapshot(ke.value); setConn(true); setLr(new Date()); setLdM(false);
    setDataAge(prev => ({ ...prev, espn: Date.now(), kalshi: Date.now() }));
    setApiCalls(prev => ({ ...prev, kalshi: prev.kalshi + KALSHI_GAME_SERIES.length, espn: prev.espn + ESPN_SPORTS.length, total: prev.total + KALSHI_GAME_SERIES.length + ESPN_SPORTS.length }));
    console.log(`[Dashboard v${APP_VERSION}] Full refresh took ${Date.now() - fetchStart}ms`); }, [vault]);
  const fetchPP = useCallback(async () => {
    setLdP(true);
    // ESPN leagues
    const espnResults = await Promise.allSettled(ESPN_PPD_LEAGUES.map(s => fetchESPNPP(s.key, 60)));
    const espnAll = espnResults.flatMap(x => x.status === "fulfilled" ? x.value : []);
    // NCAA.com (runs in background, may fail if NCAA blocks)
    let ncaaAll = [];
    try { ncaaAll = await fetchNCAAPostponed(60); } catch (e) { console.warn("[NCAA PPD] failed:", e.message); }
    const all = [...espnAll, ...ncaaAll];
    const seen = new Set();
    const unique = all.filter(g => { const k = g.id || g.name; if (seen.has(k)) return false; seen.add(k); return true; });
    unique.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    setPpd(unique);
    console.log(`[Postponed v${APP_VERSION}] Found ${unique.length} games (ESPN: ${espnAll.length}, NCAA: ${ncaaAll.length}) across ${ESPN_PPD_LEAGUES.length + NCAA_SPORTS_MAP.length} sources`);
    setLdP(false);
  }, []);
  const selMkt = useCallback((m) => { setMkt(m); setSideOpen(true); if (m?.ticker) { sessionTracker.track("market", m.ticker); setLdO(true); setLdT(true); fetchOB(m.ticker).then(d => { setOb(d); setLdO(false); }); fetchTr(m.ticker).then(d => { setTrades(d); setLdT(false); }); } }, []);

  useEffect(() => { if (!vault.locked) { fetchAll(); fetchPP(); } }, [vault.locked, fetchAll, fetchPP]);
  // The LIVE tab hunts seconds-long settlement lags — keep data flowing
  // while it's open (60s full refresh; Kalshi fetch is batched for limits).
  useEffect(() => {
    if (vault.locked || tab !== "live") return;
    const iv = setInterval(() => fetchAll(), 60000);
    return () => clearInterval(iv);
  }, [tab, vault.locked, fetchAll]);

  // ── Market tracker recording loop ──────────────────────────
  // Runs whenever the vault is unlocked and something is watched —
  // regardless of which tab is open — so recordings don't stop when
  // you navigate away. Batched market snapshot + per-ticker tape.
  const [watchList, setWatchList] = useState(() => { try { return JSON.parse(localStorage.getItem("kalshi_watchlist") || "[]"); } catch { return []; } });
  const [trackIntervalMs, setTrackIntervalMs] = useState(30000);
  const [trackTick, setTrackTick] = useState(0);
  const saveWatch = useCallback((w) => { setWatchList(w); localStorage.setItem("kalshi_watchlist", JSON.stringify(w)); }, []);
  useEffect(() => {
    if (vault.locked || !watchList.length) return;
    let cancelled = false;
    const run = async () => {
      try {
        const tickers = watchList.map(w => w.ticker).slice(0, 12);
        const d = await safeFetch(`${KALSHI_API}/markets?tickers=${tickers.join(",")}&limit=${Math.max(tickers.length, 1)}`);
        const now = Date.now();
        (d?.markets || []).map(normalizeMarket).forEach(m => trackerRecorder.record(m.ticker, m, now));
        for (const t of tickers) {
          if (cancelled) return;
          trackerRecorder.recordTrades(t, await fetchTr(t));
          await new Promise(r => setTimeout(r, 300)); // stay under rate limits
        }
        persistTracker();
        if (!cancelled) setTrackTick(x => x + 1);
      } catch (e) { console.warn("[Tracker] cycle failed:", e.message); }
    };
    run();
    const iv = setInterval(run, trackIntervalMs);
    return () => { cancelled = true; clearInterval(iv); };
  }, [vault.locked, watchList, trackIntervalMs]);

  // ── Per-profile tunable settings ───────────────────────────
  // Every detection threshold, price band and default the engine uses,
  // tuned per login and persisted. See src/engine/settings.js.
  const loadSettings = (profile) => {
    try { return mergeSettings(JSON.parse(localStorage.getItem(`kalshi_settings_v1__${profile}`) || "{}")); }
    catch { return defaultSettings(); }
  };
  const [settings, setSettings] = useState(() => loadSettings(vault.profile));
  useEffect(() => {
    const s = loadSettings(vault.profile);
    setSettings(s);
    signalJournal.minEdge = s["journal.minEdge"];
  }, [vault.profile]);
  const saveSettings = useCallback((next) => {
    setSettings(next);
    try { localStorage.setItem(`kalshi_settings_v1__${vault.profile}`, JSON.stringify(next)); } catch { /* full */ }
    signalJournal.minEdge = next["journal.minEdge"];
  }, [vault.profile]);

  // ── Signal journal: always-on logging + outcome scoring ────
  // Sportsbook odds are fetched here (not in the Arb tab) so signals are
  // journaled whichever tab is open, and the Exclusive tab gets real data.
  const oddsKeyDash = vault.getKey("the_odds_api");
  const [sbLoaded, setSbLoaded] = useState(false);
  useEffect(() => {
    if (vault.locked) return;
    if (oddsKeyDash && !sbLoaded) fetchSportsbookOdds(oddsKeyDash).then(d => { setSbOdds(d); setSbLoaded(true); }).catch(() => setSbLoaded(true));
    else if (!oddsKeyDash) setSbLoaded(true);
  }, [vault.locked, oddsKeyDash, sbLoaded]);

  const allOpps = useMemo(() => kalshi.length ? findArbOpportunities(kalshi, espn, sbOdds, engineOpts(settings)) : [], [kalshi, espn, sbOdds, settings]);
  useEffect(() => {
    if (!allOpps.length) return;
    const logged = signalJournal.logSignals(allOpps);
    // Feed current states so open entries track drift on every refresh
    const byTicker = new Map();
    kalshi.forEach(e => (e.markets || []).forEach(m => byTicker.set(m.ticker, m)));
    signalJournal.updateOutcomes(byTicker);
    persistJournal();
    if (logged) setTrackTick(x => x + 1);
  }, [allOpps, kalshi]);

  // Outcome updater: journaled markets leave the open-events feed when
  // they close, so poll them directly (batch endpoint returns settled
  // markets with their result) every 5 minutes.
  useEffect(() => {
    if (vault.locked) return;
    const run = async () => {
      const open = signalJournal.openTickers();
      if (!open.length) return;
      const byTicker = new Map();
      for (let i = 0; i < open.length; i += 20) {
        const chunk = open.slice(i, i + 20);
        try {
          const d = await safeFetch(`${KALSHI_API}/markets?tickers=${chunk.join(",")}&limit=${chunk.length}`);
          (d?.markets || []).map(normalizeMarket).forEach(m => byTicker.set(m.ticker, m));
        } catch { /* transient */ }
        if (i + 20 < open.length) await new Promise(r => setTimeout(r, 500));
      }
      const changed = signalJournal.updateOutcomes(byTicker);
      persistJournal();
      if (changed) { setTrackTick(x => x + 1); vault.showToast(`📓 Journal: ${changed} signal${changed > 1 ? "s" : ""} resolved`); }
    };
    run();
    const iv = setInterval(run, 300_000);
    return () => clearInterval(iv);
  }, [vault.locked]);

  // ── Mentor sheet modification tracking (2-min poll while enabled) ──
  const [sheetTrackOn, setSheetTrackOn] = useState(() => localStorage.getItem("kalshi_sheetwatch_on") === "1");
  const toggleSheetTrack = useCallback(() => setSheetTrackOn(v => { const n = !v; localStorage.setItem("kalshi_sheetwatch_on", n ? "1" : "0"); return n; }), []);
  useEffect(() => {
    if (vault.locked || !sheetTrackOn) return;
    const url = vault.getKey("mentor_sheet_csv_url");
    if (!url) return;
    const run = async () => {
      try {
        const r = await fetch(url.replace(/^https:\/\/docs\.google\.com/, "/gsheet"), { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return;
        const changes = sheetWatcher.ingest(parseCSV(await r.text()));
        persistSheetWatch();
        if (changes.length) { setTrackTick(x => x + 1); vault.showToast(`📊 Mentor sheet updated: ${changes.length} change${changes.length > 1 ? "s" : ""}`); }
      } catch (e) { console.warn("[SheetWatch]", e.message); }
    };
    run();
    const iv = setInterval(run, 120_000);
    return () => clearInterval(iv);
  }, [vault.locked, sheetTrackOn, vault]);
  useEffect(() => { if (!mkt?.ticker) return; ir.current = setInterval(() => { fetchOB(mkt.ticker).then(setOb); fetchTr(mkt.ticker).then(setTrades); }, 5000); return () => clearInterval(ir.current); }, [mkt]);
  const vaultAuthFetch = useCallback((path, method, body) => {
    const ak = vault.getKey("kalshi_api_key"), pk = vault.getKey("kalshi_private_key");
    if (!ak || !pk) return Promise.reject(new Error("Add your Kalshi API Key ID and RSA private key in the 🔐 Key Vault tab"));
    return kalshiAuthFetch(path, method, body, ak, pk);
  }, [vault]);
  const refresh = () => { sessionTracker.track("refresh"); fetchAll(); fetchPP(); if (mkt?.ticker) { fetchOB(mkt.ticker).then(d => { setOb(d); setDataAge(prev => ({...prev, ob: Date.now()})); }); fetchTr(mkt.ticker).then(d => { setTrades(d); setDataAge(prev => ({...prev, trades: Date.now()})); }); } };

  if (vault.locked) return <LockScreen />;

  const NAV = [{ id: "odds", icon: "📊" }, { id: "arb", icon: "⚡" }, { id: "live", icon: "🔴" }, { id: "fresh", icon: "🆕" }, { id: "tracker", icon: "📼" }, { id: "journal", icon: "📓" }, { id: "exclusive", icon: "🎯" }, { id: "favorites", icon: "★" }, { id: "ppd", icon: "⚠️" }, { id: "postponed", icon: "⏸" }, { id: "combos", icon: "🧩" }, { id: "positions", icon: "💼" }, { id: "book", icon: "📖" }, { id: "trade", icon: "💹" }, { id: "bot", icon: "🤖" }, { id: "mentor", icon: "🧭" }, { id: "feedback", icon: "💬" }, { id: "report", icon: "🐞" }, { id: "settings", icon: "⚙️" }, { id: "vault", icon: "🔐" }];

  return <>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 22px", background: "linear-gradient(180deg,#0a1020,#050910)", borderBottom: "1px solid #14203a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect width="26" height="26" rx="6" fill="#00e8a4"/><path d="M7 13l4 4 8-8" stroke="#050910" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg><span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.5px" }}>KALSHI</span><span style={{ fontSize: 9, color: "#3a4f6f", letterSpacing: "2.5px", textTransform: "uppercase" }}>PRO ASTRA</span><span style={{ fontSize: 9, color: "#1e3050", marginLeft: 8, ...S.m }}>v{APP_VERSION}</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Pulse color={conn ? "#00e8a4" : "#ef4444"} /><span style={{ fontSize: 10, color: conn ? "#00e8a4" : "#ef4444", fontWeight: 700 }}>{conn ? "LIVE" : "OFFLINE"}</span></div>
        {lr && <span style={{ fontSize: 9, color: "#3a4f6f", ...S.m }}>{lr.toLocaleTimeString()}</span>}
        {/* Data age indicators */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {[
            { key: "kalshi", label: "KALSHI", age: dataAge.kalshi },
            { key: "espn", label: "ESPN", age: dataAge.espn },
            { key: "ob", label: "BOOK", age: dataAge.ob },
          ].map(d => {
            const ageSec = d.age ? Math.floor((Date.now() - d.age) / 1000) : null;
            const ageStr = ageSec === null ? "—" : ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec/60)}m`;
            const color = ageSec === null ? "#3a4f6f" : ageSec < 10 ? "#00e8a4" : ageSec < 30 ? "#f59e0b" : "#ef4444";
            return <span key={d.key} style={{ fontSize: 8, color, ...S.m, letterSpacing: "0.5px" }}>{d.label}:{ageStr}</span>;
          })}
          <span style={{ fontSize: 8, color: "#3a4f6f", ...S.m }}>API:{apiCalls.total}</span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {vault.getKey("kalshi_api_key") ? <Badge c="#00e8a4" sm>🔓 VAULT · KEY SET</Badge> : <Badge c="#f59e0b" sm>🔓 VAULT · NO KEY</Badge>}
        <ObsidianButton />
        <SheetsButton kalshi={kalshi} />
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {/* Turbo Mode Toggle */}
          <TurboToggle />
          <select value={autoRefreshMs} onChange={e => setAutoRefreshMs(Number(e.target.value))} style={{ background: "#060a14", border: "1px solid #14203a", borderRadius: 4, padding: "4px 6px", color: "#5a6f8f", fontSize: 9, ...S.m }}>
            <option value={1000}>1s (fast)</option>
            <option value={3000}>3s</option>
            <option value={5000}>5s (default)</option>
            <option value={10000}>10s</option>
            <option value={30000}>30s (slow)</option>
          </select>
          <button onClick={refresh} style={{ background: "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 6, padding: "7px 16px", color: "#050910", fontWeight: 800, fontSize: 11, cursor: "pointer", ...S.m }}>⟳ REFRESH</button>
          {obsidianVault.connected && <button onClick={async () => {
            await obsidianVault.exportDailyJournal({
              kalshiCount: kalshi.length, sbCount: 0, arbCount: 0, tradeCount: log?.length || 0,
              topArbs: [], trades: log || [],
            });
            vault.showToast("Journal saved to Obsidian");
          }} style={{ background: "#6366f115", border: "1px solid #6366f130", borderRadius: 6, padding: "5px 10px", color: "#6366f1", fontSize: 9, fontWeight: 700, cursor: "pointer", ...S.m }}>📝 JOURNAL</button>}
        </div>
      </div>
    </div>
    <div style={{ display: "flex", height: "calc(100vh - 49px)" }}>
      <ToolNavigation items={NAV} active={tab} onSelect={id => { sessionTracker.track("tab", id); setTab(id); }} />
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: tab === "vault" || compact ? "1fr" : "1fr 370px", overflow: "hidden" }}>
        <div style={{ overflow: "hidden", borderRight: tab === "vault" ? "none" : "1px solid #14203a" }}>
          {tab === "odds" && <OddsModule espn={espn} kalshi={kalshi} onSel={selMkt} loading={ldM} onFav={addFavorite} isFav={isFavorite} />}
          {tab === "favorites" && <FavoritesModule favorites={favorites} kalshi={kalshi} onSel={selMkt} onRemove={removeFavorite} autoRules={autoTradeRules} onSaveRules={saveAutoRules} armed={autoTradeArmed} onArmToggle={() => setAutoTradeArmed(a => !a)} tradeLog={tradeLog} />}
            {tab === "exclusive" && <ExclusiveModule kalshi={kalshi} sbOdds={sbOdds} onSel={selMkt} />}
            {tab === "arb" && <ArbModule espn={espn} kalshi={kalshi} sbOdds={sbOdds} settings={settings} onRefreshOdds={() => setSbLoaded(false)} onSel={selMkt} onTradeSuggest={(s) => { setTab("trade"); setTimeout(() => { const ev = new CustomEvent("tradeSuggest", { detail: s }); window.dispatchEvent(ev); }, 100); }} />}
          {tab === "live" && <LiveModule kalshi={kalshi} espn={espn} settings={settings} onSel={selMkt} lastRefresh={dataAge.kalshi} onTradeSuggest={(s) => { setTab("trade"); setTimeout(() => { const ev = new CustomEvent("tradeSuggest", { detail: s }); window.dispatchEvent(ev); }, 100); }} />}
          {tab === "fresh" && <FreshMarketsModule kalshi={kalshi} settings={settings} onSel={selMkt} onFav={addFavorite} isFav={isFavorite} />}
          {tab === "tracker" && <TrackerModule kalshi={kalshi} watchList={watchList} onSaveWatch={saveWatch} trackIntervalMs={trackIntervalMs} onSetInterval={setTrackIntervalMs} trackTick={trackTick} onSel={selMkt} />}
          {tab === "journal" && <JournalModule changeTick={trackTick} />}
          {tab === "mentor" && <MentorModule sheetTrackOn={sheetTrackOn} onToggleSheetTrack={toggleSheetTrack} changeTick={trackTick} />}
          {tab === "feedback" && <FeedbackModule S={S} Badge={Badge} TBtn={TBtn} Empty={Empty} showToast={vault.showToast} />}
          {tab === "report" && <ReportModule currentTab={tab} watchCount={watchList.length} />}
          {tab === "settings" && <SettingsModule settings={settings} onSave={saveSettings} profile={vault.profile} />}
          {tab === "ppd" && <PPModule data={ppd} loading={ldP} kalshi={kalshi} onSel={selMkt} />}
          {tab === "postponed" && <PostponedModule S={S} Badge={Badge} TBtn={TBtn} Empty={Empty} Pulse={Pulse} showToast={vault.showToast} authFetch={vaultAuthFetch} apiBase={KALSHI_API} kalshi={kalshi} />}
          {tab === "combos" && <CombosModule profile={vault.profile} S={S} Badge={Badge} TBtn={TBtn} Empty={Empty} Pulse={Pulse} showToast={vault.showToast} authFetch={vaultAuthFetch} apiBase={KALSHI_API} />}
          {tab === "positions" && <PositionsModule S={S} Badge={Badge} TBtn={TBtn} Empty={Empty} Pulse={Pulse} showToast={vault.showToast} authFetch={vaultAuthFetch} apiBase={KALSHI_API} />}
          {tab === "book" && <BookModule mkt={mkt} ob={ob} ld={ldO} />}
          {tab === "trade" && <TradeModule mkt={mkt} ob={ob} settings={settings} />}
          {tab === "bot" && <BotDeployModule kalshi={kalshi} favorites={favorites} onSel={selMkt} mkt={mkt} trades={trades} ld={ldT} />}
          {tab === "vault" && <VaultPage />}
        </div>
        {tab !== "vault" && !compact && <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: mkt?.ticker ? "0 0 34%" : "0 0 42%", borderBottom: "1px solid #14203a", overflow: "hidden" }}><BookModule mkt={mkt} ob={ob} ld={ldO} /></div>
          <TicketModule S={S} Badge={Badge} Pulse={Pulse} showToast={vault.showToast} authFetch={vaultAuthFetch} mkt={mkt} ob={ob} />
          <div style={{ flex: 1, overflow: "hidden" }}><BotModule mkt={mkt} trades={trades} ld={ldT} /></div>
        </div>}
        {tab !== "vault" && compact && <>
          <button onClick={() => setSideOpen(o => !o)} title="book-panel"
            style={{ position: "fixed", right: 14, bottom: 84, width: 54, height: 54, borderRadius: "50%", border: "1px solid #00e8a440", background: "#0a1020f0", color: "#00e8a4", fontSize: 22, cursor: "pointer", zIndex: 600, boxShadow: "0 6px 24px rgba(0,0,0,0.5)" }}>
            {sideOpen ? "✕" : "📖"}</button>
          {sideOpen && <div style={{ position: "fixed", top: 49, right: 0, bottom: 0, width: "min(400px, 94vw)", zIndex: 500, background: "#0d1320", borderLeft: "1px solid #14203a", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "-12px 0 40px rgba(0,0,0,0.5)" }}>
            <div style={{ flex: mkt?.ticker ? "0 0 34%" : "0 0 42%", borderBottom: "1px solid #14203a", overflow: "hidden" }}><BookModule mkt={mkt} ob={ob} ld={ldO} /></div>
            <TicketModule S={S} Badge={Badge} Pulse={Pulse} showToast={vault.showToast} authFetch={vaultAuthFetch} mkt={mkt} ob={ob} />
            <div style={{ flex: 1, overflow: "hidden" }}><BotModule mkt={mkt} trades={trades} ld={ldT} /></div>
          </div>}
        </>}
      </div>
    </div>
    {vault.toast && <div style={{ position: "fixed", bottom: 24, right: 24, padding: "12px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, zIndex: 9999, animation: "fadeIn 0.3s", boxShadow: "0 8px 30px rgba(0,0,0,0.4)", ...S.m, background: vault.toast.type === "error" ? "#2a0b0b" : "#0b2a1f", border: `1px solid ${vault.toast.type === "error" ? "#ef444430" : "#00e8a430"}`, color: vault.toast.type === "error" ? "#ef4444" : "#00e8a4" }}>{vault.toast.msg}</div>}
  </>;
}

// ═══════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════
function Dashboard() {
  const vault = useVault();
  const authFetch = useCallback((path, method, body) => {
    const ak = vault.getKey("kalshi_api_key"), pk = vault.getKey("kalshi_private_key");
    if (!ak || !pk) return Promise.reject(new Error("Add your Kalshi API Key ID and private key in Key Vault"));
    return kalshiAuthFetch(path, method, body, ak, pk);
  }, [vault]);
  if (vault.locked) return <LockScreen />;
  return <ComboDashboard profile={vault.profile} apiBase={KALSHI_API} authFetch={authFetch}
    connected={!!vault.getKey("kalshi_api_key") && !!vault.getKey("kalshi_private_key")}
    onLock={vault.lock} toast={vault.toast}
    connection={() => <VaultPage />}
    positions={() => <PositionsModule S={S} Badge={Badge} TBtn={TBtn} Empty={Empty} Pulse={Pulse} showToast={vault.showToast} authFetch={authFetch} apiBase={KALSHI_API} />}
    otherTools={() => <LegacyDashboard />} />;
}

export default function App() {
  return (
    <div style={{ minHeight: "100vh", background: "#050910", fontFamily: "'IBM Plex Mono','Fira Code',monospace", color: "#eaf0f6", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:#050910}::-webkit-scrollbar-thumb{background:#14203a;border-radius:3px}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none}input[type=number]{-moz-appearance:textfield}
        select{font-family:'IBM Plex Mono',monospace}
      `}</style>
      <VaultProvider><Dashboard /></VaultProvider>
    </div>
  );
}
