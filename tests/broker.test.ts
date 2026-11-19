import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALPACA_PAPER_BASE_URL,
  AlpacaPaperBroker,
  type FetchLike,
  type FetchResponseLike,
} from "../src/lib/broker/alpacaPaper";
import { paperBrokerConfig, paperCredentials, tradingGate, type PaperBrokerConfig } from "../src/lib/broker/config";
import { clientOrderIdFor, placeIntent, validateIntent } from "../src/lib/broker/execute";
import type {
  Broker,
  BrokerAccount,
  BrokerOrder,
  BrokerPosition,
  MarketOrderRequest,
  OrderIntent,
  Result,
} from "../src/lib/broker/types";

const ON: PaperBrokerConfig = { enabled: true, killed: false, configured: true };

const ACTIVE: BrokerAccount = {
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
    private account: Result<BrokerAccount, "NETWORK"> = { ok: true, value: ACTIVE },
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

const enter = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  action: "enter",
  ticker: "NVDA",
  side: "long",
  quantity: 10,
  signalDate: "2026-11-19",
  ...over,
});

describe("config + gate", () => {
  it("requires the exact enable flag and credentials", () => {
    assert.equal(paperBrokerConfig({}).enabled, false);
    assert.equal(paperBrokerConfig({ POLARITO_PAPER_TRADING_ENABLED: "true" }).enabled, false);
    assert.equal(paperBrokerConfig({ POLARITO_PAPER_TRADING_ENABLED: "1" }).enabled, true);
    assert.equal(paperBrokerConfig({ ALPACA_PAPER_KEY_ID: "k" }).configured, false);
    assert.equal(paperBrokerConfig({ ALPACA_PAPER_KEY_ID: "k", ALPACA_PAPER_SECRET_KEY: "s" }).configured, true);
    assert.equal(paperCredentials({ ALPACA_API_KEY_ID: "data", ALPACA_API_SECRET_KEY: "data" }), null);
  });

  it("kill switch: anything but an explicit off value kills", () => {
    for (const off of [undefined, "", "0", "false", "No", "OFF", " 0 "]) {
      assert.equal(paperBrokerConfig({ POLARITO_BROKER_KILL: off }).killed, false, String(off));
    }
    for (const on of ["1", "true", "yes", "stop", "x"]) {
      assert.equal(paperBrokerConfig({ POLARITO_BROKER_KILL: on }).killed, true, on);
    }
  });

  it("kill switch beats enabled and configured", () => {
    const g = tradingGate({ enabled: true, killed: true, configured: true });
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.code, "KILLED");
  });

  it("blocks when disabled or not configured", () => {
    const d = tradingGate({ enabled: false, killed: false, configured: true });
    assert.equal(d.ok === false && d.code, "DISABLED");
    const n = tradingGate({ enabled: true, killed: false, configured: false });
    assert.equal(n.ok === false && n.code, "NOT_CONFIGURED");
    assert.equal(tradingGate(ON).ok, true);
  });
});

describe("validateIntent", () => {
  it("accepts a clean entry and rejects malformed ones", () => {
    assert.equal(validateIntent(enter()).ok, true);
    assert.equal(validateIntent(enter({ ticker: "bad ticker" })).ok, false);
    assert.equal(validateIntent(enter({ quantity: 0 })).ok, false);
    assert.equal(validateIntent(enter({ quantity: 1.5 })).ok, false);
    assert.equal(validateIntent(enter({ quantity: 100_001 })).ok, false);
    assert.equal(validateIntent(enter({ signalDate: "11/19/2026" })).ok, false);
    assert.equal(validateIntent(enter({ side: "sideways" as never })).ok, false);
    assert.equal(validateIntent(enter({ action: "yolo" as never })).ok, false);
    assert.equal(validateIntent(enter({ timeInForce: "gtc" as never })).ok, false);
  });

  it("does not require a quantity for closes", () => {
    assert.equal(validateIntent(enter({ action: "close", quantity: 0 })).ok, true);
  });
});

