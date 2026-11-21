import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlpacaPaperBroker } from "../src/lib/broker/alpacaPaper";
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

describe("live mode has no paper wording or paper calls", () => {
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

});
