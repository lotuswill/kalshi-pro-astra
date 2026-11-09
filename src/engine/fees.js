// ═══════════════════════════════════════════════════════════════
// FEES & ARB MATH — pure functions, no browser dependencies
// Kalshi fee formula from kalshi.com/fee-schedule:
//   Taker: ceil(0.07 × C × P × (1-P)), Maker: ceil(0.0175 × C × P × (1-P))
//   P = price in dollars (50¢ = 0.50), C = number of contracts
// ═══════════════════════════════════════════════════════════════

export function mlToProb(ml) {
  const n = parseFloat(ml);
  if (!n || isNaN(n)) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

export function kalshiFee(priceInCents, contracts, isMaker = false) {
  const p = (priceInCents || 0) / 100;
  const c = contracts || 1;
  const coeff = isMaker ? 0.0175 : 0.07;
  // Round away float noise (0.07×100×0.25 → 1.7500000000000002) before
  // ceiling to the cent, otherwise exact-cent fees get overcharged 1¢.
  const raw = Math.round(coeff * c * p * (1 - p) * 1e8) / 1e6;
  return Math.ceil(raw) / 100; // dollars
}

export function kalshiFeeCents(priceInCents, contracts, isMaker = false) {
  return Math.ceil(kalshiFee(priceInCents, contracts, isMaker) * 100);
}

// For paired arb: total cost = leg1_ask + leg2_ask + fee1 + fee2
// Profit = 100 - total_cost (per contract, in cents)
export function calcArbProfit(leg1AskCents, leg2AskCents, contracts = 1, isMaker = false) {
  const fee1 = kalshiFeeCents(leg1AskCents, contracts, isMaker);
  const fee2 = kalshiFeeCents(leg2AskCents, contracts, isMaker);
  const totalCostCents = (leg1AskCents + leg2AskCents) * contracts + fee1 + fee2;
  const payoutCents = 100 * contracts;
  const profitCents = payoutCents - totalCostCents;
  return { totalCostCents, payoutCents, profitCents, fee1, fee2, feeTotal: fee1 + fee2, profitable: profitCents > 0 };
}

export function midCents(market) {
  const bid = market?.yes_bid || 0, ask = market?.yes_ask || 0;
  if (!bid && !ask) return null;
  if (!bid) return ask;
  if (!ask) return bid;
  return (bid + ask) / 2;
}
