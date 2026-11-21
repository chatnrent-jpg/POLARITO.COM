import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReadOnlyClient, isAllowedReadPath, type ReadOnlyFetch } from "../src/lib/alpacaReadOnly";
import { bsPrice } from "../src/lib/optionsSelect";
import { daysBetween } from "../src/lib/broker/options";
import { newYorkDate, parseAccountSummary, readAccount, readSide, readSpot, strikeRange, type AccountSummary } from "../src/lib/spyChain";
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
  it("allows only the five read paths", () => {
    assert.ok(isAllowedReadPath("trading-live", "/v2/account"));
    assert.ok(isAllowedReadPath("trading-paper", "/v2/options/contracts"));
    assert.ok(isAllowedReadPath("data", "/v2/stocks/SPY/trades/latest"));
    assert.ok(isAllowedReadPath("data", "/v2/stocks/bars"));
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
      account: { status: "ACTIVE", tradingBlocked: false, accountBlocked: false, equity: 1000, cash: 1000, buyingPower: 1000, optionsBuyingPower: 1000, optionsApprovedLevel: 2, optionsTradingLevel: 2, multiplier: 1, optionsFieldsSeen: ["options_approved_level", "options_buying_power", "options_trading_level"] },
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

/** A fake chain that honours the requested strike window, with chosen strikes per expiry. */
function windowFetch(calls: Call[], strikesFor: (exp: string, type: "call" | "put") => number[], opts: { contractsForever?: boolean } = {}): ReadOnlyFetch {
  return async (url, init) => {
    calls.push({ url, method: init.method });
    const u = new URL(url);
    const type = u.searchParams.get("type") === "put" ? "put" : "call";
    if (u.pathname === "/v2/options/contracts") {
      const exps = ["2027-11-19", "2027-12-17", "2028-01-21"];
      return json(200, { option_contracts: exps.map((e) => ({ symbol: occ(e, type === "call" ? "C" : "P", 500), expiration_date: e, tradable: true })), next_page_token: opts.contractsForever ? "more" : null });
    }
    if (u.pathname === "/v1beta1/options/snapshots/SPY") {
      const lo = Number(u.searchParams.get("strike_price_gte") ?? 0);
      const hi = Number(u.searchParams.get("strike_price_lte") ?? Number.POSITIVE_INFINITY);
      const exp = u.searchParams.get("expiration_date") ?? "";
      const strikes = strikesFor(exp, type).filter((k) => k >= lo && k <= hi);
      return json(200, { snapshots: Object.fromEntries(strikes.map((k) => snapshotFor(exp, type, k))), next_page_token: null });
    }
    return json(404, { message: "not found" });
  };
}
const SIDE_OPTS = { symbol: "SPY", today: TODAY, now: NOW, spot: SPOT, optionsFeed: "indicative", contractsHost: "trading-live" as const };

describe("put strike window and what the report shows", () => {
  it("the put window reaches at least 3x the price, the call window stays below the price", () => {
    assert.ok(strikeRange("put", 690).high >= 690 * 3);
    assert.equal(strikeRange("put", 690).low, 690);
    assert.equal(strikeRange("call", 690).high, 690);
    assert.equal(strikeRange("call", 690).low, 345);
  });
  it("a deep-in-the-money put far above the old 1.7x window is found (and its delta rule still applies)", async () => {
    const calls: Call[] = [];
    // Only the 1300 strike (1.9x the price, beyond the old window) has |delta| >= 0.80 here; 690..800 are far below the rule.
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: windowFetch(calls, () => [690, 750, 800, 1300]) });
    const put = await readSide(client, "put", SIDE_OPTS);
    assert.ok(put.pick.ok, put.pick.ok ? "" : put.pick.reason);
    assert.equal(put.pick.row.strike, 1300);
    assert.ok(put.pick.row.delta <= -0.8);
    assert.equal(put.pick.expiration, "2027-12-17");
    assert.ok(put.pick.daysToExpiry >= 365);
    const snapshotCalls = calls.filter((c) => c.url.includes("/snapshots/"));
    assert.ok(snapshotCalls.every((c) => Number(new URL(c.url).searchParams.get("strike_price_lte")) >= 690 * 3));
    assert.equal(put.strikesRead.max, 1300);
  });
  it("no strike reaches 0.80: the best usable delta at or above the 0.60 floor is picked, marked as a fallback, with the reason", async () => {
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: windowFetch([], () => [690, 700, 850]) });
    const put = await readSide(client, "put", SIDE_OPTS);
    assert.ok(put.pick.ok, put.pick.ok ? "" : put.pick.reason);
    assert.equal(put.pick.tier, "fallback");
    assert.equal(put.pick.row.strike, 850);
    assert.ok(Math.abs(put.pick.row.delta) >= 0.6 && Math.abs(put.pick.row.delta) < 0.8);
    assert.equal(put.pick.expiration, "2027-12-17");
    assert.ok(put.pick.daysToExpiry >= 365);
    assert.equal(put.later.length, 0);
    const call = await readSide(createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: windowFetch([], () => [450, 500]) }), "call", SIDE_OPTS);
    assert.equal(call.pick.ok && call.pick.tier, "primary");
    const report = renderChainReport({ generatedAt: NOW.toISOString(), today: TODAY, spot: { price: SPOT, at: NOW.toISOString(), feed: "iex" }, accountHost: null, account: null, accountError: "x", optionsFeed: "indicative", liveBudget: 1000, call, put, model: { rate: 0.043, dividendYield: 0.012 } });
    assert.match(report, /FALLBACK DELTA \(below 0\.80\)/);
    assert.match(report, /the actual delta is -0\.\d{3}, below the 0\.8 target/);
    assert.match(report, /no 2027-12-17 put reaches \|delta\| 0\.8 with a usable quote/);
    assert.match(report, /Floor 0\.6 is never crossed/);
    assert.match(report, /picked the CHEAPEST usable contract at or above the 0\.6 floor/);
    assert.match(report, /One put \(at least 365 days\): \*\*FALLBACK DELTA \(below 0\.80\)\*\*/);
    assert.match(report, /One call \(delta >= 0\.8, at least 365 days\)/);
  });
  it("below the 0.60 floor there is no contract, the report shows the highest delta found, and nothing is substituted", async () => {
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: windowFetch([], () => [690, 700, 750]) });
    const put = await readSide(client, "put", SIDE_OPTS);
    assert.equal(put.pick.ok, false);
    assert.ok(put.highestAbsDelta);
    assert.ok(Math.abs(put.highestAbsDelta.delta) < 0.6);
    assert.equal(put.highestAbsDelta.strike, 750);
    assert.equal(put.ladder[0].strike, 750); // closest to the rule first, not the lowest delta first
    const report = renderChainReport({ generatedAt: NOW.toISOString(), today: TODAY, spot: { price: SPOT, at: NOW.toISOString(), feed: "iex" }, accountHost: null, account: null, accountError: "x", optionsFeed: "indicative", liveBudget: 1000, call: put, put, model: { rate: 0.043, dividendYield: 0.012 } });
    assert.match(report, /Highest \|delta\| found: strike 750/);
    assert.match(report, /does not qualify: \|delta\|/);
    assert.match(report, /strike window requested 690 to 2070; 3 usable quotes read at the chosen expiry, strikes 690 to 750/);
    assert.match(report, /NO CONTRACT/);
    assert.doesNotMatch(report, /FALLBACK DELTA \(below 0\.80\)\*\*:/);
  });
  it("later expiries are shown as information only and are never substituted", async () => {
    const calls: Call[] = [];
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: windowFetch(calls, (exp) => (exp === "2027-12-17" ? [690, 700, 750] : [690, 800, 1300])) });
    const put = await readSide(client, "put", SIDE_OPTS);
    assert.equal(put.pick.ok, false);
    assert.equal(put.pick.expiration, "2027-12-17");
    assert.deepEqual(put.later.map((l) => l.expiration), ["2028-01-21"]);
    assert.ok(put.later.every((l) => l.daysToExpiry >= 365));
    assert.equal(put.later[0].meetingRules, 1);
    const report = renderChainReport({ generatedAt: NOW.toISOString(), today: TODAY, spot: { price: SPOT, at: NOW.toISOString(), feed: "iex" }, accountHost: null, account: null, accountError: "x", optionsFeed: "indicative", liveBudget: 1000, call: put, put, model: { rate: 0.043, dividendYield: 0.012 } });
    assert.match(report, /INFORMATION ONLY/);
    assert.match(report, /2028-01-21 \(\d+ days\): 3 usable quotes, 1 meet every rule/);
    assert.match(report, /NO CONTRACT/);
  });
  it("later expiries are not read when the nearest expiry already has a contract", async () => {
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: windowFetch([], () => [690, 800, 1300]) });
    const put = await readSide(client, "put", SIDE_OPTS);
    assert.ok(put.pick.ok);
    assert.deepEqual(put.later, []);
  });
  it("a chain that does not fit in the page limit is refused, never used partially", async () => {
    const client = createReadOnlyClient({ keyId: "k", secretKey: SECRET, fetchImpl: windowFetch([], () => [1300], { contractsForever: true }) });
    const put = await readSide(client, "put", SIDE_OPTS);
    assert.equal(put.pick.ok, false);
    assert.match(put.error ?? "", /Too many pages/);
  });
});

