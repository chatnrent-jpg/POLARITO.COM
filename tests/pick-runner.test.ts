import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AUDIT_SOURCES } from "../src/lib/audit";
import { closeLivePosition } from "../src/lib/liveClose";
import { runPickTick, shortBlockedReason } from "../src/lib/pickRunner";
import type { BrokerOrder } from "../src/lib/broker/types";
import {
  ACCOUNT_1K,
  LIVE_ON,
  pickSetup,
  TODAY,
  type BarSpec,
  type FakeLiveBroker,
} from "./helpers/liveFake";

const SPECS = (): Record<string, BarSpec> => ({
  NVDA: { kind: "drive", mult: 12, price: 130 },
  WMT: { kind: "drive", mult: 6, price: 128 },
  AAPL: { kind: "drive", mult: 8, price: 344 },
});

type T = ReturnType<typeof pickSetup>;
const tick = (t: T, opts: { dryRun?: boolean; lossOnly?: boolean } = {}) =>
  runPickTick(t.deps, t.settings, { dryRun: opts.dryRun ?? false, lossOnly: opts.lossOnly });
const ids = (t: T) => t.broker.submitted.map((o) => o.clientOrderId);
const filled = (id: string, ticker: string, side: "buy" | "sell" = "buy"): BrokerOrder => ({
  id: `x-${id}`,
  clientOrderId: id,
  status: "filled",
  ticker,
  side,
  quantity: 1,
});
function seedHeld(t: T, ticker: string, side: "long" | "short" = "long", quantity = 1) {
  t.broker.positions.push({ ticker, side, quantity, avgEntryPrice: 130 });
  t.broker.orders.push(filled(`pol-20261119-e01-${ticker}`, ticker, side === "long" ? "buy" : "sell"));
}
const closeDeps = (t: T) => ({ broker: t.broker as FakeLiveBroker, config: t.deps.config, audit: t.deps.audit, now: t.deps.now, sleep: t.deps.sleep });

describe("the pick fills the free slots from the ranking and enters each stock once", () => {
  it("enters the strongest readings with ids pol-{date}-eNN-{TICKER} (one per ticker), 1 share each, buys; a stock too dear for the cap is skipped", async () => {
    const t = pickSetup({ specs: SPECS() });
    const r = await tick(t);
    assert.ok(r.ok);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA", "pol-20261119-e02-WMT"]);
    assert.deepEqual(t.broker.submitted.map((o) => [o.side, o.quantity, o.timeInForce]), [["buy", 1, "day"], ["buy", 1, "day"]]);
    const first = t.audit.find((a) => a.outcome === "entered")!;
    assert.equal(first.source, "pick-runner");
    assert.match(first.notes[0], /^Ranked: NVDA .*WMT/);
    assert.ok(t.audit.some((a) => a.outcome === "aside" && a.notes.some((n) => /^AAPL: rounds to zero shares/.test(n))));
  });

  it("never adds on the next tick: held, aligned stocks are left alone and a stock already entered today is not re-entered", async () => {
    const t = pickSetup({ specs: { NVDA: SPECS().NVDA, WMT: SPECS().WMT } });
    await tick(t);
    await tick(t);
    await tick(t);
    assert.equal(t.broker.submitted.length, 2);
    assert.ok(t.audit.slice(-3).some((a) => a.outcome === "held" && /Polarity unchanged/.test(a.reason)));
  });

  it("while the first order is still working a second tick sends nothing", async () => {
    const t = pickSetup({ specs: SPECS() });
    t.broker.fill = false;
    await tick(t);
    await tick(t);
    assert.equal(t.broker.submitted.length, 1);
    assert.match(t.audit.at(-1)!.reason, /still working/);
  });

  it("before the pick start (10:00 New York) nothing is picked", async () => {
    const t = pickSetup({ specs: SPECS(), now: new Date("2026-11-19T14:45:00Z") });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.match(t.audit.at(-1)!.reason, /Pick starts at 10:00/);
  });

  it("outside the session, or on stale bars, nothing is sent", async () => {
    const closed = pickSetup({ specs: SPECS(), now: new Date("2026-11-19T21:30:00Z") });
    await tick(closed);
    assert.equal(closed.broker.submitted.length, 0);
    const stale = pickSetup({ specs: { NVDA: { kind: "drive", last: "2026-11-18" } } });
    await tick(stale);
    assert.equal(stale.broker.submitted.length, 0);
    assert.match(stale.audit.at(-1)!.notes.join(" "), /not today/);
  });

  it("refuses to trade when the account cannot be trusted", async () => {
    const t = pickSetup({ specs: SPECS(), account: { lastEquity: 0 } });
    const r = await tick(t);
    assert.equal(r.ok, false);
    const blocked = pickSetup({ specs: SPECS(), account: { tradingBlocked: true } });
    assert.equal((await tick(blocked)).ok, false);
    assert.equal(t.broker.submitted.length + blocked.broker.submitted.length, 0);
  });

  it("a bars failure for every name means no order and no crash", async () => {
    const t = pickSetup({ specs: SPECS() });
    t.deps.loadBars = async () => {
      throw new Error("rate limited");
    };
    const r = await tick(t);
    assert.ok(r.ok);
    assert.equal(t.broker.submitted.length, 0);
    assert.match(t.audit.at(-1)!.notes.join(" "), /rate limited/);
  });
});

