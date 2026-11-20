import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateIntent } from "../src/lib/broker/execute";
import { placeLiveClose, placeLiveEntry } from "../src/lib/broker/liveExecute";
import {
  closeBreakerTripped,
  closeOrderId,
  deriveDayState,
  entryNumberFor,
  entryOrderId,
  isFailedStatus,
  parseLiveOrderId,
  stopOrderId,
} from "../src/lib/broker/liveOrders";
import type { BrokerOrder } from "../src/lib/broker/types";
import { FakeLiveBroker, LIVE_ON, TODAY } from "./helpers/liveFake";

const order = (clientOrderId: string, status = "filled", ticker = "WMT"): BrokerOrder => ({
  id: `id-${clientOrderId}`,
  clientOrderId,
  status,
  ticker,
  side: "buy",
  quantity: 1,
});

describe("live order ids", () => {
  it("follow pol-{date}-e{NN}-{TICKER} and friends", () => {
    assert.equal(entryOrderId(TODAY, 1, "NVDA"), "pol-20261119-e01-NVDA");
    assert.equal(entryOrderId(TODAY, 12, "GOOGL"), "pol-20261119-e12-GOOGL");
    assert.equal(closeOrderId(TODAY, 1, 2, "NVDA"), "pol-20261119-c01-a2-NVDA");
    assert.equal(stopOrderId(TODAY, 3, 1, "WMT"), "pol-20261119-s03-a1-WMT");
  });

  it("are deterministic: the same inputs always give the same id", () => {
    assert.equal(entryOrderId(TODAY, 2, "AAPL"), entryOrderId(TODAY, 2, "AAPL"));
    assert.notEqual(entryOrderId(TODAY, 2, "AAPL"), entryOrderId(TODAY, 3, "AAPL"));
    assert.notEqual(closeOrderId(TODAY, 1, 1, "AAPL"), closeOrderId(TODAY, 1, 2, "AAPL"));
  });

  it("always fit the executor's id rule, even for the longest ticker form", () => {
    for (const t of ["WMT", "GOOGL", "BRK.B", "BF-B"]) {
      for (const id of [entryOrderId(TODAY, 10, t), closeOrderId(TODAY, 10, 3, t), stopOrderId(TODAY, 10, 3, t)]) {
        const v = validateIntent({ action: "close", ticker: t, side: "long", quantity: 0, signalDate: TODAY, clientOrderId: id });
        assert.ok(v.ok, id);
        assert.ok(id.length <= 48);
      }
    }
  });

  it("parse back, and ignore other days and foreign ids", () => {
    assert.deepEqual(parseLiveOrderId("pol-20261119-e02-NVDA", TODAY), { kind: "e", nn: 2, ticker: "NVDA" });
    assert.deepEqual(parseLiveOrderId("pol-20261119-c02-a3-NVDA", TODAY), { kind: "c", nn: 2, attempt: 3, ticker: "NVDA" });
    assert.deepEqual(parseLiveOrderId("pol-20261119-s01-a1-WMT", TODAY), { kind: "s", nn: 1, attempt: 1, ticker: "WMT" });
    assert.equal(parseLiveOrderId("pol-20261118-e01-NVDA", TODAY), null);
    assert.equal(parseLiveOrderId("pol-mir-SPY-enter-long-202611191500", TODAY), null);
    assert.equal(parseLiveOrderId("manual-order", TODAY), null);
  });
});

describe("deriveDayState", () => {
  it("is empty on a fresh day", () => {
    const s = deriveDayState([], TODAY);
    assert.deepEqual([s.maxEntry, s.entryCount, s.lockTicker, s.stoppedToday], [0, 0, null, false]);
  });

  it("numbers every entry id (rejected too) but counts only live ones, locks to the first stock, and sees a stop marker", () => {
    const s = deriveDayState(
      [
        order("pol-20261119-e02-NVDA", "rejected", "NVDA"),
        order("pol-20261119-e01-NVDA", "filled", "NVDA"),
        order("pol-20261119-s01-a1-NVDA", "filled", "NVDA"),
        order("pol-20261118-e09-AAPL"),
      ],
      TODAY,
    );
    assert.equal(s.maxEntry, 2);
    assert.equal(s.entryCount, 1, "a rejected entry is not counted");
    assert.equal(s.lockTicker, "NVDA");
    assert.equal(s.stoppedToday, true);
  });

  it("knows which statuses are dead", () => {
    for (const st of ["canceled", "expired", "rejected", "done_for_day", "replaced"]) assert.ok(isFailedStatus(st));
    for (const st of ["filled", "accepted", "new", "partially_filled", "pending_new"]) assert.equal(isFailedStatus(st), false);
  });
});

