import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { POST as buyPost } from "../src/app/api/broker/live/buy/route.node";
import { AUDIT_SOURCES, type AuditRecord } from "../src/lib/audit";
import { placeLiveClose } from "../src/lib/broker/liveExecute";
import { deriveDayState, entryNumberFor, manualOrderId, parseLiveOrderId } from "../src/lib/broker/liveOrders";
import type { BrokerAccount, BrokerPosition } from "../src/lib/broker/types";
import { buyLivePosition, companyKey, type LiveBuyDeps } from "../src/lib/liveBuy";
import { runPickTick } from "../src/lib/pickRunner";
import { proxy } from "../src/proxy";
import { LIVE_ON, MID_SESSION, pickSetup, TODAY, type BarSpec } from "./helpers/liveFake";

const BASE = "https://www.polarito.com";
const SPECS = (): Record<string, BarSpec> => ({
  NVDA: { kind: "drive", mult: 12, price: 130 },
  AAPL: { kind: "drive", mult: 8, price: 100 },
  GOOGL: { kind: "drive", mult: 8, price: 100 },
  GOOG: { kind: "drive", mult: 8, price: 100 },
  BIG: { kind: "drive", mult: 8, price: 900 },
});

type Setup = {
  account?: Partial<BrokerAccount>;
  positions?: BrokerPosition[];
  specs?: Record<string, BarSpec>;
  now?: Date;
  config?: typeof LIVE_ON;
  auto?: boolean;
};

function setup(o: Setup = {}) {
  const t = pickSetup({ specs: o.specs ?? SPECS(), account: o.account, positions: o.positions, now: o.now, config: o.config, auto: o.auto ?? false });
  const deps: LiveBuyDeps = {
    broker: t.broker,
    config: t.deps.config,
    settings: t.settings,
    readAuto: t.deps.readAuto!,
    loadBars: t.deps.loadBars,
    audit: t.deps.audit,
    now: t.deps.now,
    sleep: async () => {},
  };
  return {
    ...t,
    buy: (ticker: unknown, qty: unknown, options?: { requireDrive?: boolean }) => buyLivePosition(deps, ticker, qty, options),
    buyDeps: deps,
  };
}

const lastAudit = (audit: AuditRecord[]) => audit[audit.length - 1];
const longPos = (ticker: string, quantity = 1, avgEntryPrice = 100): BrokerPosition => ({ ticker, side: "long", quantity, avgEntryPrice });
const order = (clientOrderId: string, status: string, ticker: string, side: "buy" | "sell" = "buy") => ({ id: `id-${clientOrderId}`, clientOrderId, status, ticker, side, quantity: 1 });

describe("manual buy: success and sizing", () => {
  it("sends one long market buy under the m-id, confirms the position, and audits it", async () => {
    const s = setup();
    const r = await s.buy("NVDA", 1);
    assert.ok(r.ok);
    assert.equal(r.status, "submitted");
    assert.equal(r.clientOrderId, "pol-20261119-m01-NVDA");
    assert.equal(r.filled, true);
    assert.equal(r.reduced, false);
    assert.match(r.message, /Alpaca accepted BUY 1 NVDA/);
    assert.deepEqual(s.broker.submitted.map((o) => [o.ticker, o.side, o.quantity, o.timeInForce]), [["NVDA", "buy", 1, "day"]]);
    const a = lastAudit(s.audit);
    assert.deepEqual([a.source, a.outcome, a.ticker, a.side, a.quantity, a.clientOrderId], ["live-manual-buy", "entered", "NVDA", "long", 1, "pol-20261119-m01-NVDA"]);
  });

  it("is reduced to the 50% per-position cap, never above it, and says so", async () => {
    const s = setup(); // $1,000 equity, NVDA at $130 => 3 shares under $500
    const r = await s.buy("NVDA", 10);
    assert.ok(r.ok);
    assert.equal(r.quantity, 3);
    assert.equal(r.requestedQuantity, 10);
    assert.equal(r.reduced, true);
    assert.match(r.message, /Reduced from 10 to 3/);
    assert.equal(s.broker.submitted[0].quantity, 3);
  });

  it("is reduced by available cash", async () => {
    const s = setup({ account: { equity: 1_000, lastEquity: 1_000, cash: 250, buyingPower: 250 } });
    const r = await s.buy("AAPL", 5);
    assert.ok(r.ok);
    assert.equal(r.quantity, 2);
  });

  it("is refused when not even one share fits the cap", async () => {
    const s = setup(); // BIG at $900 > 50% of $1,000
    const r = await s.buy("BIG", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "RISK"]);
    assert.deepEqual(s.broker.submitted, []);
    assert.equal(lastAudit(s.audit).outcome, "blocked");
  });

  it("says 'not filled yet' and never claims the position when the order is only accepted", async () => {
    const s = setup();
    s.broker.fill = false;
    const r = await s.buy("NVDA", 1);
    assert.ok(r.ok);
    assert.equal(r.filled, false);
    assert.match(r.message, /Not filled yet/);
    assert.doesNotMatch(r.message, /position is shown/);
    assert.equal(r.orderStatus, "accepted");
  });
});