describe("options approval level in the account answer", () => {
  const base = { status: "ACTIVE", equity: "1000", cash: "1000", buying_power: "1000", multiplier: "1" };
  const reportFor = (account: AccountSummary) => {
    const side = { type: "call" as const, listedExpirations: [], pick: { ok: false as const, reason: "x", expiration: null }, ladder: [], highestAbsDelta: null, window: { low: 0, high: 0 }, strikesRead: { count: 0, min: null, max: null }, later: [], rowsBuilt: 0, rejected: {}, error: null };
    return renderChainReport({ generatedAt: NOW.toISOString(), today: TODAY, spot: { price: SPOT, at: NOW.toISOString(), feed: "iex" }, accountHost: "live", account, accountError: null, optionsFeed: "indicative", liveBudget: 1000, call: side, put: { ...side, type: "put" }, model: { rate: 0.043, dividendYield: 0.012 } });
  };
  it("fields absent: the report says Alpaca did not return them, and lists the option-related fields it did send", () => {
    const a = parseAccountSummary({ ...base, options_buying_power: null });
    assert.ok(a);
    assert.equal(a.optionsApprovedLevel, null);
    assert.deepEqual(a.optionsFieldsSeen, ["options_buying_power (null)"]);
    const text = reportFor(a);
    assert.match(text, /Options approval level: NOT RETURNED by Alpaca/);
    assert.match(text, /options_buying_power \(null\)/);
    assert.match(text, /check it in the Alpaca dashboard/);
    assert.doesNotMatch(text, /approved n\/a/);
  });
  it("no option fields at all: says none", () => {
    const a = parseAccountSummary(base);
    assert.ok(a);
    assert.deepEqual(a.optionsFieldsSeen, []);
    assert.match(reportFor(a), /option-related fields Alpaca did send: none/);
  });
  it("levels returned as numbers or numeric strings are shown", () => {
    const a = parseAccountSummary({ ...base, options_approved_level: "2", options_trading_level: 2, options_buying_power: "900" });
    assert.ok(a);
    assert.equal(a.optionsApprovedLevel, 2);
    assert.equal(a.optionsTradingLevel, 2);
    assert.match(reportFor(a), /Options approval level: approved 2, trading 2/);
  });
  it("only one level returned: the other says not returned", () => {
    const a = parseAccountSummary({ ...base, options_approved_level: 1 });
    assert.ok(a);
    assert.match(reportFor(a), /approved 1, trading not returned/);
  });
});
