import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NextRequest } from "next/server";
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

});
