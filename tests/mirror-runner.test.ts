import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AUDIT_SOURCES, type AuditRecord } from "../src/lib/audit";
import { AlpacaPaperBroker, type FetchLike } from "../src/lib/broker/alpacaPaper";
import type { PaperBrokerConfig } from "../src/lib/broker/config";
import { placeIntent } from "../src/lib/broker/execute";
import type {
  BrokerAccount,
  BrokerOrder,
  BrokerPosition,
  MarketOrderRequest,
  Result,
} from "../src/lib/broker/types";
import {
  mirrorClientOrderId,
  mirrorSettings,
  runMirrorTick,
  sessionOpen,
  type MirrorBroker,
  type MirrorDeps,
  type MirrorSettings,
} from "../src/lib/mirrorRunner";
import type { Bar } from "../src/lib/polarity";

const ON: PaperBrokerConfig = { enabled: true, killed: false, configured: true };
// Thursday 2026-11-19, 15:00 New York (session open).
const MID_SESSION = new Date("2026-11-19T20:00:00Z");
const TODAY = "2026-11-19";

const ACCOUNT: BrokerAccount = {
  status: "ACTIVE",
  tradingBlocked: false,
  accountBlocked: false,
  equity: 100_000,
  lastEquity: 100_000,
  cash: 100_000,
  buyingPower: 200_000,
};
const SETTINGS: MirrorSettings = { quantity: 10, maxShares: 100, dailyLossPct: 2, clamped: false };

const long = (qty: number, ticker = "SPY"): BrokerPosition => ({ ticker, side: "long", quantity: qty, avgEntryPrice: 99 });
const short = (qty: number): BrokerPosition => ({ ticker: "SPY", side: "short", quantity: qty, avgEntryPrice: 101 });

