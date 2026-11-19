import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAutoSim, sideForPolarity, type AutoSimAnalysis } from "../src/lib/autoSim";
import type { AutoSimPrefs } from "../src/lib/autoSimPrefs";
import type { LedgerSnapshot, Position } from "../src/lib/ledger";

const prefsOn = (quantity = 10): AutoSimPrefs => ({ enabled: true, quantity });
const prefsOff: AutoSimPrefs = { enabled: false, quantity: 10 };

function analysis(over: Partial<AutoSimAnalysis> = {}): AutoSimAnalysis {
  return {
    ticker: "NVDA",
    polarity: 1,
    close: 100,
    asOf: "2026-11-19",
    ready: true,
    ...over,
  };
}

function ledger(positions: Position[] = []): LedgerSnapshot {
  return {
    accountId: "conservative-swing",
    positions,
    closed: [],
  };
}

function pos(over: Partial<Position> = {}): Position {
  return {
    ticker: "NVDA",
    side: "long",
    quantity: 10,
    avgPrice: 90,
    openedAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    fills: 1,
    polarityAtEntry: 1,
    ...over,
  };
}

describe("sideForPolarity", () => {
  it("maps Drive to long and Reverse to short", () => {
    assert.equal(sideForPolarity({ polarity: 1, ready: true }), "long");
    assert.equal(sideForPolarity({ polarity: -1, ready: true }), "short");
  });

  it("stands aside on Neutral or unready", () => {
    assert.equal(sideForPolarity({ polarity: 0, ready: true }), null);
    assert.equal(sideForPolarity({ polarity: 1, ready: false }), null);
  });
});

describe("decideAutoSim", () => {
  it("does nothing when auto is off", () => {
    const d = decideAutoSim(analysis(), ledger(), prefsOff);
    assert.equal(d.close, null);
    assert.equal(d.enter, null);
  });

  it("enters long on Drive when flat", () => {
    const d = decideAutoSim(analysis({ polarity: 1 }), ledger(), prefsOn(5));
    assert.equal(d.close, null);
    assert.deepEqual(d.enter, { side: "long", quantity: 5 });
  });

  it("enters short on Reverse when flat", () => {
    const d = decideAutoSim(analysis({ polarity: -1 }), ledger(), prefsOn(8));
    assert.equal(d.close, null);
    assert.deepEqual(d.enter, { side: "short", quantity: 8 });
  });

  it("stands aside on Neutral with no position", () => {
    const d = decideAutoSim(analysis({ polarity: 0 }), ledger(), prefsOn());
    assert.equal(d.close, null);
    assert.equal(d.enter, null);
  });

  it("closes open long when Neutral (stand aside)", () => {
    const open = pos({ side: "long" });
    const d = decideAutoSim(analysis({ polarity: 0 }), ledger([open]), prefsOn());
    assert.equal(d.close, open);
    assert.equal(d.enter, null);
  });

  it("does not scale in when already aligned", () => {
    const d = decideAutoSim(
      analysis({ polarity: 1 }),
      ledger([pos({ side: "long" })]),
      prefsOn(10),
    );
    assert.equal(d.close, null);
    assert.equal(d.enter, null);
  });

  it("flips long to short on Reverse", () => {
    const open = pos({ side: "long", polarityAtEntry: 1 });
    const d = decideAutoSim(analysis({ polarity: -1 }), ledger([open]), prefsOn(10));
    assert.equal(d.close, open);
    assert.deepEqual(d.enter, { side: "short", quantity: 10 });
  });

  it("blocks entry when cash is insufficient", () => {
    // Conservative Swing starts at 100k; 2000 * 100 = 200k > cash.
    const d = decideAutoSim(analysis({ polarity: 1, close: 100 }), ledger(), prefsOn(2000));
    assert.equal(d.close, null);
    assert.equal(d.enter, null);
    assert.match(d.reason, /Insufficient cash/i);
  });

  it("refuses unusable mark data", () => {
    const d = decideAutoSim(analysis({ close: 0 }), ledger(), prefsOn());
    assert.equal(d.enter, null);
    assert.equal(d.close, null);
  });
});
