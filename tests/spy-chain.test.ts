import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReadOnlyClient, isAllowedReadPath, type ReadOnlyFetch } from "../src/lib/alpacaReadOnly";
import { bsPrice } from "../src/lib/optionsSelect";
import { daysBetween } from "../src/lib/broker/options";
import { newYorkDate, parseAccountSummary, readAccount, readSide, readSpot } from "../src/lib/spyChain";
import { renderChainReport } from "../src/lib/spyChainReport";

const TODAY = "2026-11-20";
const NOW = new Date("2026-11-20T20:00:00Z");
const SPOT = 690;
const SECRET = "SUPER-SECRET-VALUE-123";

type Call = { url: string; method: string };

const occ = (exp: string, type: "C" | "P", strike: number) => `SPY${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${type}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function snapshotFor(exp: string, type: "call" | "put", strike: number) {
  const mid = bsPrice(type, SPOT, strike, daysBetween(TODAY, exp) / 365, 0.27);
  return [occ(exp, type === "call" ? "C" : "P", strike), { latestQuote: { bp: Number((mid * 0.998).toFixed(2)), ap: Number((mid * 1.002).toFixed(2)), t: "2026-11-20T19:59:00Z" } }] as const;
}

function makeFetch(calls: Call[]): ReadOnlyFetch {
  return async (url, init) => {
    calls.push({ url, method: init.method });
    const u = new URL(url);
    if (u.host === "api.alpaca.markets" && u.pathname === "/v2/account") {
      return json(200, { id: "acct-id-should-not-leak", account_number: "PA123456789", status: "ACTIVE", trading_blocked: false, account_blocked: false, equity: "1000.00", cash: "1000.00", buying_power: "1000.00", options_buying_power: "1000.00", options_approved_level: 2, options_trading_level: 2, multiplier: "1" });
    }
    if (u.pathname === "/v2/stocks/SPY/trades/latest") {
      return u.searchParams.get("feed") === "sip" ? json(403, { message: "subscription does not permit querying recent SIP data" }) : json(200, { trade: { p: 690, t: "2026-11-20T20:59:00Z" } });
    }
    if (u.pathname === "/v2/options/contracts") {
      const type = u.searchParams.get("type") === "put" ? "put" : "call";
      const exps = ["2027-06-17", "2027-11-19", "2027-12-17", "2028-01-21"]; // 2027-11-19 is 364 days out
      return json(200, { option_contracts: exps.map((e) => ({ symbol: occ(e, type === "call" ? "C" : "P", 500), expiration_date: e, tradable: true })), next_page_token: null });
    }
    if (u.pathname === "/v1beta1/options/snapshots/SPY") {
      const exp = u.searchParams.get("expiration_date") ?? "";
      const type = u.searchParams.get("type") === "put" ? "put" : "call";
      const strikes = type === "call" ? [450, 480, 500, 520, 560, 600, 650, 690] : [690, 750, 800, 850, 900, 950, 1000];
      return json(200, { snapshots: Object.fromEntries(strikes.map((k) => snapshotFor(exp, type, k))), next_page_token: null });
    }
    return json(404, { message: "not found" });
  };
}

describe("read-only client", () => {
  it("allows only the four read paths", () => {
    assert.ok(isAllowedReadPath("trading-live", "/v2/account"));
    assert.ok(isAllowedReadPath("trading-paper", "/v2/options/contracts"));
    assert.ok(isAllowedReadPath("data", "/v2/stocks/SPY/trades/latest"));
    assert.ok(isAllowedReadPath("data", "/v1beta1/options/snapshots/SPY"));
    for (const bad of ["/v2/orders", "/v2/orders/abc", "/v2/positions", "/v2/positions/SPY", "/v2/account/configurations", "/v2/account/../orders"]) {
      assert.equal(isAllowedReadPath("trading-live", bad), false, bad);
    }
    assert.equal(isAllowedReadPath("data", "/v2/orders"), false);
  });

  it("refuses an order path before any request is made", async () => {
    const calls: Call[] = [];
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: makeFetch(calls) });
    const res = await client.get("trading-live", "/v2/orders", { symbol: "SPY" });
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0);
  });

  it("only ever sends GET and never puts the secret in a URL or an error", async () => {
    const calls: Call[] = [];
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: makeFetch(calls) });
    await readAccount(client, "trading-live");
    const bad = await client.get("data", "/v2/stocks/SPY/trades/latest", { feed: "sip" });
    assert.equal(bad.ok, false);
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.equal(c.method, "GET");
      assert.ok(!c.url.includes(SECRET));
    }
    if (!bad.ok) assert.ok(!bad.error.includes(SECRET));
  });

  it("turns a thrown fetch into a clean NETWORK error", async () => {
    const client = createReadOnlyClient({
      keyId: "k",
      secretKey: SECRET,
      fetchImpl: async () => {
        throw new Error(`boom ${SECRET}`);
      },
    });
    const res = await client.get("trading-live", "/v2/account");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "NETWORK");
      assert.ok(!res.error.includes(SECRET));
    }
  });

  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const client = createReadOnlyClient({
      keyId: "k",
      secretKey: SECRET,
      sleep: async () => {},
      fetchImpl: async () => (++n < 3 ? json(429, { message: "slow down" }) : json(200, { status: "ACTIVE" })),
    });
    const res = await client.get("trading-live", "/v2/account");
    assert.ok(res.ok);
    assert.equal(n, 3);
  });
});

describe("account summary", () => {
  it("keeps only the needed fields (no id, no account number)", () => {
    const s = parseAccountSummary({ id: "x", account_number: "PA1", status: "ACTIVE", equity: "1000", cash: "900.5", buying_power: "1800", options_buying_power: "900.5", options_approved_level: 2, options_trading_level: 1, multiplier: "2" });
    assert.ok(s);
    assert.equal(s.optionsApprovedLevel, 2);
    assert.equal(s.optionsTradingLevel, 1);
    assert.equal(s.cash, 900.5);
    assert.ok(!JSON.stringify(s).includes("PA1"));
    assert.equal(parseAccountSummary({ foo: 1 }), null);
  });
});

describe("chain read end to end (fake Alpaca)", () => {
  it("falls back from sip to iex for the price, applies both rules, and sends only GETs", async () => {
    const calls: Call[] = [];
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: makeFetch(calls) });
    const spot = await readSpot(client, "SPY", ["sip", "iex"]);
    assert.ok(spot.ok);
    assert.equal(spot.value.feed, "iex");
    const opts = { symbol: "SPY", today: TODAY, now: NOW, spot: spot.value.price, optionsFeed: "indicative", contractsHost: "trading-live" as const };
    const call = await readSide(client, "call", opts);
    const put = await readSide(client, "put", opts);
    assert.ok(call.pick.ok, call.pick.ok ? "" : call.pick.reason);
    assert.ok(put.pick.ok, put.pick.ok ? "" : put.pick.reason);
    // 2027-11-19 is 364 days out and must be skipped; the nearest listed expiry at least 365 days out is 2027-12-17.
    assert.equal(call.pick.expiration, "2027-12-17");
    assert.equal(put.pick.expiration, "2027-12-17");
    assert.ok(call.pick.daysToExpiry >= 365 && put.pick.daysToExpiry >= 365);
    assert.ok(call.pick.row.delta >= 0.8);
    assert.ok(put.pick.row.delta <= -0.8);
    assert.equal(call.pick.row.deltaSource, "black-scholes");
    for (const c of calls) {
      assert.equal(c.method, "GET");
      assert.ok(!/orders|positions/.test(c.url));
    }
    assert.ok(newYorkDate(NOW) === TODAY);

    const report = renderChainReport({
      generatedAt: NOW.toISOString(),
      today: TODAY,
      spot: spot.value,
      accountHost: "live",
      account: { status: "ACTIVE", tradingBlocked: false, accountBlocked: false, equity: 1000, cash: 1000, buyingPower: 1000, optionsBuyingPower: 1000, optionsApprovedLevel: 2, optionsTradingLevel: 2, multiplier: 1 },
      accountError: null,
      optionsFeed: "indicative",
      liveBudget: 1000,
      call,
      put,
      model: { rate: 0.043, dividendYield: 0.012 },
    });
    assert.match(report, /NOT affordable/);
    assert.match(report, /CANNOT afford one contract/);
    assert.match(report, /2027-12-17/);
    assert.match(report, /computed with Black-Scholes/);
    assert.ok(!report.includes(SECRET));
    assert.ok(!report.includes("PA123456789"));
  });

  it("says NO CONTRACT instead of substituting when no listed expiry is at least 365 days out", async () => {
    const client = createReadOnlyClient({
      keyId: "k",
      secretKey: SECRET,
      fetchImpl: async (url) => {
        const u = new URL(url);
        if (u.pathname === "/v2/options/contracts") {
          return json(200, { option_contracts: [{ symbol: occ("2027-06-17", "C", 500), expiration_date: "2027-06-17", tradable: true }] });
        }
        return json(200, { snapshots: {} });
      },
    });
    const side = await readSide(client, "call", { symbol: "SPY", today: TODAY, now: NOW, spot: SPOT, optionsFeed: "indicative", contractsHost: "trading-live" });
    assert.equal(side.pick.ok, false);
  });
});
