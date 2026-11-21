import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placeLiveEntry } from "../src/lib/broker/liveExecute";
import { deriveDayState } from "../src/lib/broker/liveOrders";
import { LIVE_LIMITS, liveLimitsView, slotUse } from "../src/lib/liveLimits";
import { sizeLiveEntry } from "../src/lib/pickRank";
import { runPickTick } from "../src/lib/pickRunner";
import { ACCOUNT_1K, LIVE_ON, pickSetup, TODAY, type BarSpec, type FakeLiveBroker } from "./helpers/liveFake";

// Every fixture stock trades at $100, the fake broker's fill price: 33% of $1,000 = $330 = 3 shares ($300).
const five = (): Record<string, BarSpec> => ({
  NVDA: { kind: "drive", mult: 12, price: 100 },
  WMT: { kind: "drive", mult: 10, price: 100 },
  KO: { kind: "drive", mult: 8, price: 100 },
  PG: { kind: "drive", mult: 6, price: 100 },
  XOM: { kind: "drive", mult: 4, price: 100 },
});
const FILL_TO_CAP = { POLARITO_LIVE_QTY: "1000" };

type T = ReturnType<typeof pickSetup>;
const tick = (t: T, o: { dryRun?: boolean } = {}) => runPickTick(t.deps, t.settings, { dryRun: o.dryRun ?? false });
const ids = (t: T) => t.broker.submitted.map((o) => o.clientOrderId);
const held = (t: T, ticker: string, quantity = 1, nn = 1) => {
  t.broker.positions.push({ ticker, side: "long", quantity, avgEntryPrice: 100 });
  t.broker.orders.push({ id: `x-${ticker}`, clientOrderId: `pol-20261119-e${String(nn).padStart(2, "0")}-${ticker}`, status: "filled", ticker, side: "buy", quantity });
};

describe("the limits live in one constant", () => {
  it("3 positions, 33% each, 1% whole-account stop, long only", () => {
    assert.deepEqual({ ...LIVE_LIMITS }, { maxPositions: 3, perPositionCapPct: 33, totalExposureCapPct: 100, dailyStopPct: 1, maxAutoEntriesPerTickerPerDay: 1, longOnly: true });
    const r = pickSetupSettings();
    assert.deepEqual([r.maxPositions, r.maxPositionPct, r.dailyLossPct], [3, 33, 1]);
  });

  it("the status view reports maxPositions=3 and perPositionCapPct=33, and an env value can only lower the cap", () => {
    const view = liveLimitsView(pickSetupSettings(), 2);
    assert.deepEqual([view.maxPositions, view.perPositionCapPct, view.maxPositionPct, view.totalExposureCapPct, view.dailyLossPct, view.longOnly, view.slotsUsed], [3, 33, 33, 100, 1, true, 2]);
    assert.equal(liveLimitsView(pickSetupSettings({ POLARITO_LIVE_MAX_POSITION_PCT: "20" }), 0).perPositionCapPct, 20);
    assert.deepEqual([liveLimitsView(null, 0).maxPositions, liveLimitsView(null, 0).perPositionCapPct], [3, 33]);
  });

});

function pickSetupSettings(env: Record<string, string> = {}) {
  return pickSetup({ specs: five(), env }).settings;
}

describe("cap math on a $1,000 account (33% per position, whole shares, floored)", () => {
  const size = (price: number, extra: Partial<Parameters<typeof sizeLiveEntry>[0]> = {}) =>
    sizeLiveEntry({ price, equity: 1_000, lastEquity: 1_000, cash: 1_000, buyingPower: 1_000, reservedNotional: 0, today: TODAY, quantity: 1_000, maxPositionPct: 33, dailyLossPct: 1, ...extra }, "long");

  it("floors to whole shares under $330", () => {
    assert.equal(size(100).quantity, 3); // $300
    assert.equal(size(110).quantity, 3); // $330 exactly
    assert.equal(size(130).quantity, 2); // $260
    assert.equal(size(165).quantity, 2); // $330 exactly
    assert.equal(size(200).quantity, 1);
    assert.equal(size(330).quantity, 1);
  });

  it("a stock that rounds to zero shares is skipped and says so", () => {
    const r = size(331);
    assert.equal(r.quantity, 0);
    assert.match(r.reason ?? "", /rounds to zero shares/);
    assert.match(r.reason ?? "", /\$330\.00/);
    assert.match(r.reason ?? "", /33% of \$1,000\.00/);
  });

  it("three full positions are 99% of equity, inside the 100% total exposure cap", () => {
    assert.equal(3 * size(100).quantity * 100, 900);
    // After two $300 positions the third still gets its full 33% ...
    assert.equal(size(100, { reservedNotional: 600 }).quantity, 3);
    // ... but total exposure is still enforced if the book is already near 100%.
    assert.equal(size(100, { reservedNotional: 950 }).quantity, 0);
    assert.equal(size(100, { reservedNotional: 800 }).quantity, 2);
  });

  it("the cap uses today's equity, not the last close", () => {
    assert.equal(size(100, { equity: 1_200, lastEquity: 1_200, cash: 1_200, buyingPower: 1_200 }).quantity, 3); // $396 -> 3
    assert.equal(size(130, { equity: 1_200, lastEquity: 1_200, cash: 1_200, buyingPower: 1_200 }).quantity, 3); // $396 / 130 -> 3
    assert.equal(size(130, { equity: 900, lastEquity: 900, cash: 900, buyingPower: 900 }).quantity, 2); // $297 / 130 -> 2
  });
});

