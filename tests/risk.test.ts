import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessEntry,
  consecutiveLosses,
  dayRisk,
  DEFAULT_RISK_CONFIG,
  resolveConfig,
  streakMultiplier,
  type AssessInput,
} from "../src/lib/risk";

const cfg = resolveConfig();
const trade = (realizedPnl: number, exitDate = "2026-11-10") => ({ realizedPnl, exitDate });

function base(over: Partial<AssessInput> = {}): AssessInput {
  return {
    closed: [],
    startingCash: 100_000,
    reservedNotional: 0,
    cashAvailable: 100_000,
    price: 100,
    day: "2026-11-19",
    sizing: { mode: "fixed", quantity: 10 },
    ...over,
  };
}

describe("consecutiveLosses", () => {
  it("counts the trailing run of losers only", () => {
    assert.equal(consecutiveLosses([]), 0);
    assert.equal(consecutiveLosses([trade(-1), trade(5), trade(-2), trade(-3)]), 2);
    assert.equal(consecutiveLosses([trade(-1), trade(-2), trade(4)]), 0);
  });

  it("treats breakeven as ending the streak", () => {
    assert.equal(consecutiveLosses([trade(-1), trade(0), trade(-1)]), 1);
  });
});

describe("streakMultiplier", () => {
  it("is 1 before the scale start, then halves per loss down to the floor", () => {
    assert.equal(streakMultiplier(0, cfg), 1);
    assert.equal(streakMultiplier(1, cfg), 1);
    assert.equal(streakMultiplier(2, cfg), 0.5);
    assert.equal(streakMultiplier(3, cfg), 0.25);
    assert.equal(streakMultiplier(4, cfg), 0.125);
    assert.equal(streakMultiplier(12, cfg), 0.125);
  });
});

describe("dayRisk", () => {
  it("halts new entries at the daily loss limit, not before", () => {
    const limit = DEFAULT_RISK_CONFIG.dailyLossLimitPct * 100_000;
    assert.equal(dayRisk([trade(-limit + 1, "2026-11-19")], 100_000, "2026-11-19", cfg).halted, null);
    assert.equal(dayRisk([trade(-limit, "2026-11-19")], 100_000, "2026-11-19", cfg).halted, "daily-loss");
  });

  it("locks profit at the daily profit boundary", () => {
    const lock = DEFAULT_RISK_CONFIG.dailyProfitLockPct * 100_000;
    assert.equal(dayRisk([trade(lock, "2026-11-19")], 100_000, "2026-11-19", cfg).halted, "daily-profit");
  });

  it("counts earlier days toward start-of-day equity, not today's P&L", () => {
    const r = dayRisk([trade(-5_000, "2026-11-18"), trade(-100, "2026-11-19")], 100_000, "2026-11-19", cfg);
    assert.equal(r.startEquity, 95_000);
    assert.equal(r.realizedToday, -100);
    assert.equal(r.halted, null);
  });
});

describe("assessEntry", () => {
  it("allows a fixed-size entry within all caps", () => {
    const a = assessEntry(base());
    assert.equal(a.allowed, true);
    assert.equal(a.quantity, 10);
    assert.deepEqual(a.notes, []);
  });

  it("risk sizing: equity * risk% / (price * stop%)", () => {
    // 100k * 0.5% = 500 risk; stop = 100 * 3% = 3 per share -> 166 shares
    const a = assessEntry(base({ sizing: { mode: "risk", riskPct: 0.005 } }));
    assert.equal(a.allowed, true);
    assert.equal(a.quantity, 166);
  });

  it("clips an oversized request to the per-position cap and says so", () => {
    const a = assessEntry(base({ sizing: { mode: "fixed", quantity: 2_000 } }));
    assert.equal(a.allowed, true);
    assert.equal(a.quantity, 250); // 25% of 100k / $100
    assert.match(a.notes.join(" "), /per-position cap/);
  });

  it("scales size down on a losing streak", () => {
    const a = assessEntry(base({ closed: [trade(-10), trade(-10)] }));
    assert.equal(a.allowed, true);
    assert.equal(a.streak, 2);
    assert.equal(a.quantity, 5);
    assert.match(a.notes.join(" "), /scaled/i);
  });

  it("never scales below 1 share when a base size exists", () => {
    const a = assessEntry(base({ sizing: { mode: "fixed", quantity: 1 }, closed: Array.from({ length: 6 }, () => trade(-1)) }));
    assert.equal(a.quantity, 1);
  });

  it("blocks new entries after the daily loss limit", () => {
    const a = assessEntry(base({ closed: [trade(-2_500, "2026-11-19")] }));
    assert.equal(a.allowed, false);
    assert.equal(a.halted, "daily-loss");
    assert.match(a.reason ?? "", /Daily loss limit/);
  });

  it("limits to available cash and to remaining exposure room", () => {
    assert.equal(assessEntry(base({ cashAvailable: 500 })).quantity, 5);
    assert.equal(assessEntry(base({ reservedNotional: 99_000 })).quantity, 10);
    const blocked = assessEntry(base({ reservedNotional: 100_000 }));
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason ?? "", /less than 1 share/);
  });

  it("fails closed on malformed inputs", () => {
    assert.equal(assessEntry(base({ price: 0 })).allowed, false);
    assert.equal(assessEntry(base({ price: Number.NaN })).allowed, false);
    assert.equal(assessEntry(base({ cashAvailable: Number.POSITIVE_INFINITY })).allowed, false);
    assert.equal(assessEntry(base({ sizing: { mode: "risk", riskPct: 0 } })).allowed, false);
    assert.equal(assessEntry(base({ config: { stopDistancePct: 0 } })).allowed, false);
  });

  it("blocks when equity is not positive", () => {
    assert.equal(assessEntry(base({ closed: [trade(-100_000)] })).allowed, false);
  });
});
