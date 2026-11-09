# Astra 8.0.0-astra.1 — November 9, 2026

Source baseline: `lotuswill/kalshi-pro` commit
`80b028d0a87d955da0ca2a7caf24958802ab28fb` (v7.18.1). That repository remains the
Claude version. This independent snapshot is published only to
`lotuswill/kalshi-pro-astra`; its new history records the upstream baseline.

## Combos page

The old Combos page searched for buying discounts using midpoint estimates.
The Astra page uses explicit bid/ask quotes for the requested sell-original /
buy-reduced-combination analysis. Other terminal modules retain their inherited
behavior; this is not a rewrite of their valuation or live-order logic.

- Defaults: minimum OI 100,000 contracts, future expiration within 72 hours,
  earliest combo expiration first. Search title/ticker/legs; filter volume,
  24-hour volume, venue, max legs, and optionally first-leg expiration.
- Separate original bid and ask; required-outcome leg ask product; sortable
  original bid minus product. Zero and unknown stay distinct. No midpoint or
  last-trade fallback in Astra calculations.
- Load 200 markets per page or up to 20 further pages; filters/sorts cover the
  loaded subset. Price the first 20 matches and their underlying books. All
  observation times stay attached to the respective quotes.
- Remove one or several legs, pin mandatory legs, compare bounded subsets (up
  to 128). Exact matching includes venue, underlying IDs and YES/NO outcomes.
  Unquoted alternatives show quote-required. Removing a leg never modifies an
  existing exchange position.
- Compare original/new bid and ask, ask delta, quantity-aware hedge purchase
  cost, fee estimates, conservative capital and conditional payoff bounds.
  Scenario table includes every binary outcome up to 12 legs (first 64 shown).
- Local draft export and catalog import/export. Ledger/drafts are isolated by
  Key Vault profile. Market snapshots and settings are session-local.

## Create and quote

The selected reduced set can be created/found on Kalshi after an explicit
in-app preview. The app requires verified collection identity, unordered
semantics and leg-count limits; the exchange validates additional constraints.
Retained leg order and outcomes are preserved. The returned instrument must
match the requested set. It does not automatically create all alternatives.
Creating a market can consume the exchange's instrument-creation quota.

Request original or hedge RFQs at the chosen quantity, inspect returned maker
bid/ask/size and timestamps, and cancel each RFQ. Each maker stays separate;
quotes are not combined into a fictitious book. This page never accepts RFQs or
places real orders. RFQ responses remain separate from the paper book model.
RFQ tracking is session-local: leaving the page does not cancel exchange RFQs.
Use your Kalshi account to manage requests after leaving.

Official endpoint references checked for implementation:

- https://docs.kalshi.com/api-reference/multivariate/create-market-in-multivariate-event-collection
- https://docs.kalshi.com/api-reference/multivariate/get-multivariate-event-collection
- https://docs.kalshi.com/api-reference/communications/create-rfq
- https://docs.kalshi.com/api-reference/communications/get-quotes

## Manual and automatic paper trading

Both modes use quote age/skew, spread, liquidity, settlement-rule review,
configured fees, adverse price allowance, P&L floor, per-trade/portfolio/event
capital and daily realized loss limits. Pending orders reserve capital. A
paper fill requires a subsequent observation of BOTH books within 60 seconds
and a second guard check. One original cannot have duplicate active positions.

Automatic paper mode polls the selected combination every 15 seconds, only
while the page is visible. It starts off and stops on navigation/unmount,
hidden tab, storage changes or errors. Stop aborts reads and cancels pending
paper orders; it does not close open positions or cancel live exchange RFQs.
Paper writes use Web Locks across tabs. Corrupt/full storage blocks execution.

The simulator assumes both sides fill. It does not model exchange rejection,
partial fills, queue position or recovery. This release does not add automated
real-money hedging or a self-learning profitability model. Inherited live-order
features in other tabs remain separate from these new paper controls.

## Model interpretation

For q contracts per side, short the original YES at bid (modeled as buying its
NO at 1−bid), then buy reduced-combo YES at ask. Walk depth and apply configured
adverse price allowance. No cross-margin credit is assumed.

```
net = original bid proceeds − hedge ask cost − modeled fees
capital = q − original bid proceeds + hedge ask cost + modeled fees
settlement P&L = net + q × (retained product − original product)
```

If the retained outcomes are identical and both contracts settle by the same
product rule, each underlying outcome is in [0,1] and the product difference is
in [0,1]. The conditional worst/best P&L bounds are net and net+q. Correlation
does not change that subset identity, but incompatible settlement/void rules
invalidate its application. Review both exact contracts before enabling the
model assumption. These are not independently verified profitable trades.

The leg ask product is only a benchmark. Buying individual legs does not
replicate their conjunction, and multiplying market asks does not establish
fair value. Fees use user-supplied θ×q×p×(1−p), rounded per modeled depth fill;
synthetic θ=.07 is an example, not a current fee-schedule assertion.

## Local runtime and separation

`npm ci` then `npm run dev`, at http://127.0.0.1:5174. The explicit separate
port keeps browser vault/settings storage apart from the Claude app's usual
5173 origin. Export/import vault data intentionally if needed. The Combos page
is mounted inside the existing terminal with isolated styles; no companion
server or iframe is required. It uses the existing local proxy and Key Vault.

The stale dependency lockfile is repaired; package/PWA/Android identifiers are
Astra-specific. The Claude GitHub automation is excluded from this copy. The
push helper checks that its destination is `kalshi-pro-astra` and does not stage
or commit arbitrary local files. Original license and attribution are retained.

## Validation

Run `npm test` for inherited engine tests and Astra tests, `npm run test:ui`
for the integrated DOM workflow, and `npm run build` for the production build.
Tests use simulated exchange responses, never a funded account. Live creation,
RFQ lifecycle and order execution have not been exercised against your account.
The DOM test verifies behavior, not browser layout or Windows installation.
