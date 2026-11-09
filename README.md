# Kalshi Pro Astra

Personal, local-first Kalshi terminal with a bid/ask combo scanner, reduced-leg
hedge optimizer, manual create/quote workflow, and guarded paper trading.

Based on `lotuswill/kalshi-pro` v7.18.1 at commit
`80b028d0a87d955da0ca2a7caf24958802ab28fb`. The original `kalshi-pro` remains the
Claude version. This repository is the independent Astra version.

## Run

Use Node.js 22 or newer:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5174**. On Windows, `START.bat` runs these steps.
The separate port gives this app its own browser vault/settings storage.
No cloud deployment is required. Existing local repositories may contain
unpublished work: review their status before syncing this independent snapshot.

Unlock/create your local Key Vault, open **Combos**, and choose **Load synthetic
examples** for a complete walkthrough without sending exchange requests.
Choose **Load Kalshi markets** for real public listings, load more pages, then
**Price first 20 matches** or select a combo and refresh its books.

## Combos

Defaults: OI **100,000+**, expiry **within 72 hours**, **earliest expiration
first**. Search/filter volume and leg count; sort by bid minus required-leg ask
product. Both bid and ask stay visible. Unknown prices remain unknown.

Remove legs or pin the ones to retain, compare costs and price changes, save a
local draft, and optionally create/find the selected reduced instrument on
Kalshi. Instrument creation and RFQs require explicit in-app confirmation and
use your existing Key Vault. New combos need actual quotes; the product of leg
prices is not treated as an executable quote.

Manual/automatic **paper** trading includes liquidity, freshness, spread, fees,
settlement review and portfolio limits. This new page does not execute real
hedge orders or accept quotes. Other inherited terminal tabs retain their own
live-order features; the combo paper Stop button does not cancel those orders.

## Validation

```sh
npm test
npm run test:ui
npm run build
```

See [Astra changes and limitations](docs/ASTRA_CHANGES.md),
[catalog schema](docs/COMBO_CATALOG_SCHEMA.md), and the
[original app documentation](docs/CLAUDE_BASELINE_README.md).

Source remains subject to the included proprietary [LICENSE](LICENSE).
