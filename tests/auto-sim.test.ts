import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAutoSimInput,
  decideAutoSim,
  isStale,
  sideForPolarity,
  type AutoSimInput,
} from "../src/lib/autoSim";
import { DEFAULT_AUTO_SIM_PREFS, type AutoSimPrefs } from "../src/lib/autoSimPrefs";
import type { ClosedTrade, LedgerSnapshot, Position } from "../src/lib/ledger";
import type { DayResult, Polarity } from "../src/lib/polarity";

const NOW = new Date("2026-11-20T15:00:00Z");

const prefs = (over: Partial<AutoSimPrefs> = {}): AutoSimPrefs => ({
  ...DEFAULT_AUTO_SIM_PREFS,
  enabled: true,
  quantity: 10,
  ...over,
});

function input(polarity: Polarity = 1, over: Partial<AutoSimInput> = {}): AutoSimInput {
  return {
    ticker: "NVDA",
    signal: { polarity, ready: true, date: "2026-11-18" },
    fill: { date: "2026-11-19", price: 100 },
    ...over,
  };
}

function ledger(positions: Position[] = [], closed: ClosedTrade[] = []): LedgerSnapshot {
  return { accountId: "conservative-swing", positions, closed };
}

function pos(over: Partial<Position> = {}): Position {
  return {
    ticker: "NVDA",
    side: "long",
    quantity: 10,
    avgPrice: 90,
    openedAt: "2026-11-17T00:00:00.000Z",
    updatedAt: "2026-11-17T00:00:00.000Z",
    fills: 1,
    polarityAtEntry: 1,
    ...over,
  };
}

function closedTrade(realizedPnl: number, exitDate: string): ClosedTrade {
  return {
    id: `t-${exitDate}-${realizedPnl}`,
    simulated: true,
    ticker: "NVDA",
    side: "long",
    quantity: 10,
    entryPrice: 100,
    exitPrice: 100 + realizedPnl / 10,
    exitDate,
    openedAt: "2026-11-01T00:00:00.000Z",
    closedAt: "2026-11-02T00:00:00.000Z",
    realizedPnl,
  };
}