describe("placeIntent", () => {
  it("submits a long entry as a buy and a short entry as a sell", async () => {
    const b = new FakeBroker();
    const r = await placeIntent(b, ON, enter());
    assert.equal(r.ok && r.status, "submitted");
    assert.deepEqual(b.submitted[0], {
      ticker: "NVDA",
      side: "buy",
      quantity: 10,
      clientOrderId: "pol-NVDA-enter-long-2026-11-19",
      timeInForce: "day",
    });
    const s = new FakeBroker();
    await placeIntent(s, ON, enter({ side: "short", ticker: "TSLA" }));
    assert.equal(s.submitted[0].side, "sell");
  });

  it("refuses everything under the kill switch, disabled, or unconfigured, without touching the broker", async () => {
    for (const cfg of [
      { enabled: true, killed: true, configured: true },
      { enabled: false, killed: false, configured: true },
      { enabled: true, killed: false, configured: false },
    ]) {
      const b = new FakeBroker();
      const r = await placeIntent(b, cfg, enter());
      assert.equal(r.ok, false);
      assert.equal(b.submitted.length, 0);
    }
  });

  it("is idempotent: the same signal never sends a second order", async () => {
    const b = new FakeBroker();
    const first = await placeIntent(b, ON, enter());
    const second = await placeIntent(b, ON, enter());
    assert.equal(first.ok && first.status, "submitted");
    assert.equal(second.ok && second.status, "noop");
    assert.equal(b.submitted.length, 1);
  });

  it("a different signal date is a different order id", () => {
    assert.notEqual(
      clientOrderIdFor({ action: "enter", ticker: "NVDA", side: "long", signalDate: "2026-11-19" }),
      clientOrderIdFor({ action: "enter", ticker: "NVDA", side: "long", signalDate: "2026-11-20" }),
    );
  });

  it("does not add to an existing position and refuses to flip without a close", async () => {
    const held: BrokerPosition = { ticker: "NVDA", side: "long", quantity: 10, avgEntryPrice: 100 };
    const same = new FakeBroker(undefined, [held]);
    const r1 = await placeIntent(same, ON, enter());
    assert.equal(r1.ok && r1.status, "noop");
    assert.equal(same.submitted.length, 0);

    const flip = new FakeBroker(undefined, [held]);
    const r2 = await placeIntent(flip, ON, enter({ side: "short" }));
    assert.equal(r2.ok, false);
    assert.equal(!r2.ok && r2.code, "CONFLICT");
    assert.equal(flip.submitted.length, 0);
  });

  it("closes flatten the broker's ACTUAL quantity, with the opposite side", async () => {
    const b = new FakeBroker(undefined, [{ ticker: "NVDA", side: "long", quantity: 37, avgEntryPrice: 100 }]);
    const r = await placeIntent(b, ON, enter({ action: "close", quantity: 1 }));
    assert.equal(r.ok && r.status, "submitted");
    assert.equal(b.submitted[0].side, "sell");
    assert.equal(b.submitted[0].quantity, 37);

    const sh = new FakeBroker(undefined, [{ ticker: "TSLA", side: "short", quantity: 5, avgEntryPrice: 200 }]);
    await placeIntent(sh, ON, enter({ action: "close", ticker: "TSLA", side: "short" }));
    assert.equal(sh.submitted[0].side, "buy");
  });

  it("closing when flat is a no-op, and closing the wrong side is a conflict", async () => {
    const flat = new FakeBroker();
    const r = await placeIntent(flat, ON, enter({ action: "close" }));
    assert.equal(r.ok && r.status, "noop");
    const wrong = new FakeBroker(undefined, [{ ticker: "NVDA", side: "short", quantity: 3, avgEntryPrice: 1 }]);
    const w = await placeIntent(wrong, ON, enter({ action: "close", side: "long" }));
    assert.equal(!w.ok && w.code, "CONFLICT");
  });

  it("refuses fractional broker positions rather than guessing", async () => {
    const b = new FakeBroker(undefined, [{ ticker: "NVDA", side: "long", quantity: 2.5, avgEntryPrice: 100 }]);
    const r = await placeIntent(b, ON, enter({ action: "close" }));
    assert.equal(r.ok, false);
    assert.equal(b.submitted.length, 0);
  });

  it("refuses when the account is blocked or the broker is unreachable", async () => {
    const blocked = new FakeBroker({ ok: true, value: { ...ACTIVE, tradingBlocked: true } });
    assert.equal((await placeIntent(blocked, ON, enter())).ok, false);
    const inactive = new FakeBroker({ ok: true, value: { ...ACTIVE, status: "ACCOUNT_UPDATED" } });
    assert.equal((await placeIntent(inactive, ON, enter())).ok, false);
    const down = new FakeBroker({ ok: false, code: "NETWORK", error: "down" });
    const r = await placeIntent(down, ON, enter());
    assert.equal(!r.ok && r.code, "BROKER");
    assert.equal(down.submitted.length, 0);
  });

  it("never throws, even if the broker does", async () => {
    const boom: Broker = {
      getAccount: async () => {
        throw new Error("kaboom");
      },
      getPositions: async () => ({ ok: true, value: [] }),
      getOrderByClientId: async () => ({ ok: true, value: null }),
      submitMarketOrder: async () => {
        throw new Error("kaboom");
      },
    };
    const r = await placeIntent(boom, ON, enter());
    assert.equal(r.ok, false);
  });
});