describe("live switched off or observe-only", () => {
  it("with live trading not enabled a tick only observes and says what it would do", async () => {
    const t = pickSetup({ specs: SPECS(), config: { enabled: false, killed: false, configured: true } });
    const r = await tick(t);
    assert.ok(r.ok);
    assert.equal(r.dryRun, true);
    assert.equal(t.broker.submitted.length, 0);
    assert.ok(t.audit.some((a) => a.outcome === "dry-run" && /Would enter long 1 NVDA as entry 1/.test(a.reason)));
  });

  it("?dry=1 never sends even when trading is enabled", async () => {
    const t = pickSetup({ specs: SPECS() });
    await tick(t, { dryRun: true });
    assert.equal(t.broker.submitted.length, 0);
  });

  it("the kill switch stops everything with an error", async () => {
    const t = pickSetup({ specs: SPECS(), config: { enabled: true, killed: true, configured: true } });
    const r = await tick(t);
    assert.equal(r.ok, false);
    assert.equal(t.broker.submitted.length, 0);
  });

  it("without live credentials it errors instead of trading", async () => {
    const t = pickSetup({ specs: SPECS(), config: { enabled: true, killed: false, configured: false } });
    assert.equal((await tick(t)).ok, false);
    const obs = pickSetup({ specs: SPECS(), config: { enabled: false, killed: false, configured: false } });
    assert.equal((await tick(obs)).ok, false);
  });

  it("observe mode would close a held position and would re-enter, without sending", async () => {
    const t = pickSetup({ specs: { NVDA: { kind: "neutral" } }, config: { enabled: false, killed: false, configured: true } });
    seedHeld(t, "NVDA");
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.ok(t.audit.some((a) => /Would close long 1 NVDA/.test(a.reason)));
  });
});

const ONE = (): Record<string, BarSpec> => ({ NVDA: SPECS().NVDA });

