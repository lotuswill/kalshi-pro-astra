// ═══════════════════════════════════════════════════════════════
// TICKER PARSING — pure functions for Kalshi ticker structure
// Ticker anatomy: KX<SERIES>-<YY><MMM><DD><AWAY><HOME>[-<MARKET>]
//   e.g. event  KXNBAGAME-26MAR07GSWOKC
//        market KXNBAGAME-26MAR07GSWOKC-GSW
// ═══════════════════════════════════════════════════════════════

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// Extract the two team codes from an event ticker suffix.
export function extractTeamsFromTicker(ticker) {
  const m = (ticker || "").match(/\d{2}[A-Z]{3}\d{2}([A-Z]{2,4})([A-Z]{2,4})$/);
  if (!m) return [];
  return [m[1], m[2]];
}

// All plausible 2/3/4-char splits of the team-pair blob (team code
// lengths vary, so "LALDEN" could split LAL|DEN or LA|LDEN etc).
export function extractTeamCodes(eventTicker) {
  const parts = (eventTicker || "").split("-");
  if (parts.length < 2) return [];
  const gameCode = parts[1];
  const dateMatch = gameCode.match(/^\d{2}[A-Z]{3}\d{2}(.+)$/);
  if (!dateMatch) return [];
  const teams = dateMatch[1];
  const codes = [];
  for (let i = 2; i <= 4; i++) {
    if (i < teams.length) codes.push([teams.slice(0, i).toUpperCase(), teams.slice(i).toUpperCase()]);
  }
  return codes;
}

export function parseGameDate(ticker) {
  const m = (ticker || "").match(/(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (month === undefined) return null;
  return new Date(2000 + parseInt(m[1]), month, parseInt(m[3]));
}

// Canonical sorted "AAA-BBB" key for the two teams in a game, so
// winner/spread/total events for the same game group together.
export function getTeamPair(ticker) {
  const m = (ticker || "").match(/\d{2}[A-Z]{3}\d{2}([A-Z]{2,4})([A-Z]{2,4})/);
  return m ? [m[1], m[2]].sort().join("-") : null;
}

// Game key shared by all markets on the same game: strip series prefix
// and market suffix. "KXNBAGAME-26MAR05LALDEN-LAL" → "26MAR05LALDEN"
export function getGameKey(eventTicker) {
  const parts = (eventTicker || "").split("-");
  if (parts.length < 2) return null;
  return parts.slice(1).join("-").replace(/-[A-Z0-9]+$/, "");
}

// Series prefix ("KXNBAGAME") from an event ticker.
export function getSeriesPrefix(eventTicker) {
  return (eventTicker || "").split("-")[0] || "";
}