function day(date: string, over: Partial<DayResult> = {}): DayResult {
  return {
    date,
    kind: "green",
    open: 10,
    close: 11,
    volume: 1000,
    netVolume: 1000,
    avgVolume: 1000,
    noiseFloor: 100,
    polarity: 1,
    ready: true,
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

describe("isStale", () => {
  it("allows a long weekend, rejects older or malformed dates", () => {
    assert.equal(isStale("2026-11-17", NOW), false); // 3 days
    assert.equal(isStale("2026-11-14", NOW), true); // 6 days
    assert.equal(isStale("not-a-date", NOW), true);
    assert.equal(isStale("2026-12-25", NOW), true); // far in the future
  });
});

describe("buildAutoSimInput", () => {
  const results = [day("2026-11-17", { polarity: -1 }), day("2026-11-18", { polarity: 1, open: 50, close: 51 }), day("2026-11-19", { polarity: 0, open: 52, close: 53 })];

  it("next-open acts on the last COMPLETED bar and fills at the latest open", () => {
    const i = buildAutoSimInput("NVDA", results, "next-open");
    assert.deepEqual(i?.signal, { polarity: 1, ready: true, date: "2026-11-18" });
    assert.deepEqual(i?.fill, { date: "2026-11-19", price: 52 });
  });

  it("signal-close acts on the latest bar and fills at its close", () => {
    const i = buildAutoSimInput("NVDA", results, "signal-close");
    assert.deepEqual(i?.signal, { polarity: 0, ready: true, date: "2026-11-19" });
    assert.deepEqual(i?.fill, { date: "2026-11-19", price: 53 });
  });

  it("returns null when there is not enough data", () => {
    assert.equal(buildAutoSimInput("NVDA", [], "next-open"), null);
    assert.equal(buildAutoSimInput("NVDA", [day("2026-11-19")], "next-open"), null);
    assert.notEqual(buildAutoSimInput("NVDA", [day("2026-11-19")], "signal-close"), null);
  });
});

describe("decideAutoSim", () => {
  it("does nothing when auto is off or there is no input", () => {
    const off = decideAutoSim(input(), ledger(), prefs({ enabled: false }), NOW);
    assert.equal(off.enter, null);
    assert.equal(decideAutoSim(null, ledger(), prefs(), NOW).enter, null);
  });

  it("enters long on Drive and short on Reverse when flat", () => {
    assert.deepEqual(decideAutoSim(input(1), ledger(), prefs({ quantity: 5 }), NOW).enter, { side: "long", quantity: 5 });
    assert.deepEqual(decideAutoSim(input(-1), ledger(), prefs({ quantity: 8 }), NOW).enter, { side: "short", quantity: 8 });
  });

  it("stands aside on Neutral, and closes an open position on Neutral", () => {
    const flat = decideAutoSim(input(0), ledger(), prefs(), NOW);
    assert.equal(flat.close, null);
    assert.equal(flat.enter, null);
    const open = pos();
    const d = decideAutoSim(input(0), ledger([open]), prefs(), NOW);
    assert.equal(d.close, open);
    assert.equal(d.enter, null);
  });

  it("does not scale in when already aligned", () => {
    const d = decideAutoSim(input(1), ledger([pos()]), prefs(), NOW);
    assert.equal(d.close, null);
    assert.equal(d.enter, null);
  });

  it("flips long to short on Reverse", () => {
    const open = pos();
    const d = decideAutoSim(input(-1), ledger([open]), prefs(), NOW);
    assert.equal(d.close, open);
    assert.deepEqual(d.enter, { side: "short", quantity: 10 });
  });

  it("risk-based sizing sizes from equity, risk percent and stop distance", () => {
    // 100k * 0.5% = 500; effective entry 100.05 * 3% = 3.0015 -> 166
    const d = decideAutoSim(input(1), ledger(), prefs({ sizingMode: "risk", riskPct: 0.5 }), NOW);
    assert.deepEqual(d.enter, { side: "long", quantity: 166 });
  });

  it("clips an oversized fixed request to the per-position cap", () => {
    const d = decideAutoSim(input(1), ledger(), prefs({ quantity: 2_000 }), NOW);
    assert.deepEqual(d.enter, { side: "long", quantity: 249 }); // 25k / 100.05
    assert.match(d.notes.join(" "), /per-position cap/);
  });

  it("scales down after a losing streak", () => {
    const d = decideAutoSim(
      input(1),
      ledger([], [closedTrade(-10, "2026-11-10"), closedTrade(-10, "2026-11-11")]),
      prefs(),
      NOW,
    );
    assert.deepEqual(d.enter, { side: "long", quantity: 5 });
  });

  it("blocks new entries after the daily loss limit but still closes on Neutral", () => {
    const hit = [closedTrade(-2_500, "2026-11-19")];
    const blocked = decideAutoSim(input(1), ledger([], hit), prefs(), NOW);
    assert.equal(blocked.enter, null);
    assert.match(blocked.reason, /Daily loss limit/);

    const open = pos();
    const closes = decideAutoSim(input(0), ledger([open], hit), prefs(), NOW);
    assert.equal(closes.close, open);
  });

  it("closes a misaligned position even when the new entry is blocked", () => {
    const open = pos();
    const hit = [closedTrade(-2_500, "2026-11-19")];
    const d = decideAutoSim(input(-1), ledger([open], hit), prefs(), NOW);
    assert.equal(d.close, open);
    assert.equal(d.enter, null);
    assert.match(d.reason, /blocked/);
  });

  it("refuses stale, malformed or inconsistent data", () => {
    const old = {
      signal: { polarity: 1 as Polarity, ready: true, date: "2026-10-30" },
      fill: { date: "2026-11-01", price: 100 },
    };
    const stale = decideAutoSim(input(1, old), ledger(), prefs(), NOW);
    assert.equal(stale.enter, null);
    assert.match(stale.reason, /stale/i);

    assert.equal(decideAutoSim(input(1, { fill: { date: "2026-11-19", price: 0 } }), ledger(), prefs(), NOW).enter, null);
    assert.equal(decideAutoSim(input(1, { ticker: "bad ticker!" }), ledger(), prefs(), NOW).enter, null);
    const future = input(1, { signal: { polarity: 1, ready: true, date: "2026-11-20" } });
    assert.equal(decideAutoSim(future, ledger(), prefs(), NOW).enter, null);
  });

  it("stale data does not close an existing position either", () => {
    const old = {
      signal: { polarity: 0 as Polarity, ready: true, date: "2026-10-30" },
      fill: { date: "2026-11-01", price: 100 },
    };
    const d = decideAutoSim(input(0, old), ledger([pos()]), prefs(), NOW);
    assert.equal(d.close, null);
    assert.match(d.reason, /stale/i);
  });
});