describe("manual buy with the ticket's gear gate (requireDrive)", () => {
  it("sends a long for a Drive reading and refuses Reverse, Neutral and not-ready readings, sending nothing", async () => {
    const ok = setup();
    assert.equal((await ok.buy("NVDA", 1, { requireDrive: true })).ok, true);
    for (const kind of ["reverse", "neutral"] as const) {
      const s = setup({ specs: { ...SPECS(), NVDA: { kind, mult: 12, price: 130 } } });
      const r = await s.buy("NVDA", 1, { requireDrive: true });
      assert.deepEqual([r.ok, !r.ok && r.code], [false, "GEAR"], kind);
      assert.deepEqual(s.broker.submitted, []);
      assert.equal(lastAudit(s.audit).outcome, "blocked");
    }
    const young = setup({ specs: { ...SPECS(), NVDA: { kind: "drive", mult: 12, price: 130, count: 10 } } });
    const y = await young.buy("NVDA", 1, { requireDrive: true });
    assert.deepEqual([y.ok, !y.ok && y.code], [false, "GEAR"]);
  });

  it("without the flag a hand buy does not consult the gear", async () => {
    const s = setup({ specs: { ...SPECS(), NVDA: { kind: "reverse", mult: 12, price: 130 } } });
    assert.equal((await s.buy("NVDA", 1)).ok, true);
  });
});

describe("manual buy: input and switches", () => {
  it("refuses a bad ticker, a ticker off the watchlist, and bad quantities", async () => {
    const s = setup();
    for (const [t, q, code] of [
      ["", 1, "INVALID"],
      ["NVDA!", 1, "INVALID"],
      ["TSLA", 1, "NOT_WATCHLIST"],
      ["NVDA", 0, "INVALID"],
      ["NVDA", 1.5, "INVALID"],
      ["NVDA", "2", "INVALID"],
      ["NVDA", Number.NaN, "INVALID"],
    ] as const) {
      const r = await s.buy(t, q);
      assert.deepEqual([r.ok, !r.ok && r.code], [false, code], `${t} ${q}`);
    }
    assert.deepEqual(s.broker.submitted, []);
    assert.equal(s.audit.length, 7);
    assert.ok(s.audit.every((a) => a.source === "live-manual-buy"));
  });

  it("refuses when live trading is not enabled", async () => {
    const s = setup({ config: { enabled: false, killed: false, configured: true } });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "DISABLED"]);
    assert.match(!r.ok ? r.error : "", /POLARITO_LIVE_TRADING_ENABLED/);
    assert.deepEqual(s.broker.submitted, []);
  });

  it("is stopped by the kill switch", async () => {
    const s = setup({ config: { enabled: true, killed: true, configured: true } });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "KILLED"]);
    assert.deepEqual(s.broker.submitted, []);
  });

  it("refuses outside market hours and after the end-of-day flatten", async () => {
    const closed = setup({ now: new Date("2026-11-19T12:00:00Z") }); // 07:00 New York
    assert.deepEqual([(await closed.buy("NVDA", 1)).ok, closed.broker.submitted.length], [false, 0]);
    const weekend = setup({ now: new Date("2026-11-21T17:00:00Z") });
    const w = await weekend.buy("NVDA", 1);
    assert.deepEqual([w.ok, !w.ok && w.code], [false, "MARKET_CLOSED"]);
    const late = setup({ now: new Date("2026-11-19T20:56:00Z") }); // 15:56 New York
    const l = await late.buy("NVDA", 1);
    assert.deepEqual([l.ok, !l.ok && l.code], [false, "FLATTEN_TIME"]);
    assert.deepEqual(late.broker.submitted, []);
  });
});