describe("placeLiveEntry", () => {
  const args = (broker: FakeLiveBroker, nn = 1) => ({
    broker,
    config: LIVE_ON,
    date: TODAY,
    nn,
    ticker: "WMT",
    side: "long" as const,
    quantity: 1,
    polarity: 1,
    signalDate: TODAY,
  });

  it("sends one buy with the e-id and is a no-op on a repeat of the same id", async () => {
    const broker = new FakeLiveBroker();
    broker.fill = false;
    const first = await placeLiveEntry(args(broker));
    assert.ok(first.ok && first.status === "submitted");
    const again = await placeLiveEntry(args(broker));
    assert.ok(again.ok && again.status === "noop");
    assert.deepEqual(broker.submitted.map((o) => o.clientOrderId), ["pol-20261119-e01-WMT"]);
    assert.equal(broker.submitted[0].side, "buy");
  });

  it("treats a duplicate-id 422 as already placed only when the order is found by its id", async () => {
    const broker = new FakeLiveBroker();
    broker.orders.push(order("pol-20261119-e01-WMT", "accepted"));
    broker.hideFromLookupOnce.add("pol-20261119-e01-WMT");
    const res = await placeLiveEntry(args(broker));
    assert.ok(res.ok && res.status === "noop");
    assert.equal(broker.submitted.length, 1, "the broker was asked once and refused with 422");
  });

  it("does NOT read a 422 as success when no such order can be found", async () => {
    const broker = new FakeLiveBroker();
    broker.rejectNext.push({ code: "REJECTED", error: "Alpaca live API returned 422: client_order_id must be unique" });
    const res = await placeLiveEntry(args(broker));
    assert.equal(res.ok, false);
    assert.equal(broker.positions.length, 0);
  });

  it("does not read a 422 as success when the existing order is dead", async () => {
    const broker = new FakeLiveBroker();
    broker.orders.push(order("pol-20261119-e01-WMT", "canceled"));
    broker.hideFromLookupOnce.add("pol-20261119-e01-WMT");
    const res = await placeLiveEntry(args(broker));
    assert.equal(res.ok, false);
  });

  it("a different entry number is a different order, so re-entry is never blocked by the old id", async () => {
    const broker = new FakeLiveBroker();
    broker.fill = false;
    await placeLiveEntry(args(broker, 1));
    broker.orders[0].status = "filled";
    const second = await placeLiveEntry(args(broker, 2));
    assert.ok(second.ok && second.status === "submitted");
    assert.deepEqual(broker.submitted.map((o) => o.clientOrderId), ["pol-20261119-e01-WMT", "pol-20261119-e02-WMT"]);
  });

  it("is refused with a live-worded message when live trading is off, and sends nothing", async () => {
    const broker = new FakeLiveBroker();
    const res = await placeLiveEntry({ ...args(broker), config: { enabled: false, killed: false, configured: true } });
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.error : "", /POLARITO_LIVE_TRADING_ENABLED/);
    const killed = await placeLiveEntry({ ...args(broker), config: { enabled: true, killed: true, configured: true } });
    assert.equal(!killed.ok && killed.code, "KILLED");
    assert.equal(broker.submitted.length, 0);
  });

  it("an entry must match the polarity", async () => {
    const broker = new FakeLiveBroker();
    const res = await placeLiveEntry({ ...args(broker), polarity: -1 });
    assert.equal(res.ok, false);
    assert.equal(broker.submitted.length, 0);
  });
});

