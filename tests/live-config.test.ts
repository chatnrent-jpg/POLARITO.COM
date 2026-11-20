import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALPACA_LIVE_BASE_URL,
  ALPACA_PAPER_BASE_URL,
  AlpacaPaperBroker,
  type FetchLike,
} from "../src/lib/broker/alpacaPaper";
import { tradingGate } from "../src/lib/broker/config";
import {
  createLiveBroker,
  liveBrokerConfig,
  liveCredentials,
  liveOptedIn,
  liveSettings,
} from "../src/lib/broker/liveConfig";
import { sameOriginRequest } from "../src/lib/sameOrigin";

const WATCH = "AAPL,MSFT,NVDA,AMZN,AVGO,GOOGL,GOOG,TSLA,JPM,WMT";

type Call = { url: string; method: string; headers: Record<string, string> };
function recorder(status: number, data: unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    return { ok: status < 400, status, json: async () => data };
  }) as FetchLike;
  return { calls, fetchImpl };
}

describe("live is off unless explicitly opted in", () => {
  it("builds no live broker with no env vars, with keys but no opt-in, or with opt-in but no keys", () => {
    assert.equal(liveOptedIn({}), false);
    assert.equal(createLiveBroker({}), null);
    assert.equal(createLiveBroker({ ALPACA_LIVE_KEY_ID: "k", ALPACA_LIVE_SECRET_KEY: "s" }), null);
    assert.equal(createLiveBroker({ POLARITO_LIVE_ACCOUNT: "1" }), null);
    assert.equal(createLiveBroker({ POLARITO_LIVE_ACCOUNT: "true", ALPACA_LIVE_KEY_ID: "k", ALPACA_LIVE_SECRET_KEY: "s" }), null);
  });

  it("opt-in alone never enables orders; the enable switch must be exactly 1", () => {
    const env = { POLARITO_LIVE_ACCOUNT: "1", ALPACA_LIVE_KEY_ID: "k", ALPACA_LIVE_SECRET_KEY: "s" };
    assert.ok(createLiveBroker(env));
    const gate = tradingGate(liveBrokerConfig(env));
    assert.equal(gate.ok, false);
    assert.equal(!gate.ok && gate.code, "DISABLED");
    assert.equal(tradingGate(liveBrokerConfig({ ...env, POLARITO_LIVE_TRADING_ENABLED: "true" })).ok, false);
    assert.equal(tradingGate(liveBrokerConfig({ ...env, POLARITO_LIVE_TRADING_ENABLED: "1" })).ok, true);
  });

  it("the paper enable switch and paper keys never switch live on", () => {
    const env = { POLARITO_PAPER_TRADING_ENABLED: "1", ALPACA_PAPER_KEY_ID: "pk", ALPACA_PAPER_SECRET_KEY: "ps" };
    assert.equal(liveCredentials(env), null);
    assert.equal(createLiveBroker(env), null);
    const cfg = liveBrokerConfig(env);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.configured, false);
  });

  it("the kill switch stops live orders too", () => {
    const env = { POLARITO_LIVE_TRADING_ENABLED: "1", ALPACA_LIVE_KEY_ID: "k", ALPACA_LIVE_SECRET_KEY: "s", POLARITO_BROKER_KILL: "1" };
    const gate = tradingGate(liveBrokerConfig(env));
    assert.equal(!gate.ok && gate.code, "KILLED");
  });
});

