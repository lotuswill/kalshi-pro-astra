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

- Defaults: minimum OI 1 contract, future expiration within 72 hours,
  highest combo open interest first, showing the top 100 loaded matches. Search title/ticker/legs; filter volume,
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

## Open-interest discovery correction

The live listing can begin with hundreds of newly created combos reporting
`open_interest_fp: "0.00"`. Loading only its first page made every positive OI
minimum appear broken. Load Kalshi markets now follows up to 20 pages (200
records each), stopping early only at end of listing. Search more
continues from the cursor for another bounded batch. Stop interrupts requests.
The catalog keeps room for leg-book refreshes and stops discovery before its
10,000-instrument limit; repeated cursors are rejected. Filters are fixed while
a batch runs. This remains a partial listing scan, not an exchange-wide index.

Diagnostics show maximum reported combo OI, positive/zero/unknown counts, and
the same figures after other filters. Minimum OI zero disables the OI filter;
unknown stays unknown and cannot pass a positive minimum. OI remains the combo's
own outstanding contract count, never a sum or product of its legs' OI.

Regression coverage includes zero-OI pages before a funded combo, thresholds
1/10/100000, missing and fractional OI, pagination budgets, continuation,
repeated cursors, and Stop. Public API inspection reproduced all-zero initial
pages and positive OI on later pages; no account or order endpoint was used.

## Combo-focused layout

- Default to a full-width combo workspace, with no sports icon rail, order-book
  sidebar, Turbo controls, or unrelated feed-status indicators.
- Mount the original sports terminal only through More → Other tools. Its
  WebSocket engine disconnects when leaving that terminal.
- Keep five primary scanner fields visible; collapse secondary filters, import/
  export, diagnostics, RFQs and model settings into labeled disclosures.
- Use a single combo workflow bar; retain paper status, Stop, bid/ask comparison,
  the leg editor, fee/risk checks and explicit create/RFQ confirmation dialogs.
- Preserve the combo workspace while viewing Connection or Live positions.
  Leaving pauses monitoring, aborts pending read requests and closes previews.
  A request already submitted to Kalshi is not undone by changing views.
- Extend `npm run test:ui` with the React shell regression: no default network
  requests, deferred sports-tool mounting, preserved filters/catalog, disclosure
  state, and automatic paper pause across account navigation.

## Top 100 default

Minimum combo OI is now 1 contract. The default ordering is open interest,
descending, with up to 100 rows shown after applying all filters. The 72-hour
expiration window remains. Each discovery batch scans its full page budget even
when 100 matches have already been found, so later pages can improve the ranking.
The matching count includes all loaded matches; the visible table is capped at
100. Search more continues discovery and reranks the list. Partial coverage is
explicit; this is not an exchange-wide top-100 index. Reset defaults restores
these settings. Regression coverage includes a higher-OI combo on a later page
replacing an earlier result after the first page already had 120 matches.

## Direct ticker and suffix lookup; larger combos

The user-supplied reference KXMVECROSSCATEGORY-S2026S5C36JL3LF2DS5U3-EGY4ZTQ7G
was confirmed through the public market endpoint to contain 17 legs. The prior
12-leg catalog validator skipped it entirely. Catalog validation, default scan
leg count and leg editing now support up to 32 legs. Scenario enumeration stays
limited to 12; optimization stays bounded to 128 candidate alternatives.

Enter a full ticker in Search and press Enter for a direct metadata request.
A separate result remains visible regardless of scanner filters, market status
or top-100 placement. Books and execution gates remain independent. Full lookup
works even if the order book is unavailable. Ticker identity is verified.

Suffix lookup resolves exactly the last nine characters, case-insensitively,
against a per-profile local ticker index plus the named user-supplied reference.
Only IDs are persisted; lookup metadata is fetched afresh. Unseen suffixes search
up to 20 listing pages and report incomplete coverage. Suffix collisions require
the full ticker rather than choosing an arbitrary market. No quote acceptance
or real order capability was added.

## Local proxy reliability

Direct API tests had missed the Vite proxy's outbound connection behavior. In
this session, the old proxy returned an empty HTTP 500 with EAI_AGAIN while the
environment-aware direct HTTPS client succeeded. The local proxy now supplies
an explicit environment-aware HTTPS agent, uses the recommended external-api
host and sends structured connection errors. It bounds DNS/connection waits as
well as socket waits. TLS verification stays enabled.

Public GETs use a 10-second request/body deadline, one alternate-host attempt
on network/timeouts/server errors, and remember a working route for the session.
Caller cancellation stops fallback. 401/403/404 are reported without retry.
Authenticated write paths are not retried. Lookup progress and final failures
are visible, and `npm run diagnose:kalshi` tests the actual local proxy path.
Native and hosting route mappings include the same public fallback; no cloud
deployment was performed.

Validation includes a successful reference-ticker lookup through the real local
Vite proxy, plus simulated stalled fetch/body, fallback, cancellation and
non-retryable HTTP errors. This does not establish the precise network failure
on the user's Windows machine; the diagnostic command can verify that path.
