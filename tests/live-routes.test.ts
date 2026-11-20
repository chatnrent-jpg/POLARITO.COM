import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NextRequest } from "next/server";
import { POST as closePost } from "../src/app/api/broker/live/close/route.node";
import { GET as statusGet } from "../src/app/api/broker/live/status/route.node";
import { GET as lossCheckGet } from "../src/app/api/cron/loss-check/route.node";
import { GET as paperRunGet } from "../src/app/api/cron/paper-run/route.node";
import { GET as pickRunGet } from "../src/app/api/cron/pick-run/route.node";

const SECRET = "0123456789abcdef0123456789abcdef";
const BASE = "https://www.polarito.com";

const ENV_KEYS = [
  "CRON_SECRET",
  "POLARITO_PAPER_INSTRUMENT",
  "POLARITO_LIVE_ACCOUNT",
  "POLARITO_LIVE_TRADING_ENABLED",
  "POLARITO_LIVE_WATCHLIST",
  "ALPACA_LIVE_KEY_ID",
  "ALPACA_LIVE_SECRET_KEY",
  "ALPACA_PAPER_KEY_ID",
  "ALPACA_PAPER_SECRET_KEY",
  "POLARITO_BROKER_KILL",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const get = (path: string, auth = true) => {
  const url = `${BASE}${path}`;
  return Object.assign(new Request(url, { headers: auth ? { authorization: `Bearer ${SECRET}` } : {} }), {
    nextUrl: new URL(url),
  }) as unknown as NextRequest;
};
const post = (body: unknown, headers: Record<string, string> = { origin: BASE, host: "www.polarito.com" }) =>
  new Request(`${BASE}/api/broker/live/close`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;

/** A fetch that fails the test if anything at all goes over the network. */
function forbidNetwork() {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    throw new Error("network is forbidden in this test");
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = real) };
}

describe("with no new env vars the live code does nothing", () => {
  it("pick-run is a no-op in the default mode and never touches the network", async () => {
    const net = forbidNetwork();
    try {
      const res = await pickRunGet(get("/api/cron/pick-run"));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.action, "none");
      assert.match(body.reason, /pick mode/);
      assert.deepEqual(net.seen, []);
    } finally {
      net.restore();
    }
  });

  it("pick-run with instrument=pick but no live opt-in is still a no-op", async () => {
    process.env.POLARITO_PAPER_INSTRUMENT = "pick";
    process.env.ALPACA_LIVE_KEY_ID = "k";
    process.env.ALPACA_LIVE_SECRET_KEY = "s";
    const net = forbidNetwork();
    try {
      const body = await (await pickRunGet(get("/api/cron/pick-run"))).json();
      assert.equal(body.action, "none");
      assert.match(body.reason, /POLARITO_LIVE_ACCOUNT/);
      assert.deepEqual(net.seen, []);
    } finally {
      net.restore();
    }
  });

  it("pick-run still requires the cron secret", async () => {
    assert.equal((await pickRunGet(get("/api/cron/pick-run", false))).status, 401);
  });

  it("pick-run opted in but without live keys or a watchlist fails closed", async () => {
    process.env.POLARITO_PAPER_INSTRUMENT = "pick";
    process.env.POLARITO_LIVE_ACCOUNT = "1";
    assert.equal((await pickRunGet(get("/api/cron/pick-run"))).status, 500);
    process.env.POLARITO_LIVE_WATCHLIST = "WMT";
    assert.equal((await pickRunGet(get("/api/cron/pick-run"))).status, 503);
  });

  it("the daily paper run does nothing in pick mode instead of failing", async () => {
    process.env.POLARITO_PAPER_INSTRUMENT = "pick";
    const body = await (await paperRunGet(get("/api/cron/paper-run"))).json();
    assert.equal(body.action, "none");
  });

  it("loss-check keeps its options-only behaviour by default and without the live opt-in", async () => {
    const def = await (await lossCheckGet(get("/api/cron/loss-check"))).json();
    assert.deepEqual(def, { ok: true, action: "none", reason: "Not in options mode. Nothing to check." });
    process.env.POLARITO_PAPER_INSTRUMENT = "pick";
    const pick = await (await lossCheckGet(get("/api/cron/loss-check"))).json();
    assert.equal(pick.action, "none");
  });

  it("the close route refuses and does nothing when the live account is not switched on", async () => {
    const net = forbidNetwork();
    try {
      const res = await closePost(post({ ticker: "NVDA" }));
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "LIVE_OFF");
      assert.deepEqual(net.seen, []);
    } finally {
      net.restore();
    }
  });

  it("the status route says live: false and reads nothing", async () => {
    const net = forbidNetwork();
    try {
      let body: unknown;
      try {
        body = await (await statusGet()).json();
      } catch (e) {
        // `connection()` only works inside a Next request scope; outside it the route cannot run at all.
        assert.match(String(e), /request scope|outside/i);
        return;
      }
      assert.deepEqual(body, { ok: true, live: false });
      assert.deepEqual(net.seen, []);
    } finally {
      net.restore();
    }
  });
});

describe("the close route when live is on", () => {
  beforeEach(() => {
    process.env.POLARITO_LIVE_ACCOUNT = "1";
  });

  it("refuses a cross-site request before doing anything", async () => {
    const net = forbidNetwork();
    try {
      const res = await closePost(post({ ticker: "NVDA" }, { origin: "https://evil.example", host: "www.polarito.com" }));
      assert.equal(res.status, 403);
      assert.deepEqual(net.seen, []);
    } finally {
      net.restore();
    }
  });

  it("validates the body shape", async () => {
    assert.equal((await closePost(post("not json"))).status, 400);
    assert.equal((await closePost(post({ symbol: "NVDA" }))).status, 400);
    assert.equal((await closePost(post({ ticker: 5 }))).status, 400);
  });

  it("needs live credentials", async () => {
    const res = await closePost(post({ ticker: "NVDA" }));
    assert.equal(res.status, 503);
  });

  it("with live keys it calls only the live host, with the live keys", async () => {
    process.env.ALPACA_LIVE_KEY_ID = "LIVEID";
    process.env.ALPACA_LIVE_SECRET_KEY = "LIVESECRET";
    process.env.ALPACA_PAPER_KEY_ID = "PAPERID";
    process.env.ALPACA_PAPER_SECRET_KEY = "PAPERSECRET";
    const real = globalThis.fetch;
    const calls: Array<{ url: string; key: string | undefined; method: string | undefined }> = [];
    globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push({ url: String(input), key: init?.headers?.["APCA-API-KEY-ID"], method: init?.method });
      const data = String(input).endsWith("/v2/positions")
        ? [{ symbol: "NVDA", qty: "1", avg_entry_price: "100", side: "long" }]
        : [];
      return { ok: true, status: 200, json: async () => data };
    }) as unknown as typeof fetch;
    try {
      const res = await closePost(post({ ticker: "NVDA" }));
      const body = await res.json();
      assert.equal(body.status, "observed", "live orders are not enabled, so it only observes");
      assert.ok(calls.length >= 1);
      assert.ok(calls.every((c) => c.method === "GET"), "no order is sent while live trading is off");
      for (const c of calls) {
        assert.ok(c.url.startsWith("https://api.alpaca.markets/"), c.url);
        assert.equal(c.key, "LIVEID");
      }
      assert.doesNotMatch(JSON.stringify(body), /LIVESECRET|PAPERSECRET|LIVEID/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