describe("close, then the slot goes to the next stock (one automatic entry per ticker per day)", () => {
  it("a manual close sends a real sell as c01-a1; the same day the automation does NOT re-enter that ticker, it fills the slot with the next-ranked one", async () => {
    const t = pickSetup({ specs: SPECS() });
    await tick(t);
    const closed = await closeLivePosition(closeDeps(t), "NVDA");
    assert.ok(closed.ok);
    assert.equal(closed.ok && closed.status, "submitted");
    assert.equal(closed.ok && closed.flat, true);
    t.specs.WMT.mult = 40;
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA", "pol-20261119-e02-WMT", "pol-20261119-c01-a1-NVDA"]);
    assert.deepEqual(t.broker.positions.map((p) => p.ticker), ["WMT"]);
    await tick(t);
    assert.equal(t.broker.submitted.length, 3, "no re-entry of NVDA and no double entry");
    assert.ok(t.audit.some((a) => a.notes.some((n) => /^NVDA: already entered today/.test(n))));
  });

  it("a second Close click on the same position is a no-op (same id)", async () => {
    const t = pickSetup({ specs: ONE() });
    await tick(t);
    t.broker.fill = false;
    const first = await closeLivePosition(closeDeps(t), "NVDA");
    assert.ok(first.ok && first.status === "submitted");
    assert.equal(first.ok && first.flat, false);
    const second = await closeLivePosition(closeDeps(t), "NVDA");
    assert.ok(second.ok && second.status === "noop");
    assert.equal(t.broker.submitted.length, 2);
  });

  it("the automation closes a stock on Neutral (c01-a1) and does not re-enter it today even if Drive returns", async () => {
    const t = pickSetup({ specs: ONE() });
    await tick(t);
    t.specs.NVDA = { kind: "neutral" };
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA", "pol-20261119-c01-a1-NVDA"]);
    assert.equal(t.broker.positions.length, 0);
    await tick(t);
    assert.equal(t.broker.submitted.length, 2, "Neutral: stays flat");
    t.specs.NVDA = { kind: "drive", mult: 12, price: 130 };
    await tick(t);
    assert.equal(t.broker.submitted.length, 2, "one entry per ticker per day: no same-day re-entry");
    assert.match(t.audit.at(-1)!.notes.join(" "), /NVDA: already entered today/);
  });

  it("a flip to Reverse closes the long and never opens a short (long only)", async () => {
    const t = pickSetup({ specs: ONE() });
    await tick(t);
    t.specs.NVDA = { kind: "reverse", mult: 12, price: 130 };
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-NVDA", "pol-20261119-c01-a1-NVDA"]);
    assert.equal(t.broker.positions.length, 0);
    await tick(t);
    assert.equal(t.broker.submitted.length, 2);
  });

  it("the ticker limit is per day: the next session enters it again (a new date in the id)", async () => {
    const t = pickSetup({ specs: ONE() });
    await tick(t);
    await closeLivePosition(closeDeps(t), "NVDA");
    await tick(t);
    assert.equal(t.broker.submitted.length, 2);
    t.setNow(new Date("2026-11-20T20:00:00Z"));
    for (const k of Object.keys(t.specs)) t.specs[k] = { ...t.specs[k], last: "2026-11-20" };
    await tick(t);
    assert.equal(t.broker.submitted.at(-1)!.clientOrderId, "pol-20261120-e01-NVDA");
  });

  it("rejected or canceled entries do not use up the ticker's automatic entry (the entry number just moves on)", async () => {
    const t = pickSetup({ specs: ONE() });
    for (const n of [1, 2, 3, 4]) {
      t.broker.orders.push({ ...filled(`pol-20261119-e0${n}-NVDA`, "NVDA"), status: n % 2 ? "rejected" : "canceled" });
    }
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e05-NVDA"]);
  });

  it("the next entry number comes from the broker's orders, so a restart cannot reuse an id", async () => {
    const t = pickSetup({ specs: ONE() });
    t.broker.orders.push({ ...filled("pol-20261119-e01-NVDA", "NVDA"), status: "canceled" });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e02-NVDA"]);
  });

  it("a stock entered today that has since left the watchlist does not block the others", async () => {
    const t = pickSetup({ specs: { WMT: { kind: "drive" } } });
    t.broker.orders.push({ ...filled("pol-20261119-e01-NVDA", "NVDA"), status: "canceled" });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e02-WMT"]);
  });
});

describe("rejected close", () => {
  it("shows no closed state: the position stays, nothing re-enters, and the error is audited", async () => {
    const t = pickSetup({ specs: ONE() });
    await tick(t);
    t.broker.rejectNext.push({ code: "REJECTED", error: "Alpaca live API returned 403: wash trade" });
    const res = await closeLivePosition(closeDeps(t), "NVDA");
    assert.equal(res.ok, false);
    assert.equal(t.broker.positions.length, 1);
    assert.ok(t.audit.some((a) => a.source === "live-manual-close" && a.outcome === "error"));
    await tick(t);
    assert.equal(t.broker.orders.filter((o) => o.clientOrderId.includes("-e0")).length, 1);
  });

  it("an automatic close that Alpaca rejects is retried under the next attempt id", async () => {
    const t = pickSetup({ specs: { NVDA: { kind: "neutral" } } });
    seedHeld(t, "NVDA");
    t.broker.orders.push({ ...filled("pol-20261119-c01-a1-NVDA", "NVDA", "sell"), status: "rejected" });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-c01-a2-NVDA"]);
  });

  it("after three failed attempts the breaker trips: no order, a loud error, no new entries", async () => {
    const t = pickSetup({ specs: { NVDA: { kind: "neutral" } } });
    seedHeld(t, "NVDA");
    for (const [i, st] of ["rejected", "canceled", "expired"].entries()) {
      t.broker.orders.push({ ...filled(`pol-20261119-c01-a${i + 1}-NVDA`, "NVDA", "sell"), status: st });
    }
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.equal(t.audit.at(-1)!.outcome, "error");
    assert.match(t.audit.at(-1)!.reason, /Circuit breaker/);
  });
});

