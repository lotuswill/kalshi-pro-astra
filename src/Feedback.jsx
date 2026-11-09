// ═══════════════════════════════════════════════════════════════
// FEEDBACK & SESSION INSIGHTS MODULE
// Captures how the user actually works the terminal (tabs, sports,
// markets, refresh cadence) + their own written feedback, and kicks
// it back to the GitHub repo as an Issue so it can be pulled later
// and used to improve the tool.
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect } from "react";

// Set after the repo is created; can be overridden in the panel.
export const DEFAULT_FEEDBACK_REPO = "lotuswill/kalshi-pro";

// ---------- Session pattern tracker (singleton) ----------
const LS_EVENTS = "kalshi_session_events";
const LS_HISTORY = "kalshi_feedback_history";
const LS_REPO = "kalshi_feedback_repo";
const LS_TOKEN = "kalshi_gh_token";

function loadJSON(k, fb) { try { return JSON.parse(localStorage.getItem(k) || JSON.stringify(fb)); } catch { return fb; } }

export const sessionTracker = {
  sessionStart: Date.now(),
  events: [],
  track(type, detail) {
    const e = { t: Date.now(), type, detail: detail == null ? "" : String(detail).slice(0, 120) };
    this.events.push(e);
    if (this.events.length > 2000) this.events = this.events.slice(-1500);
    try { localStorage.setItem(LS_EVENTS, JSON.stringify(this.events.slice(-500))); } catch {}
  },
  summarize() {
    const ev = this.events;
    const durMin = Math.max(1, Math.round((Date.now() - this.sessionStart) / 60000));
    const count = (type) => ev.filter(e => e.type === type).length;
    const topBy = (type, n = 5) => {
      const m = {};
      ev.filter(e => e.type === type && e.detail).forEach(e => { m[e.detail] = (m[e.detail] || 0) + 1; });
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);
    };
    const tabSeq = ev.filter(e => e.type === "tab").map(e => e.detail);
    return {
      version: (typeof window !== "undefined" && window.__KALSHI_VERSION) || "",
      sessionMinutes: durMin,
      totalActions: ev.length,
      tabsVisited: topBy("tab", 10),
      tabFlow: tabSeq.slice(-20).join(" → "),
      marketsViewed: topBy("market", 8),
      sportFilters: topBy("sport", 8),
      favoritesAdded: count("favorite"),
      refreshes: count("refresh"),
      tradesTouched: topBy("trade", 5),
      searches: topBy("search", 5),
    };
  },
  summaryMarkdown() {
    const s = this.summarize();
    const list = (arr) => arr.length ? arr.map(([k, n]) => `${k} (${n}×)`).join(", ") : "—";
    return [
      `**Session:** ${s.sessionMinutes} min · ${s.totalActions} actions · v${s.version}`,
      `**Tabs used:** ${list(s.tabsVisited)}`,
      `**Recent flow:** ${s.tabFlow || "—"}`,
      `**Markets viewed:** ${list(s.marketsViewed)}`,
      `**Sport filters:** ${list(s.sportFilters)}`,
      `**Searches:** ${list(s.searches)}`,
      `**Favorites added:** ${s.favoritesAdded} · **Refreshes:** ${s.refreshes}`,
      `**Trade panel activity:** ${list(s.tradesTouched)}`,
    ].join("\n");
  },
};

