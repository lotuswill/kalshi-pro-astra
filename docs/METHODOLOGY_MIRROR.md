# Methodology Mirror — roadmap

Goal: the app's detection logic should mirror how the methodology creator
("the mentor") actually trades. We ingest his activity, distill patterns,
and tune the scanner until its signals match his entries.

## What ships today (v7.2)

- **Login for him** — the LockScreen has per-user profiles; each profile is
  an independently AES-256-encrypted vault. He picks/creates his profile,
  sets his own master password, and stores his own Kalshi keys. Nothing is
  shared between profiles.
- **Fills ingestion** — the 🧭 Mentor tab pulls his fills from Kalshi's
  authenticated `/portfolio/fills` (using `mentor_kalshi_api_key` /
  `mentor_kalshi_private_key` from the vault) and runs
  `src/engine/fills.js → analyzeFills`:
  entry-price distribution, YES/NO and buy/sell mix, taker %, series bias,
  median hours-before-game, FIFO round trips with hold time, win rate and
  realized P&L.
- **Sheet ingestion (values)** — paste his sheet's published-CSV link;
  `parseCSV` + `summarizeSheet` profile every column (numeric ranges,
  means, samples) as raw material for reverse-engineering his edge
  formula inputs.

## Next phases

1. **Formula capture** — published CSVs carry values only. To read his
   actual formulas we need the Google Sheets API (`spreadsheets.get` with
   `includeGridData=true&fields=sheets.data.rowData.values(userEnteredValue)`),
   which requires an OAuth client or a service account he shares the sheet
   with. Store the token in his vault profile.
2. **Pattern → rule extraction** — correlate each of his fills with the
   market snapshot at fill time (odds gap, spread, hours-to-game, fresh
   listing age, near-certain band). The stats that separate his entries
   from random markets become scanner rules with his thresholds.
3. **Signal replay/backtest** — run the scanner over recorded snapshots
   and measure: how many of his entries would our signals have flagged,
   and how many of our signals did he ignore? Tune until precision/recall
   against his fills is high.
4. **Live mirror mode** — when a scanner signal matches his historical
   pattern profile, tag it "MENTOR MATCH" in the Arbitrage tab and weight
   it in suggestions.

## Data needed from him

- Kalshi API key + RSA private key (read scope is enough for fills).
- Google Sheet: published-CSV link now; Sheets API sharing when we do
  formula capture.
- Ideally: a note per trade type (what he looks at first) to label the
  pattern clusters.
