// Unpack a kalshi-bug-report-*.json bundle (exported from the 🐞 Report
// tab) into a folder with report.md + screenshots, ready to hand to
// Claude Code: `npm run report -- path/to/kalshi-bug-report-....json`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const file = process.argv[2];
if (!file) { console.error("usage: npm run report -- <kalshi-bug-report-*.json>"); process.exit(1); }

const bundle = JSON.parse(readFileSync(file, "utf8"));
if (bundle.kind !== "kalshi-bug-report") { console.error("not a kalshi bug report bundle"); process.exit(1); }

const dir = join(process.cwd(), basename(file).replace(/\.json$/, ""));
mkdirSync(dir, { recursive: true });

const shots = (bundle.screenshots || []).map((s, i) => {
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(s.dataUrl || "");
  if (!m) return null;
  const ext = m[1].split("/")[1].replace("jpeg", "jpg");
  const name = `screenshot-${i + 1}.${ext}`;
  writeFileSync(join(dir, name), Buffer.from(m[2], "base64"));
  return name;
}).filter(Boolean);

const c = bundle.context || {};
const md = `# Bug report — Kalshi Sports Terminal v${c.appVersion || "?"}

**Reported:** ${c.time || "?"} · profile \`${c.profile || "?"}\` · tab \`${c.tab || "?"}\` · ${c.screen || ""}
**UA:** ${c.userAgent || "?"}

## What went wrong

${bundle.description || "(no description)"}

## Expected

${bundle.expected || "—"}

## Screenshots

${shots.length ? shots.map(s => `![${s}](${s})`).join("\n\n") : "(none)"}

## Auto-captured errors

${(c.recentErrors || []).map(e => `- \`${new Date(e.time).toISOString()}\` **${e.kind}**: ${e.msg}${e.extra ? ` _(${e.extra})_` : ""}`).join("\n") || "(none captured)"}
`;
writeFileSync(join(dir, "report.md"), md);
console.log(`Unpacked to ${dir}\n  report.md + ${shots.length} screenshot(s)`);
console.log(`\nFeed it to Claude: open the repo in Claude Code and say "read ${basename(dir)}/report.md and fix the bug"`);
