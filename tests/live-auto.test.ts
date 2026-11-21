import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { POST as autoPost } from "../src/app/api/broker/live/auto/route.node";
import { proxy } from "../src/proxy";
import { closeLivePosition } from "../src/lib/liveClose";
import { runPickTick } from "../src/lib/pickRunner";
import { autoStoreCredentials, createAutoStore, LIVE_AUTO_KEY, readAutoState } from "../src/lib/liveAutoStore";
import { requireIdle } from "../src/lib/liveAutoGuard";
import { AUDIT_SOURCES } from "../src/lib/audit";
import { pickSetup, type BarSpec, type FakeLiveBroker } from "./helpers/liveFake";

const KV = { KV_REST_API_URL: "https://kv.example.upstash.io", KV_REST_API_TOKEN: "kv-token-value" };

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
function memoryKv(initial?: string | null) {
  const state = { value: initial ?? null, calls: [] as Array<{ url: string; auth: string | undefined; args: string[] }>, failNext: false, lie: false };
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; body?: string }): Promise<Reply> => {
    const args = JSON.parse(String(init?.body)) as string[];
    state.calls.push({ url, auth: init?.headers?.Authorization, args });
    if (state.failNext) return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    if (args[0] === "GET") return { ok: true, status: 200, json: async () => ({ result: state.value }) };
    if (args[0] === "SET") {
      if (!state.lie) state.value = args[2];
      return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
    }
    return { ok: false, status: 400, json: async () => ({}) };
  };
  return { state, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const SPECS = (): Record<string, BarSpec> => ({ NVDA: { kind: "drive", mult: 12, price: 130 } });
type T = ReturnType<typeof pickSetup>;
const tick = (t: T) => runPickTick(t.deps, t.settings, { dryRun: false });
const ids = (t: T) => t.broker.submitted.map((o) => o.clientOrderId);

describe("the Auto store", () => {
  it("needs an https URL and a token, from the Vercel KV or the Upstash names", () => {
    assert.equal(autoStoreCredentials({}), null);
    assert.equal(autoStoreCredentials({ KV_REST_API_URL: "https://x", KV_REST_API_TOKEN: "" }), null);
    assert.equal(autoStoreCredentials({ KV_REST_API_URL: "http://x", KV_REST_API_TOKEN: "t" }), null);
    assert.deepEqual(autoStoreCredentials({ UPSTASH_REDIS_REST_URL: "https://u/", UPSTASH_REDIS_REST_TOKEN: "t" }), { url: "https://u", token: "t" });
    assert.equal(createAutoStore({}), null);
  });

  it("a missing key means OFF; write then read round-trips and sends the bearer token only to the store", async () => {
    const kv = memoryKv();
    const store = createAutoStore(KV, kv.fetchImpl)!;
    assert.deepEqual(await store.read(), { ok: true, on: false, at: null });
    assert.deepEqual(await store.write(true, new Date("2026-11-19T20:00:00Z")), { ok: true });
    const r = await store.read();
    assert.ok(r.ok && r.on && r.at === "2026-11-19T20:00:00.000Z");
    assert.equal(kv.state.calls[0].args[1], LIVE_AUTO_KEY);
    assert.ok(kv.state.calls.every((c) => c.url === KV.KV_REST_API_URL && c.auth === `Bearer ${KV.KV_REST_API_TOKEN}`));
  });

  it("fails closed: no store, store errors, a network throw, and malformed values are all OFF", async () => {
    const none = await readAutoState(null);
    assert.deepEqual([none.on, none.available], [false, false]);
    assert.match(none.reason, /No Auto store is configured/);

    const down = memoryKv(JSON.stringify({ auto: true, at: "x" }));
    down.state.failNext = true;
    const s1 = await readAutoState(createAutoStore(KV, down.fetchImpl));
    assert.deepEqual([s1.on, s1.available], [false, true]);
    assert.match(s1.reason, /answered 500/);

    const thrown = createAutoStore(KV, (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    assert.equal((await readAutoState(thrown)).on, false);

    for (const bad of ["not json", JSON.stringify({ auto: "yes" }), JSON.stringify([1]), "true"]) {
      const s = await readAutoState(createAutoStore(KV, memoryKv(bad).fetchImpl));
      assert.equal(s.on, false, bad);
      assert.match(s.reason, /malformed/);
    }
  });

  it("a write the store does not confirm is an error", async () => {
    const kv = memoryKv();
    kv.state.failNext = true;
    const w = await createAutoStore(KV, kv.fetchImpl)!.write(true);
    assert.equal(w.ok, false);
  });
});

describe("Auto gates the live runner's signal-driven orders", () => {
  it("OFF (the default): nothing is entered; the audit says what still runs", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    const r = await tick(t);
    assert.ok(r.ok);
    assert.equal(t.broker.submitted.length, 0);
    const reasons = t.audit.map((a) => a.reason).join(" | ");
    assert.match(reasons, /Live Auto is OFF/);
    assert.match(reasons, /stop-out and the end-of-day flatten still run/);
    assert.match(reasons, /Would enter long 1 NVDA/);
    assert.ok(t.audit.every((a) => a.outcome !== "entered"));
  });

  it("with no Auto source wired, or a source that throws, it is OFF", async () => {
    const none = pickSetup({ specs: SPECS() });
    delete none.deps.readAuto;
    await tick(none);
    assert.equal(none.broker.submitted.length, 0);

    const broken = pickSetup({ specs: SPECS() });
    broken.deps.readAuto = async () => {
      throw new Error("kv down");
    };
    await tick(broken);
    assert.equal(broken.broker.submitted.length, 0);
    assert.match(broken.audit.map((a) => a.reason).join(" "), /Reading Auto failed/);
  });

  it("switching ON takes effect on the next tick, switching OFF stops entries", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    t.autoState.on = true;
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA"]);

    const closed = await closeLivePosition(
      { broker: t.broker as FakeLiveBroker, config: t.deps.config, audit: t.deps.audit, now: t.deps.now, sleep: t.deps.sleep },
      "NVDA",
    );
    assert.ok(closed.ok);
    t.autoState.on = false;
    await tick(t);
    assert.equal(t.broker.positions.length, 0, "no entry while Auto is OFF");
    t.autoState.on = true;
    await tick(t);
    assert.deepEqual(t.broker.positions.map((p) => p.ticker), [], "NVDA already used its entry today");
  });

  it("OFF: a held stock is not closed or flipped by the signal, only logged", async () => {
    const t = pickSetup({ specs: { NVDA: { kind: "neutral" } }, auto: false });
    t.broker.positions.push({ ticker: "NVDA", side: "long", quantity: 1, avgEntryPrice: 130 });
    t.broker.orders.push({ id: "x", clientOrderId: "pol-20261119-e01-NVDA", status: "filled", ticker: "NVDA", side: "buy", quantity: 1 });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.equal(t.broker.positions.length, 1);
    assert.ok(t.audit.some((a) => a.outcome === "dry-run" && /Nothing was sent/.test(a.reason)));
  });

  it("OFF: the 1% stop-out still flattens", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 989 }, auto: false });
    t.broker.positions.push({ ticker: "NVDA", side: "long", quantity: 1, avgEntryPrice: 130 });
    t.broker.orders.push({ id: "x", clientOrderId: "pol-20261119-e01-NVDA", status: "filled", ticker: "NVDA", side: "buy", quantity: 1 });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-s01-a1-NVDA"]);
  });

  it("OFF: the 15:55 flatten still runs", async () => {
    const t = pickSetup({ specs: SPECS(), now: new Date("2026-11-19T20:56:00Z"), auto: false });
    t.broker.positions.push({ ticker: "NVDA", side: "long", quantity: 1, avgEntryPrice: 130 });
    t.broker.orders.push({ id: "x", clientOrderId: "pol-20261119-e01-NVDA", status: "filled", ticker: "NVDA", side: "buy", quantity: 1 });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-c01-a1-NVDA"]);
  });

  it("OFF: the manual Close route still works", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    t.broker.positions.push({ ticker: "NVDA", side: "long", quantity: 1, avgEntryPrice: 130 });
    const res = await closeLivePosition(
      { broker: t.broker as FakeLiveBroker, config: t.deps.config, audit: t.deps.audit, now: t.deps.now, sleep: t.deps.sleep },
      "NVDA",
    );
    assert.ok(res.ok && res.status === "submitted");
    assert.equal(t.broker.positions.length, 0);
  });

  it("an explicit dry run with Auto OFF stays a plain dry run (no Auto record)", async () => {
    const t = pickSetup({ specs: SPECS(), auto: false });
    await runPickTick(t.deps, t.settings, { dryRun: true });
    assert.equal(t.broker.submitted.length, 0);
    assert.ok(!t.audit.some((a) => /Live Auto is OFF/.test(a.reason)));
  });
});