describe("AlpacaPaperBroker", () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

  function mock(responses: Array<{ status?: number; body?: unknown; throws?: boolean; badJson?: boolean }>) {
    const calls: Call[] = [];
    let i = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r.throws) throw new Error("socket hang up");
      const status = r.status ?? 200;
      const res: FetchResponseLike = {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (r.badJson) throw new Error("bad json");
          return r.body;
        },
      };
      return res;
    };
    return { calls, broker: new AlpacaPaperBroker({ keyId: "KEY123", secretKey: "SECRET456", fetchImpl }) };
  }

  it("only ever talks to the paper host, with auth headers", async () => {
    const m = mock([{ body: [] }]);
    await m.broker.getPositions();
    assert.ok(m.calls[0].url.startsWith("https://paper-api.alpaca.markets/"));
    assert.equal(ALPACA_PAPER_BASE_URL, "https://paper-api.alpaca.markets");
    assert.equal(m.calls[0].headers["APCA-API-KEY-ID"], "KEY123");
    assert.equal(m.calls[0].headers["APCA-API-SECRET-KEY"], "SECRET456");
  });

  it("requires credentials", () => {
    assert.throws(() => new AlpacaPaperBroker({ keyId: " ", secretKey: "x" }));
  });

  it("parses an account and rejects a malformed one", async () => {
    const good = mock([
      { body: { status: "ACTIVE", trading_blocked: false, account_blocked: false, equity: "100000.5", last_equity: "99000", cash: "5000", buying_power: "10000" } },
    ]);
    const a = await good.broker.getAccount();
    assert.equal(a.ok && a.value.equity, 100000.5);
    assert.equal(a.ok && a.value.lastEquity, 99000);
    const bad = mock([{ body: { status: "ACTIVE", equity: "NaN" } }]);
    const b = await bad.broker.getAccount();
    assert.equal(!b.ok && b.code, "MALFORMED");
  });

  it("parses short positions from negative quantities and rejects bad rows", async () => {
    const m = mock([
      { body: [{ symbol: "TSLA", qty: "-5", avg_entry_price: "200.1" }, { symbol: "NVDA", qty: "10", side: "long", avg_entry_price: "100" }] },
    ]);
    const r = await m.broker.getPositions();
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.value[0], { ticker: "TSLA", side: "short", quantity: 5, avgEntryPrice: 200.1 });
      assert.equal(r.value[1].side, "long");
    }
    const bad = mock([{ body: [{ symbol: "X", qty: "abc", avg_entry_price: "1" }] }]);
    const b = await bad.broker.getPositions();
    assert.equal(!b.ok && b.code, "MALFORMED");
  });

  it("posts a validated market order", async () => {
    const m = mock([
      { body: { id: "abc", client_order_id: "cid", status: "accepted", symbol: "NVDA", side: "buy", qty: "10" } },
    ]);
    const r = await m.broker.submitMarketOrder({ ticker: "NVDA", side: "buy", quantity: 10, clientOrderId: "cid", timeInForce: "opg" });
    assert.ok(r.ok);
    assert.equal(m.calls[0].method, "POST");
    assert.deepEqual(JSON.parse(m.calls[0].body ?? "{}"), {
      symbol: "NVDA",
      qty: "10",
      side: "buy",
      type: "market",
      time_in_force: "opg",
      client_order_id: "cid",
    });
  });

  it("refuses non-integer quantities before any request", async () => {
    const m = mock([{ body: {} }]);
    const r = await m.broker.submitMarketOrder({ ticker: "NVDA", side: "buy", quantity: 1.5, clientOrderId: "c", timeInForce: "day" });
    assert.equal(r.ok, false);
    assert.equal(m.calls.length, 0);
  });

  it("maps a 404 on lookup to 'no such order'", async () => {
    const m = mock([{ status: 404, body: { message: "order not found" } }]);
    const r = await m.broker.getOrderByClientId("cid");
    assert.ok(r.ok);
    assert.equal(r.ok && r.value, null);
  });

  it("fails closed on HTTP errors, network errors and bad JSON, without leaking secrets", async () => {
    const http = await mock([{ status: 403, body: { message: "forbidden" } }]).broker.getAccount();
    assert.equal(!http.ok && http.code, "REJECTED");
    const net = await mock([{ throws: true }]).broker.getAccount();
    assert.equal(!net.ok && net.code, "NETWORK");
    const bad = await mock([{ badJson: true }]).broker.getAccount();
    assert.equal(bad.ok, false);
    for (const r of [http, net, bad]) {
      const text = JSON.stringify(r);
      assert.ok(!text.includes("KEY123") && !text.includes("SECRET456"));
    }
  });

  it("times out instead of hanging", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const broker = new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl, timeoutMs: 20 });
    const r = await broker.getAccount();
    assert.equal(!r.ok && r.code, "TIMEOUT");
  });
});
