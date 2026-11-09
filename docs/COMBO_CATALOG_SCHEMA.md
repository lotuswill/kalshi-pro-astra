# Catalog contract

Import a JSON object `{ "version": 1, "markets": [...] }`. Maximum 10,000
instruments / 15 MB. Each instrument includes:

```json
{
  "id": "EXAMPLE-AB", "venue": "kalshi", "title": "Example A and B",
  "legs": [
    {"marketId":"EXAMPLE-A","outcome":"yes","title":"A","eventId":"EVENT-A"},
    {"marketId":"EXAMPLE-B","outcome":"no","title":"B","eventId":"EVENT-B"}
  ],
  "status": "open", "payout": 1,
  "openInterest": 150000, "volume": 250000, "volume24h": 25000,
  "expiration": null, "closeAt": null, "quoteAt": null,
  "bid": 0.30, "ask": 0.32, "bidSize": 25, "askSize": 30,
  "bids": [[0.30,25],[0.29,100]], "asks": [[0.32,30],[0.33,100]],
  "source": "import", "fee": null,
  "productSettlement": false, "rulesVerified": false,
  "rules": "Supply exact terms from the venue."
}
```

This example deliberately contains unknown timestamps/rules/fees and cannot
pass paper checks. Timestamps are Unix **milliseconds**, price/quantity fields
are JSON numbers, dollar prices range from 0 to 1. Set unknown values to null,
not zero. `expiration` is settlement expiration; `closeAt` is trading close.
`quoteAt` is when that specific quote was observed, never the export time.

Venues: `kalshi`, `polymarket-us`. Tradable states: `open`, `active`. Each market
has 1–12 unique underlying IDs and explicit `yes`/`no` outcomes. Exact quote
matching is venue + sorted set of underlying IDs and outcomes. Supply canonical
YES single instruments with `id` matching their sole leg's `marketId` so the
engine can find each required leg; NO prices are complemented from these.

`bids`/`asks` are levels `[dollars, available contracts]`. If omitted, a known
top price and positive top size provide only that much liquidity. An explicitly
empty side means no liquidity. Top prices must agree with supplied depth.

Fee models: `{ "rate": 0.07, "rounding": "ceil" }` or `half-even`, where `rate`
is θ in the documented formula. Values are user modeling assumptions. Do not
mark rules verified until the exact contract and exceptional-settlement terms
have been reviewed. Import always labels observations as imported, regardless
of their declared source, and never enables automatic paper execution.

For `polymarketMarket(m, book, metadata)`, metadata takes `openInterest`,
`volume`, `volume24h`, `expiration`, `closeAt`, `observedAt`, `status`, `fee`,
`productSettlement`, `rulesVerified`. The adapter accepts explicit normalized
book levels and buy/sell or yes/no leg outcomes. It rejects unknown leg sides.

Local draft exports use schema `astra-combo-draft/v1`, a parent ID, venue and
retained legs, plus status `quote-required`. They are not venue API payloads.
