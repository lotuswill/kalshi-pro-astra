// ═══════════════════════════════════════════════════════════════
// BOT DETECTION & ACTOR FINGERPRINTING
//
// Kalshi's tape is anonymous — no account names. But automated actors
// leave fingerprints: identical order sizes over and over, clockwork
// inter-trade timing, 1¢ price stepping, self-matching prints. This
// module clusters the tape into "actors" and classifies bot behaviors,
// each with a counter-tactic.
//
// Input: recorder tape entries { t, price, count, taker }.
// ═══════════════════════════════════════════════════════════════

// Recurring size signatures: the same contract count appearing again
// and again is one player's order template.
export function fingerprintActors(tape, opts = {}) {
  const minOccurrences = opts.minOccurrences ?? 5;
  const bySize = new Map();
  (tape || []).forEach(tr => {
    if (!tr.count) return;
    if (!bySize.has(tr.count)) bySize.set(tr.count, []);
    bySize.get(tr.count).push(tr);
  });

  const actors = [];
  for (const [size, prints] of bySize) {
    if (prints.length < minOccurrences) continue;
    const times = prints.map(p => p.t).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const mean = gaps.reduce((s, g) => s + g, 0) / Math.max(1, gaps.length);
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / Math.max(1, gaps.length);
    const regularity = mean > 0 ? Math.sqrt(variance) / mean : Infinity; // CV: low = clockwork
    const yesShare = prints.filter(p => p.taker === "yes").length / prints.length;
    actors.push({
      label: `Actor·${size}`,
      size,
      prints: prints.length,
      contracts: prints.length * size,
      meanGapSec: mean / 1000,
      regularity,
      clockwork: gaps.length >= 4 && regularity < 0.35,
      yesShare,
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
    });
  }
  actors.sort((a, b) => b.prints - a.prints);
  return actors;
}

const TACTICS = {
  SNIPER: "Don't chase the same fill. Rest limit orders 1-2¢ better than the sniper's trigger levels ahead of time — snipers cross the spread and will pay your price.",
  PENNY_JUMPER: "Never bid-war a penny jumper — it always goes +1¢. Either leapfrog 2-3¢ to make its game unprofitable, or rest at your true price and let it sit in front of a level that won't fill.",
  CLOCKWORK: "A fixed-size, fixed-interval feed (likely a hedging or rebalancing bot). Its flow is price-insensitive — fade it: quote against its direction and collect the spread it pays on schedule.",
  MOMENTUM: "Momentum bots overshoot. Place contrarian limits 3-5¢ beyond the run's likely exhaustion instead of joining late.",
  WASH: "Volume here is manufactured — ignore volume-based signals on this market and trust only the order book depth.",
  MARKET_MAKER: "A two-sided quoter keeps this book tight. Don't pay the spread — join its bid/ask instead of crossing, and use maker fees to your advantage.",
};

export function detectBots(tape, opts = {}) {
  const detections = [];
  const t = (tape || []).slice(-200);
  if (t.length < 8) return { detections, actors: [] };

  // 1. SNIPER — bursts of prints with sub-800ms gaps
  const times = t.map(x => x.t);
  let fastGaps = 0;
  for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g >= 0 && g < 800) fastGaps++; }
  if (fastGaps >= 4) detections.push({ type: "SNIPER", confidence: Math.min(95, 45 + fastGaps * 8), evidence: `${fastGaps} sub-second gaps between prints`, tactic: TACTICS.SNIPER });

  // 2. PENNY_JUMPER — long chains of ±1¢ price steps
  let steps = 0;
  for (let i = 1; i < t.length; i++) if (Math.abs(t[i].price - t[i - 1].price) === 1) steps++;
  if (steps >= 5) detections.push({ type: "PENNY_JUMPER", confidence: Math.min(90, 35 + steps * 7), evidence: `${steps} one-cent price steps in the last ${t.length} prints`, tactic: TACTICS.PENNY_JUMPER });

  // 3. Actors + CLOCKWORK
  const actors = fingerprintActors(t, opts);
  actors.filter(a => a.clockwork).forEach(a => {
    detections.push({ type: "CLOCKWORK", confidence: Math.min(92, 60 + Math.round((0.35 - a.regularity) * 100)),
      evidence: `${a.label}: ${a.prints}× exactly ${a.size} contracts every ~${a.meanGapSec.toFixed(0)}s (${a.yesShare >= 0.5 ? "YES" : "NO"}-heavy)`, tactic: TACTICS.CLOCKWORK, actor: a.label });
  });

  // 4. MOMENTUM — sustained same-direction price runs
  let run = 0, dir = 0, maxRun = 0;
  for (let i = 1; i < t.length; i++) {
    const d = Math.sign(t[i].price - t[i - 1].price);
    if (d !== 0 && d === dir) { run++; maxRun = Math.max(maxRun, run); }
    else if (d !== 0) { dir = d; run = 1; }
  }
  if (maxRun >= 5) detections.push({ type: "MOMENTUM", confidence: Math.min(88, 30 + maxRun * 10), evidence: `${maxRun}-print same-direction run`, tactic: TACTICS.MOMENTUM });

  // 5. WASH — identical price+count prints repeating
  const fp = new Map();
  t.forEach(x => { const k = `${x.price}|${x.count}`; fp.set(k, (fp.get(k) || 0) + 1); });
  const maxDup = Math.max(...fp.values());
  if (maxDup >= 5) detections.push({ type: "WASH", confidence: 70, evidence: `identical ${maxDup}× repeat of the same price+size print`, tactic: TACTICS.WASH });

  // 6. MARKET_MAKER — balanced two-sided taker flow
  const yes = t.filter(x => x.taker === "yes").length, no = t.filter(x => x.taker === "no").length;
  if (yes >= 5 && no >= 5 && Math.abs(yes - no) <= Math.max(3, t.length * 0.15)) {
    detections.push({ type: "MARKET_MAKER", confidence: 65, evidence: `${yes} YES-taker vs ${no} NO-taker prints — someone quotes both sides`, tactic: TACTICS.MARKET_MAKER });
  }

  detections.sort((a, b) => b.confidence - a.confidence);
  return { detections, actors };
}