describe("the pick runner holds at most 3 stocks", () => {
  it("one tick enters the top 3 of 5, each at 3 shares ($300 = 30% of equity), one order at a time", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    const r = await tick(t);
    assert.ok(r.ok);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA", "pol-20261119-e02-WMT", "pol-20261119-e03-KO"]);
    assert.deepEqual(t.broker.submitted.map((o) => [o.side, o.quantity]), [["buy", 3], ["buy", 3], ["buy", 3]]);
    assert.equal(t.broker.positions.length, 3);
    assert.ok(t.broker.positions.every((p) => p.quantity * p.avgEntryPrice <= 330));
  });

  it("never a fourth, however many ticks and however strong the others read", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    for (let i = 0; i < 6; i++) await tick(t);
    t.specs.XOM.mult = 99;
    for (let i = 0; i < 3; i++) await tick(t);
    assert.equal(t.broker.submitted.length, 3);
    assert.equal(t.broker.positions.length, 3);
    assert.match(t.audit.at(-1)!.reason, /All 3 position slots are in use \(NVDA, WMT, KO\)/);
  });

  it("only fills the free slots: with 1 held it enters 2, with 2 held it enters 1", async () => {
    const one = pickSetup({ specs: five(), env: FILL_TO_CAP });
    held(one, "PG", 3);
    await tick(one);
    assert.deepEqual(ids(one), ["pol-20261119-e02-NVDA", "pol-20261119-e03-WMT"]);
    const two = pickSetup({ specs: five(), env: FILL_TO_CAP });
    held(two, "PG", 3, 1);
    held(two, "XOM", 3, 2);
    await tick(two);
    assert.deepEqual(ids(two), ["pol-20261119-e03-NVDA"]);
  });

  it("an option position or an off-watchlist stock in the account uses a slot too", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    t.broker.positions.push({ ticker: "SPY260619C00500000", side: "long", quantity: 1, avgEntryPrice: 5 });
    t.broker.positions.push({ ticker: "AMZN", side: "long", quantity: 1, avgEntryPrice: 100 });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA"]);
    assert.deepEqual(slotUse(t.broker.positions, [], 3), { used: 3, free: 0, companies: new Set(["SPY260619C00500000", "AMZN", "NVDA"]) });
  });

  it("a working order anywhere blocks the tick (fail closed): nothing is sent", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    t.broker.orders.push({ id: "w", clientOrderId: "hand-1", status: "accepted", ticker: "KO", side: "buy", quantity: 1 });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
  });

  it("each next entry waits for the previous fill: an unfilled order stops the sequence until the next tick", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    t.broker.fill = false;
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA"]);
    assert.match(t.audit.map((a) => a.reason).join(" | "), /NVDA entry is not filled yet/);
    await tick(t);
    assert.equal(t.broker.submitted.length, 1, "the working order holds the next tick too");
  });

  it("the account is re-read before every later entry: a hand buy that lands in between uses the slot", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    const broker = t.broker as FakeLiveBroker;
    const submit = broker.submitMarketOrder.bind(broker);
    broker.submitMarketOrder = async (req) => {
      const res = await submit(req);
      if (broker.submitted.length === 1) {
        broker.positions.push({ ticker: "AMZN", side: "long", quantity: 1, avgEntryPrice: 100 });
        broker.positions.push({ ticker: "MSFT", side: "long", quantity: 1, avgEntryPrice: 100 });
      }
      return res;
    };
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA"], "3 positions now: no second entry");
    assert.equal(broker.positions.length, 3);
  });

  it("a stock that rounds to zero shares is skipped with a note and the next one is entered", async () => {
    const specs = { ...five(), TOP: { kind: "drive" as const, mult: 50, price: 400 } };
    const t = pickSetup({ specs, env: FILL_TO_CAP });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA", "pol-20261119-e02-WMT", "pol-20261119-e03-KO"]);
    const dry = pickSetup({ specs, env: FILL_TO_CAP });
    const r = await tick(dry, { dryRun: true });
    assert.ok(r.results.flatMap((x) => x.notes ?? []).some((n) => /^TOP: rounds to zero shares/.test(n)));
  });

  it("long only: a Reverse reading is never entered, even above $2,000 with shorting on", async () => {
    const specs = { UPA: { kind: "drive" as const, mult: 9, price: 100 }, DOWN: { kind: "reverse" as const, mult: 30, price: 100 }, UPB: { kind: "drive" as const, mult: 5, price: 100 } };
    const rich = { equity: 5_000, lastEquity: 5_000, cash: 5_000, buyingPower: 10_000, shortingEnabled: true };
    const t = pickSetup({ specs, account: rich, env: { POLARITO_LIVE_LONG_ONLY_FALLBACK: "next" } });
    t.broker.assets.set("DOWN", { symbol: "DOWN", status: "active", tradable: true, shortable: true, borrowStatus: "easy_to_borrow" });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-UPA", "pol-20261119-e02-UPB"]);
    assert.ok(t.broker.submitted.every((o) => o.side === "buy"));
  });

  it("entries start at the pick start (10:00 New York), for every stock", async () => {
    const t = pickSetup({ specs: five(), now: new Date("2026-11-19T14:45:00Z") });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
  });
});

