import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AUTO_SIM_STORAGE_KEY,
  DEFAULT_AUTO_SIM_PREFS,
  getAutoSimPrefs,
  getServerAutoSimPrefs,
  setAutoSimEnabled,
  setAutoSimFillMode,
  setAutoSimQuantity,
  setAutoSimRiskPct,
  setAutoSimSizingMode,
} from "../src/lib/autoSimPrefs";

type FakeWindow = {
  localStorage: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
  };
  addEventListener: () => void;
  removeEventListener: () => void;
};

const g = globalThis as unknown as { window?: FakeWindow };

describe("autoSimPrefs snapshots (useSyncExternalStore contract)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    g.window = {
      localStorage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    delete g.window;
  });

  it("returns the same object on repeated reads of unchanged storage", () => {
    assert.equal(getAutoSimPrefs(), getAutoSimPrefs());
    store.set(AUTO_SIM_STORAGE_KEY, JSON.stringify({ enabled: false, quantity: 25 }));
    const a = getAutoSimPrefs();
    assert.equal(a, getAutoSimPrefs());
    assert.equal(a.enabled, false);
    assert.equal(a.quantity, 25);
  });

  it("server snapshot is a stable object", () => {
    assert.equal(getServerAutoSimPrefs(), getServerAutoSimPrefs());
  });

  it("defaults to on, next-open fills, fixed sizing with no stored value", () => {
    const p = getAutoSimPrefs();
    assert.equal(p.enabled, true);
    assert.equal(p.fillMode, "next-open");
    assert.equal(p.sizingMode, "fixed");
    assert.equal(p.riskPct, DEFAULT_AUTO_SIM_PREFS.riskPct);
  });

  it("migrates a legacy stored value (enabled + quantity only) with new defaults", () => {
    store.set(AUTO_SIM_STORAGE_KEY, JSON.stringify({ enabled: true, quantity: 40 }));
    const p = getAutoSimPrefs();
    assert.equal(p.quantity, 40);
    assert.equal(p.fillMode, "next-open");
    assert.equal(p.sizingMode, "fixed");
  });

  it("changes identity only when the stored value changes", () => {
    const before = getAutoSimPrefs();
    assert.equal(setAutoSimEnabled(false).ok, true);
    const after = getAutoSimPrefs();
    assert.notEqual(before, after);
    assert.equal(after.enabled, false);
    assert.equal(after, getAutoSimPrefs());
  });

  it("malformed storage falls back to defaults without throwing", () => {
    store.set(AUTO_SIM_STORAGE_KEY, "{not json");
    const p = getAutoSimPrefs();
    assert.equal(p.enabled, true);
    assert.equal(p, getAutoSimPrefs());
  });

  it("falls back per field when individual values are invalid", () => {
    store.set(
      AUTO_SIM_STORAGE_KEY,
      JSON.stringify({ enabled: true, quantity: -5, sizingMode: "yolo", riskPct: 50, fillMode: "instant" }),
    );
    const p = getAutoSimPrefs();
    assert.equal(p.quantity, DEFAULT_AUTO_SIM_PREFS.quantity);
    assert.equal(p.sizingMode, "fixed");
    assert.equal(p.riskPct, DEFAULT_AUTO_SIM_PREFS.riskPct);
    assert.equal(p.fillMode, "next-open");
  });

  it("setters validate input and never persist bad values", () => {
    assert.equal(setAutoSimQuantity("0").ok, false);
    assert.equal(setAutoSimQuantity("1.5").ok, false);
    assert.equal(setAutoSimQuantity("100001").ok, false);
    assert.equal(setAutoSimQuantity("25").ok, true);
    assert.equal(setAutoSimRiskPct("0.01").ok, false);
    assert.equal(setAutoSimRiskPct("5").ok, false);
    assert.equal(setAutoSimRiskPct("abc").ok, false);
    assert.equal(setAutoSimRiskPct("1.25").ok, true);
    assert.equal(setAutoSimSizingMode("wild").ok, false);
    assert.equal(setAutoSimSizingMode("risk").ok, true);
    assert.equal(setAutoSimFillMode("instant").ok, false);
    assert.equal(setAutoSimFillMode("signal-close").ok, true);
    const p = getAutoSimPrefs();
    assert.equal(p.quantity, 25);
    assert.equal(p.riskPct, 1.25);
    assert.equal(p.sizingMode, "risk");
    assert.equal(p.fillMode, "signal-close");
  });

  it("a failed write is reported, not swallowed", () => {
    g.window!.localStorage.setItem = () => {
      throw new Error("quota");
    };
    assert.equal(setAutoSimEnabled(false).ok, false);
  });
});