describe("placeLiveClose", () => {
  const held = [{ ticker: "WMT", side: "long" as const, quantity: 1, avgEntryPrice: 100 }];
  const close = (broker: FakeLiveBroker, orders: BrokerOrder[], kind: "close" | "stop" = "close") =>
    placeLiveClose({ broker, config: LIVE_ON, state: deriveDayState(orders, TODAY), ticker: "WMT", side: "long", kind });

  it("sells the broker's real quantity under c{NN}-a1 and a second click is a no-op", async () => {
    const broker = new FakeLiveBroker(undefined, held.map((p) => ({ ...p, quantity: 3 })));
    broker.fill = false;
    const entry = order("pol-20261119-e01-WMT");
    const first = await close(broker, [entry]);
    assert.ok(first.ok && first.status === "submitted");
    assert.deepEqual([broker.submitted[0].clientOrderId, broker.submitted[0].side, broker.submitted[0].quantity], ["pol-20261119-c01-a1-WMT", "sell", 3]);
    const second = await close(broker, [entry, ...broker.orders]);
    assert.ok(second.ok && second.status === "noop");
    assert.equal(broker.submitted.length, 1);
  });

  it("covers a short with a buy", async () => {
    const broker = new FakeLiveBroker(undefined, [{ ticker: "WMT", side: "short", quantity: 2, avgEntryPrice: 100 }]);
    const res = await placeLiveClose({ broker, config: LIVE_ON, state: deriveDayState([order("pol-20261119-e01-WMT")], TODAY), ticker: "WMT", side: "short", kind: "close" });
    assert.ok(res.ok);
    assert.deepEqual([broker.submitted[0].side, broker.submitted[0].quantity], ["buy", 2]);
  });

  it("a canceled or rejected attempt is followed by the next attempt number", async () => {
    const broker = new FakeLiveBroker(undefined, [...held]);
    const orders = [order("pol-20261119-e01-WMT"), order("pol-20261119-c01-a1-WMT", "canceled")];
    const res = await close(broker, orders);
    assert.ok(res.ok && res.status === "submitted");
    assert.equal(broker.submitted[0].clientOrderId, "pol-20261119-c01-a2-WMT");
  });

  it("stops after 3 failed attempts (circuit breaker) and sends nothing", async () => {
    const broker = new FakeLiveBroker(undefined, [...held]);
    const orders = [
      order("pol-20261119-e01-WMT"),
      order("pol-20261119-c01-a1-WMT", "rejected"),
      order("pol-20261119-c01-a2-WMT", "canceled"),
      order("pol-20261119-s01-a3-WMT", "expired"),
    ];
    const state = deriveDayState(orders, TODAY);
    assert.equal(closeBreakerTripped(state, "WMT", entryNumberFor(state, "WMT")), true);
    const res = await close(broker, orders);
    assert.equal(!res.ok && res.code, "BREAKER");
    assert.equal(broker.submitted.length, 0);
  });

  it("a rejection at submit leaves the position open and writes no closed state", async () => {
    const broker = new FakeLiveBroker(undefined, [...held]);
    broker.rejectNext.push({ code: "REJECTED", error: "Alpaca live API returned 403: wash trade" });
    const res = await close(broker, [order("pol-20261119-e01-WMT")]);
    assert.equal(res.ok, false);
    assert.equal(broker.positions.length, 1);
  });

  it("a stop-out uses the s-id and a prior close for the same entry blocks a second sell", async () => {
    const broker = new FakeLiveBroker(undefined, [...held]);
    broker.fill = false;
    const first = await close(broker, [order("pol-20261119-e01-WMT")], "stop");
    assert.ok(first.ok);
    assert.equal(broker.submitted[0].clientOrderId, "pol-20261119-s01-a1-WMT");
    const again = await close(broker, [order("pol-20261119-e01-WMT"), ...broker.orders], "close");
    assert.ok(again.ok && again.status === "noop");
    assert.equal(broker.submitted.length, 1);
  });

  it("with no entry today (held overnight) closes are filed under 00", async () => {
    const broker = new FakeLiveBroker(undefined, [...held]);
    await close(broker, []);
    assert.equal(broker.submitted[0].clientOrderId, "pol-20261119-c00-a1-WMT");
  });

  it("nothing to close at the broker is a no-op", async () => {
    const broker = new FakeLiveBroker();
    const res = await close(broker, []);
    assert.ok(res.ok && res.status === "noop");
    assert.equal(broker.submitted.length, 0);
  });
});