describe("1% stop-out", () => {
  it("flattens with the stop id even if the signal says go, and sends nothing else", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 989 } });
    seedHeld(t, "NVDA");
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-s01-a1-NVDA"]);
    assert.equal(t.broker.submitted[0].side, "sell");
    assert.match(t.audit.at(-1)!.reason, /Daily stop \(1%\) reached/);
  });

  it("then no re-entry for the rest of the day, even after a deposit lifts equity back", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 989 } });
    seedHeld(t, "NVDA");
    await tick(t);
    t.broker.account = { ...ACCOUNT_1K, equity: 1_500, lastEquity: 1_000, cash: 1_500, buyingPower: 1_500 };
    await tick(t);
    await tick(t);
    assert.equal(t.broker.submitted.length, 1);
    assert.match(t.audit.at(-1)!.reason, /Stopped out earlier today/);
  });

  it("a stop-out whose flatten did not go through is retried even after equity recovers", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 1_005 } });
    seedHeld(t, "NVDA");
    t.broker.orders.push({ ...filled("pol-20261119-s01-a1-NVDA", "NVDA", "sell"), status: "rejected" });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-s01-a2-NVDA"]);
    assert.equal(t.broker.positions.length, 0);
  });

  it("a flat account already at -1% stands aside and sends nothing", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 985 } });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.equal(t.audit.at(-1)!.outcome, "aside");
  });

  it("just inside the stop it still follows the signal", async () => {
    const t = pickSetup({ specs: ONE(), account: { equity: 990.5 } });
    await tick(t);
    assert.equal(t.broker.submitted.length, 1);
  });

  it("a manual close at a loss that takes the day to -1% keeps the automation out", async () => {
    const t = pickSetup({ specs: ONE() });
    await tick(t);
    await closeLivePosition(closeDeps(t), "NVDA");
    t.broker.account = { ...ACCOUNT_1K, equity: 989 };
    await tick(t);
    assert.equal(t.broker.submitted.length, 2);
  });

  it("a small manual loss that leaves the day above -1% does not stop anything (but the closed ticker is not re-entered today)", async () => {
    const t = pickSetup({ specs: { NVDA: SPECS().NVDA, WMT: SPECS().WMT } });
    await tick(t);
    await closeLivePosition(closeDeps(t), "NVDA");
    t.broker.account = { ...ACCOUNT_1K, equity: 995 };
    await tick(t);
    assert.equal(t.broker.submitted.length, 3);
    assert.ok(!ids(t).some((id) => /-s\d\d-/.test(id)), "no stop-out");
    assert.deepEqual(t.broker.positions.map((p) => p.ticker), ["WMT"]);
  });

  it("the loss-only backstop stops out but never enters or follows the signal", async () => {
    const flat = pickSetup({ specs: SPECS() });
    await tick(flat, { lossOnly: true });
    assert.equal(flat.broker.submitted.length, 0);
    const held = pickSetup({ specs: { NVDA: { kind: "neutral" } } });
    seedHeld(held, "NVDA");
    await tick(held, { lossOnly: true });
    assert.equal(held.broker.submitted.length, 0, "no signal-based close in the backstop");
    const stopped = pickSetup({ specs: SPECS(), account: { equity: 980 } });
    seedHeld(stopped, "NVDA");
    await tick(stopped, { lossOnly: true });
    assert.deepEqual(ids(stopped), ["pol-20261119-s01-a1-NVDA"]);
  });

  it("a custom stop is honoured", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 997 }, env: { POLARITO_LIVE_DAILY_LOSS_PCT: "0.25" } });
    seedHeld(t, "NVDA");
    await tick(t);
    assert.match(ids(t)[0], /-s01-a1-NVDA$/);
  });
});