describe("manual buy: daily lockout", () => {
  it("refuses after a stop-out today", async () => {
    const s = setup();
    s.broker.orders.push(order("pol-20261119-s01-a1-NVDA", "filled", "NVDA", "sell"));
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "STOPPED"]);
    assert.deepEqual(s.broker.submitted, []);
  });

  it("refuses when the account is already down the daily limit", async () => {
    const s = setup({ account: { equity: 989, lastEquity: 1_000, cash: 989, buyingPower: 989 } });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "DAILY_LOSS"]);
    assert.deepEqual(s.broker.submitted, []);
  });

  it("allows a smaller loss than the limit", async () => {
    const s = setup({ account: { equity: 995, lastEquity: 1_000, cash: 995, buyingPower: 995 } });
    assert.equal((await s.buy("NVDA", 1)).ok, true);
  });
});

describe("manual buy: one stock at a time", () => {
  it("refuses with a position in a different ticker", async () => {
    const s = setup({ positions: [longPos("AAPL")] });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "OTHER_POSITION"]);
    assert.deepEqual(s.broker.submitted, []);
  });

  it("refuses with a working order in a different ticker", async () => {
    const s = setup();
    s.broker.orders.push(order("someone-else-1", "accepted", "AAPL"));
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "OTHER_ORDER"]);
  });

  it("refuses an option position anywhere in the account", async () => {
    const s = setup({ positions: [{ ticker: "AAPL261218C00200000", side: "long", quantity: 1, avgEntryPrice: 5 }] });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "OTHER_POSITION"]);
  });

  it("does not add to a position already held or stack on a working order in the same stock", async () => {
    const held = setup({ positions: [longPos("NVDA")] });
    const h = await held.buy("NVDA", 1);
    assert.deepEqual([h.ok, !h.ok && h.code], [false, "HELD"]);
    const working = setup();
    working.broker.orders.push(order("pol-20261119-e01-NVDA", "accepted", "NVDA"));
    const w = await working.buy("NVDA", 1);
    assert.deepEqual([w.ok, !w.ok && w.code], [false, "WORKING"]);
    assert.deepEqual([...held.broker.submitted, ...working.broker.submitted], []);
  });

  it("treats GOOGL and GOOG as one company", async () => {
    assert.equal(companyKey("GOOG"), companyKey("GOOGL"));
    const s = setup({ positions: [longPos("GOOG")] });
    const r = await s.buy("GOOGL", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "HELD"]);
    const other = setup({ positions: [longPos("GOOGL")] });
    const o = await other.buy("NVDA", 1);
    assert.deepEqual([o.ok, !o.ok && o.code], [false, "OTHER_POSITION"]);
  });
});

