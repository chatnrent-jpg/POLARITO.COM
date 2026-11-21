import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AlpacaPaperBroker } from "../src/lib/broker/alpacaPaper";
import { readLiveOrders } from "../src/lib/liveOrdersView";
import { tradingGate } from "../src/lib/broker/config";

describe("adapter parses the extra read-only fields only when valid", () => {
  const brokerWith = (body: unknown) =>
    new AlpacaPaperBroker({
      keyId: "k",
      secretKey: "s",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    });

  it("orders carry fills and times", async () => {
    const res = await brokerWith([
      { id: "1", client_order_id: "pol-1", status: "filled", symbol: "AAPL", side: "buy", qty: "3", filled_qty: "3", filled_avg_price: "101.5", submitted_at: "2026-11-20T15:00:00Z", filled_at: "2026-11-20T15:00:01Z" },
      { id: "2", client_order_id: "pol-2", status: "new", symbol: "AAPL", side: "buy", qty: "3", filled_qty: "0", filled_avg_price: null, created_at: "nonsense" },
    ]).listOrdersSince("2026-11-19T00:00:00Z");
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value[0].filledQuantity, 3);
    assert.equal(res.value[0].filledAvgPrice, 101.5);
    assert.equal(res.value[0].submittedAt, "2026-11-20T15:00:00Z");
    assert.equal(res.value[1].filledAvgPrice, undefined);
    assert.equal(res.value[1].submittedAt, undefined);
  });

  it("positions carry mark and unrealized P&L when Alpaca sends them", async () => {
    const res = await brokerWith([
      { symbol: "AAPL", qty: "5", avg_entry_price: "100", current_price: "104", market_value: "520", unrealized_pl: "20" },
      { symbol: "MSFT", qty: "1", avg_entry_price: "10" },
    ]).getPositions();
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value[0].currentPrice, 104);
    assert.equal(res.value[0].unrealizedPnl, 20);
    assert.equal(res.value[1].currentPrice, undefined);
    assert.equal(res.value[1].unrealizedPnl, undefined);
  });
});

describe("readLiveOrders (GET /api/broker/live/orders)", () => {
  const KEYS = ["POLARITO_LIVE_ACCOUNT", "ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY"];
  let saved: Record<string, string | undefined> = {};
  let realFetch: typeof fetch;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const enable = () => {
    process.env.POLARITO_LIVE_ACCOUNT = "1";
    process.env.ALPACA_LIVE_KEY_ID = "live-key-id";
    process.env.ALPACA_LIVE_SECRET_KEY = "live-secret";
  };

  it("touches nothing and says live:false when live is not opted in", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("no network");
    }) as typeof fetch;
    const res = await readLiveOrders(process.env);
    assert.deepEqual(res.body, { ok: true, live: false });
    assert.equal(calls, 0);
  });

  it("returns newest-first real orders without credentials", async () => {
    enable();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: "1", client_order_id: "pol-a", status: "filled", symbol: "AAPL", side: "buy", qty: "1", filled_qty: "1", filled_avg_price: "100" },
          { id: "2", client_order_id: "pol-b", status: "new", symbol: "NVDA", side: "buy", qty: "2" },
        ]),
        { status: 200 },
      )) as typeof fetch;
    const res = await readLiveOrders(process.env);
    const text = JSON.stringify(res.body);
    assert.equal(res.status, 200);
    const body = res.body as { ok: true; live: true; orders: { id: string }[] };
    assert.equal(body.live, true);
    assert.deepEqual(body.orders.map((o) => o.id), ["2", "1"]);
    assert.ok(!text.includes("live-secret") && !text.includes("live-key-id"));
  });

  it("caps the list and never exceeds 50 rows", async () => {
    enable();
    const many = Array.from({ length: 80 }, (_, i) => ({ id: String(i), client_order_id: `pol-${i}`, status: "filled", symbol: "AAPL", side: "buy", qty: "1" }));
    globalThis.fetch = (async () => new Response(JSON.stringify(many), { status: 200 })) as typeof fetch;
    const res = await readLiveOrders(process.env);
    assert.equal(res.status === 200 && res.body.live === true && res.body.orders.length, 50);
  });

  it("is an error, not an empty list, when Alpaca cannot be read", async () => {
    enable();
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const res = await readLiveOrders(process.env);
    assert.equal(res.status, 502);
    assert.equal(res.body.ok, false);
    assert.equal("orders" in res.body, false);
  });

  it("answers 503 when live is on but the keys are missing", async () => {
    process.env.POLARITO_LIVE_ACCOUNT = "1";
    const res = await readLiveOrders(process.env);
    assert.equal(res.status, 503);
  });
});

describe("live mode has no paper wording or paper calls", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const live = { enabled: false, killed: false, configured: true };

  it("the live gate names the live switch, never the paper one", () => {
    const off = tradingGate(live, "live");
    assert.ok(!off.ok);
    if (off.ok) return;
    assert.equal(off.code, "DISABLED");
    assert.match(off.error, /POLARITO_LIVE_TRADING_ENABLED=1/);
    assert.doesNotMatch(off.error, /paper/i);
    const keys = tradingGate({ enabled: true, killed: false, configured: false }, "live");
    assert.ok(!keys.ok);
    if (!keys.ok) assert.doesNotMatch(keys.error, /paper/i);
  });

  it("the paper wording is unchanged when no target is given", () => {
    const off = tradingGate(live);
    assert.ok(!off.ok);
    if (!off.ok) assert.match(off.error, /POLARITO_PAPER_TRADING_ENABLED=1/);
  });

  it("live routes and executors use the live wording", () => {
    for (const f of ["src/app/api/broker/live/status/route.node.ts", "src/lib/liveClose.ts", "src/lib/broker/liveExecute.ts"]) {
      assert.match(read(f), /tradingGate\([^)]*"live"\)/, f);
    }
  });

  it("the market-data auth error does not send a deployed page to .env.local", () => {
    const api = read("src/lib/marketApi.ts");
    assert.match(api, /process\.env\.VERCEL\s*\?\s*"Alpaca rejected the market-data API key/);
  });
});
