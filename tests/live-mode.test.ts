import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AlpacaPaperBroker } from "../src/lib/broker/alpacaPaper";
import { readLiveOrders } from "../src/lib/liveOrdersView";
import { tradingGate } from "../src/lib/broker/config";
import { deriveLiveMode, liveDay, liveExposure, type LiveStatus } from "../src/lib/liveMode";

const GOOD: LiveStatus = {
  ok: true,
  live: true,
  tradingAllowed: true,
  account: { equity: 1_050, lastEquity: 1_000, cash: 400, buyingPower: 400 },
  positions: [{ ticker: "AAPL", side: "long", quantity: 5, avgEntryPrice: 100, marketValue: 520, currentPrice: 104, unrealizedPnl: 20 }],
};

describe("deriveLiveMode: sim vs live vs unavailable", () => {
  it("is simulated whenever live is not opted in, whatever the route says", () => {
    assert.deepEqual(deriveLiveMode(false, null, null), { kind: "sim" });
    assert.deepEqual(deriveLiveMode(false, GOOD, null), { kind: "sim" });
    assert.deepEqual(deriveLiveMode(false, null, "boom"), { kind: "sim" });
  });

  it("shows no numbers while the first read is pending", () => {
    assert.deepEqual(deriveLiveMode(true, null, null), { kind: "checking" });
  });

  it("is live with Alpaca's figures when the account is readable", () => {
    const m = deriveLiveMode(true, GOOD, null);
    assert.equal(m.kind, "live");
    if (m.kind !== "live") return;
    assert.equal(m.account.equity, 1_050);
    assert.equal(m.ordersAllowed, true);
    assert.equal(m.ordersReason, null);
  });

  it("is live but order-locked when trading is not enabled or the kill switch is on", () => {
    const m = deriveLiveMode(true, { ...GOOD, tradingAllowed: false, blockedReason: "Broker kill switch is on." }, null);
    assert.equal(m.kind, "live");
    if (m.kind !== "live") return;
    assert.equal(m.ordersAllowed, false);
    assert.equal(m.ordersReason, "Broker kill switch is on.");
    const d = deriveLiveMode(true, { ...GOOD, tradingAllowed: undefined }, null);
    assert.equal(d.kind === "live" && d.ordersAllowed, false);
  });

  it("is unavailable (never stale, zero or simulated) when the read fails", () => {
    for (const status of [
      { ok: false, live: true, error: "Alpaca is down." } as LiveStatus,
      { ok: true, live: false } as LiveStatus,
      { ok: true, live: true, positions: [] } as LiveStatus,
      { ok: true, live: true, account: { equity: Number.NaN, lastEquity: 1, cash: 1, buyingPower: 1 }, positions: [] } as LiveStatus,
      { ok: true, live: true, account: { equity: -5, lastEquity: 1, cash: 1, buyingPower: 1 }, positions: [] } as LiveStatus,
      { ok: true, live: true, account: GOOD.account } as LiveStatus,
    ]) {
      assert.equal(deriveLiveMode(true, status, null).kind, "unavailable", JSON.stringify(status));
    }
    const failed = deriveLiveMode(true, { ok: false, live: true, error: "Alpaca is down." }, null);
    assert.equal(failed.kind === "unavailable" && failed.reason, "Alpaca is down.");
  });

  it("a failed poll after a good one drops the old numbers instead of keeping them", () => {
    assert.equal(deriveLiveMode(true, GOOD, null).kind, "live");
    assert.equal(deriveLiveMode(true, GOOD, "Could not reach the live status route.").kind, "unavailable");
    assert.equal(deriveLiveMode(true, GOOD, null).kind, "live");
  });
});

describe("live day and exposure", () => {
  it("computes today's P&L from Alpaca equity vs last close", () => {
    assert.deepEqual(liveDay({ equity: 1_050, lastEquity: 1_000 }), { pnl: 50, pct: 5 });
    assert.equal(liveDay({ equity: 10, lastEquity: 0 }).pct, null);
    assert.equal(liveDay({ equity: 900, lastEquity: 1_000 }).pnl, -100);
  });

  it("sums exposure from market value, falling back to shares x entry", () => {
    const e = liveExposure(
      [
        { ticker: "A", side: "long", quantity: 2, avgEntryPrice: 100, marketValue: 210 },
        { ticker: "B", side: "long", quantity: 1, avgEntryPrice: 50 },
      ],
      1_000,
    );
    assert.equal(e.notional, 260);
    assert.equal(e.pct, 26);
    assert.equal(liveExposure([], 0).pct, null);
  });
});

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

describe("the displays follow the live mode (source assertions)", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("page.tsx decides opt-in on the server and wraps the dashboard in the provider", () => {
    const page = read("src/app/page.tsx");
    assert.match(page, /liveOptedIn\(process\.env\)/);
    assert.match(page, /<LiveModeProvider optIn=/);
  });

  it("the provider fetches nothing without opt-in and reads only the status route", () => {
    const p = read("src/components/LiveModeProvider.tsx");
    assert.match(p, /if \(!optIn\) return;/);
    assert.match(p, /\/api\/broker\/live\/status/);
    assert.doesNotMatch(p, /method:\s*"POST"/);
  });

  it("account card, ledger, auto controls and ticket switch off the simulated data when live", () => {
    assert.match(read("src/components/AccountSelector.tsx"), /mode\.kind !== "sim"\) return <LiveAccountCard/);
    assert.match(read("src/components/LedgerPanel.tsx"), /mode\.kind !== "sim"\) return <LiveLedgerPanel/);
    assert.match(read("src/components/AutoSimControls.tsx"), /mode\.kind !== "sim"/);
    const t = read("src/components/OrderModule.tsx");
    assert.match(t, /Live data unavailable/);
  });

  it("the browser simulation effect does not run, so nothing is written to the ledger, in live mode", () => {
    const d = read("src/components/PolarityDashboard.tsx");
    assert.match(d, /if \(!autoPrefs\.enabled \|\| !simMode\)/);
  });

  it("the live ledger is read-only: no order or close calls, only the orders route", () => {
    const l = read("src/components/LiveLedgerPanel.tsx");
    assert.match(l, /\/api\/broker\/live\/orders/);
    assert.match(read("src/app/api/broker/live/orders/route.node.ts"), /export async function GET\(\)/);
    assert.doesNotMatch(read("src/app/api/broker/live/orders/route.node.ts"), /export async function (POST|PUT|DELETE|PATCH)/);
    assert.doesNotMatch(l, /method:\s*"POST"|live\/buy|live\/close/);
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

  it("no page component calls the paper broker routes", () => {
    for (const f of ["PolarityDashboard", "OrderModule", "LiveAccountPanel", "LiveLedgerPanel", "LiveModeProvider", "AccountSelector", "LedgerPanel", "AutoSimControls"]) {
      assert.doesNotMatch(read(`src/components/${f}.tsx`), /broker\/paper|paper\/status/, f);
    }
  });

  it("simulation-only panels and notes are not rendered in live mode", () => {
    assert.match(read("src/components/AutoSimControls.tsx"), /if \(mode\.kind !== "sim"\) return null;/);
    assert.doesNotMatch(read("src/components/AccountSelector.tsx"), /simulated accounts are not used/);
    assert.doesNotMatch(read("src/components/OrderModule.tsx"), /Nothing is written to the simulated ledger while live is on/);
  });

  it("the market-data auth error does not send a deployed page to .env.local", () => {
    const api = read("src/lib/marketApi.ts");
    assert.match(api, /process\.env\.VERCEL\s*\?\s*"Alpaca rejected the market-data API key/);
  });
});