describe("requireIdle", () => {
  it("treats a broker that throws as unreadable (not idle)", async () => {
    const boom = async () => {
      throw new Error("x");
    };
    const a = await requireIdle({ getPositions: boom, listOpenOrders: async () => ({ ok: true, value: [] }) } as never);
    assert.ok(!a.ok && a.code === "POSITIONS_UNREADABLE");
    const b = await requireIdle({ getPositions: async () => ({ ok: true, value: [] }), listOpenOrders: boom } as never);
    assert.ok(!b.ok && b.code === "ORDERS_UNREADABLE");
  });
});

describe("POST /api/broker/live/auto", () => {
  const BASE = "https://www.polarito.com";
  const ENV_KEYS = ["POLARITO_LIVE_ACCOUNT", "ALPACA_LIVE_KEY_ID", "ALPACA_LIVE_SECRET_KEY", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  let saved: Record<string, string | undefined> = {};
  let realFetch: typeof fetch;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const post = (body: unknown, headers: Record<string, string> = { origin: BASE, host: "www.polarito.com" }) =>
    new Request(`${BASE}/api/broker/live/auto`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }) as unknown as NextRequest;
  const alpaca = { positions: [] as unknown[], orders: [] as unknown[], positionsFail: false, ordersFail: false, calls: [] as Array<{ url: string; method?: string }> };
  const withKv = (initial?: string | null) => {
    process.env.POLARITO_LIVE_ACCOUNT = "1";
    process.env.ALPACA_LIVE_KEY_ID = "LIVEID";
    process.env.ALPACA_LIVE_SECRET_KEY = "LIVESECRET";
    process.env.KV_REST_API_URL = KV.KV_REST_API_URL;
    process.env.KV_REST_API_TOKEN = KV.KV_REST_API_TOKEN;
    alpaca.positions = [];
    alpaca.positionsFail = false;
    alpaca.orders = [];
    alpaca.ordersFail = false;
    alpaca.calls = [];
    const kv = memoryKv(initial);
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.startsWith(KV.KV_REST_API_URL)) return (kv.fetchImpl as unknown as (u: string, i?: unknown) => Promise<Reply>)(url, init);
      alpaca.calls.push({ url, method: init?.method });
      const isOrders = url.includes("/v2/orders");
      if ((isOrders ? alpaca.ordersFail : alpaca.positionsFail) || (!isOrders && !url.endsWith("/v2/positions"))) {
        return { ok: false, status: 500, json: async () => ({ message: "down" }) };
      }
      const data = isOrders ? alpaca.orders : alpaca.positions;
      return { ok: true, status: 200, json: async () => data };
    }) as unknown as typeof fetch;
    return kv;
  };
  const working = (n = 1) =>
    Array.from({ length: n }, (_, i) => ({ id: `o${i}`, client_order_id: `pol-20261120-e0${i + 1}-NVDA`, status: "new", symbol: "NVDA", side: "buy", qty: "1" }));
  const heldNvda = () => [{ symbol: "NVDA", qty: "1", avg_entry_price: "100", side: "long" }];

  it("is in the audit sources", () => {
    assert.ok((AUDIT_SOURCES as readonly string[]).includes("live-auto"));
  });

  it("is behind the session gate like the close route", () => {
    const res = proxy(new NextRequest(`${BASE}/api/broker/live/auto`, { method: "POST" }));
    assert.equal(res.status, 401);
  });

  it("refuses when the live account is not switched on, without touching the network", async () => {
    const kv = withKv();
    delete process.env.POLARITO_LIVE_ACCOUNT;
    const res = await autoPost(post({ auto: true }));
    assert.equal(res.status, 409);
    assert.equal(kv.state.calls.length, 0);
  });

  it("refuses cross-site and malformed requests before writing", async () => {
    const kv = withKv();
    assert.equal((await autoPost(post({ auto: true }, { origin: "https://evil.example", host: "www.polarito.com" }))).status, 403);
    assert.equal((await autoPost(post("nope"))).status, 400);
    assert.equal((await autoPost(post({ auto: "on" }))).status, 400);
    assert.equal((await autoPost(post({}))).status, 400);
    assert.equal(kv.state.calls.length, 0);
  });

  it("without a store it answers 503 and Auto stays OFF", async () => {
    process.env.POLARITO_LIVE_ACCOUNT = "1";
    const res = await autoPost(post({ auto: true }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "NO_STORE");
  });

  it("switches ON then OFF, reporting what the store really holds", async () => {
    const kv = withKv();
    const on = await (await autoPost(post({ auto: true }))).json();
    assert.equal(on.ok, true);
    assert.equal(on.auto.on, true);
    assert.equal(JSON.parse(kv.state.value!).auto, true);
    const off = await (await autoPost(post({ auto: false }))).json();
    assert.equal(off.auto.on, false);
    assert.equal(JSON.parse(kv.state.value!).auto, false);
    assert.doesNotMatch(JSON.stringify([on, off]), /kv-token-value/);
  });

  it("never reports a change the store did not keep", async () => {
    const kv = withKv();
    kv.state.lie = true;
    const res = await autoPost(post({ auto: true }));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).ok, false);
    kv.state.lie = false;
    kv.state.failNext = true;
    assert.equal((await autoPost(post({ auto: true }))).status, 502);
    assert.equal(kv.state.value, null);
  });

  it("refuses OFF while any position is open, server-side, and leaves Auto ON", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.positions = heldNvda();
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "POSITIONS_OPEN");
    assert.match(body.error, /Close all positions first/);
    assert.equal(JSON.parse(kv.state.value!).auto, true);
    assert.ok(!kv.state.calls.some((c) => c.args[0] === "SET"), "nothing was written");
    assert.ok(alpaca.calls.every((c) => c.method === "GET" && c.url.startsWith("https://api.alpaca.markets/")));
  });

  it("an option or off-watchlist position also blocks OFF", async () => {
    withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.positions = [{ symbol: "SPY261120C00600000", qty: "1", avg_entry_price: "1", side: "long", asset_class: "us_option" }];
    assert.equal((await autoPost(post({ auto: false }))).status, 409);
  });

  it("fails closed when positions cannot be read: OFF refused, Auto unchanged", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.positionsFail = true;
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "POSITIONS_UNREADABLE");
    assert.equal(JSON.parse(kv.state.value!).auto, true);
    assert.ok(!kv.state.calls.some((c) => c.args[0] === "SET"));
  });

  it("without live credentials OFF is refused (cannot check positions)", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    delete process.env.ALPACA_LIVE_KEY_ID;
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "NO_BROKER");
    assert.equal(JSON.parse(kv.state.value!).auto, true);
  });

  it("refuses OFF while a working order exists (ORDERS_OPEN), cancels nothing, Auto stays ON", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.orders = working(2);
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ORDERS_OPEN");
    assert.match(body.error, /Cancel or let working orders finish first \(2 working orders open\)/);
    assert.equal(JSON.parse(kv.state.value!).auto, true);
    assert.ok(!kv.state.calls.some((c) => c.args[0] === "SET"));
    assert.ok(alpaca.calls.every((c) => c.method === "GET"), "nothing is cancelled or sent");
  });

  it("with a position and a working order the answer names both, with counts", async () => {
    withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.positions = heldNvda();
    alpaca.orders = working(1);
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "POSITIONS_OPEN");
    assert.match(body.error, /1 position open/);
    assert.match(body.error, /1 working order also open/);
  });

  it("fails closed when orders cannot be read: OFF refused, Auto unchanged", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.ordersFail = true;
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, "ORDERS_UNREADABLE");
    assert.equal(JSON.parse(kv.state.value!).auto, true);
    assert.ok(!kv.state.calls.some((c) => c.args[0] === "SET"));
  });

  it("a malformed order list also fails closed", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.orders = [{ nonsense: true }];
    assert.equal((await autoPost(post({ auto: false }))).status, 502);
    assert.equal(JSON.parse(kv.state.value!).auto, true);
  });

  it("allows OFF only when flat with no working orders, and sends no cancel", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(kv.state.value!).auto, false);
    assert.ok(alpaca.calls.every((c) => c.method === "GET"), "no order is cancelled or sent");
  });

  it("drill: refused with a position or order open, closed or filled/cancelled, then OFF works", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    alpaca.positions = heldNvda();
    assert.equal((await autoPost(post({ auto: false }))).status, 409);
    alpaca.positions = [];
    alpaca.orders = working(1);
    assert.equal((await autoPost(post({ auto: false }))).status, 409);
    alpaca.orders = [];
    assert.equal((await autoPost(post({ auto: false }))).status, 200);
    assert.equal(JSON.parse(kv.state.value!).auto, false);
  });

  it("turning ON is unchanged: no Alpaca call, allowed with positions open", async () => {
    withKv();
    alpaca.positions = heldNvda();
    const res = await autoPost(post({ auto: true }));
    assert.equal(res.status, 200);
    assert.equal(alpaca.calls.length, 0);
  });

  it("restores ON when a working order appears between the check and the write", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    let reads = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      if (String(input).includes("/v2/orders")) {
        reads += 1;
        if (reads === 2) return { ok: true, status: 200, json: async () => working(1) };
      }
      return (inner as unknown as (i: unknown, n?: unknown) => Promise<unknown>)(input, init);
    }) as unknown as typeof fetch;
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ORDERS_OPEN");
    assert.match(body.error, /kept ON/);
    assert.equal(JSON.parse(kv.state.value!).auto, true);
  });

  it("restores ON when a position appears between the check and the write", async () => {
    const kv = withKv(JSON.stringify({ auto: true, at: "x" }));
    let reads = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      if (String(input).endsWith("/v2/positions")) {
        reads += 1;
        if (reads === 2) return { ok: true, status: 200, json: async () => heldNvda() };
      }
      return (inner as unknown as (i: unknown, n?: unknown) => Promise<unknown>)(input, init);
    }) as unknown as typeof fetch;
    const res = await autoPost(post({ auto: false }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /kept ON/);
    assert.equal(JSON.parse(kv.state.value!).auto, true);
  });
});
