// Files a kalshi-data-*.json bundle (⬇ DATA BUNDLE button in the 📓
// Journal tab) into the repo's data/<profile>/ folder, with readable
// CSVs alongside the raw JSON. Optionally commits and pushes.
//
//   npm run data:import -- path/to/kalshi-data-default-....json
//   npm run data:import -- path/to/bundle.json --commit
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { SignalJournal } from "../src/engine/journal.js";
import { MarketRecorder } from "../src/engine/timeseries.js";

const args = process.argv.slice(2).filter(a => a !== "--commit");
const doCommit = process.argv.includes("--commit");
const file = args[0];
if (!file) { console.error("usage: npm run data:import -- <kalshi-data-*.json> [--commit]"); process.exit(1); }

const bundle = JSON.parse(readFileSync(file, "utf8"));
if (bundle.kind !== "kalshi-data-bundle") { console.error("not a kalshi data bundle"); process.exit(1); }

const profile = bundle.profile || "default";
const dir = join(process.cwd(), "data", profile);
mkdirSync(dir, { recursive: true });

const d = bundle.datasets || {};
const write = (name, content) => { writeFileSync(join(dir, name), content); console.log(`  data/${profile}/${name}`); };
const manifest = { profile, appVersion: bundle.appVersion, exportedAt: bundle.exportedAt, importedAt: new Date().toISOString(), counts: {} };

if (d.journal) {
  const j = SignalJournal.fromJSON(d.journal);
  write("journal.json", JSON.stringify(d.journal, null, 1));
  write("journal.csv", j.toCSV());
  write("journal-stats.csv", ["group,logged,open,settled,expired,win_rate_pct,avg_pnl_cents,avg_convergence_cents",
    ...j.stats().map(s => [s.group, s.n, s.open, s.settled, s.expired, s.winRatePct ?? "", s.avgPnlCents?.toFixed(2) ?? "", s.avgConvergenceCents?.toFixed(2) ?? ""].join(","))].join("\n"));
  manifest.counts.journalSignals = j.list().length;
}
if (d.tracker) {
  const r = MarketRecorder.fromJSON(d.tracker);
  write("tracker.json", JSON.stringify(d.tracker));
  const tickers = r.tickers();
  mkdirSync(join(dir, "tracker"), { recursive: true });
  for (const t of tickers) {
    writeFileSync(join(dir, "tracker", `${t}-prices.csv`), r.toCSV(t));
    writeFileSync(join(dir, "tracker", `${t}-tape.csv`), r.tapeCSV(t));
  }
  console.log(`  data/${profile}/tracker/ (${tickers.length} markets × prices+tape CSVs)`);
  manifest.counts.trackedMarkets = tickers.length;
}
if (d.snapshots) { write("snapshots.json", JSON.stringify(d.snapshots)); manifest.counts.snapshotBatches = (d.snapshots.batches || d.snapshots.snaps || []).length || undefined; }
if (d.sheetwatch) { write("sheet-changes.json", JSON.stringify(d.sheetwatch, null, 1)); manifest.counts.sheetChangeBatches = (d.sheetwatch.log || []).length; }
if (d.watchlist) { write("watchlist.json", JSON.stringify(d.watchlist, null, 1)); manifest.counts.watched = (d.watchlist || []).length; }
if (d.favorites) write("favorites.json", JSON.stringify(d.favorites, null, 1));
if (d.settings) write("settings.json", JSON.stringify(d.settings, null, 1));
write("manifest.json", JSON.stringify(manifest, null, 2));

console.log(`\n✅ Imported bundle from ${bundle.exportedAt} (app v${bundle.appVersion})`);

if (doCommit) {
  const msg = `data: ${profile} bundle ${String(bundle.exportedAt).slice(0, 16)}`;
  execSync(`git add "data/${profile}"`, { stdio: "inherit" });
  execSync(`git commit -m "${msg}"`, { stdio: "inherit" });
  execSync("git push origin main", { stdio: "inherit" });
  console.log("\n📤 Committed and pushed to the repository.");
} else {
  console.log(`\nTo publish: git add data/${profile} && git commit -m "data: ${profile}" && git push`);
  console.log("(or rerun with --commit)");
}
