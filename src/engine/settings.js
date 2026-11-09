// ═══════════════════════════════════════════════════════════════
// TUNABLE SETTINGS — every detection threshold, price band and
// variable the engine uses, exposed as a typed schema so each user
// profile can tune the scanner to their own methodology in detail.
//
// The schema is the single source of truth: the ⚙️ Settings page
// renders from it, values are clamped to their documented ranges,
// and engineOpts() maps the flat settings object onto the option
// bags each detector accepts.
// ═══════════════════════════════════════════════════════════════

export const SETTINGS_SCHEMA = [
  {
    id: "value", label: "VALUE — book consensus divergence", icon: "💠",
    desc: "Kalshi vs the devigged multi-sportsbook consensus.",
    fields: [
      { key: "value.minBooks", label: "Min books for consensus", desc: "How many sportsbooks must price a game before their no-vig median counts as fair value.", default: 2, min: 1, max: 10, step: 1, unit: "books" },
      { key: "value.minEvCents", label: "Min EV to signal", desc: "Fee-adjusted expected value per contract required before a VALUE signal fires. Higher = fewer, stronger signals.", default: 3, min: 0.5, max: 25, step: 0.5, unit: "¢" },
    ],
  },
  {
    id: "skew", label: "FRESH SKEW — new-listing fade", icon: "🎀",
    desc: "Freshly listed markets at an extreme on thin volume that should relax by gametime.",
    fields: [
      { key: "skew.maxAgeHours", label: "Max listing age", desc: "Only markets listed within this many hours count as fresh.", default: 36, min: 1, max: 96, step: 1, unit: "h" },
      { key: "skew.extremeCents", label: "Extreme threshold", desc: "Mid must be at/above this (or below 100 minus this) to be a skew candidate. 65 flags 70/30-style listings; 60 is more aggressive.", default: 65, min: 55, max: 90, step: 1, unit: "¢" },
      { key: "skew.maxVolume", label: "Max volume (thin book)", desc: "Above this traded volume the price is considered crowd-confirmed, not lazily listed.", default: 300, min: 0, max: 10000, step: 50, unit: "contracts" },
      { key: "skew.minAnchorGap", label: "Min gap vs consensus", desc: "How far the fresh price must sit from book consensus to fire an ANCHORED fade.", default: 5, min: 1, max: 30, step: 1, unit: "¢" },
    ],
  },
  {
    id: "equiv", label: "EQUIVALENCE — win ≡ advance", icon: "🔀",
    desc: "Same outcome listed in two different events (game winner vs series/advance).",
    fields: [
      { key: "equiv.minDivergence", label: "Min price divergence", desc: "Equivalent markets must be at least this far apart before surfacing.", default: 2, min: 0.5, max: 20, step: 0.5, unit: "¢" },
      { key: "equiv.exactWindowHours", label: "EXACT close-time window", desc: "Close times within this window mean the progression market settles with the game.", default: 6, min: 1, max: 24, step: 1, unit: "h" },
    ],
  },
  {
    id: "live", label: "LIVE — settlement lags & near-certain", icon: "🔴",
    desc: "The seconds-to-minutes window after something happens on the field.",
    fields: [
      { key: "live.lagThreshold", label: "Winner lag ceiling", desc: "ESPN-final winners still asking below this price are settlement lags. 97 is standard; lower demands a bigger discount.", default: 97, min: 80, max: 99, step: 1, unit: "¢" },
      { key: "live.lagFloor", label: "Loser lag floor", desc: "ESPN-final losers still bidding above this are lags (buy NO).", default: 3, min: 1, max: 20, step: 1, unit: "¢" },
      { key: "live.nearMinMid", label: "Near-certain band: low", desc: "In-game watchlist lower bound.", default: 80, min: 50, max: 95, step: 1, unit: "¢" },
      { key: "live.nearMaxMid", label: "Near-certain band: high", desc: "In-game watchlist upper bound (at/above this is effectively settled).", default: 97, min: 85, max: 99, step: 1, unit: "¢" },
    ],
  },
  {
    id: "volume", label: "VOLUME — outliers & fresh listings", icon: "📊",
    desc: "High-volume crowd magnets, dead books near game time, and the New Markets window.",
    fields: [
      { key: "volume.highX", label: "High-volume multiple", desc: "A market trading this many times its series median volume is a HIGH outlier.", default: 5, min: 2, max: 25, step: 1, unit: "×" },
      { key: "volume.minHigh", label: "High-volume floor", desc: "Absolute minimum volume to qualify as HIGH regardless of the multiple.", default: 1000, min: 100, max: 50000, step: 100, unit: "contracts" },
      { key: "volume.deadMax", label: "Dead-book ceiling", desc: "At/below this volume within a day of game time counts as a DEAD book.", default: 5, min: 0, max: 100, step: 1, unit: "contracts" },
      { key: "volume.freshWindowHours", label: "New Markets default window", desc: "Default listing-age window on the 🆕 page.", default: 48, min: 6, max: 96, step: 6, unit: "h" },
    ],
  },
  {
    id: "journal", label: "JOURNAL & ALERTS", icon: "📓",
    desc: "What gets recorded in the learning database and when you're pinged.",
    fields: [
      { key: "journal.minEdge", label: "Min edge to journal", desc: "Signals below this edge aren't logged (keeps the learning table meaningful).", default: 0.5, min: 0, max: 10, step: 0.5, unit: "¢" },
      { key: "alerts.improveThreshold", label: "Improved-alert threshold", desc: "An existing opportunity must gain at least this much edge to re-alert as IMPROVED.", default: 2, min: 0.5, max: 20, step: 0.5, unit: "¢" },
    ],
  },
  {
    id: "trade", label: "TRADING DEFAULTS", icon: "💹",
    desc: "Prefills for the order form — every order is still confirmed by hand.",
    fields: [
      { key: "trade.defaultQty", label: "Default contracts", desc: "Prefilled quantity when a signal hands off to the trade form.", default: 10, min: 1, max: 1000, step: 1, unit: "contracts" },
      { key: "trade.maxCostDollars", label: "Order cost warning", desc: "The trade form warns when a prefilled order would cost more than this.", default: 50, min: 1, max: 10000, step: 1, unit: "$" },
    ],
  },
];