describe("the adapter only reaches the live host when built for it", () => {
  it("defaults to paper and keeps the paper wording", async () => {
    const r = recorder(500, { message: "boom" });
    const b = new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl: r.fetchImpl });
    const res = await b.getAccount();
    assert.ok(r.calls[0].url.startsWith(`${ALPACA_PAPER_BASE_URL}/`));
    assert.equal(res.ok, false);
    assert.match(!res.ok ? res.error : "", /Alpaca paper API returned 500/);
  });

  it("createLiveBroker's broker calls the live host with the LIVE keys", async () => {
    const r = recorder(200, { symbol: "WMT", status: "active", tradable: true, shortable: true, borrow_status: "easy_to_borrow" });
    const env = { POLARITO_LIVE_ACCOUNT: "1", ALPACA_LIVE_KEY_ID: "live-id", ALPACA_LIVE_SECRET_KEY: "live-secret", ALPACA_PAPER_KEY_ID: "paper-id", ALPACA_PAPER_SECRET_KEY: "paper-secret" };
    const creds = liveCredentials(env);
    assert.ok(creds);
    const b = new AlpacaPaperBroker({ ...creds, target: "live", fetchImpl: r.fetchImpl });
    const asset = await b.getAsset("WMT");
    assert.equal(r.calls[0].url, `${ALPACA_LIVE_BASE_URL}/v2/assets/WMT`);
    assert.equal(ALPACA_LIVE_BASE_URL, "https://api.alpaca.markets");
    assert.equal(r.calls[0].headers["APCA-API-KEY-ID"], "live-id");
    assert.equal(r.calls[0].headers["APCA-API-SECRET-KEY"], "live-secret");
    assert.deepEqual(asset, { ok: true, value: { symbol: "WMT", status: "active", tradable: true, shortable: true, borrowStatus: "easy_to_borrow" } });
  });

  it("live errors say live and never include the keys", async () => {
    const r = recorder(403, { message: "forbidden" });
    const b = new AlpacaPaperBroker({ keyId: "LIVEKEYID", secretKey: "LIVESECRET", target: "live", fetchImpl: r.fetchImpl });
    const res = await b.getPositions();
    assert.equal(res.ok, false);
    const text = JSON.stringify(res);
    assert.match(text, /Alpaca live API returned 403/);
    assert.doesNotMatch(text, /LIVEKEYID|LIVESECRET/);
  });

  it("an unknown target value falls back to paper", async () => {
    const r = recorder(200, []);
    const b = new AlpacaPaperBroker({ keyId: "k", secretKey: "s", target: "prod" as never, fetchImpl: r.fetchImpl });
    await b.getPositions();
    assert.ok(r.calls[0].url.startsWith(ALPACA_PAPER_BASE_URL));
  });

  it("reads shorting_enabled and multiplier when present and ignores them when malformed", async () => {
    const acct = { status: "ACTIVE", trading_blocked: false, account_blocked: false, equity: "1000", last_equity: "1000", cash: "1000", buying_power: "1000" };
    const ok = recorder(200, { ...acct, shorting_enabled: true, multiplier: "2" });
    const a = await new AlpacaPaperBroker({ keyId: "k", secretKey: "s", target: "live", fetchImpl: ok.fetchImpl }).getAccount();
    assert.ok(a.ok);
    assert.equal(a.ok && a.value.shortingEnabled, true);
    assert.equal(a.ok && a.value.multiplier, 2);
    const bad = recorder(200, { ...acct, shorting_enabled: "yes", multiplier: "x" });
    const b = await new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl: bad.fetchImpl }).getAccount();
    assert.ok(b.ok);
    assert.equal(b.ok && b.value.shortingEnabled, undefined);
    assert.equal(b.ok && b.value.multiplier, undefined);
    const plain = recorder(200, acct);
    const c = await new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl: plain.fetchImpl }).getAccount();
    assert.ok(c.ok);
    assert.equal(c.ok && "shortingEnabled" in c.value, false);
  });

  it("lists today's orders and open orders, refusing a malformed list", async () => {
    const order = { id: "1", client_order_id: "pol-20261119-e01-WMT", status: "filled", symbol: "WMT", side: "buy", qty: "1" };
    const r = recorder(200, [order]);
    const b = new AlpacaPaperBroker({ keyId: "k", secretKey: "s", target: "live", fetchImpl: r.fetchImpl });
    const since = await b.listOrdersSince("2026-11-18T12:00:00Z");
    assert.ok(since.ok);
    assert.match(r.calls[0].url, /^https:\/\/api\.alpaca\.markets\/v2\/orders\?status=all&limit=500&direction=asc&after=2026-11-18T12%3A00%3A00\.000Z$/);
    const open = await b.listOpenOrders();
    assert.ok(open.ok);
    assert.match(r.calls[1].url, /\/v2\/orders\?status=open&limit=500&direction=asc$/);
    const bad = await new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl: recorder(200, [{ nope: 1 }]).fetchImpl }).listOpenOrders();
    assert.equal(bad.ok, false);
    const noTime = await b.listOrdersSince("not a date");
    assert.equal(noTime.ok, false);
  });

  it("getAsset: 404 is null, a malformed body is refused", async () => {
    const nf = await new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl: recorder(404, { message: "no" }).fetchImpl }).getAsset("ZZZ");
    assert.deepEqual(nf, { ok: true, value: null });
    const bad = await new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl: recorder(200, { symbol: "X" }).fetchImpl }).getAsset("X");
    assert.equal(bad.ok, false);
  });
});

