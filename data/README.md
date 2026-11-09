# data/ — recorded market data, per profile

The app records into browser localStorage (journal, tracker recordings,
hourly snapshots, mentor sheet changes, watchlist, settings). This
folder is where those recordings get filed into the repository so
they're versioned, shareable, and safe from browser data loss.

## Flow

1. In the app: **📓 Journal tab → ⬇ DATA BUNDLE → REPO** downloads
   `kalshi-data-<profile>-<timestamp>.json`.
2. In the repo:
   ```
   npm run data:import -- ~/Downloads/kalshi-data-default-....json --commit
   ```
   This writes `data/<profile>/` (raw JSON + readable CSVs, including
   per-market tracker price/tape files and the journal learning table)
   and, with `--commit`, commits and pushes in one step.

Each import overwrites the profile's current files — git history keeps
every prior version, so nothing is ever lost and diffs show exactly
what changed between exports.

**Never contains keys.** The encrypted vault is deliberately excluded
from bundles.