/** Broker whose market orders fill instantly (like SPY in the session) unless `fill` is false. */
class FakeBroker implements MirrorBroker {
  submitted: MarketOrderRequest[] = [];
  orders = new Map<string, BrokerOrder>();
  open = 0;
  fill = true;
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
  async openOrderCount() {
    return { ok: true as const, value: this.open };
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
    if (this.fill) {
      const cur = this.positions.find((p) => p.ticker === req.ticker);
      const signed = (cur ? (cur.side === "long" ? cur.quantity : -cur.quantity) : 0) + (req.side === "buy" ? req.quantity : -req.quantity);
      this.positions = this.positions.filter((p) => p.ticker !== req.ticker);
      if (signed !== 0) {
        this.positions.push({ ticker: req.ticker, side: signed > 0 ? "long" : "short", quantity: Math.abs(signed), avgEntryPrice: 100 });
      }
    }
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

/** 30 quiet bars; the final bar is "forming today" and carries the signal. */
function bars(last: string, kind: "drive" | "neutral" | "reverse", count = 30): Bar[] {
  return weekdaysEnding(last, count).map((date, i, all) => {
    const isLast = i === all.length - 1;
    const volume = isLast ? (kind === "neutral" ? 10 : 9000) : 1000;
    const open = isLast ? (kind === "reverse" ? 100 : 98) : 99;
    const close = isLast ? (kind === "reverse" ? 98 : 100) : 99.5;
    return { date, open, high: 101, low: 97, close, volume };
  });
}

function setup(opts: {
  kind: "drive" | "neutral" | "reverse";
  positions?: BrokerPosition[];
  account?: Partial<BrokerAccount>;
  config?: PaperBrokerConfig;
  now?: Date;
  last?: string;
}) {
  const broker = new FakeBroker({ ok: true, value: { ...ACCOUNT, ...opts.account } }, opts.positions ?? []);
  const audit: AuditRecord[] = [];
  let sleeps = 0;
  let clock = opts.now ?? MID_SESSION;
  const deps: MirrorDeps = {
    broker,
    config: opts.config ?? ON,
    loadBars: async () => bars(opts.last ?? TODAY, opts.kind),
    audit: (r) => audit.push(r),
    now: () => clock,
    sleep: async () => {
      sleeps++;
    },
  };
  return { broker, audit, deps, sleeps: () => sleeps, setNow: (d: Date) => (clock = d) };
}

describe("mirrorSettings", () => {
  it("defaults to the dashboard's 10 shares, a 100 share cap and a 2% loss limit", () => {
    const r = mirrorSettings({});
    assert.ok(r.ok);
    assert.deepEqual(r.settings, { quantity: 10, maxShares: 100, dailyLossPct: 2, clamped: false });
  });
  it("caps the entry size at the max and says so", () => {
    const r = mirrorSettings({ POLARITO_MIRROR_QTY: "500", POLARITO_MIRROR_MAX_SHARES: "50" });
    assert.ok(r.ok);
    assert.equal(r.settings.quantity, 50);
    assert.equal(r.settings.clamped, true);
  });
  it("rejects bad values", () => {
    assert.equal(mirrorSettings({ POLARITO_MIRROR_QTY: "0" }).ok, false);
    assert.equal(mirrorSettings({ POLARITO_MIRROR_QTY: "1.5" }).ok, false);
    assert.equal(mirrorSettings({ POLARITO_MIRROR_MAX_SHARES: "abc" }).ok, false);
    assert.equal(mirrorSettings({ POLARITO_MIRROR_DAILY_LOSS_PCT: "0" }).ok, false);
    assert.equal(mirrorSettings({ POLARITO_MIRROR_DAILY_LOSS_PCT: "50" }).ok, false);
  });
});

describe("sessionOpen", () => {
  it("is true only 09:30-16:00 New York on weekdays (DST-safe)", () => {
    assert.equal(sessionOpen(new Date("2026-11-19T14:29:00Z")), false); // 09:29 EST
    assert.equal(sessionOpen(new Date("2026-11-19T14:30:00Z")), true); // 09:30 EST
    assert.equal(sessionOpen(new Date("2026-11-19T20:59:00Z")), true); // 15:59 EST
    assert.equal(sessionOpen(new Date("2026-11-19T21:00:00Z")), false); // 16:00 EST
    assert.equal(sessionOpen(new Date("2026-07-15T13:30:00Z")), true); // 09:30 EDT
    assert.equal(sessionOpen(new Date("2026-07-15T13:29:00Z")), false);
    assert.equal(sessionOpen(new Date("2026-11-21T17:00:00Z")), false); // Saturday
  });
});

describe("runMirrorTick follows the live signal with no delay or filter", () => {
  it("goes long on Drive using today's FORMING bar (nothing is dropped)", async () => {
    const t = setup({ kind: "drive" });
    const r = await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.ok(r.ok);
    assert.equal(t.broker.submitted.length, 1);
    assert.deepEqual(
      { side: t.broker.submitted[0].side, qty: t.broker.submitted[0].quantity, ticker: t.broker.submitted[0].ticker },
      { side: "buy", qty: 10, ticker: "SPY" },
    );
    assert.equal(t.audit[0].source, "mirror-runner");
    assert.equal(t.audit[0].outcome, "entered");
  });

  it("goes short on Reverse in the first tick it sees it", async () => {
    const t = setup({ kind: "reverse" });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 1);
    assert.equal(t.broker.submitted[0].side, "sell");
    assert.deepEqual(t.broker.positions.map((p) => [p.side, p.quantity]), [["short", 10]]);
  });

  it("flips in ONE tick: closes the long, then enters the short, without sleeping", async () => {
    const t = setup({ kind: "reverse", positions: [long(10)] });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.deepEqual(
      t.broker.submitted.map((o) => [o.side, o.quantity]),
      [["sell", 10], ["sell", 10]],
    );
    assert.deepEqual(t.broker.positions.map((p) => [p.side, p.quantity]), [["short", 10]]);
    assert.deepEqual(t.audit.map((a) => a.outcome), ["closed", "entered"]);
    assert.equal(t.sleeps(), 0);
  });

  it("flips short to long the same way", async () => {
    const t = setup({ kind: "drive", positions: [short(7)] });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.deepEqual(
      t.broker.submitted.map((o) => [o.side, o.quantity]),
      [["buy", 7], ["buy", 10]],
    );
    assert.deepEqual(t.broker.positions.map((p) => [p.side, p.quantity]), [["long", 10]]);
  });

  it("closes on Neutral and never re-enters", async () => {
    const t = setup({ kind: "neutral", positions: [long(10)] });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.deepEqual(t.broker.submitted.map((o) => o.side), ["sell"]);
    assert.equal(t.broker.positions.length, 0);
  });

  it("does nothing when already aligned (never adds size on every tick)", async () => {
    const t = setup({ kind: "drive", positions: [long(10)] });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 0);
    assert.deepEqual(t.audit.map((a) => a.outcome), ["held", "held"]);
  });

  it("an immediate flip-flop in the same session is followed each time (no hold time)", async () => {
    const t = setup({ kind: "reverse", positions: [long(10)] });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.positions[0].side, "short");
    // Polarity swings back one tick (a few seconds) later.
    t.deps.loadBars = async () => bars(TODAY, "drive");
    t.setNow(new Date(MID_SESSION.getTime() + 5_000));
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.positions[0].side, "long");
    assert.equal(t.broker.submitted.length, 4);
    const ids = t.broker.submitted.map((o) => o.clientOrderId);
    assert.equal(new Set(ids).size, ids.length, "every order has its own id");
  });

  it("a retried tick in the same minute cannot double-send", async () => {
    const t = setup({ kind: "drive" });
    t.broker.fill = false; // the order is still working
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 1);
    t.broker.open = 0; // pretend the working-order check missed it
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 1, "same minute => same client order id => no second order");
  });

  it("defers the entry to the next tick if the close has not filled yet", async () => {
    const t = setup({ kind: "reverse", positions: [long(10)] });
    t.broker.fill = false;
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 1, "only the close was sent");
    assert.equal(t.sleeps() > 0, true);
    assert.equal(t.audit.at(-1)?.outcome, "held");
    // The close fills; the next tick sees flat + Reverse and enters.
    t.broker.positions = [];
    t.broker.fill = true;
    t.setNow(new Date(MID_SESSION.getTime() + 5_000));
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.deepEqual(t.broker.positions.map((p) => [p.side, p.quantity]), [["short", 10]]);
  });
});

