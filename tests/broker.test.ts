import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALPACA_PAPER_BASE_URL,
  AlpacaPaperBroker,
  type FetchLike,
  type FetchResponseLike,
} from "../src/lib/broker/alpacaPaper";
import { paperBrokerConfig, paperCredentials, tradingGate, type PaperBrokerConfig } from "../src/lib/broker/config";

const ON: PaperBrokerConfig = { enabled: true, killed: false, configured: true };

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
