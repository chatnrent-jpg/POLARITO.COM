import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AUTO_SIM_STORAGE_KEY,
  getAutoSimPrefs,
  getServerAutoSimPrefs,
  setAutoSimEnabled,
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
    assert.deepEqual({ ...a }, { enabled: false, quantity: 25 });
  });

  it("server snapshot is a stable object", () => {
    assert.equal(getServerAutoSimPrefs(), getServerAutoSimPrefs());
  });

  it("defaults to on with no stored value", () => {
    assert.equal(getAutoSimPrefs().enabled, true);
  });

  it("changes identity only when the stored value changes", () => {
    const before = getAutoSimPrefs();
    const result = setAutoSimEnabled(false);
    assert.equal(result.ok, true);
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
});
