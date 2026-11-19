import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_FILL_COSTS, effectiveFillPrice } from "../src/lib/fillModel";

describe("effectiveFillPrice", () => {
  it("buys fill higher and sells fill lower (5 bps default)", () => {
    assert.equal(effectiveFillPrice("enter", "long", 100), 100.05);
    assert.equal(effectiveFillPrice("close", "long", 100), 99.95);
    assert.equal(effectiveFillPrice("enter", "short", 100), 99.95);
    assert.equal(effectiveFillPrice("close", "short", 100), 100.05);
  });

  it("zero costs fill at the quote", () => {
    const free = { slippageBps: 0, commissionPerShare: 0 };
    assert.equal(effectiveFillPrice("enter", "long", 123.45, free), 123.45);
    assert.equal(effectiveFillPrice("close", "short", 123.45, free), 123.45);
  });

  it("adds commission adversely on every fill", () => {
    const c = { slippageBps: 0, commissionPerShare: 0.01 };
    assert.equal(effectiveFillPrice("enter", "long", 50, c), 50.01);
    assert.equal(effectiveFillPrice("close", "long", 50, c), 49.99);
  });

  it("a round trip always costs money", () => {
    const inn = effectiveFillPrice("enter", "long", 100);
    const out = effectiveFillPrice("close", "long", 100);
    assert.ok(out < inn);
    const sIn = effectiveFillPrice("enter", "short", 100);
    const sOut = effectiveFillPrice("close", "short", 100);
    assert.ok(sOut > sIn);
  });

  it("rejects unusable inputs", () => {
    assert.throws(() => effectiveFillPrice("enter", "long", 0), RangeError);
    assert.throws(() => effectiveFillPrice("enter", "long", Number.NaN), RangeError);
    assert.throws(
      () => effectiveFillPrice("enter", "long", 100, { slippageBps: -1, commissionPerShare: 0 }),
      RangeError,
    );
    assert.throws(
      () => effectiveFillPrice("close", "long", 1, { slippageBps: 0, commissionPerShare: 5 }),
      RangeError,
    );
  });

  it("defaults are frozen", () => {
    assert.throws(() => {
      (DEFAULT_FILL_COSTS as { slippageBps: number }).slippageBps = 99;
    });
  });
});
