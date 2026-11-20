import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditRecord } from "../src/lib/audit";
import { AlpacaPaperBroker, type FetchLike } from "../src/lib/broker/alpacaPaper";
import type { PaperBrokerConfig } from "../src/lib/broker/config";
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
  type OptionsBroker,
} from "../src/lib/broker/options";
import { MSG_OPTION_MISALIGNED, optionClientOrderId, placeOptionIntent } from "../src/lib/broker/optionsExecute";
import type {
  BrokerAccount,
  BrokerOrder,
  BrokerPosition,
  MarketOrderRequest,
} from "../src/lib/broker/types";
import { optionsRunnerSettings, runOptionsCycle, type OptionsRunnerDeps, type OptionsSettings } from "../src/lib/optionsRunner";
import type { Bar } from "../src/lib/polarity";

const ON: PaperBrokerConfig = { enabled: true, killed: false, configured: true };
// Thursday 2026-11-19, 17:00 New York (after the close).
const AFTER_CLOSE = new Date("2026-11-19T22:00:00Z");
const QUOTE_TIME = "2026-11-19T21:00:00Z";

const ACCOUNT: BrokerAccount = {
  status: "ACTIVE",
  tradingBlocked: false,
  accountBlocked: false,
  equity: 100_000,
  lastEquity: 100_000,
  cash: 100_000,
  buyingPower: 200_000,
};

const CALL = "NVDA271217C00100000";
const PUT = "NVDA271217P00100000";

const contract = (symbol: string, tradable = true): OptionContract => {
  const p = parseOccSymbol(symbol);
  if (!p) throw new Error("bad test symbol");
  return { symbol, underlying: p.underlying, type: p.type, strike: p.strike, expiration: p.expiration, tradable };
};

class FakeOptionsBroker implements OptionsBroker {
  orders: OptionOrderRequest[] = [];
  byClient = new Map<string, BrokerOrder>();
  queries: ContractQuery[] = [];
  constructor(
    public positions: BrokerPosition[] = [],
    public account: BrokerAccount = ACCOUNT,
    public contracts: OptionContract[] = [contract(CALL), contract(PUT)],
    public quote: OptionQuote | null = { symbol: CALL, bid: 9.8, ask: 10.02, at: QUOTE_TIME },
  ) {}
  async getAccount() {
    return { ok: true as const, value: this.account };
  }
  async getPositions() {
    return { ok: true as const, value: this.positions };
  }
  async getOrderByClientId(id: string) {
    return { ok: true as const, value: this.byClient.get(id) ?? null };
  }
  async submitMarketOrder(...args: [MarketOrderRequest]): Promise<never> {
    void args;
    throw new Error("options runner must never send a stock order");
  }
  async listContracts(q: ContractQuery) {
    this.queries.push(q);
    return { ok: true as const, value: this.contracts.filter((c) => c.type === q.type && c.underlying === q.underlying) };
  }
  async getOptionQuote(symbol: string) {
    return { ok: true as const, value: this.quote ? { ...this.quote, symbol } : null };
  }
  async submitOptionOrder(req: OptionOrderRequest) {
    this.orders.push(req);
    const order: BrokerOrder = {
      id: `o${this.orders.length}`,
      clientOrderId: req.clientOrderId,
      status: "accepted",
      ticker: req.symbol,
      side: req.side,
      quantity: req.quantity,
    };
    this.byClient.set(req.clientOrderId, order);
    return { ok: true as const, value: order };
  }
}