describe("affordability and the cap", () => {
  it("a top-ranked name that rounds to zero shares is skipped for the next, with the reason logged", async () => {
    const t = pickSetup({ specs: { BIG: { kind: "drive", mult: 20, price: 900 }, WMT: { kind: "drive", mult: 5, price: 128 } } });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-WMT"]);
    assert.ok(t.audit.at(-1)!.notes.some((n) => /^BIG: .*per-position cap/.test(n)));
  });

  it("if nothing is affordable no order is sent", async () => {
    const t = pickSetup({ specs: { BIG: { kind: "drive", price: 900 }, HUGE: { kind: "drive", price: 1_106 } } });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.match(t.audit.at(-1)!.reason, /No eligible candidate/);
  });

  it("an asset that is not tradable is skipped", async () => {
    const t = pickSetup({ specs: SPECS() });
    t.broker.assets.set("NVDA", { symbol: "NVDA", status: "active", tradable: false, shortable: false, borrowStatus: null });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-WMT"]);
    assert.ok(t.audit.some((a) => a.notes.some((n) => /^NVDA: asset is not tradable/.test(n))));
  });

  it("unmanaged positions outside the watchlist are never touched, even at the stop", async () => {
    const t = pickSetup({ specs: SPECS(), account: { equity: 980 } });
    t.broker.positions.push({ ticker: "KO", side: "long", quantity: 1, avgEntryPrice: 60 });
    t.broker.positions.push({ ticker: "SPY260619C00500000", side: "long", quantity: 1, avgEntryPrice: 5 });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
  });
});

describe("GOOGL and GOOG are one candidate", () => {
  const twin = () => ({
    GOOGL: { kind: "drive" as const, mult: 12, price: 270 },
    GOOG: { kind: "drive" as const, mult: 12, price: 270 },
    NVDA: { kind: "drive" as const, mult: 5, price: 130 },
  });
  const entries = (t: T) => ids(t).filter((id) => /-e\d\d-/.test(id));

  it("an exact tie trades GOOG (alphabetical), only one share class, and uses one slot", async () => {
    const t = pickSetup({ specs: twin() });
    await tick(t);
    await tick(t);
    assert.deepEqual(entries(t), ["pol-20261119-e01-GOOG", "pol-20261119-e02-NVDA"]);
    assert.deepEqual(t.broker.positions.map((p) => p.ticker).sort(), ["GOOG", "NVDA"]);
  });

  it("the more liquid class wins the tie", async () => {
    const specs = twin();
    specs.GOOGL = { kind: "drive", mult: 12, price: 270, baseVolume: 5_000 } as never;
    const t = pickSetup({ specs });
    await tick(t);
    assert.equal(entries(t)[0], "pol-20261119-e01-GOOGL");
  });

  it("after the company is closed the other class is not entered either (one entry per company per day)", async () => {
    const t = pickSetup({ specs: twin() });
    await tick(t);
    await closeLivePosition(closeDeps(t), "GOOG");
    t.specs.GOOGL.mult = 60;
    await tick(t);
    assert.deepEqual(entries(t), ["pol-20261119-e01-GOOG", "pol-20261119-e02-NVDA"]);
  });

  it("if the chosen class is not tradable the other class is used once, before the next company", async () => {
    const t = pickSetup({ specs: twin() });
    t.broker.assets.set("GOOG", { symbol: "GOOG", status: "active", tradable: false, shortable: false, borrowStatus: null });
    await tick(t);
    assert.deepEqual(entries(t), ["pol-20261119-e01-GOOGL", "pol-20261119-e02-NVDA"]);
  });

  it("when one class is Neutral the other class trades", async () => {
    const specs = twin();
    specs.GOOG = { kind: "neutral" } as never;
    const t = pickSetup({ specs });
    await tick(t);
    assert.equal(entries(t)[0], "pol-20261119-e01-GOOGL");
  });
});