describe("liveSettings", () => {
  it("needs the live-only watchlist and ignores the paper one", () => {
    assert.equal(liveSettings({}).ok, false);
    assert.equal(liveSettings({ POLARITO_PAPER_WATCHLIST: WATCH }).ok, false);
  });

  it("parses Henry's ten names and applies the decided defaults", () => {
    const r = liveSettings({ POLARITO_LIVE_WATCHLIST: WATCH });
    assert.ok(r.ok);
    assert.deepEqual(r.settings.watchlist, WATCH.split(","));
    assert.equal(r.settings.quantity, 1);
    assert.equal(r.settings.maxPositionPct, 50);
    assert.equal(r.settings.dailyLossPct, 1);
    assert.equal("maxEntries" in r.settings, false, "there is no daily entry cap");
    assert.equal(r.settings.pickStartMinutes, 600);
    assert.equal(r.settings.flattenAtMinutes, 15 * 60 + 55);
    assert.equal(r.settings.longOnlyFallback, "aside");
  });

  it("rejects an eleventh name and a bad ticker", () => {
    assert.equal(liveSettings({ POLARITO_LIVE_WATCHLIST: `${WATCH},META` }).ok, false);
    assert.equal(liveSettings({ POLARITO_LIVE_WATCHLIST: "AAPL,12$" }).ok, false);
  });

  it("a bad stop value falls back to 1% instead of loosening it", () => {
    for (const bad of ["abc", "0", "11", "-1", ""]) {
      const r = liveSettings({ POLARITO_LIVE_WATCHLIST: "WMT", POLARITO_LIVE_DAILY_LOSS_PCT: bad });
      assert.ok(r.ok);
      assert.equal(r.settings.dailyLossPct, 1, bad);
    }
    const r = liveSettings({ POLARITO_LIVE_WATCHLIST: "WMT", POLARITO_LIVE_DAILY_LOSS_PCT: "0.5" });
    assert.ok(r.ok && r.settings.dailyLossPct === 0.5);
  });

  it("validates the other knobs and allows holding overnight", () => {
    const base = { POLARITO_LIVE_WATCHLIST: "WMT" };
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_QTY: "0" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_MAX_POSITION_PCT: "150" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_MAX_ENTRIES: "1" }).ok, true, "the old cap variable is ignored");
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_PICK_START: "9:00" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_PICK_START: "ten" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_FLATTEN_AT: "17:00" }).ok, false);
    assert.equal(liveSettings({ ...base, POLARITO_LIVE_LONG_ONLY_FALLBACK: "maybe" }).ok, false);
    const hold = liveSettings({ ...base, POLARITO_LIVE_FLATTEN_AT: "off", POLARITO_LIVE_LONG_ONLY_FALLBACK: "next" });
    assert.ok(hold.ok);
    assert.equal(hold.settings.flattenAtMinutes, null);
    assert.equal(hold.settings.longOnlyFallback, "next");
  });
});

describe("sameOriginRequest", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  it("accepts a same-origin browser POST and refuses anything else", () => {
    assert.equal(sameOriginRequest(h({ origin: "https://www.polarito.com", host: "www.polarito.com" })), true);
    assert.equal(sameOriginRequest(h({ origin: "https://evil.example", host: "www.polarito.com" })), false);
    assert.equal(sameOriginRequest(h({ "sec-fetch-site": "cross-site", origin: "https://www.polarito.com", host: "www.polarito.com" })), false);
    assert.equal(sameOriginRequest(h({ host: "www.polarito.com" })), false);
    assert.equal(sameOriginRequest(h({ "sec-fetch-site": "same-origin", host: "www.polarito.com" })), true);
    assert.equal(sameOriginRequest(h({ origin: "not a url", host: "x" })), false);
  });
});
