import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AlpacaPaperBroker, type FetchLike } from "../src/lib/broker/alpacaPaper";

const root = join(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const rel = (f: string) => f.slice(root.length + 1);
const sources = [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter((f) => /\.(ts|tsx|mjs)$/.test(f));

describe("the repository contains no order-sending code", () => {
  it("nothing defines or calls an order submit, cancel or replace function", () => {
    const offenders = sources.filter((f) => /submitMarketOrder|submitOptionOrder|placeIntent|placeLive|placeOption|cancelOrder|replaceOrder|closePosition\(/.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders.map(rel), []);
  });

  it("the Alpaca adapter has no POST, DELETE, PATCH or PUT and no order body fields", () => {
    const src = readFileSync(join(root, "src/lib/broker/alpacaPaper.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /"POST"|"DELETE"|"PATCH"|"PUT"|time_in_force|client_order_id:|position_intent|limit_price|body:/);
    assert.match(src, /method: "GET"/);
  });

  it("the only POSTs left are the key-value store and the browser's calls to the dry-run desk routes", () => {
    const posting = sources.filter((f) => /method:\s*"POST"/.test(readFileSync(f, "utf8"))).map(rel).sort();
    assert.deepEqual(posting, ["src/components/spy/SpyDesk.tsx", "src/lib/liveAutoStore.ts", "src/lib/spyDeskStore.ts"]);
    assert.match(readFileSync(join(root, "src/lib/spyDeskStore.ts"), "utf8"), /KV_REST_API|autoStoreCredentials/);
    assert.match(readFileSync(join(root, "src/lib/liveAutoStore.ts"), "utf8"), /KV_REST_API/);
  });

  it("no source file sends to the Alpaca order endpoint except as a GET read", () => {
    for (const f of sources) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\/v2\/orders[^`"']*/g)) {
        assert.ok(f.endsWith("alpacaPaper.ts") || f.endsWith("alpacaReadOnly.ts"), `${rel(f)} mentions ${m[0]}`);
      }
    }
  });
});

describe("the example environment ships the live switches off", () => {
  const env = readFileSync(join(root, ".env.example"), "utf8");
  const active = env.split("\n").filter((l) => /^[A-Z]/.test(l));

  it("no live opt-in, live trading or paper trading variable is set to on in .env.example", () => {
    assert.ok(!active.some((l) => /^POLARITO_LIVE_TRADING_ENABLED=/.test(l) || /^POLARITO_LIVE_ACCOUNT=/.test(l)));
    assert.ok(active.includes("POLARITO_PAPER_TRADING_ENABLED=0"));
    assert.ok(active.includes("POLARITO_BROKER_KILL=0"));
  });

  it("the removed runner, watchlist and cron variables are gone from the example", () => {
    assert.doesNotMatch(env, /CRON_SECRET|POLARITO_PAPER_(INSTRUMENT|WATCHLIST|QTY|SIZING|RISK_PCT)|POLARITO_MIRROR_|POLARITO_OPTIONS_|POLARITO_LIVE_(WATCHLIST|QTY|MAX_POSITION_PCT|DAILY_LOSS_PCT|PICK_START|FLATTEN_AT|LONG_ONLY_FALLBACK)|NEXT_PUBLIC_[A-Z]/);
  });
});

describe("the Alpaca adapter can only read", () => {
  it("every method it has sends GET without a body, on both the paper and the live target", async () => {
    for (const target of ["paper", "live"] as const) {
      const seen: Array<{ method: string; body?: string }> = [];
      const fetchImpl: FetchLike = async (_url, init) => {
        seen.push({ method: init.method, body: init.body });
        return { ok: true, status: 200, json: async () => ({}) };
      };
      const b = new AlpacaPaperBroker({ keyId: "k", secretKey: "s", target, fetchImpl });
      await b.getAccount();
      await b.getPositions();
      await b.getOrderByClientId("cid");
      await b.openOrderCount("SPY");
      await b.getAsset("SPY");
      await b.listOrdersSince("2026-11-19T00:00:00Z");
      await b.listOpenOrders();
      await b.listContracts({ underlying: "SPY", type: "put", expiresFrom: "2027-11-19", expiresTo: "2028-01-19", strikeLow: 500, strikeHigh: 700 });
      await b.getOptionQuote("SPY271217P00600000");
      assert.ok(seen.length >= 9, target);
      assert.deepEqual([...new Set(seen.map((s) => s.method))], ["GET"], target);
      assert.ok(seen.every((s) => s.body === undefined), target);
    }
  });

  it("has no method that creates, changes or cancels an order", () => {
    const names = Object.getOwnPropertyNames(AlpacaPaperBroker.prototype);
    assert.deepEqual(names.filter((n) => /submit|place|cancel|replace|close|create|send/i.test(n)), []);
  });
});