const FIELD_INDEX = new Map();
for (const g of SETTINGS_SCHEMA) for (const f of g.fields) FIELD_INDEX.set(f.key, f);

export function defaultSettings() {
  const out = {};
  for (const [key, f] of FIELD_INDEX) out[key] = f.default;
  return out;
}

export function clampSetting(key, value) {
  const f = FIELD_INDEX.get(key);
  if (!f) return null;
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!isFinite(n)) return f.default;
  return Math.min(f.max, Math.max(f.min, n));
}

// Merge a saved blob over defaults: unknown keys dropped, values clamped.
export function mergeSettings(saved) {
  const out = defaultSettings();
  for (const [key, value] of Object.entries(saved || {})) {
    if (FIELD_INDEX.has(key)) out[key] = clampSetting(key, value);
  }
  return out;
}

// Map the flat settings object onto the option bags the engine takes.
export function engineOpts(s) {
  return {
    // value.js
    minBooks: s["value.minBooks"],
    minEvCents: s["value.minEvCents"],
    // fresh skew (value.js)
    maxAgeHours: s["skew.maxAgeHours"],
    extremeCents: s["skew.extremeCents"],
    maxVolume: s["skew.maxVolume"],
    minAnchorGap: s["skew.minAnchorGap"],
    // equivalence.js
    minDivergence: s["equiv.minDivergence"],
    exactWindowMs: s["equiv.exactWindowHours"] * 3600_000,
  };
}

export function liveOpts(s) {
  return {
    threshold: s["live.lagThreshold"],
    floor: s["live.lagFloor"],
    minMid: s["live.nearMinMid"],
    maxMid: s["live.nearMaxMid"],
  };
}

export function volumeOpts(s) {
  return {
    highX: s["volume.highX"],
    minHigh: s["volume.minHigh"],
    deadMax: s["volume.deadMax"],
  };
}