describe("runMirrorTick safety rails (they never alter the signal, only stop orders)", () => {
  it("kill switch stops everything", async () => {
    const t = setup({ kind: "drive", config: { enabled: true, killed: true, configured: true } });
    const r = await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(t.broker.submitted.length, 0);
  });

  it("observes (decides, audits, sends nothing) until trading is switched on", async () => {
    const t = setup({ kind: "drive", config: { enabled: false, killed: false, configured: true } });
    const r = await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.ok(r.ok);
    assert.equal(r.dryRun, true);
    assert.equal(t.broker.submitted.length, 0);
    assert.ok(t.audit.some((a) => a.outcome === "dry-run" && /Would enter long 10 SPY/.test(a.reason)));
  });

  it("dry run sends nothing", async () => {
    const t = setup({ kind: "reverse", positions: [long(10)] });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: true });
    assert.equal(t.broker.submitted.length, 0);
    assert.deepEqual(t.audit.map((a) => a.outcome), ["dry-run", "dry-run"]);
  });

  it("sends nothing outside 09:30-16:00 New York or on weekends", async () => {
    for (const iso of ["2026-11-19T14:00:00Z", "2026-11-19T21:30:00Z", "2026-11-21T17:00:00Z"]) {
      const t = setup({ kind: "drive", now: new Date(iso) });
      const r = await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
      assert.ok(r.ok);
      assert.equal(t.broker.submitted.length, 0, iso);
      assert.equal(t.audit[0].outcome, "skipped");
    }
  });

  it("refuses a latest bar that is not today (stale data / holiday)", async () => {
    const t = setup({ kind: "drive", last: "2026-11-18" });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 0);
    assert.match(t.audit[0].reason, /not today/);
  });

  it("skips the tick while an SPY order is still working", async () => {
    const t = setup({ kind: "drive" });
    t.broker.open = 1;
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 0);
    assert.match(t.audit[0].reason, /still working/);
  });

  it("daily loss limit: flattens SPY and stands aside, even if the signal says go", async () => {
    const t = setup({ kind: "drive", positions: [short(10)], account: { equity: 97_500 } });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.deepEqual(t.broker.submitted.map((o) => [o.side, o.quantity]), [["buy", 10]]);
    assert.equal(t.broker.positions.length, 0);
    assert.match(t.audit[0].reason, /Daily loss limit/);
    // Next tick: still halted, flat, no entry.
    t.setNow(new Date(MID_SESSION.getTime() + 5_000));
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 1);
    assert.equal(t.audit.at(-1)?.outcome, "aside");
  });

  it("just inside the loss limit it still follows the signal", async () => {
    const t = setup({ kind: "drive", account: { equity: 98_100 } });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 1);
  });

  it("never exceeds the max shares, even if the sizing says more", async () => {
    const t = setup({ kind: "drive" });
    await runMirrorTick(t.deps, { ...SETTINGS, quantity: 50, maxShares: 20 }, { dryRun: false });
    assert.equal(t.broker.submitted[0].quantity, 20);
  });

  it("ignores option positions: they neither block nor count as SPY", async () => {
    const t = setup({ kind: "drive", positions: [long(1, "SPY271217P00715000")] });
    await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(t.broker.submitted.length, 1);
    assert.equal(t.broker.submitted[0].ticker, "SPY");
    assert.equal(t.broker.positions.some((p) => p.ticker === "SPY271217P00715000"), true);
  });

  it("an unreadable account means no order", async () => {
    const t = setup({ kind: "drive" });
    t.broker.account = { ok: false, code: "NETWORK", error: "down" };
    const r = await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(t.broker.submitted.length, 0);
  });

  it("a bar-load failure means no order", async () => {
    const t = setup({ kind: "drive" });
    t.deps.loadBars = async () => {
      throw new Error("no data");
    };
    const r = await runMirrorTick(t.deps, SETTINGS, { dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(t.broker.submitted.length, 0);
  });
});