describe("long only at any equity", () => {
  const downOnTop = () => ({ DOWN: { kind: "reverse" as const, mult: 20, price: 130 }, UP: { kind: "drive" as const, mult: 5, price: 128 } });

  it("default fallback: a Reverse name on top means the day stands aside (no weaker Drive stock)", async () => {
    const t = pickSetup({ specs: downOnTop() });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
    assert.match(t.audit.at(-1)!.reason, /Standing aside/);
  });

  it("fallback=next: the next eligible Drive stock is taken, long", async () => {
    const t = pickSetup({ specs: downOnTop(), env: { POLARITO_LIVE_LONG_ONLY_FALLBACK: "next" } });
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-UP"]);
    assert.equal(t.broker.submitted[0].side, "buy");
  });

  it("shorting is blocked below $2,000 and when the account does not report it enabled", () => {
    assert.match(shortBlockedReason({ ...ACCOUNT_1K, equity: 1_999.99, shortingEnabled: true }) ?? "", /\$2,000/);
    assert.match(shortBlockedReason({ ...ACCOUNT_1K, equity: 5_000, shortingEnabled: false }) ?? "", /not report shorting/);
    assert.match(shortBlockedReason({ ...ACCOUNT_1K, equity: 5_000, shortingEnabled: undefined }) ?? "", /not report shorting/);
    assert.equal(shortBlockedReason({ ...ACCOUNT_1K, equity: 2_000, shortingEnabled: true }), null);
  });

  const rich = { equity: 2_000, lastEquity: 2_000, cash: 2_000, buyingPower: 4_000, shortingEnabled: true, multiplier: 2 };

  it("even at $2,000 with shorting enabled and an easy-to-borrow asset a Reverse reading is never sold short", async () => {
    const t = pickSetup({ specs: downOnTop(), account: rich });
    t.broker.assets.set("DOWN", { symbol: "DOWN", status: "active", tradable: true, shortable: true, borrowStatus: "easy_to_borrow" });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0, "default fallback: stand aside");
    const next = pickSetup({ specs: downOnTop(), account: rich, env: { POLARITO_LIVE_LONG_ONLY_FALLBACK: "next" } });
    next.broker.assets.set("DOWN", { symbol: "DOWN", status: "active", tradable: true, shortable: true, borrowStatus: "easy_to_borrow" });
    await tick(next);
    assert.deepEqual(ids(next), ["pol-20261119-e01-UP"]);
    assert.ok(next.broker.submitted.every((o) => o.side === "buy"));
  });

  it("a short on an asset that is not shortable or not easy to borrow is skipped", async () => {
    const notShortable = pickSetup({ specs: downOnTop(), account: rich, env: { POLARITO_LIVE_LONG_ONLY_FALLBACK: "next" } });
    notShortable.broker.assets.set("DOWN", { symbol: "DOWN", status: "active", tradable: true, shortable: false, borrowStatus: "easy_to_borrow" });
    await tick(notShortable);
    assert.deepEqual(ids(notShortable), ["pol-20261119-e01-UP"]);
    const hard = pickSetup({ specs: downOnTop(), account: rich, env: { POLARITO_LIVE_LONG_ONLY_FALLBACK: "next" } });
    hard.broker.assets.set("DOWN", { symbol: "DOWN", status: "active", tradable: true, shortable: true, borrowStatus: "hard_to_borrow" });
    await tick(hard);
    assert.deepEqual(ids(hard), ["pol-20261119-e01-UP"]);
  });

  it("just under $2,000 the same Reverse reading is refused", async () => {
    const t = pickSetup({ specs: downOnTop(), account: { ...rich, equity: 1_999, lastEquity: 1_999 } });
    t.broker.assets.set("DOWN", { symbol: "DOWN", status: "active", tradable: true, shortable: true, borrowStatus: "easy_to_borrow" });
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
  });

  it("a flip at $2,000 closes the long and does not open the short", async () => {
    const t = pickSetup({ specs: { DOWN: { kind: "drive", mult: 9, price: 130 } }, account: rich });
    t.broker.assets.set("DOWN", { symbol: "DOWN", status: "active", tradable: true, shortable: true, borrowStatus: "easy_to_borrow" });
    await tick(t);
    t.specs.DOWN = { kind: "reverse", mult: 9, price: 130 };
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-e01-DOWN", "pol-20261119-c01-a1-DOWN"]);
    assert.deepEqual(t.broker.submitted.map((o) => o.side), ["buy", "sell"]);
    assert.equal(t.broker.positions.length, 0);
  });
});

