import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlpacaPaperBroker, type FetchLike } from "../src/lib/broker/alpacaPaper";
import {
  checkQuote,
  parseOccSymbol,
  type ContractQuery,
  type OptionQuote,
} from "../src/lib/broker/options";

// Thursday 2026-11-19, 17:00 New York (after the close).
const AFTER_CLOSE = new Date("2026-11-19T22:00:00Z");
const QUOTE_TIME = "2026-11-19T21:00:00Z";

const CALL = "NVDA271217C00100000";

describe("OCC symbols", () => {
  it("parses a real symbol", () => {
    assert.deepEqual(parseOccSymbol("MSFT271217C00500000"), {
      underlying: "MSFT",
      expiration: "2027-12-17",
      type: "call",
      strike: 500,
    });
    assert.equal(parseOccSymbol("AAPL271217P00172500")?.strike, 172.5);
  });
  it("rejects stock tickers and malformed or impossible symbols", () => {
    for (const bad of ["NVDA", "NVDA271317C00100000", "NVDA270230C00100000", "NVDA271217X00100000", "271217C00100000", "NVDA271217C0", "", null, 5]) {
      assert.equal(parseOccSymbol(bad), null, String(bad));
    }
  });
});

describe("quote check", () => {
  const q = (over: Partial<OptionQuote> = {}): OptionQuote => ({ symbol: CALL, bid: 9.8, ask: 10.02, at: QUOTE_TIME, ...over });
  it("accepts a sane quote and reports the spread", () => {
    const r = checkQuote(q(), AFTER_CLOSE);
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.spreadPct > 0.02 && r.spreadPct < 0.03);
  });
  it("rejects missing, empty, crossed, stale and undated quotes", () => {
    for (const bad of [null, q({ bid: 0 }), q({ ask: 0 }), q({ bid: 11 }), q({ at: "2026-11-01T00:00:00Z" }), q({ at: "garbage" }), q({ bid: NaN })]) {
      assert.equal(checkQuote(bad, AFTER_CLOSE).ok, false);
    }
  });
});

describe("Alpaca paper adapter: option calls", () => {
  type Call = { url: string; method: string; body?: string };
  function adapter(responses: Array<{ status?: number; data: unknown }>) {
    const calls: Call[] = [];
    const queue = [...responses];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      const r = queue.shift() ?? { status: 500, data: null };
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => r.data };
    };
    return { calls, broker: new AlpacaPaperBroker({ keyId: "k", secretKey: "s", fetchImpl }) };
  }
  const q: ContractQuery = {
    underlying: "NVDA",
    type: "call",
    expiresFrom: "2027-11-19",
    expiresTo: "2028-12-23",
    strikeLow: 90,
    strikeHigh: 110,
  };
  const row = (symbol: string, over: Record<string, unknown> = {}) => ({
    symbol,
    strike_price: "100",
    expiration_date: "2027-12-17",
    type: "call",
    tradable: true,
    ...over,
  });

  it("lists contracts from the paper host and drops rows that disagree with their own symbol", async () => {
    const { calls, broker } = adapter([
      {
        data: {
          option_contracts: [row(CALL), row("NVDA271217C00100000", { type: "put" }), row("NVDA271217C00100000", { strike_price: "99" }), row("bad")],
          next_page_token: null,
        },
      },
    ]);
    const res = await broker.listContracts(q);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value.map((c) => c.symbol), [CALL]);
    assert.ok(calls[0].url.startsWith("https://paper-api.alpaca.markets/v2/options/contracts?"));
    assert.match(calls[0].url, /underlying_symbols=NVDA/);
    assert.match(calls[0].url, /expiration_date_gte=2027-11-19/);
  });

  it("follows pages and fails closed on a malformed response", async () => {
    const paged = adapter([
      { data: { option_contracts: [row(CALL)], next_page_token: "p2" } },
      { data: { option_contracts: [row("NVDA280121C00100000", { expiration_date: "2028-01-21" })], next_page_token: null } },
    ]);
    const res = await paged.broker.listContracts(q);
    assert.equal(res.ok && res.value.length, 2);
    assert.match(paged.calls[1].url, /page_token=p2/);
    const bad = await adapter([{ data: { nope: true } }]).broker.listContracts(q);
    assert.equal(bad.ok, false);
  });

  it("reads a quote from the data host and validates it", async () => {
    const good = adapter([{ data: { snapshots: { [CALL]: { latestQuote: { bp: 9.8, ap: 10.02, t: QUOTE_TIME } } } } }]);
    const res = await good.broker.getOptionQuote(CALL);
    assert.equal(res.ok && res.value?.ask, 10.02);
    assert.ok(good.calls[0].url.startsWith("https://data.alpaca.markets/v1beta1/options/snapshots?"));
    const missing = await adapter([{ data: { snapshots: {} } }]).broker.getOptionQuote(CALL);
    assert.equal(missing.ok && missing.value, null);
    const bad = await adapter([{ data: { snapshots: { [CALL]: { latestQuote: { bp: "x", ap: 1, t: 5 } } } } }]).broker.getOptionQuote(CALL);
    assert.equal(bad.ok, false);
    assert.equal((await adapter([]).broker.getOptionQuote("NVDA")).ok, false);
  });

});
