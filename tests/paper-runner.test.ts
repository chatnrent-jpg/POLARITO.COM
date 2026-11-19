import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditRecord } from "../src/lib/audit";
import type { PaperBrokerConfig } from "../src/lib/broker/config";
import type {
  Broker,
  BrokerAccount,
  BrokerOrder,
  BrokerPosition,
  MarketOrderRequest,
  Result,
} from "../src/lib/broker/types";
import type { Bar } from "../src/lib/polarity";
import {
  completedBars,
  newYorkClock,
  paperRunnerSettings,
  runPaperCycle,
  type RunnerDeps,
  type RunnerSettings,
} from "../src/lib/paperRunner";

const ON: PaperBrokerConfig = { enabled: true, killed: false, configured: true };
// Thursday 2026-11-19, 17:00 New York (after the close).
const AFTER_CLOSE = new Date("2026-11-19T22:00:00Z");
// Same day, 15:00 New York (session still open).
const MID_SESSION = new Date("2026-11-19T20:00:00Z");

const ACCOUNT: BrokerAccount = {
  status: "ACTIVE",
  tradingBlocked: false,
  accountBlocked: false,
  equity: 100_000,
  lastEquity: 100_000,
  cash: 100_000,
  buyingPower: 200_000,
};

class FakeBroker implements Broker {
  submitted: MarketOrderRequest[] = [];
  orders = new Map<string, BrokerOrder>();
  constructor(
    public account: Result<BrokerAccount, "NETWORK"> = { ok: true, value: ACCOUNT },
    public positions: BrokerPosition[] = [],
  ) {}
  async getAccount() {
    return this.account;
  }
  async getPositions() {
    return { ok: true as const, value: this.positions };
  }
  async getOrderByClientId(id: string) {
    return { ok: true as const, value: this.orders.get(id) ?? null };
  }
  async submitMarketOrder(req: MarketOrderRequest) {
    this.submitted.push(req);
    const order: BrokerOrder = {
      id: `o${this.submitted.length}`,
      clientOrderId: req.clientOrderId,
      status: "accepted",
      ticker: req.ticker,
      side: req.side,
      quantity: req.quantity,
    };
    this.orders.set(req.clientOrderId, order);
    return { ok: true as const, value: order };
  }
}