describe("end of day", () => {
  it("flattens at 15:55 New York and enters nothing afterward", async () => {
    const t = pickSetup({ specs: SPECS(), now: new Date("2026-11-19T20:56:00Z") });
    seedHeld(t, "NVDA");
    await tick(t);
    assert.deepEqual(ids(t), ["pol-20261119-c01-a1-NVDA"]);
    await tick(t);
    assert.equal(t.broker.submitted.length, 1);
    assert.match(t.audit.at(-1)!.reason, /End-of-day flatten/);
  });

  it("can be switched off to hold overnight", async () => {
    const t = pickSetup({ specs: ONE(), now: new Date("2026-11-19T20:56:00Z"), env: { POLARITO_LIVE_FLATTEN_AT: "off" } });
    seedHeld(t, "NVDA");
    await tick(t);
    assert.equal(t.broker.submitted.length, 0);
  });
});

describe("closeLivePosition", () => {
  it("is observe-only (nothing sent, position still shown open) when live trading is off", async () => {
    const t = pickSetup({ specs: SPECS(), config: { enabled: false, killed: false, configured: true } });
    seedHeld(t, "NVDA");
    const res = await closeLivePosition(closeDeps(t), "NVDA");
    assert.ok(res.ok);
    assert.equal(res.ok && res.status, "observed");
    assert.equal(res.ok && res.flat, null);
    assert.equal(t.broker.submitted.length, 0);
    assert.ok(t.audit.some((a) => a.source === "live-manual-close" && /Would close long 1 NVDA/.test(a.reason)));
  });

  it("refuses with the kill switch on, bad tickers, and says so when there is nothing to close", async () => {
    const t = pickSetup({ specs: SPECS() });
    seedHeld(t, "NVDA");
    const killed = await closeLivePosition({ ...closeDeps(t), config: { enabled: true, killed: true, configured: true } }, "NVDA");
    assert.equal(killed.ok, false);
    const bad = await closeLivePosition(closeDeps(t), "12$");
    assert.equal(!bad.ok && bad.code, "INVALID");
    const none = await closeLivePosition(closeDeps(t), "WMT");
    assert.ok(none.ok && none.status === "none");
    assert.equal(t.broker.submitted.length, 0);
  });

  it("closes the broker's real quantity (not the browser's) and reports flat only when the position is gone", async () => {
    const t = pickSetup({ specs: SPECS() });
    seedHeld(t, "NVDA", "long", 3);
    const res = await closeLivePosition({ ...closeDeps(t), config: LIVE_ON }, "nvda");
    assert.ok(res.ok && res.flat === true);
    assert.deepEqual([t.broker.submitted[0].side, t.broker.submitted[0].quantity], ["sell", 3]);

    const slow = pickSetup({ specs: SPECS() });
    seedHeld(slow, "NVDA");
    slow.broker.fill = false;
    const pending = await closeLivePosition(closeDeps(slow), "NVDA");
    assert.ok(pending.ok);
    assert.equal(pending.ok && pending.flat, false);
    assert.match(pending.ok ? pending.message : "", /stays shown as open/);
  });

  it("covers a short with a buy", async () => {
    const t = pickSetup({ specs: SPECS() });
    seedHeld(t, "NVDA", "short", 2);
    await closeLivePosition(closeDeps(t), "NVDA");
    assert.deepEqual([t.broker.submitted[0].side, t.broker.submitted[0].quantity], ["buy", 2]);
  });
});

describe("the pick reuses POLARITO's signal code", () => {
  const src = readFileSync(new URL("../src/lib/pickRunner.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  it("goes through computePolaritySeries and buildAutoSimInput and has no gate or noise floor of its own", () => {
    assert.match(src, /computePolaritySeries\(bars\)/);
    assert.match(src, /buildAutoSimInput\(pos\.ticker, a\.series, "signal-close"\)/);
    assert.doesNotMatch(src, /netVolume|noiseFloor|NOISE_FLOOR|VOLUME_MA|gate\(/);
  });
  it("registers its audit sources", () => {
    assert.ok((AUDIT_SOURCES as readonly string[]).includes("pick-runner"));
    assert.ok((AUDIT_SOURCES as readonly string[]).includes("live-close"));
  });
  it("TODAY is the date the fixtures assume", () => {
    assert.equal(TODAY, "2026-11-19");
  });
});
