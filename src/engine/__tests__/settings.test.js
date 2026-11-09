import { describe, it, expect } from "vitest";
import { SETTINGS_SCHEMA, defaultSettings, clampSetting, mergeSettings, engineOpts, liveOpts, volumeOpts } from "../settings.js";

describe("SETTINGS_SCHEMA integrity", () => {
  it("has unique keys, sane ranges, and defaults inside them", () => {
    const seen = new Set();
    for (const g of SETTINGS_SCHEMA) for (const f of g.fields) {
      expect(seen.has(f.key)).toBe(false);
      seen.add(f.key);
      expect(f.min).toBeLessThan(f.max);
      expect(f.default).toBeGreaterThanOrEqual(f.min);
      expect(f.default).toBeLessThanOrEqual(f.max);
      expect(f.desc.length).toBeGreaterThan(10); // every knob is explained
    }
    expect(seen.size).toBeGreaterThanOrEqual(18);
  });
});

describe("defaults / clamp / merge", () => {
  it("defaultSettings covers every schema key", () => {
    const d = defaultSettings();
    for (const g of SETTINGS_SCHEMA) for (const f of g.fields) expect(d[f.key]).toBe(f.default);
  });

  it("clamps out-of-range and garbage values", () => {
    expect(clampSetting("value.minEvCents", 999)).toBe(25);
    expect(clampSetting("value.minEvCents", -4)).toBe(0.5);
    expect(clampSetting("value.minEvCents", "abc")).toBe(3); // default
    expect(clampSetting("not.a.key", 5)).toBeNull();
  });

  it("merge drops unknown keys and clamps known ones", () => {
    const m = mergeSettings({ "value.minEvCents": 100, "hacked.key": 1, "skew.extremeCents": "70" });
    expect(m["value.minEvCents"]).toBe(25);
    expect(m["skew.extremeCents"]).toBe(70);
    expect(m["hacked.key"]).toBeUndefined();
    expect(m["trade.defaultQty"]).toBe(10); // untouched default
  });
});

describe("option mapping", () => {
  const s = mergeSettings({ "value.minEvCents": 6, "equiv.exactWindowHours": 3, "live.lagThreshold": 95, "volume.highX": 8 });

  it("engineOpts feeds the arb composition", () => {
    const o = engineOpts(s);
    expect(o.minEvCents).toBe(6);
    expect(o.exactWindowMs).toBe(3 * 3600_000);
    expect(o.extremeCents).toBe(65);
  });

  it("liveOpts and volumeOpts map their pages", () => {
    expect(liveOpts(s).threshold).toBe(95);
    expect(volumeOpts(s).highX).toBe(8);
  });
});