function weekdaysEnding(last: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${last}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/** 30 quiet bars; the final bar carries the signal ("drive" = big green volume, "neutral" = tiny). */
function bars(last: string, kind: "drive" | "neutral", count = 30): Bar[] {
  const dates = weekdaysEnding(last, count);
  return dates.map((date, i) => {
    const isLast = i === dates.length - 1;
    const volume = isLast ? (kind === "drive" ? 9000 : 10) : 1000;
    const open = isLast ? 98 : 99;
    const close = isLast ? 100 : 99.5;
    return { date, open, high: 101, low: 97, close, volume };
  });
}

const settings = (over: Partial<RunnerSettings["prefs"]> = {}, watchlist = ["NVDA"]): RunnerSettings => ({
  watchlist,
  prefs: { enabled: true, quantity: 1, sizingMode: "risk", riskPct: 0.5, fillMode: "signal-close", ...over },
});

function deps(broker: Broker, load: RunnerDeps["loadBars"], over: Partial<RunnerDeps> = {}) {
  const audit: AuditRecord[] = [];
  const d: RunnerDeps = {
    broker,
    config: ON,
    loadBars: load,
    audit: (r) => void audit.push(r),
    now: () => AFTER_CLOSE,
    ...over,
  };
  return { d, audit };
}

const pos = (ticker: string, side: "long" | "short", quantity: number): BrokerPosition => ({
  ticker,
  side,
  quantity,
  avgEntryPrice: 99,
});

describe("settings", () => {
  it("parses a valid environment and applies safe defaults", () => {
    const r = paperRunnerSettings({ POLARITO_PAPER_WATCHLIST: " spy, nvda ,SPY" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.settings.watchlist, ["SPY", "NVDA"]);
      assert.equal(r.settings.prefs.sizingMode, "fixed");
      assert.equal(r.settings.prefs.quantity, 1);
      assert.equal(r.settings.prefs.riskPct, 0.5);
      assert.equal(r.settings.prefs.fillMode, "signal-close");
    }
  });

  it("refuses bad configuration instead of guessing", () => {
    assert.equal(paperRunnerSettings({}).ok, false);
    assert.equal(paperRunnerSettings({ POLARITO_PAPER_WATCHLIST: "AAPL,bad!" }).ok, false);
    assert.equal(paperRunnerSettings({ POLARITO_PAPER_WATCHLIST: "A,B,C,D,E,F" }).ok, false);
    assert.equal(paperRunnerSettings({ POLARITO_PAPER_WATCHLIST: "SPY", POLARITO_PAPER_RISK_PCT: "9" }).ok, false);
    assert.equal(paperRunnerSettings({ POLARITO_PAPER_WATCHLIST: "SPY", POLARITO_PAPER_SIZING: "yolo" }).ok, false);
    assert.equal(paperRunnerSettings({ POLARITO_PAPER_WATCHLIST: "SPY", POLARITO_PAPER_QTY: "1.5" }).ok, false);
  });
});

describe("completed bars (New York time)", () => {
  it("reads the New York date and minutes", () => {
    assert.deepEqual(newYorkClock(AFTER_CLOSE), { date: "2026-11-19", minutes: 17 * 60 });
    assert.deepEqual(newYorkClock(new Date("2026-07-01T00:30:00Z")), { date: "2026-06-30", minutes: 20 * 60 + 30 });
  });

  it("drops today's bar until the close has finalized, and anything from the future", () => {
    const b = bars("2026-11-19", "drive");
    assert.equal(completedBars(b, AFTER_CLOSE).length, 30);
    assert.equal(completedBars(b, MID_SESSION).length, 29);
    const future = [...b, { ...b[b.length - 1], date: "2026-11-20" }];
    assert.equal(completedBars(future, AFTER_CLOSE).length, 30);
  });
});

describe("runPaperCycle", () => {
  it("enters a risk-sized long on a Drive signal and audits it", async () => {
    const broker = new FakeBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    const report = await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(report.ok, true);
    assert.equal(broker.submitted.length, 1);
    const o = broker.submitted[0];
    assert.equal(o.side, "buy");
    assert.equal(o.ticker, "NVDA");
    assert.equal(o.timeInForce, "day");
    assert.equal(o.clientOrderId, "pol-NVDA-enter-long-2026-11-19");
    // 0.5% of 100k = $500 risk / (100 * 3% stop) = 166 shares
    assert.equal(o.quantity, 166);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, "entered");
    assert.equal(audit[0].source, "paper-runner");
    assert.equal(audit[0].orderId, "o1");
  });

  it("is idempotent: running the same signal twice sends one order", async () => {
    const broker = new FakeBroker();
    const load = async () => bars("2026-11-19", "drive");
    await runPaperCycle(deps(broker, load).d, settings(), { dryRun: false });
    const second = deps(broker, load);
    const r = await runPaperCycle(second.d, settings(), { dryRun: false });
    assert.equal(r.ok, true);
    assert.equal(broker.submitted.length, 1);
    assert.equal(second.audit[0].outcome, "held");
  });

  it("stands aside on Neutral with nothing open", async () => {
    const broker = new FakeBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "neutral"));
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 0);
    assert.equal(audit[0].outcome, "aside");
  });

  it("closes the broker's ACTUAL quantity when the signal goes Neutral", async () => {
    const broker = new FakeBroker(undefined, [pos("NVDA", "long", 37)]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "neutral"));
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 1);
    assert.equal(broker.submitted[0].side, "sell");
    assert.equal(broker.submitted[0].quantity, 37);
    assert.equal(audit[0].outcome, "closed");
  });

  it("holds without adding when already aligned", async () => {
    const broker = new FakeBroker(undefined, [pos("NVDA", "long", 10)]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 0);
    assert.equal(audit[0].outcome, "held");
  });

  it("flips by closing only; the re-entry waits for the next session", async () => {
    const broker = new FakeBroker(undefined, [pos("NVDA", "short", 20)]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 1);
    assert.equal(broker.submitted[0].side, "buy");
    assert.equal(broker.submitted[0].quantity, 20);
    assert.equal(audit[0].outcome, "closed");
    assert.match(audit[0].notes.join(" "), /deferred/);
  });

  it("never takes a signal from a bar that is still forming", async () => {
    const broker = new FakeBroker();
    const load = async () => {
      const b = bars("2026-11-19", "drive");
      b[b.length - 2] = { ...b[b.length - 2], volume: 10 };
      return b;
    };
    const { d, audit } = deps(broker, load, { now: () => MID_SESSION });
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 0);
    assert.equal(audit[0].signalDate, "2026-11-18");
    assert.equal(audit[0].outcome, "aside");
  });

  it("does not trade on stale data", async () => {
    const broker = new FakeBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-02", "drive"));
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 0);
    assert.equal(audit[0].outcome, "skipped");
  });

  it("does not trade without enough history", async () => {
    const broker = new FakeBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive", 5));
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 0);
    assert.notEqual(audit[0].outcome, "entered");
  });

  it("dry run decides and audits but sends nothing", async () => {
    const broker = new FakeBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"), {
      config: { enabled: false, killed: false, configured: true },
    });
    const r = await runPaperCycle(d, settings(), { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(broker.submitted.length, 0);
    assert.equal(audit[0].outcome, "dry-run");
    assert.match(audit[0].reason, /Would enter long 166/);
  });

  it("refuses a real run when disabled, killed or unconfigured", async () => {
    for (const config of [
      { enabled: false, killed: false, configured: true },
      { enabled: true, killed: true, configured: true },
      { enabled: true, killed: false, configured: false },
    ]) {
      const broker = new FakeBroker();
      const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"), { config });
      const r = await runPaperCycle(d, settings(), { dryRun: false });
      assert.equal(r.ok, false);
      assert.equal(broker.submitted.length, 0);
      assert.equal(audit[0].outcome, "error");
    }
  });

  it("places no order when the account cannot be read or is blocked", async () => {
    const down = new FakeBroker({ ok: false, code: "NETWORK", error: "down" });
    const a = deps(down, async () => bars("2026-11-19", "drive"));
    assert.equal((await runPaperCycle(a.d, settings(), { dryRun: false })).ok, false);
    assert.equal(down.submitted.length, 0);

    const blocked = new FakeBroker({ ok: true, value: { ...ACCOUNT, tradingBlocked: true } });
    const b = deps(blocked, async () => bars("2026-11-19", "drive"));
    assert.equal((await runPaperCycle(b.d, settings(), { dryRun: false })).ok, false);
    assert.equal(blocked.submitted.length, 0);

    const zero = new FakeBroker({ ok: true, value: { ...ACCOUNT, equity: 0 } });
    const c = deps(zero, async () => bars("2026-11-19", "drive"));
    assert.equal((await runPaperCycle(c.d, settings(), { dryRun: false })).ok, false);
  });

  it("daily loss limit blocks new entries but never a close", async () => {
    const hit: BrokerAccount = { ...ACCOUNT, equity: 97_000, lastEquity: 100_000 };
    const enterBroker = new FakeBroker({ ok: true, value: hit });
    const e = deps(enterBroker, async () => bars("2026-11-19", "drive"));
    await runPaperCycle(e.d, settings(), { dryRun: false });
    assert.equal(enterBroker.submitted.length, 0);
    assert.equal(e.audit[0].outcome, "blocked");
    assert.match(e.audit[0].reason, /Daily loss limit/);

    const closeBroker = new FakeBroker({ ok: true, value: hit }, [pos("NVDA", "long", 12)]);
    const c = deps(closeBroker, async () => bars("2026-11-19", "neutral"));
    await runPaperCycle(c.d, settings(), { dryRun: false });
    assert.equal(closeBroker.submitted.length, 1);
    assert.equal(c.audit[0].outcome, "closed");
  });

  it("daily profit lock also blocks new entries", async () => {
    const up = new FakeBroker({ ok: true, value: { ...ACCOUNT, equity: 105_000, lastEquity: 100_000 } });
    const { d, audit } = deps(up, async () => bars("2026-11-19", "drive"));
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(up.submitted.length, 0);
    assert.match(audit[0].reason, /profit lock/i);
  });

  it("several tickers in one cycle can never oversubscribe the account", async () => {
    const broker = new FakeBroker();
    const list = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    await runPaperCycle(d, settings({ riskPct: 2 }, list), { dryRun: false });
    const notional = broker.submitted.reduce((s, o) => s + o.quantity * 100, 0);
    assert.ok(notional <= 100_000, `notional ${notional}`);
    assert.equal(audit.length, 5);
    assert.ok(audit.some((r) => r.notes.join(" ").match(/exposure cap|per-position cap/) || r.outcome === "blocked"));
  });

  it("one ticker failing does not stop the others, and the failure is audited", async () => {
    const broker = new FakeBroker();
    const load = async (t: string) => {
      if (t === "BAD") throw new Error("feed down");
      return bars("2026-11-19", "drive");
    };
    const { d, audit } = deps(broker, load);
    const r = await runPaperCycle(d, settings({}, ["BAD", "NVDA"]), { dryRun: false });
    assert.equal(r.ok, true);
    assert.deepEqual(audit.map((a) => [a.ticker, a.outcome]), [["BAD", "error"], ["NVDA", "entered"]]);
    assert.equal(broker.submitted.length, 1);
  });

  it("malformed bars produce no trade", async () => {
    const broker = new FakeBroker();
    const load = async () => {
      const b = bars("2026-11-19", "drive");
      b[10] = { ...b[10], close: Number.NaN };
      return b;
    };
    const { d, audit } = deps(broker, load);
    await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(broker.submitted.length, 0);
    assert.equal(audit[0].outcome, "skipped");
  });

  it("a throwing audit sink never changes what was sent", async () => {
    const broker = new FakeBroker();
    const { d } = deps(broker, async () => bars("2026-11-19", "drive"), {
      audit: () => {
        throw new Error("disk full");
      },
    });
    const r = await runPaperCycle(d, settings(), { dryRun: false });
    assert.equal(r.ok, true);
    assert.equal(broker.submitted.length, 1);
  });
});
