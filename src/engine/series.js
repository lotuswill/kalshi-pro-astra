// ═══════════════════════════════════════════════════════════════
// KALSHI SERIES TICKERS — shared by the app fetch loop and the
// live-scan script so the two never drift apart.
// ═══════════════════════════════════════════════════════════════

// Verified active game-level series (tested 2026-03-04)
export const KALSHI_GAME_SERIES = [
  // PRIORITY: Niche sports (fetch first for Exclusives tab)
  "KXMLBSTGAME", "KXNCAAWBGAME", "KXNCAABBGAME", "KXNCAAHOCKEYGAME",
  "KXMLBSTTOTAL", "KXMLBSTSPREAD", "KXNCAAWBSPREAD", "KXNCAAWBTOTAL", "KXNCAABBSPREAD",
  // Asian baseball (verified live 2026-08-31): KBO (Korea) + NPB (Japan) —
  // winner, spread, total, and first-inning-run. Games run ~05:00Z (2pm KST/JST),
  // i.e. US late-night / early-morning — thin books, sportsbooks rarely price them.
  "KXKBOGAME", "KXKBOSPREAD", "KXKBOTOTAL", "KXKBORFI",
  "KXNPBGAME", "KXNPBSPREAD", "KXNPBTOTAL", "KXNPBRFI",
  // NBA (30 active)
  "KXNBAGAME", "KXNBASPREAD", "KXNBATOTAL", "KXNBA1HSPREAD", "KXNBA1HTOTAL", "KXNBA2HSPREAD",
  // NHL
  "KXNHLGAME", "KXNHLTOTAL", "KXNHLSPREAD", "KXNHLFIRSTGOAL", "KXNHLGOAL", "KXNHLANYGOAL",
  // NCAA Basketball
  "KXNCAAMBGAME", "KXNCAAMBSPREAD", "KXNCAAMBTOTAL", "KXNCAAMB1HWINNER",
  // MLB (seasonal - Spring Training moved to priority above)
  "KXMLBGAME", "KXMLBTOTAL", "KXMLBSPREAD", "KXMLBRFI",
  // NFL (seasonal)
  "KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL", "KXNFL2HSPREAD",
  // Soccer
  "KXEPLGAME", "KXLALIGAGAME", "KXBUNDESLIGAGAME", "KXBUNDESLIGASPREAD",
  "KXSERIAGAME", "KXUCLGAME", "KXUELGAME", "KXMLSGAME", "KXMLSSPREAD", "KXMLSTOTAL",
  "KXLIGAPORTUGALGAME", "KXSOCCERTOTAL",
  // Tennis
  "KXATPMATCH", "KXWTAMATCH", "KXCHALLENGERMATCH", "KXITFMATCH",
  // Cricket
  "KXT20MATCH", "KXIPLGAME",
  // Combat
  "KXUFCFIGHT",
  // World Cup (verified live 2026-07-03): regulation-time moneyline
  // (team/team/TIE) + spread/total
  "KXWCGAME", "KXWCSPREAD", "KXWCTOTAL",
];

// Progression / advancement series (series winner, advance to next round,
// conference & league champions). These feed the cross-event equivalence
// engine: when a game is decisive, "Team A wins the game" and "Team A
// advances / wins the series" are the same outcome in two markets.
// Unknown or out-of-season series return no events and are skipped.
export const KALSHI_PROGRESSION_SERIES = [
  // NBA playoffs
  "KXNBASERIES", "KXNBAEAST", "KXNBAWEST", "KXNBA", "KXNBACHAMP", "KXNBAFINALSMVP",
  // NHL playoffs
  "KXNHLSERIES", "KXSTANLEYCUP", "KXNHLEAST", "KXNHLWEST", "KXNHL",
  // MLB postseason (verified in catalog 2026-07-03)
  "KXMLBWS", "KXMLB", "KXWSAL", "KXWSNL", "KXMLBAL", "KXMLBNL", "KXMLBDIVWINNER",
  // NFL playoffs
  "KXSUPERBOWL", "KXNFLAFC", "KXNFLNFC", "KXNFL",
  // NCAA tournaments (March Madness advancement)
  "KXNCAAMBCHAMP", "KXMARMADMEN", "KXMARMADWOMEN", "KXNCAAWBCHAMP",
  "KXNCAAMBFINALFOUR", "KXNCAAMBELITE8", "KXNCAAMBSWEET16",
  // Soccer knockout / titles
  "KXUCL", "KXUCLCHAMP", "KXUEL", "KXEPLWINNER", "KXEPLCHAMP",
  // World Cup progression (verified live 2026-07-03):
  //   KXWCADVANCE — per-match "Team advances" (match winner incl. ET/pens)
  //   KXWCROUND   — round-qualifier ladder (R32/R16/QUAR/SEMI/FINAL)
  //   KXMENWORLDCUP — cup winner
  "KXWCADVANCE", "KXWCROUND", "KXWCSTAGE", "KXMENWORLDCUP",
];