// ---------- GitHub submission ----------
async function submitIssue({ repo, token, title, body, labels }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ---------- UI ----------
const CATS = [
  { id: "change", label: "CHANGE REQUEST", color: "#f59e0b", desc: "Something in the tool needs to work differently" },
  { id: "insight", label: "TRADING INSIGHT", color: "#6366f1", desc: "How I think about trades — something the tool doesn't capture" },
  { id: "bug", label: "BUG", color: "#ef4444", desc: "Something is broken" },
  { id: "idea", label: "IDEA", color: "#00e8a4", desc: "New feature or improvement" },
];

export function FeedbackModule({ S, Badge, TBtn, Empty, showToast }) {
  const [cat, setCat] = useState("change");
  const [text, setText] = useState("");
  const [includeSession, setIncludeSession] = useState(true);
  const [repo, setRepo] = useState(() => localStorage.getItem(LS_REPO) || DEFAULT_FEEDBACK_REPO);
  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN) || "");
  const [showSettings, setShowSettings] = useState(false);
  const [showTok, setShowTok] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(() => loadJSON(LS_HISTORY, []));
  const [preview, setPreview] = useState("");

  useEffect(() => { setPreview(sessionTracker.summaryMarkdown()); const t = setInterval(() => setPreview(sessionTracker.summaryMarkdown()), 5000); return () => clearInterval(t); }, []);
  useEffect(() => { localStorage.setItem(LS_REPO, repo); }, [repo]);
  useEffect(() => { localStorage.setItem(LS_TOKEN, token); }, [token]);

  const catDef = CATS.find(c => c.id === cat);

  const buildIssue = () => {
    const title = `[${catDef.label}] ${text.trim().split("\n")[0].slice(0, 70) || "Session feedback"}`;
    const body = [
      `### Feedback (${catDef.label.toLowerCase()})`,
      "",
      text.trim() || "_no comment written_",
      "",
      ...(includeSession ? ["---", "### Session patterns (auto-captured)", "", sessionTracker.summaryMarkdown()] : []),
      "",
      `_Submitted from Kalshi Sports Terminal on ${new Date().toLocaleString()}_`,
    ].join("\n");
    return { title, body };
  };

  const record = (entry) => {
    const next = [entry, ...history].slice(0, 100);
    setHistory(next);
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(next)); } catch {}
  };

  const doSubmit = async () => {
    if (!text.trim() && !includeSession) { showToast("Write a comment or include session insights", "error"); return; }
    const { title, body } = buildIssue();
    if (token && repo && !repo.includes("__GITHUB_OWNER__")) {
      setBusy(true);
      try {
        const issue = await submitIssue({ repo, token, title, body, labels: ["feedback", cat] });
        record({ t: Date.now(), cat, title, status: "submitted", url: issue.html_url, number: issue.number });
        setText("");
        showToast(`✓ Feedback pushed to repo — issue #${issue.number}`);
      } catch (e) {
        record({ t: Date.now(), cat, title, status: "failed", err: e.message });
        showToast(`Submit failed: ${e.message}`, "error");
      } finally { setBusy(false); }
    } else {
      // No token configured — open a pre-filled GitHub issue in the browser.
      const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 6000))}&labels=feedback,${cat}`;
      window.open(url, "_blank");
      record({ t: Date.now(), cat, title, status: "opened in browser" });
      showToast("Opened pre-filled GitHub issue — click Submit there");
    }
  };

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.title}>💬 Feedback & Session Insights</span>
          <Badge c="#6366f1">{history.length} SENT</Badge>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Badge c={token ? "#00e8a4" : "#f59e0b"} sm>{token ? "DIRECT SUBMIT" : "BROWSER SUBMIT"}</Badge>
          <TBtn active={showSettings} onClick={() => setShowSettings(s => !s)}>⚙ SETTINGS</TBtn>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {showSettings && (
          <div style={{ background: "#0a1020", border: "1px solid #14203a", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 10, color: "#5a6f8f", fontWeight: 700, letterSpacing: "0.8px" }}>GITHUB CONNECTION</div>
            <label style={{ fontSize: 10, color: "#5a6f8f" }}>Repository (owner/name)
              <input value={repo} onChange={e => setRepo(e.target.value.trim())} placeholder="owner/kalshi-sports-terminal" style={{ ...S.inp, marginTop: 4 }} />
            </label>
            <label style={{ fontSize: 10, color: "#5a6f8f" }}>Personal access token (optional — enables one-click submit; stored only on this computer)
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <input type={showTok ? "text" : "password"} value={token} onChange={e => setToken(e.target.value.trim())} placeholder="github_pat_… (needs Issues: write on the repo)" style={{ ...S.inp }} />
                <TBtn active={showTok} onClick={() => setShowTok(s => !s)}>{showTok ? "HIDE" : "SHOW"}</TBtn>
              </div>
            </label>
            <div style={{ fontSize: 9, color: "#3a4f6f" }}>Without a token, submitting opens a pre-filled GitHub issue in your browser instead (you must be signed in to GitHub with repo access).</div>
          </div>
        )}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CATS.map(c => <TBtn key={c.id} active={cat === c.id} color={c.color} onClick={() => setCat(c.id)}>{c.label}</TBtn>)}
        </div>
        <div style={{ fontSize: 10, color: "#3a4f6f", marginTop: -8 }}>{catDef.desc}</div>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={cat === "insight"
            ? "Describe how you look at trades — the angle, the pattern, the gut check the tool doesn't capture yet…"
            : "What needs to change, and why…"}
          rows={6}
          style={{ ...S.inp, resize: "vertical", minHeight: 110, lineHeight: 1.5 }}
        />

        <div style={{ background: "#0a1020", border: "1px solid #14203a", borderRadius: 8, padding: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8 }}>
            <input type="checkbox" checked={includeSession} onChange={e => setIncludeSession(e.target.checked)} />
            <span style={{ fontSize: 11, color: "#c8d6e5", fontWeight: 700 }}>Attach this session's patterns</span>
            <Badge c="#6366f1" sm>AUTO-CAPTURED</Badge>
          </label>
          {includeSession && <pre style={{ fontSize: 10, color: "#5a6f8f", whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0, fontFamily: "inherit" }}>{preview}</pre>}
        </div>

        <button onClick={doSubmit} disabled={busy} style={{ background: busy ? "#14203a" : "linear-gradient(135deg,#00e8a4,#00c48c)", border: "none", borderRadius: 6, padding: "12px 18px", color: busy ? "#5a6f8f" : "#050910", fontWeight: 800, fontSize: 12, cursor: busy ? "wait" : "pointer", letterSpacing: "0.5px", ...S.m }}>
          {busy ? "SUBMITTING…" : token ? "⤴ PUSH FEEDBACK TO REPO" : "⤴ OPEN GITHUB ISSUE (PRE-FILLED)"}
        </button>

        <div>
          <div style={{ fontSize: 10, color: "#5a6f8f", fontWeight: 700, letterSpacing: "0.8px", marginBottom: 6 }}>SUBMITTED FEEDBACK</div>
          {history.length === 0 ? <Empty icon="📭" text="Nothing submitted yet" /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {history.slice(0, 20).map((h, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#0a1020", border: "1px solid #0f1728", borderRadius: 6, fontSize: 10 }}>
                  <Badge c={(CATS.find(c => c.id === h.cat) || CATS[0]).color} sm>{h.cat}</Badge>
                  <span style={{ color: "#c8d6e5", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.title}</span>
                  {h.url ? <a href={h.url} target="_blank" rel="noreferrer" style={{ color: "#00e8a4" }}>#{h.number}</a> : <span style={{ color: h.status === "failed" ? "#ef4444" : "#5a6f8f" }}>{h.status}</span>}
                  <span style={{ color: "#3a4f6f" }}>{new Date(h.t).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