describe("mirror client order ids and the executor override", () => {
  it("differ per action, side and minute; identical within a minute", () => {
    const a = new Date("2026-11-19T20:00:05Z");
    const b = new Date("2026-11-19T20:00:50Z");
    const c = new Date("2026-11-19T20:01:05Z");
    assert.equal(mirrorClientOrderId("enter", "long", a), mirrorClientOrderId("enter", "long", b));
    assert.notEqual(mirrorClientOrderId("enter", "long", a), mirrorClientOrderId("enter", "long", c));
    assert.notEqual(mirrorClientOrderId("enter", "long", a), mirrorClientOrderId("close", "long", a));
    assert.ok(mirrorClientOrderId("close", "short", a).length <= 48);
  });

  it("placeIntent uses a supplied client order id, and rejects a malformed one", async () => {
    const broker = new FakeBroker();
    const ok = await placeIntent(broker, ON, {
      action: "enter", ticker: "SPY", side: "long", quantity: 1, signalPolarity: 1, signalDate: TODAY, clientOrderId: "pol-mir-test_1",
    });
    assert.ok(ok.ok);
    assert.equal(broker.submitted[0].clientOrderId, "pol-mir-test_1");
    const bad = await placeIntent(broker, ON, {
      action: "enter", ticker: "SPY", side: "long", quantity: 1, signalPolarity: 1, signalDate: TODAY, clientOrderId: "bad id!",
    });
    assert.equal(bad.ok, false);
  });

  it("default ids are unchanged for existing callers", async () => {
    const broker = new FakeBroker();
    await placeIntent(broker, ON, { action: "enter", ticker: "SPY", side: "long", quantity: 1, signalPolarity: 1, signalDate: TODAY });
    assert.equal(broker.submitted[0].clientOrderId, `pol-SPY-enter-long-${TODAY}`);
  });
});

describe("AlpacaPaperBroker.openOrderCount", () => {
  const order = { id: "1", client_order_id: "c", status: "new", symbol: "SPY", side: "buy", qty: "10" };
  const make = (status: number, data: unknown, seen: string[] = []) =>
    new AlpacaPaperBroker({
      keyId: "k",
      secretKey: "s",
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return { ok: status < 400, status, json: async () => data };
      }) as FetchLike,
    });

  it("counts open orders for the symbol via the paper host only", async () => {
    const seen: string[] = [];
    const r = await make(200, [order, order], seen).openOrderCount("SPY");
    assert.deepEqual(r, { ok: true, value: 2 });
    assert.match(seen[0], /^https:\/\/paper-api\.alpaca\.markets\/v2\/orders\?status=open&limit=50&symbols=SPY$/);
  });
  it("refuses a malformed list", async () => {
    const r = await make(200, [{ nope: true }]).openOrderCount("SPY");
    assert.equal(r.ok, false);
  });
  it("surfaces an HTTP failure", async () => {
    const r = await make(500, { message: "boom" }).openOrderCount("SPY");
    assert.equal(r.ok, false);
  });
});

describe("the mirror reuses POLARITO's signal code instead of forking it", () => {
  const src = readFileSync(new URL("../src/lib/mirrorRunner.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("imports the engine, the input builder and the sim's decision function", () => {
    assert.match(src, /import \{[^}]*computePolaritySeries[^}]*\} from "@\/lib\/polarity"/);
    assert.match(src, /import \{[^}]*buildAutoSimInput[^}]*decideAuto[^}]*\} from "@\/lib\/autoDecision"/);
    assert.match(src, /buildAutoSimInput\(ticker, computePolaritySeries\(bars\), "signal-close"\)/);
  });

  it("has no signal logic of its own: no completed-bars filter, gate, noise floor or hold logic", () => {
    assert.doesNotMatch(src, /completedBars/);
    assert.doesNotMatch(src, /netVolume|noiseFloor|NOISE_FLOOR|VOLUME_MA|gate\(/);
    assert.doesNotMatch(src, /hysteresis|confirmation|minHold|cooldown/i);
  });

  it("registers its audit source", () => {
    assert.ok((AUDIT_SOURCES as readonly string[]).includes("mirror-runner"));
  });
});