describe("ids and idempotency", () => {
  it("entry ids are unique across tickers and carry the ticker, in one tick and across ticks", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    await tick(t);
    const sent = ids(t);
    assert.equal(new Set(sent).size, sent.length);
    assert.ok(sent.every((id) => /^pol-20261119-e0[1-3]-[A-Z]+$/.test(id)));
    assert.deepEqual(sent.map((id) => id.split("-").at(-1)), ["NVDA", "WMT", "KO"]);
  });

  it("sending the same entry id twice places one order: the second is a no-op, not a duplicate", async () => {
    const t = pickSetup({ specs: five() });
    const args = { broker: t.broker, config: LIVE_ON, date: TODAY, nn: 1, ticker: "NVDA", side: "long" as const, quantity: 3, polarity: 1, signalDate: TODAY };
    const first = await placeLiveEntry(args);
    t.broker.hideFromLookupOnce.add("pol-20261119-e01-NVDA");
    const second = await placeLiveEntry({ ...args, broker: t.broker });
    assert.ok(first.ok && first.status === "submitted");
    assert.ok(second.ok && second.status === "noop");
    assert.equal(t.broker.orders.filter((o) => o.ticker === "NVDA").length, 1);
  });

  it("a restart or a replay of the same tick cannot enter a ticker twice in a day (the day's orders are the memory)", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    await tick(t);
    t.broker.positions = []; // everything was closed by hand outside this test's orders
    const state = deriveDayState(t.broker.orders, TODAY);
    assert.deepEqual(state.enteredTickers, ["NVDA", "WMT", "KO"]);
    await tick(t);
    assert.deepEqual(ids(t).slice(3), ["pol-20261119-e04-PG", "pol-20261119-e05-XOM"], "only the stocks not yet entered today, with continuing entry numbers");
    const again = new Set(ids(t));
    assert.equal(again.size, ids(t).length);
  });

  it("manual and automatic entries share one numbering and one entered-today list", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    t.broker.orders.push({ id: "m", clientOrderId: "pol-20261119-m01-NVDA", status: "filled", ticker: "NVDA", side: "buy", quantity: 1 });
    t.broker.positions.push({ ticker: "NVDA", side: "long", quantity: 1, avgEntryPrice: 100 });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e02-WMT", "pol-20261119-e03-KO"]);
  });
});

describe("1% daily stop across all positions", () => {
  const book = (equity: number) => {
    const t = pickSetup({ specs: five(), account: { equity, lastEquity: 1_000 } });
    held(t, "NVDA", 3, 1);
    held(t, "WMT", 3, 2);
    held(t, "KO", 3, 3);
    return t;
  };

  it("when the WHOLE account is down 1% every position is flattened with its own stop id, and nothing is entered", async () => {
    const t = book(989);
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-s01-a1-NVDA", "pol-20261119-s02-a1-WMT", "pol-20261119-s03-a1-KO"]);
    assert.ok(t.broker.submitted.every((o) => o.side === "sell" && o.quantity === 3));
    assert.equal(t.broker.positions.length, 0);
  });

  it("the lockout lasts until the next session, even when equity recovers", async () => {
    const t = book(989);
    await tick(t);
    t.broker.account = { ...ACCOUNT_1K, equity: 1_400, lastEquity: 1_000, cash: 1_400, buyingPower: 1_400 };
    await tick(t);
    await tick(t);
    assert.equal(t.broker.submitted.length, 3);
    assert.match(t.audit.at(-1)!.reason, /Stopped out earlier today/);
  });

  it("just inside the stop (-0.9%) nothing is flattened", async () => {
    const t = book(991);
    await tick(t);
    assert.ok(!ids(t).some((id) => /-s\d\d-/.test(id)));
  });

  it("uses the existing last_equity baseline: a $1,000 deposit's equity step is the broker's own number, not the sum of the positions", async () => {
    const t = pickSetup({ specs: five(), account: { equity: 2_000, lastEquity: 1_000, cash: 1_700, buyingPower: 1_700 } });
    held(t, "NVDA", 1, 1);
    await tick(t);
    assert.ok(!ids(t).some((id) => /-s\d\d-/.test(id)), "up on the day: no stop");
  });

  it("a position whose flatten was rejected is retried under the next attempt id while the others are done", async () => {
    const t = book(985);
    t.broker.orders.push({ id: "r", clientOrderId: "pol-20261119-s02-a1-WMT", status: "rejected", ticker: "WMT", side: "sell", quantity: 3 });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-s01-a1-NVDA", "pol-20261119-s02-a2-WMT", "pol-20261119-s03-a1-KO"]);
  });
});