describe("manual buy with Auto ON", () => {
  it("is refused while Auto has not picked today's stock", async () => {
    const s = setup({ auto: true });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "AUTO_LOCK"]);
    assert.deepEqual(s.broker.submitted, []);
  });

  it("is refused for a different ticker than today's locked stock", async () => {
    const s = setup({ auto: true });
    s.broker.orders.push(order("pol-20261119-e01-AAPL", "filled", "AAPL"), order("pol-20261119-c01-a1-AAPL", "filled", "AAPL", "sell"));
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "AUTO_LOCK"]);
    assert.match(!r.ok ? r.error : "", /today's stock is AAPL/);
  });

  it("is allowed for the locked stock and takes the next entry number", async () => {
    const s = setup({ auto: true });
    s.broker.orders.push(order("pol-20261119-e01-NVDA", "filled", "NVDA"), order("pol-20261119-c01-a1-NVDA", "filled", "NVDA", "sell"));
    const r = await s.buy("NVDA", 1);
    assert.ok(r.ok);
    assert.equal(r.clientOrderId, "pol-20261119-m02-NVDA");
  });

  it("is allowed for the same company's other share class", async () => {
    const s = setup({ auto: true });
    s.broker.orders.push(order("pol-20261119-e01-GOOG", "filled", "GOOG"), order("pol-20261119-c01-a1-GOOG", "filled", "GOOG", "sell"));
    assert.equal((await s.buy("GOOGL", 1)).ok, true);
  });

  it("with Auto OFF a different ticker is allowed when the account is flat and nothing is working", async () => {
    const s = setup({ auto: false });
    s.broker.orders.push(order("pol-20261119-e01-AAPL", "filled", "AAPL"), order("pol-20261119-c01-a1-AAPL", "filled", "AAPL", "sell"));
    assert.equal((await s.buy("NVDA", 1)).ok, true);
  });
});

describe("manual buy fails closed on unreadable data", () => {
  const fail = { ok: false as const, code: "NETWORK" as const, error: "down" };
  const cases: Array<[string, (s: ReturnType<typeof setup>) => void]> = [
    ["account", (s) => void (s.broker.getAccount = async () => fail)],
    ["positions", (s) => void (s.broker.getPositions = async () => fail)],
    ["open orders", (s) => void (s.broker.listOpenOrders = async () => fail)],
    ["today's orders", (s) => void (s.broker.listOrdersSince = async () => fail)],
    ["asset", (s) => void (s.broker.getAsset = async () => fail)],
    ["Auto read throws", (s) => void (s.buyDeps.readAuto = async () => Promise.reject(new Error("x")))],
    [
      "Auto store error",
      (s) => void (s.buyDeps.readAuto = async () => ({ on: false, available: true, at: null, reason: "The Auto store timed out. Auto is OFF until the store answers." })),
    ],
    ["prices", (s) => void (s.buyDeps.loadBars = async () => Promise.reject(new Error("no bars")))],
    ["empty prices", (s) => void (s.buyDeps.loadBars = async () => [])],
    ["equity", (s) => void (s.broker.account = { ...s.broker.account, equity: Number.NaN })],
  ];
  for (const [name, breakIt] of cases) {
    it(`unreadable ${name}: refuses, sends nothing, audits an error or block`, async () => {
      const s = setup();
      breakIt(s);
      const r = await buyLivePosition(s.buyDeps, "NVDA", 1);
      assert.equal(r.ok, false, name);
      assert.deepEqual(s.broker.submitted, []);
      assert.equal(s.audit.length, 1);
      assert.match(lastAudit(s.audit).outcome, /error|blocked/);
    });
  }

  it("Auto with no store configured is simply OFF (not an error)", async () => {
    const s = setup();
    s.buyDeps.readAuto = async () => ({ on: false, available: false, at: null, reason: "No Auto store is configured." });
    assert.equal((await buyLivePosition(s.buyDeps, "NVDA", 1)).ok, true);
  });

  it("refuses stale prices and a halted or untradable asset", async () => {
    const stale = setup({ specs: { ...SPECS(), NVDA: { kind: "drive", mult: 12, price: 130, last: "2026-11-18" } } });
    const r = await stale.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "STALE"]);
    const inactive = setup();
    inactive.broker.assets.set("NVDA", { symbol: "NVDA", status: "inactive", tradable: true, shortable: false, borrowStatus: null });
    assert.deepEqual([(await inactive.buy("NVDA", 1)).ok, inactive.broker.submitted.length], [false, 0]);
    const untradable = setup();
    untradable.broker.assets.set("NVDA", { symbol: "NVDA", status: "active", tradable: false, shortable: false, borrowStatus: null });
    assert.equal((await untradable.buy("NVDA", 1)).ok, false);
  });

  it("refuses an inactive or blocked account", async () => {
    const s = setup({ account: { tradingBlocked: true } });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "ACCOUNT"]);
  });
});