function weekdaysEnding(last: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${last}T00:00:00Z`);
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/** 30 quiet bars; the last carries the signal. Spot (last close) is 100 for drive, 98 for reverse. */
function bars(last: string, kind: "drive" | "neutral" | "reverse", count = 30): Bar[] {
  return weekdaysEnding(last, count).map((date, i, all) => {
    const isLast = i === all.length - 1;
    const volume = isLast ? (kind === "neutral" ? 10 : 9000) : 1000;
    const open = isLast ? (kind === "reverse" ? 100 : 98) : 99;
    const close = isLast ? (kind === "reverse" ? 98 : 100) : 99.5;
    return { date, open, high: 101, low: 97, close, volume };
  });
}

const settings = (over: Partial<OptionsSettings> = {}): OptionsSettings => ({ watchlist: ["NVDA"], contracts: 1, ...over });

function deps(broker: OptionsBroker, load: OptionsRunnerDeps["loadBars"], over: Partial<OptionsRunnerDeps> = {}) {
  const audit: AuditRecord[] = [];
  const d: OptionsRunnerDeps = {
    broker,
    config: ON,
    loadBars: load,
    audit: (r) => void audit.push(r),
    now: () => AFTER_CLOSE,
    ...over,
  };
  return { d, audit };
}

const held = (symbol: string, quantity = 1, side: "long" | "short" = "long"): BrokerPosition => ({
  ticker: symbol,
  side,
  quantity,
  avgEntryPrice: 10,
});

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

describe("executor: hard alignment backstop", () => {
  const enter = (contractSymbol: string, signalPolarity: number | undefined) => ({
    action: "enter" as const,
    ticker: "NVDA",
    contractSymbol,
    signalPolarity,
    signalDate: "2026-11-19",
    quantity: 1,
    limitPrice: 10.05,
  });

  it("only a call on +1 and a put on -1 can ever be sent (exhaustive)", async () => {
    for (const polarity of [-1, 0, 1, undefined, 2, NaN]) {
      for (const symbol of [CALL, PUT]) {
        const broker = new FakeOptionsBroker();
        const res = await placeOptionIntent(broker, ON, enter(symbol, polarity));
        const allowed = (polarity === 1 && symbol === CALL) || (polarity === -1 && symbol === PUT);
        assert.equal(res.ok, allowed, `${polarity} ${symbol}`);
        assert.equal(broker.orders.length, allowed ? 1 : 0);
        if (!allowed && !res.ok) assert.equal(res.error, MSG_OPTION_MISALIGNED);
      }
    }
  });

  it("rejects a stock symbol, another ticker's contract, bad size and a missing or bad limit", async () => {
    const broker = new FakeOptionsBroker();
    const bad = [
      enter("NVDA", 1),
      enter("AAPL271217C00100000", 1),
      { ...enter(CALL, 1), quantity: 0 },
      { ...enter(CALL, 1), quantity: 11 },
      { ...enter(CALL, 1), quantity: 1.5 },
      { ...enter(CALL, 1), limitPrice: undefined },
      { ...enter(CALL, 1), limitPrice: -1 },
      { ...enter(CALL, 1), limitPrice: NaN },
      { ...enter(CALL, 1), signalDate: "yesterday" },
      { ...enter(CALL, 1), ticker: "NV DA" },
    ];
    for (const intent of bad) {
      const res = await placeOptionIntent(broker, ON, intent);
      assert.equal(res.ok, false);
    }
    assert.equal(broker.orders.length, 0);
  });

  it("refuses when killed, disabled or unconfigured", async () => {
    for (const config of [
      { enabled: true, killed: true, configured: true },
      { enabled: false, killed: false, configured: true },
      { enabled: true, killed: false, configured: false },
    ]) {
      const broker = new FakeOptionsBroker();
      const res = await placeOptionIntent(broker, config, enter(CALL, 1));
      assert.equal(res.ok, false);
      assert.equal(broker.orders.length, 0);
    }
  });

  it("is idempotent: the same signal never produces a second order", async () => {
    const broker = new FakeOptionsBroker();
    const a = await placeOptionIntent(broker, ON, enter(CALL, 1));
    const b = await placeOptionIntent(broker, ON, enter(CALL, 1));
    assert.equal(a.ok && a.status, "submitted");
    assert.equal(b.ok && b.status, "noop");
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0].clientOrderId, optionClientOrderId("enter", "NVDA", "call", "2026-11-19"));
    assert.equal(broker.orders[0].positionIntent, "buy_to_open");
    assert.equal(broker.orders[0].side, "buy");
    assert.equal(broker.orders[0].type, "limit");
  });

  it("never adds to, or enters against, an option already held", async () => {
    const same = new FakeOptionsBroker([held(CALL)]);
    const r1 = await placeOptionIntent(same, ON, enter(CALL, 1));
    assert.equal(r1.ok && r1.status, "noop");
    const opposite = new FakeOptionsBroker([held(CALL)]);
    const r2 = await placeOptionIntent(opposite, ON, enter(PUT, -1));
    assert.equal(r2.ok, false);
    assert.equal(same.orders.length + opposite.orders.length, 0);
  });

  it("refuses short or multiple option positions", async () => {
    for (const positions of [[held(CALL, 1, "short")], [held(CALL), held("NVDA280121C00100000")]]) {
      const broker = new FakeOptionsBroker(positions);
      const res = await placeOptionIntent(broker, ON, enter(PUT, -1));
      assert.equal(res.ok, false);
      assert.equal(broker.orders.length, 0);
    }
  });

  it("closes the broker's actual quantity, at market without a limit", async () => {
    const broker = new FakeOptionsBroker([held(CALL, 3)]);
    const res = await placeOptionIntent(broker, ON, { action: "close", ticker: "NVDA", signalDate: "2026-11-19", quantity: 0 });
    assert.equal(res.ok && res.status, "submitted");
    assert.equal(broker.orders[0].quantity, 3);
    assert.equal(broker.orders[0].side, "sell");
    assert.equal(broker.orders[0].type, "market");
    assert.equal(broker.orders[0].positionIntent, "sell_to_close");
  });

  it("a close with nothing held is a no-op", async () => {
    const broker = new FakeOptionsBroker();
    const res = await placeOptionIntent(broker, ON, { action: "close", ticker: "NVDA", signalDate: "2026-11-19", quantity: 0 });
    assert.equal(res.ok && res.status, "noop");
    assert.equal(broker.orders.length, 0);
  });
});

describe("settings", () => {
  it("defaults to one contract and validates the count", () => {
    const ok = optionsRunnerSettings({ POLARITO_PAPER_WATCHLIST: "SPY, NVDA" });
    assert.equal(ok.ok && ok.settings.contracts, 1);
    for (const v of ["0", "11", "1.5", "x"]) {
      assert.equal(optionsRunnerSettings({ POLARITO_PAPER_WATCHLIST: "SPY", POLARITO_OPTIONS_CONTRACTS: v }).ok, false, v);
    }
    assert.equal(optionsRunnerSettings({ POLARITO_PAPER_WATCHLIST: "" }).ok, false);
  });
});

describe("options cycle", () => {
  it("Drive buys a long-dated call at the ask", async () => {
    const broker = new FakeOptionsBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    const r = await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(r.ok, true);
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0].symbol, CALL);
    assert.equal(broker.orders[0].limitPrice, 10.05);
    assert.equal(audit[0].outcome, "entered");
    assert.equal(audit[0].source, "options-runner");
    assert.equal(broker.queries[0].expiresFrom, "2027-11-19");
    assert.equal(broker.queries[0].type, "call");
  });

  it("Reverse buys a put, never a call", async () => {
    const broker = new FakeOptionsBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "reverse"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0].symbol, PUT);
    assert.equal(audit[0].outcome, "entered");
  });

  it("Neutral holds nothing", async () => {
    const broker = new FakeOptionsBroker();
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "neutral"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 0);
    assert.equal(audit[0].outcome, "aside");
  });

  it("Neutral closes an option that is held", async () => {
    const broker = new FakeOptionsBroker([held(CALL, 2)]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "neutral"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0].side, "sell");
    assert.equal(broker.orders[0].quantity, 2);
    assert.equal(broker.orders[0].type, "limit");
    assert.equal(broker.orders[0].limitPrice, 9.8);
    assert.equal(audit[0].outcome, "closed");
  });

  it("a flip closes now and defers the new option to the next session", async () => {
    const broker = new FakeOptionsBroker([held(CALL)]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "reverse"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0].side, "sell");
    assert.equal(audit[0].outcome, "closed");
  });

  it("holds an aligned option and never adds", async () => {
    const broker = new FakeOptionsBroker([held(CALL)]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 0);
    assert.equal(audit[0].outcome, "held");
  });

  it("closes an aligned option that is within 60 days of expiry (roll)", async () => {
    const soon = "NVDA270115C00100000";
    const broker = new FakeOptionsBroker([held(soon)]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0].side, "sell");
    assert.match(audit[0].reason, /Expires 2027-01-15/);
  });

  it("closes at market when there is no usable quote (a close is never blocked)", async () => {
    const broker = new FakeOptionsBroker([held(CALL)], ACCOUNT, [contract(CALL), contract(PUT)], null);
    const { d } = deps(broker, async () => bars("2026-11-19", "neutral"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders[0].type, "market");
  });

  it("does not enter on a wide spread, a missing quote, or no contract", async () => {
    const wide = new FakeOptionsBroker([], ACCOUNT, [contract(CALL), contract(PUT)], { symbol: CALL, bid: 5, ask: 10, at: QUOTE_TIME });
    const none = new FakeOptionsBroker([], ACCOUNT, [contract(CALL), contract(PUT)], null);
    const empty = new FakeOptionsBroker([], ACCOUNT, []);
    for (const broker of [wide, none, empty]) {
      const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
      await runOptionsCycle(d, settings(), { dryRun: false });
      assert.equal(broker.orders.length, 0);
      assert.notEqual(audit[0].outcome, "entered");
    }
  });

  it("does not enter when the premium is over the per-position cap or the cash", async () => {
    const pricey = new FakeOptionsBroker([], ACCOUNT, [contract(CALL), contract(PUT)], { symbol: CALL, bid: 119, ask: 120, at: QUOTE_TIME });
    const poor = new FakeOptionsBroker([], { ...ACCOUNT, cash: 500, buyingPower: 500 });
    for (const broker of [pricey, poor]) {
      const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
      await runOptionsCycle(d, settings(), { dryRun: false });
      assert.equal(broker.orders.length, 0);
      assert.equal(audit[0].outcome, "blocked");
    }
  });

  it("tracks premium across tickers so several can never oversubscribe cash", async () => {
    const calls = ["NVDA", "AAPL", "MSFT"].map((t) => contract(`${t}271217C00100000`));
    const broker = new FakeOptionsBroker([], { ...ACCOUNT, cash: 2_500, buyingPower: 2_500 }, calls);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    await runOptionsCycle(d, settings({ watchlist: ["NVDA", "AAPL", "MSFT"] }), { dryRun: false });
    // Each costs about $1,005; only two fit in $2,500.
    assert.equal(broker.orders.length, 2);
    assert.deepEqual(audit.map((a) => a.outcome), ["entered", "entered", "blocked"]);
  });

  it("a 2% daily loss closes an aligned option and blocks new entries until the next session", async () => {
    const down = { ...ACCOUNT, equity: 97_000 };
    const noEntry = new FakeOptionsBroker([], down);
    const a = deps(noEntry, async () => bars("2026-11-19", "drive"));
    await runOptionsCycle(a.d, settings(), { dryRun: false });
    assert.equal(noEntry.orders.length, 0);
    assert.equal(a.audit[0].outcome, "blocked");

    const closing = new FakeOptionsBroker([held(CALL)], down);
    const b = deps(closing, async () => bars("2026-11-19", "drive"));
    await runOptionsCycle(b.d, settings(), { dryRun: false });
    assert.equal(closing.orders.length, 1);
    assert.equal(closing.orders[0].side, "sell");
    assert.equal(b.audit[0].outcome, "closed");
    assert.match(b.audit[0].reason, /Daily loss limit \(2%\) reached/);

    const fine = new FakeOptionsBroker([held(CALL)], { ...ACCOUNT, equity: 98_500 });
    const c = deps(fine, async () => bars("2026-11-19", "drive"));
    await runOptionsCycle(c.d, settings(), { dryRun: false });
    assert.equal(fine.orders.length, 0);
    assert.equal(c.audit[0].outcome, "held");
  });

  it("never trades on stale or malformed bars", async () => {
    const broker = new FakeOptionsBroker();
    const stale = deps(broker, async () => bars("2026-11-02", "drive"));
    await runOptionsCycle(stale.d, settings(), { dryRun: false });
    const bad = deps(broker, async () => [{ date: "x", open: NaN, high: 1, low: 1, close: 1, volume: 1 }] as Bar[]);
    await runOptionsCycle(bad.d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 0);
  });

  it("observes until trading is switched on, and a dry run sends nothing", async () => {
    for (const [config, dryRun] of [
      [{ enabled: false, killed: false, configured: true }, false],
      [ON, true],
    ] as const) {
      const broker = new FakeOptionsBroker();
      const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"), { config });
      const r = await runOptionsCycle(d, settings(), { dryRun });
      assert.equal(r.ok, true);
      assert.equal(broker.orders.length, 0);
      assert.ok(audit.some((a) => a.outcome === "dry-run" && /Would buy 1 NVDA 2027-12-17 100 CALL/.test(a.reason)));
    }
  });

  it("the kill switch stops everything", async () => {
    const broker = new FakeOptionsBroker([held(CALL)]);
    const { d } = deps(broker, async () => bars("2026-11-19", "neutral"), { config: { enabled: true, killed: true, configured: true } });
    const r = await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(broker.orders.length, 0);
  });

  it("one failing ticker does not stop the others", async () => {
    const broker = new FakeOptionsBroker([], ACCOUNT, [contract(CALL), contract("AAPL271217C00100000")]);
    const { d, audit } = deps(broker, async (t) => {
      if (t === "NVDA") throw new Error("boom");
      return bars("2026-11-19", "drive");
    });
    await runOptionsCycle(d, settings({ watchlist: ["NVDA", "AAPL"] }), { dryRun: false });
    assert.equal(audit[0].outcome, "error");
    assert.equal(audit[1].outcome, "entered");
    assert.equal(broker.orders.length, 1);
  });

  it("never touches a plain stock position, only notes it", async () => {
    const broker = new FakeOptionsBroker([{ ticker: "NVDA", side: "short", quantity: 1, avgEntryPrice: 150 }]);
    const { d, audit } = deps(broker, async () => bars("2026-11-19", "drive"));
    await runOptionsCycle(d, settings(), { dryRun: false });
    assert.equal(broker.orders.length, 1);
    assert.equal(broker.orders[0].symbol, CALL);
    assert.match(audit[0].notes.join(" "), /plain NVDA stock position/);
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