describe("dry run (pick-run dry=1) shows every 'Would enter' line plus the ranking and skip reasons", () => {
  it("lists up to 3 'Would enter' results, never sends, and carries the Ranked line and per-stock skips", async () => {
    const specs = { ...five(), TOP: { kind: "drive" as const, mult: 50, price: 400 } };
    const t = pickSetup({ specs, env: FILL_TO_CAP });
    const r = await tick(t, { dryRun: true });
    assert.ok(r.ok && r.dryRun);
    assert.equal(t.broker.submitted.length, 0);
    const would = r.results.filter((x) => /^Would enter long 3 /.test(x.reason));
    assert.deepEqual(would.map((x) => x.ticker), ["NVDA", "WMT", "KO"]);
    assert.match(would[0].reason, /as entry 1\./);
    assert.match(would[2].reason, /as entry 3\./);
    const notes = r.results.flatMap((x) => x.notes ?? []);
    assert.ok(notes.some((n) => /^Ranked: TOP .*NVDA/.test(n)));
    assert.ok(notes.some((n) => /^TOP: rounds to zero shares/.test(n)));
    assert.ok(notes.some((n) => /^PG: all 3 position slots are in use/.test(n)));
    assert.ok(r.results.some((x) => /Would enter 3 of 3 open slots/.test(x.reason)));
  });

  it("plans against what it would have bought: held stocks reduce the lines, and exposure grows with each planned entry", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    held(t, "NVDA", 3, 1);
    const r = await tick(t, { dryRun: true });
    assert.deepEqual(r.results.filter((x) => /^Would enter long/.test(x.reason)).map((x) => x.ticker), ["WMT", "KO"]);
    assert.ok(r.results.flatMap((x) => x.notes ?? []).some((n) => /^NVDA: already held/.test(n)));
    const tight = pickSetup({ specs: five(), env: FILL_TO_CAP, account: { cash: 400, buyingPower: 400 } });
    const rt = await tick(tight, { dryRun: true });
    assert.deepEqual(rt.results.filter((x) => /^Would enter long/.test(x.reason)).map((x) => Number(/long (\d+) /.exec(x.reason)?.[1])), [3, 1], "cash left after the first planned entry limits the second");
  });

  it("Auto OFF behaves the same: observe only, three lines, no orders", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP, auto: false });
    const r = await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.equal(r.results.filter((x) => x.outcome === "aside").length >= 1, true);
  });
});

describe("re-entry after a signal-driven close, per ticker", () => {
  it("a Neutral close frees the slot; the same ticker waits for the next session and the next-ranked stock takes the slot", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    await tick(t);
    t.specs.WMT = { kind: "neutral" };
    await tick(t);
    assert.ok(ids(t).includes("pol-20261119-c02-a1-WMT"));
    await tick(t);
    assert.deepEqual(t.broker.positions.map((p) => p.ticker).sort(), ["KO", "NVDA", "PG"], "PG takes the freed slot; WMT is not re-entered");
    t.specs.WMT = { kind: "drive", mult: 99, price: 100 };
    for (let i = 0; i < 3; i++) await tick(t);
    assert.ok(!ids(t).some((id) => /-e\d\d-WMT$/.test(id) && id !== "pol-20261119-e02-WMT"), "no second WMT entry today");
  });

  it("the stop-out ends all entries for the day, including freed slots", async () => {
    const t = pickSetup({ specs: five(), env: FILL_TO_CAP });
    await tick(t);
    t.broker.account = { ...ACCOUNT_1K, equity: 985 };
    await tick(t);
    assert.equal(t.broker.positions.length, 0);
    await tick(t);
    assert.equal(ids(t).filter((id) => /-e\d\d-/.test(id)).length, 3);
  });
});