describe("manual buy: broker errors and duplicate ids", () => {
  it("a broker rejection is an error: nothing assumed bought, audited as error", async () => {
    const s = setup();
    s.broker.rejectNext.push({ code: "REJECTED", error: "insufficient buying power" });
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "BROKER"]);
    assert.match(!r.ok ? r.error : "", /Nothing is assumed bought/);
    assert.equal(lastAudit(s.audit).outcome, "error");
    assert.equal(s.broker.positions.length, 0);
  });

  it("an order with this id that already exists is a no-op, never a second order", async () => {
    const s = setup();
    s.broker.orders.push(order("pol-20261119-m01-NVDA", "accepted", "NVDA"));
    s.broker.listOrdersSince = async () => ({ ok: true, value: [] }); // a racing request: the day state does not show it yet
    s.broker.listOpenOrders = async () => ({ ok: true, value: [] });
    const r = await s.buy("NVDA", 1);
    assert.ok(r.ok);
    assert.equal(r.status, "noop");
    assert.equal(r.filled, false);
    assert.match(r.message, /already exists at Alpaca/);
    assert.deepEqual(s.broker.submitted, []);
    assert.equal(lastAudit(s.audit).outcome, "held");
  });

  it("a duplicate-id 422 at submit counts as placed only when the live order is found by its id", async () => {
    const s = setup();
    s.broker.orders.push(order("pol-20261119-m01-NVDA", "filled", "NVDA"));
    s.broker.listOrdersSince = async () => ({ ok: true, value: [] });
    s.broker.listOpenOrders = async () => ({ ok: true, value: [] });
    s.broker.hideFromLookupOnce.add("pol-20261119-m01-NVDA");
    const r = await s.buy("NVDA", 1);
    assert.ok(r.ok);
    assert.equal(r.status, "noop");
    assert.equal(s.broker.submitted.length, 1);
    assert.equal(s.broker.orders.length, 1);
  });

  it("a 422 with no such order, or only a dead one, is an error", async () => {
    const s = setup();
    s.broker.orders.push(order("pol-20261119-m01-NVDA", "canceled", "NVDA"));
    s.broker.listOrdersSince = async () => ({ ok: true, value: [] });
    s.broker.hideFromLookupOnce.add("pol-20261119-m01-NVDA");
    const r = await s.buy("NVDA", 1);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "BROKER"]);
  });

  it("a canceled earlier manual buy moves to the next number instead of colliding", async () => {
    const s = setup();
    s.broker.orders.push(order("pol-20261119-m01-NVDA", "canceled", "NVDA"));
    const r = await s.buy("NVDA", 1);
    assert.ok(r.ok);
    assert.equal(r.clientOrderId, "pol-20261119-m02-NVDA");
  });
});

