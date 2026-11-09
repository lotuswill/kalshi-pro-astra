import { describe, it, expect } from "vitest";
import { extractTeamsFromTicker, parseGameDate, getTeamPair, getGameKey, getSeriesPrefix, extractTeamCodes } from "../tickers.js";

describe("parseGameDate", () => {
  it("reads YYMMMDD from the ticker", () => {
    const d = parseGameDate("KXNBAGAME-26MAR07GSWOKC");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(7);
  });
  it("returns null when no date present", () => {
    expect(parseGameDate("KXNBASERIES-FINALS")).toBeNull();
  });
});

describe("extractTeamsFromTicker", () => {
  it("splits the trailing team blob into two codes covering all letters", () => {
    const teams = extractTeamsFromTicker("KXNBAGAME-26MAR07LALDEN");
    expect(teams).toHaveLength(2);
    expect(teams.join("")).toBe("LALDEN");
  });
});

describe("getTeamPair", () => {
  it("produces the same canonical key for winner and spread events of one game", () => {
    expect(getTeamPair("KXNBAGAME-26MAR05LALDEN")).toBe(getTeamPair("KXNBASPREAD-26MAR05LALDEN"));
  });
  it("returns null when unparseable", () => {
    expect(getTeamPair("KXWEIRD")).toBeNull();
  });
});

describe("getGameKey", () => {
  it("strips series prefix and market suffix", () => {
    expect(getGameKey("KXNBAGAME-26MAR05LALDEN-LAL")).toBe("26MAR05LALDEN");
    expect(getGameKey("KXNBAGAME-26MAR05LALDEN")).toBe("26MAR05LALDEN");
  });
});

describe("getSeriesPrefix", () => {
  it("returns the leading series ticker", () => {
    expect(getSeriesPrefix("KXNBAGAME-26MAR05LALDEN")).toBe("KXNBAGAME");
  });
});

describe("extractTeamCodes", () => {
  it("offers all plausible 2-4 char splits", () => {
    const splits = extractTeamCodes("KXNBAGAME-26MAR05LALDEN");
    expect(splits).toContainEqual(["LAL", "DEN"]);
  });
});
