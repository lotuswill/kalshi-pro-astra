# Kalshi Pro Astra

Personal, local-first Kalshi terminal with a bid/ask combo scanner, reduced-leg
hedge optimizer, manual create/quote workflow, and guarded paper trading.

Based on `lotuswill/kalshi-pro` v7.18.1 at commit
`80b028d0a87d955da0ca2a7caf24958802ab28fb`. The original `kalshi-pro` remains the
Claude version. This repository is the independent Astra version.

## Run

Use Node.js 24.15+ in the 24.x LTS line (or a version allowed by `package.json`):

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5174**. On Windows, `START.bat` runs these steps.
The separate port gives this app its own browser vault/settings storage.
No cloud deployment is required. Existing local repositories may contain
unpublished work: review their status before syncing this independent snapshot.

### Update an existing Windows folder

`UPDATE_LOCAL.ps1` downloads and tests a clean checkout first, then moves your
existing `C:\Users\ash\git\kalshi-pro-astra` folder to a timestamped sibling
backup and installs the tested checkout in its place. It never targets
`kalshi-pro`. Unpublished edits and local-only files remain in the backup;
they are not automatically merged into the new checkout. Browser vault data
stays associated with the app's browser origin and is not copied by this script.

Run the updater from PowerShell, or download it separately from this repository
if the old checkout does not contain it yet. Its default destination is
`$env:USERPROFILE\git\kalshi-pro-astra`; `-RepoRoot` overrides that path, and
`-NoStart` installs without starting the server. It requires Git, a supported Node.js version
and your Windows PowerShell policy to permit the script. Stop an existing
Astra server before running the default update-and-start flow.

Unlock/create your local Key Vault, open **Combos**, and choose **Load synthetic
examples** for a complete walkthrough without sending exchange requests.
Choose **Load Kalshi markets** for real public listings, load more pages, then
**Refresh match prices** (first 20 matches) or select a combo and refresh its books.

## Combos

Defaults: OI **1+**, expiry **within 72 hours**, **highest open interest first**,
showing up to **100 combos** from loaded matches. Each search batch reads up to
20 pages, even if 100 matches appear sooner; Search more extends the ranking.
This is a ranking of loaded markets, not an exchange-wide top 100. Search/filter volume and leg count; sort by bid minus required-leg ask
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
npm run test:local
npm run build
```

See [Astra changes and limitations](docs/ASTRA_CHANGES.md),
[catalog schema](docs/COMBO_CATALOG_SCHEMA.md), and the
[original app documentation](docs/CLAUDE_BASELINE_README.md).

Source remains subject to the included proprietary [LICENSE](LICENSE).

### Combo-focused workspace

After unlocking, the app opens directly to Combos with the full window available
for the scanner and hedge editor. The workflow is Find combos → Build hedge →
Paper trading, with Saved drafts alongside it. Search, OI, expiration, volume,
and sort remain visible. More filters, Search details, and Data options contain
secondary controls. Quotes & model assumptions contains RFQs and manual quotes.

Connection and Live positions are in the app header. Visiting either preserves
the combo catalog, selected hedge, filters, and drafts in this session. Active
scans are interrupted and automatic paper monitoring pauses when leaving Combos;
it does not restart automatically on return. More → Other tools opens the
original sports terminal on demand, including its live trading controls.
Sports feeds, trackers and sportsbook fetches do not start in the combo workspace.