describe("manual orders in the day state", () => {
  it("parse, share the entry sequence, and a failed manual buy does not lock the day", () => {
    assert.equal(manualOrderId(TODAY, 3, "NVDA"), "pol-20261119-m03-NVDA");
    assert.deepEqual(parseLiveOrderId("pol-20261119-m03-NVDA", TODAY), { kind: "m", nn: 3, ticker: "NVDA" });
    const failed = deriveDayState([order("pol-20261119-m01-NVDA", "rejected", "NVDA")], TODAY);
    assert.deepEqual([failed.maxEntry, failed.entryCount, failed.lockTicker], [1, 0, null]);
    const live = deriveDayState([order("pol-20261119-m01-AAPL", "filled", "AAPL"), order("pol-20261119-e02-NVDA", "filled", "NVDA")], TODAY);
    assert.deepEqual([live.maxEntry, live.entryCount, live.lockTicker], [2, 2, "AAPL"]);
  });

  it("the position from a manual buy closes under its own number, round trip after round trip", async () => {
    const s = setup();
    for (const [nn, id] of [
      [1, "pol-20261119-m01-NVDA"],
      [2, "pol-20261119-m02-NVDA"],
    ] as const) {
      const r = await s.buy("NVDA", 1);
      assert.ok(r.ok);
      assert.equal(r.clientOrderId, id);
      const state = deriveDayState(s.broker.orders, TODAY);
      assert.equal(entryNumberFor(state, "NVDA"), nn);
      const close = await placeLiveClose({ broker: s.broker, config: LIVE_ON, state, ticker: "NVDA", side: "long", kind: "close" });
      assert.ok(close.ok && close.status === "submitted", `close ${nn}`);
      assert.equal(close.ok && close.clientOrderId, `pol-20261119-c0${nn}-a1-NVDA`);
      assert.equal(s.broker.positions.length, 0);
    }
  });

  it("the automation numbers its next entry after a manual one, so ids never collide", async () => {
    const s = setup({ auto: true });
    s.broker.orders.push(order("pol-20261119-m01-NVDA", "filled", "NVDA"), order("pol-20261119-c01-a1-NVDA", "filled", "NVDA", "sell"));
    s.setNow(MID_SESSION);
    const rep = await runPickTick(s.deps, s.settings, { dryRun: false });
    assert.ok(rep.ok);
    assert.deepEqual(s.broker.submitted.map((o) => o.clientOrderId), ["pol-20261119-e02-NVDA"]);
  });

  it("Auto OFF still sends nothing after a manual buy (the runner only logs)", async () => {
    const s = setup({ auto: false });
    assert.ok((await s.buy("NVDA", 1)).ok);
    const sent = s.broker.submitted.length;
    await runPickTick(s.deps, s.settings, { dryRun: false });
    assert.equal(s.broker.submitted.length, sent);
  });
});

