import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlpacaPaperBroker, type FetchLike } from "../src/lib/broker/alpacaPaper";
import {
  buyLimit,
  checkQuote,
  optionTypeForPolarity,
  parseOccSymbol,
  pickContract,
  sellLimit,
  type ContractQuery,
  type OptionContract,
  type OptionOrderRequest,
  type OptionQuote,
} from "../src/lib/broker/options";

// Thursday 2026-11-19, 17:00 New York (after the close).
const AFTER_CLOSE = new Date("2026-11-19T22:00:00Z");
const QUOTE_TIME = "2026-11-19T21:00:00Z";

const CALL = "NVDA271217C00100000";

const contract = (symbol: string, tradable = true): OptionContract => {
  const p = parseOccSymbol(symbol);
  if (!p) throw new Error("bad test symbol");
  return { symbol, underlying: p.underlying, type: p.type, strike: p.strike, expiration: p.expiration, tradable };
};

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

describe("polarity -> option type (independent oracle)", () => {
  it("+1 call, -1 put, everything else nothing", () => {
    for (const polarity of [-1, 0, 1]) {
      for (const ready of [true, false]) {
        const expected = !ready ? null : polarity === 1 ? "call" : polarity === -1 ? "put" : null;
        assert.equal(optionTypeForPolarity({ polarity, ready }), expected, `${polarity}/${ready}`);
      }
    }
  });
});

describe("contract choice", () => {
  const list = [
    contract("NVDA280121C00090000"),
    contract("NVDA280121C00100000"),
    contract("NVDA271217C00110000"),
    contract("NVDA271217C00095000"),
    contract("NVDA271217C00100000", false),
    contract("NVDA271217P00100000"),
    contract("NVDA261218C00100000"),
  ];
  it("takes the nearest expiry past the minimum, then the strike nearest the price", () => {
    const c = pickContract(list, 96, "call", "2027-11-19");
    assert.equal(c?.symbol, "NVDA271217C00095000");
  });
  it("never picks an untradable, wrong-type or too-short contract", () => {
    assert.equal(pickContract(list, 100, "call", "2027-11-19")?.strike, 95);
    assert.equal(pickContract(list, 100, "put", "2027-11-19")?.type, "put");
    assert.equal(pickContract(list, 100, "call", "2029-01-01"), null);
    assert.equal(pickContract([], 100, "call", "2027-11-19"), null);
    assert.equal(pickContract(list, 0, "call", "2027-11-19"), null);
  });
});

describe("quotes and limits", () => {
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
  it("rounds the buy limit up and the sell limit down to the 5-cent tick", () => {
    assert.equal(buyLimit(10.02), 10.05);
    assert.equal(buyLimit(10.05), 10.05);
    assert.equal(sellLimit(9.98), 9.95);
    assert.equal(sellLimit(9.95), 9.95);
    assert.equal(sellLimit(0.01), 0.05);
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

  it("sends a limit order to the paper host only, and refuses bad input before any request", async () => {
    const { calls, broker } = adapter([
      { data: { id: "i", client_order_id: "c", status: "accepted", symbol: CALL, side: "buy", qty: "1" } },
    ]);
    const res = await broker.submitOptionOrder({
      symbol: CALL,
      side: "buy",
      quantity: 1,
      clientOrderId: "c",
      type: "limit",
      limitPrice: 10.05,
      positionIntent: "buy_to_open",
    });
    assert.equal(res.ok, true);
    assert.equal(calls[0].url, "https://paper-api.alpaca.markets/v2/orders");
    const body = JSON.parse(calls[0].body ?? "{}");
    assert.equal(body.limit_price, "10.05");
    assert.equal(body.time_in_force, "day");
    assert.equal(body.position_intent, "buy_to_open");

    const none = adapter([]);
    for (const req of [
      { symbol: "NVDA", side: "buy" as const, quantity: 1, clientOrderId: "c", type: "limit" as const, limitPrice: 1, positionIntent: "buy_to_open" as const },
      { symbol: CALL, side: "buy" as const, quantity: 0, clientOrderId: "c", type: "limit" as const, limitPrice: 1, positionIntent: "buy_to_open" as const },
      { symbol: CALL, side: "buy" as const, quantity: 1, clientOrderId: "c", type: "limit" as const, positionIntent: "buy_to_open" as const },
    ] satisfies OptionOrderRequest[]) {
      assert.equal((await none.broker.submitOptionOrder(req)).ok, false);
    }
    assert.equal(none.calls.length, 0);
  });
});