describe("the buy route", () => {
  const KEYS = ["POLARITO_LIVE_ACCOUNT", "POLARITO_LIVE_TRADING_ENABLED", "POLARITO_LIVE_WATCHLIST", "ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY", "POLARITO_BROKER_KILL"];
  let saved: Record<string, string | undefined> = {};
  let realFetch: typeof fetch;
  let seen: string[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    realFetch = globalThis.fetch;
    seen = [];
    globalThis.fetch = (async (input: unknown) => {
      seen.push(String(input));
      throw new Error("network is forbidden in this test");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const post = (body: unknown, headers: Record<string, string> = { origin: BASE, host: "www.polarito.com" }) =>
    new NextRequest(`${BASE}/api/broker/live/buy`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const liveOn = () => {
    process.env.POLARITO_LIVE_ACCOUNT = "1";
    process.env.ALPACA_LIVE_KEY_ID = "k";
    process.env.ALPACA_LIVE_SECRET_KEY = "s";
    process.env.POLARITO_LIVE_WATCHLIST = "NVDA,AAPL";
  };

  it("is a registered audit source and sits behind the session gate", () => {
    assert.ok((AUDIT_SOURCES as readonly string[]).includes("live-manual-buy"));
    const res = proxy(new NextRequest(`${BASE}/api/broker/live/buy`, { method: "POST" }));
    assert.equal(res.status, 401);
  });

  it("refuses and touches nothing when the live account is not switched on", async () => {
    const res = await buyPost(post({ ticker: "NVDA", quantity: 1 }));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "LIVE_OFF");
    assert.deepEqual(seen, []);
  });

  it("refuses cross-site posts, non-JSON bodies and wrong shapes", async () => {
    liveOn();
    process.env.POLARITO_LIVE_TRADING_ENABLED = "1";
    assert.equal((await buyPost(post({ ticker: "NVDA", quantity: 1 }, { origin: "https://evil.example", host: "www.polarito.com" }))).status, 403);
    assert.equal((await buyPost(post({ ticker: "NVDA", quantity: 1 }, {}))).status, 403);
    assert.equal((await buyPost(post("nope"))).status, 400);
    assert.equal((await buyPost(post({ ticker: "NVDA" }))).status, 400);
    assert.equal((await buyPost(post({ ticker: 5, quantity: 1 }))).status, 400);
    assert.equal((await buyPost(post({ ticker: "NVDA", quantity: "1" }))).status, 400);
    assert.equal((await buyPost(post({ ticker: "NVDA", quantity: 1, requireDrive: "yes" }))).status, 400);
    assert.deepEqual(seen, []);
  });

  it("fails closed on a missing watchlist or missing live keys", async () => {
    process.env.POLARITO_LIVE_ACCOUNT = "1";
    assert.equal((await buyPost(post({ ticker: "NVDA", quantity: 1 }))).status, 500);
    process.env.POLARITO_LIVE_WATCHLIST = "NVDA";
    assert.equal((await buyPost(post({ ticker: "NVDA", quantity: 1 }))).status, 503);
    assert.deepEqual(seen, []);
  });

  it("refuses when live trading is not enabled, before any network call", async () => {
    liveOn();
    const res = await buyPost(post({ ticker: "NVDA", quantity: 1 }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "DISABLED");
    assert.deepEqual(seen, []);
  });

  it("is blocked by the kill switch, before any network call", async () => {
    liveOn();
    process.env.POLARITO_LIVE_TRADING_ENABLED = "1";
    process.env.POLARITO_BROKER_KILL = "1";
    const res = await buyPost(post({ ticker: "NVDA", quantity: 1 }));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "KILLED");
    assert.deepEqual(seen, []);
  });

  it("refuses a ticker off the watchlist with 400", async () => {
    liveOn();
    process.env.POLARITO_LIVE_TRADING_ENABLED = "1";
    const res = await buyPost(post({ ticker: "TSLA", quantity: 1 }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "NOT_WATCHLIST");
    assert.deepEqual(seen, []);
  });
});

describe("the order ticket is the live order path", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const ticket = read("src/components/OrderModule.tsx");
  const panel = read("src/components/LiveAccountPanel.tsx");
  const dashboard = read("src/components/PolarityDashboard.tsx");

  it("keeps the ticket's own fields, gear gate and review flow", () => {
    for (const text of ["Stock Ticker", "Order Type", "Quantity (shares)", "Review Order", "evaluateGuard", "validateQuantity", "Confirm simulated order", "addLedgerEntry"]) {
      assert.ok(ticket.includes(text), text);
    }
    assert.match(dashboard, /<OrderModule key=\{accountId\} analysis=\{analysis\} ticker=\{tickerControl\} \/>/);
  });

  it("shows the mode on the header and only goes live on the server's say-so, never the other way", () => {
    assert.match(ticket, /MODE: LIVE REAL CASH/);
    assert.match(ticket, /MODE: SIMULATED/);
    assert.match(ticket, /bg-amber-400/);
    assert.match(ticket, /const live = mode\.kind === "live" && mode\.ordersAllowed;/);
    const lib = read("src/lib/liveMode.ts");
    assert.match(lib, /const ordersAllowed = status\.tradingAllowed === true;/);
  });

  it("live confirm posts to /api/broker/live/buy with the gear gate and writes nothing to the sim ledger", () => {
    assert.match(ticket, /\/api\/broker\/live\/buy/);
    assert.match(ticket, /requireDrive: true/);
    const live = ticket.slice(ticket.indexOf("if (live) {\n      setReview(null);\n      void submitLive"));
    assert.ok(live.indexOf("submitLive") < live.indexOf("addLedgerEntry"));
    assert.match(ticket, /Short is not supported in LIVE mode/);
  });

  it("puts the live account inside the ticket card and no floating panel remains", () => {
    assert.match(ticket, /<LiveAccountPanel feed=\{feed\} \/>/);
    assert.doesNotMatch(panel, /\bfixed\b|\babsolute\b/);
    assert.match(panel, /mode\.kind === "sim"\) return null/);
    for (const text of ["Confirm Auto ON", "Close all positions first", "Confirm close"]) assert.ok(panel.includes(text), text);
    assert.doesNotMatch(read("src/app/page.tsx"), /LiveBroker/);
    assert.throws(() => read("src/components/LiveBrokerPanel.tsx"));
    assert.throws(() => read("src/components/LiveBrokerGate.tsx"));
  });
});
