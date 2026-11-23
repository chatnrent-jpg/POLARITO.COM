import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";
import { FALLBACK_LABEL } from "../src/lib/optionsSelect";
import { etClock } from "../src/lib/marketCalendar";
import {
  AUTO_LOCK_KEY,
  AUTO_LOG_KEY,
  AUTO_SWITCH_KEY,
  buildAutoView,
  readLog,
  readSwitch,
  runAutoCycle,
  setAutoSwitch,
  type AutoRunResult,
} from "../src/lib/spyAuto";
import { AUTO_LOG_MAX, AUTO_UNAVAILABLE, isAutoView, parseAutoLog, type AutoLogEntry } from "../src/lib/spyAutoTypes";
import { CRON_SECRET_MIN_LENGTH, cronAuthorized, handleAutoRun, handleAutoSwitch, parseSwitchRequest, type AutoRouteContext } from "../src/lib/spyAutoRoutes";
import { buildDeskSnapshot, entryMode, parseDeskSnapshot, type DeskConfig, type DeskDeps, type DeskPosition, type DeskState, type DeskStore, type JournalEntry } from "../src/lib/spyDesk";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { createKvSpyKv, createMemorySpyKv, createSpyKv } from "../src/lib/spyKv";
import { DRIVE, NEUTRAL, REVERSE, T0, makeDeps, row, side, type Calls, type Scenario } from "./helpers/spyDeskFixtures";

const CFG: DeskConfig = { timeframe: "M", liveBudget: 1000 };
const NEAREST = "2027-11-05";
const calls = (): Calls => ({ daily: 0, spot: 0, sides: [], held: 0 });
const SWITCH_ON = JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" });

type Rig = { kv: ReturnType<typeof createMemorySpyKv>; desk: ReturnType<typeof createMemoryDeskStore>; c: Calls; deps: DeskDeps; run(dry?: boolean): Promise<AutoRunResult> };

function rig(sc: Scenario, o: { on?: boolean; state?: DeskState; opts?: Parameters<typeof makeDeps>[1]; deps?: (d: DeskDeps) => DeskDeps; desk?: DeskStore } = {}): Rig {
  const kv = createMemorySpyKv();
  if (o.on !== false) kv.data.set(AUTO_SWITCH_KEY, { value: SWITCH_ON, expiresAt: null });
  const desk = createMemoryDeskStore(o.state);
  const c = calls();
  const base = makeDeps(sc, { calls: c, ...o.opts });
  const deps = o.deps ? o.deps(base) : base;
  return { kv, desk, c, deps, run: (dry = false) => runAutoCycle(deps, CFG, { desk: o.desk ?? desk, kv }, { dryRun: dry }) };
}

function held(type: "call" | "put", strike: number, source: DeskPosition["source"] = "auto", journal: JournalEntry[] = []): DeskState {
  const r = row(type, NEAREST, strike);
  const position: DeskPosition = {
    type, symbol: r.symbol, expiration: NEAREST, strike, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta,
    deltaTier: "primary", fallbackReason: null, decisionTimeframe: "M", maxLossUsd: r.ask * 100, source,
  };
  return { version: 1, position, journal };
}

function journalEntry(kind: JournalEntry["kind"], at = "2026-11-03T20:00:00.000Z"): JournalEntry {
  return { id: `${kind}-${at}`, at, kind, symbol: "SPY271105C00600000", type: "call", strike: 600, expiration: NEAREST, delta: 0.9, costUsd: 9000, exitBid: null, pnlUsd: null, note: "earlier" };
}

const logOf = async (kv: ReturnType<typeof createMemorySpyKv>): Promise<AutoLogEntry[]> => {
  const r = await readLog(kv);
  assert.ok(r.ok);
  return r.log;
};
const stateOf = async (desk: ReturnType<typeof createMemoryDeskStore>): Promise<DeskState> => {
  const r = await desk.read();
  assert.ok(r.ok);
  return r.state;
};

describe("Auto switch", () => {
  it("defaults to OFF: no key means no action, no market data is read, and the decision is logged", async () => {
    const r = rig(DRIVE, { on: false });
    const out = await r.run();
    assert.equal(out.outcome, "off");
    assert.equal(out.status, 200);
    assert.equal((await stateOf(r.desk)).position, null);
    assert.deepEqual(r.c, { daily: 0, spot: 0, sides: [], held: 0 });
    const log = await logOf(r.kv);
    assert.equal(log.length, 1);
    assert.equal(log[0].outcome, "off");
  });
  it("an explicit OFF, a malformed value and an unreadable switch all mean OFF (fail closed)", async () => {
    for (const value of [JSON.stringify({ auto: false, at: "x" }), "not json", JSON.stringify({ auto: "yes" })]) {
      const r = rig(DRIVE, { on: false });
      r.kv.data.set(AUTO_SWITCH_KEY, { value, expiresAt: null });
      const out = await r.run();
      assert.equal(out.outcome, "off");
      assert.equal((await stateOf(r.desk)).position, null);
    }
    const r = rig(DRIVE);
    const real = r.kv;
    const flaky = { ...real, get: async (k: string) => (k === AUTO_SWITCH_KEY ? { ok: false as const, error: "switch store down" } : real.get(k)) };
    const out = await runAutoCycle(r.deps, CFG, { desk: r.desk, kv: flaky }, {});
    assert.equal(out.outcome, "off");
    assert.match(out.message, /switch store down/);
    assert.equal((await stateOf(r.desk)).position, null);
  });
  it("turning it ON and OFF is verified, logged, and takes the run lock", async () => {
    const kv = createMemorySpyKv();
    const on = await setAutoSwitch(kv, true, T0);
    assert.ok(on.ok);
    const sw = await readSwitch(kv);
    assert.ok(sw.ok && sw.on === true);
    const off = await setAutoSwitch(kv, false, T0);
    assert.ok(off.ok);
    const log = await logOf(kv);
    assert.deepEqual(log.map((e) => e.outcome), ["switch-on", "switch-off"]);
    assert.equal(kv.data.has(AUTO_LOCK_KEY), false);
    kv.data.set(AUTO_LOCK_KEY, { value: "someone", expiresAt: null });
    const busy = await setAutoSwitch(kv, true, T0);
    assert.ok(!busy.ok && busy.status === 409);
    assert.equal((await setAutoSwitch(null, true, T0)).ok, false);
    const dropped = createMemorySpyKv();
    dropped.dropWrites = true;
    assert.equal((await setAutoSwitch(dropped, true, T0)).ok, false);
  });
});

describe("Auto: when it may act (calendar and data)", () => {
  it("not a trading day (Saturday, holiday) and before 16:15 ET: no action, logged", async () => {
    for (const [now, why] of [["2026-11-07T21:30:00Z", /not a trading day/], ["2026-11-26T21:30:00Z", /not a trading day/], ["2026-11-03T19:00:00Z", /has not closed yet/]] as const) {
      const r = rig(DRIVE, { opts: { now: new Date(now) } });
      const out = await r.run();
      assert.equal(out.outcome, "skipped");
      assert.match(out.message, why);
      assert.equal((await stateOf(r.desk)).position, null);
      assert.equal(r.c.daily, 0);
    }
  });
  it("stale daily bars, failing bars, missing spot, or an unreadable desk record: REFUSE, nothing traded", async () => {
    const stale = rig(DRIVE, { opts: { now: new Date("2026-11-05T21:30:00Z") } });
    const s = await stale.run();
    assert.equal(s.outcome, "refused");
    assert.equal(s.status, 503);
    assert.match(s.message, /stale data/);

    const bars = rig(DRIVE, { opts: { dailyFails: true } });
    assert.equal((await bars.run()).outcome, "refused");

    const spot = rig(DRIVE, { opts: { spotFails: true } });
    const sp = await spot.run();
    assert.equal(sp.outcome, "refused");
    assert.match(sp.message, /SPY price could not be read/);

    const deskDown = rig(DRIVE);
    deskDown.desk.failReads = true;
    const dd = await deskDown.run();
    assert.equal(dd.outcome, "refused");
    assert.match(dd.message, /desk record could not be read/);

    for (const x of [stale, bars, spot]) assert.equal((await stateOf(x.desk)).position, null);
    assert.equal((await logOf(stale.kv))[0].outcome, "refused");
  });
  it("without its audit log Auto does not trade at all", async () => {
    const r = rig(DRIVE);
    r.kv.failReads = true;
    const out = await r.run();
    assert.equal(out.outcome, "refused");
    assert.equal((await stateOf(r.desk)).position, null);
    assert.equal(r.c.daily, 0);
    const bad = rig(DRIVE);
    bad.kv.data.set(AUTO_LOG_KEY, { value: JSON.stringify([{ nope: 1 }]), expiresAt: null });
    assert.equal((await bad.run()).outcome, "refused");
    assert.equal((await stateOf(bad.desk)).position, null);
  });
  it("no store configured: refuses and does nothing", async () => {
    const r = rig(DRIVE);
    assert.equal((await runAutoCycle(r.deps, CFG, { desk: null, kv: r.kv }, {})).outcome, "refused");
    assert.equal((await runAutoCycle(r.deps, CFG, { desk: r.desk, kv: null }, {})).outcome, "refused");
  });
  it("the daily-bars call throwing is caught: error result, lock released, nothing traded", async () => {
    const r = rig(DRIVE, { deps: (d) => ({ ...d, loadDaily: async () => { throw new Error("boom"); } }) });
    const out = await r.run();
    assert.equal(out.outcome, "error");
    assert.equal(out.status, 500);
    assert.equal(r.kv.data.has(AUTO_LOCK_KEY), false);
    assert.equal((await stateOf(r.desk)).position, null);
  });
});

describe("Auto: no position", () => {
  it("Drive: opens the call the contract rules pick, at the ask, labelled AUTO, and logs it", async () => {
    const r = rig(DRIVE);
    const out = await r.run();
    assert.equal(out.outcome, "opened");
    assert.equal(out.status, 200);
    const pick = side("call").pick;
    assert.ok(pick.ok);
    const st = await stateOf(r.desk);
    assert.ok(st.position);
    assert.equal(st.position.type, "call");
    assert.equal(st.position.source, "auto");
    assert.equal(st.position.symbol, pick.row.symbol);
    assert.equal(st.position.entryAsk, pick.row.ask);
    assert.equal(st.position.quantity, 1);
    assert.equal(st.position.deltaTier, pick.tier);
    assert.equal(st.journal.length, 1);
    assert.equal(st.journal[0].kind, "auto-open");
    assert.equal(entryMode(st.journal[0].kind), "AUTO");
    assert.match(st.journal[0].note, /^AUTO dry-run buy/);
    assert.match(st.journal[0].note, /No order sent/);
    const log = await logOf(r.kv);
    assert.deepEqual(log.map((e) => e.outcome), ["opened"]);
    assert.equal(log[0].reading, "Drive");
    assert.equal(log[0].ask, pick.row.ask);
    assert.equal(r.kv.data.has(AUTO_LOCK_KEY), false);
  });
  it("Reverse: opens a put; when no put reaches 0.80 it takes the cheapest at 0.60 or better and says FALLBACK", async () => {
    const r = rig(REVERSE, { opts: { putStrikes: [690, 800, 850, 900] } });
    const out = await r.run();
    assert.equal(out.outcome, "opened");
    const st = await stateOf(r.desk);
    assert.equal(st.position?.type, "put");
    assert.equal(st.position?.deltaTier, "fallback");
    assert.ok(st.position?.fallbackReason);
    assert.ok(Math.abs(st.position?.entryDelta ?? 0) >= 0.6);
    assert.match(out.message, new RegExp(FALLBACK_LABEL.replace(/[()]/g, "\\$&")));
    const normal = rig(REVERSE);
    await normal.run();
    assert.equal((await stateOf(normal.desk)).position?.type, "put");
  });
  it("Neutral: no automatic action (the trader decides), no option chain read", async () => {
    const r = rig(NEUTRAL);
    const out = await r.run();
    assert.equal(out.outcome, "neutral");
    assert.match(out.message, /TRADER DECIDES/);
    assert.equal((await stateOf(r.desk)).position, null);
    assert.deepEqual(r.c.sides, []);
    assert.equal((await logOf(r.kv))[0].reading, "Neutral");
  });
  it("no contract passes the rules, a crossed quote, or an unreadable chain: REFUSE, nothing bought", async () => {
    const none = rig(REVERSE, { opts: { putStrikes: [690] } });
    const n = await none.run();
    assert.equal(n.outcome, "refused");
    assert.match(n.message, /no contract passes the rules/);

    const crossed = rig(DRIVE, {
      deps: (d) => ({
        ...d,
        readSide: async (type, spot, today, at) => {
          const s = await d.readSide(type, spot, today, at);
          if (s.pick.ok) s.pick = { ...s.pick, row: { ...s.pick.row, bid: 9, ask: 8 } };
          return s;
        },
      }),
    });
    const c = await crossed.run();
    assert.equal(c.outcome, "refused");
    assert.match(c.message, /crossed/);

    const broken = rig(DRIVE, { deps: (d) => ({ ...d, readSide: async () => { throw new Error("chain down"); } }) });
    assert.equal((await broken.run()).outcome, "refused");

    for (const x of [none, crossed, broken]) assert.equal((await stateOf(x.desk)).position, null);
  });
  it("a write the store does not keep is reported as an error and never as an opened position", async () => {
    const r = rig(DRIVE);
    r.desk.dropWrites = true;
    const out = await r.run();
    assert.equal(out.outcome, "error");
    assert.match(out.message, /could not be recorded/);
    assert.equal((await stateOf(r.desk)).position, null);
    assert.ok(!(await logOf(r.kv)).some((e) => e.outcome === "opened"));
  });
});

describe("Auto: a position is held", () => {
  it("same side as the reading: hold, nothing changes, no quote needed", async () => {
    const r = rig(DRIVE, { state: held("call", 600) });
    const before = await stateOf(r.desk);
    const out = await r.run();
    assert.equal(out.outcome, "hold");
    assert.deepEqual(await stateOf(r.desk), before);
    assert.equal(r.c.held, 0);
  });
  it("reading turns OPPOSITE (call held, Reverse): closes at the re-fetched bid, then opens the put in the same run", async () => {
    const start = held("call", 600);
    const r = rig(REVERSE, { state: start });
    const out = await r.run();
    assert.equal(out.outcome, "closed-and-opened");
    assert.equal(r.c.held, 1, "the held quote is re-fetched at action time");
    const quote = row("call", NEAREST, 600);
    const entryAsk = start.position?.entryAsk ?? 0;
    const st = await stateOf(r.desk);
    assert.deepEqual(st.journal.map((j) => j.kind), ["auto-close", "auto-open"]);
    assert.equal(st.journal[0].exitBid, quote.bid);
    assert.equal(st.journal[0].pnlUsd, (quote.bid - entryAsk) * 100);
    assert.equal(st.position?.type, "put");
    assert.equal(st.position?.source, "auto");
    const pick = side("put").pick;
    assert.ok(pick.ok);
    assert.equal(st.position?.entryAsk, pick.row.ask);
    const entry = (await logOf(r.kv))[0];
    assert.equal(entry.outcome, "closed-and-opened");
    assert.equal(entry.bid, quote.bid);
    assert.equal(entry.pnlUsd, (quote.bid - entryAsk) * 100);
  });
  it("the mirror: put held, Drive: closes the put and opens a call", async () => {
    const r = rig(DRIVE, { state: held("put", 850) });
    const out = await r.run();
    assert.equal(out.outcome, "closed-and-opened");
    assert.equal((await stateOf(r.desk)).position?.type, "call");
  });
  it("opposite reading but no usable quote (or a crossed one) to price the close: REFUSE, the position stays", async () => {
    const noQuote = rig(REVERSE, { state: held("call", 600), opts: { heldQuote: false } });
    const a = await noQuote.run();
    assert.equal(a.outcome, "refused");
    assert.match(a.message, /no usable quote/);
    const crossed = rig(REVERSE, { state: held("call", 600), deps: (d) => ({ ...d, readHeld: async (p, ...rest) => ({ ...(await d.readHeld(p, ...rest))!, bid: 9, ask: 8 }) }) });
    const b = await crossed.run();
    assert.equal(b.outcome, "refused");
    assert.match(b.message, /crossed/);
    for (const x of [noQuote, crossed]) {
      const st = await stateOf(x.desk);
      assert.equal(st.position?.type, "call");
      assert.equal(st.journal.length, 0);
    }
  });
  it("opposite reading, closes, but the other side cannot be opened under the rules: closed only, and the retry run may still open it", async () => {
    const r = rig(REVERSE, { state: held("call", 600), opts: { putStrikes: [690] } });
    const out = await r.run();
    assert.equal(out.outcome, "closed");
    assert.match(out.message, /was not opened/);
    const st = await stateOf(r.desk);
    assert.equal(st.position, null);
    assert.deepEqual(st.journal.map((j) => j.kind), ["auto-close"]);
    const retry = await r.run();
    assert.equal(retry.repeat, false, "a close without the open does not settle the session");
    assert.equal(retry.outcome, "refused");
  });
  it("close recorded but the open could not be saved: error, flat, and the close stays in the journal", async () => {
    const inner = createMemoryDeskStore(held("call", 600));
    let writes = 0;
    const flaky: DeskStore = { read: () => inner.read(), write: async (s) => (++writes === 2 ? { ok: false, error: "second write failed" } : inner.write(s)) };
    const r = rig(REVERSE, { desk: flaky });
    const out = await runAutoCycle(r.deps, CFG, { desk: flaky, kv: r.kv }, {});
    assert.equal(out.outcome, "error");
    assert.match(out.message, /Closed SPY/);
    const st = await stateOf(inner);
    assert.equal(st.position, null);
    assert.deepEqual(st.journal.map((j) => j.kind), ["auto-close"]);
  });
  it("Neutral while holding: the position is left alone (the page shows the banner)", async () => {
    const r = rig(NEUTRAL, { state: held("call", 600) });
    const before = await stateOf(r.desk);
    const out = await r.run();
    assert.equal(out.outcome, "neutral");
    assert.match(out.message, /left as it is/);
    assert.deepEqual(await stateOf(r.desk), before);
    assert.equal(r.c.held, 0);
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore(before));
    assert.match(snap.auto.banner ?? "", /NEUTRAL: TRADER DECIDES/);
    assert.match(snap.auto.banner ?? "", /\(AUTO\)/);
    const flat = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore());
    assert.equal(flat.auto.banner, null);
    const manual = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore(held("call", 600, "manual")));
    assert.match(manual.auto.banner ?? "", /\(MANUAL\)/);
  });
  it("a MANUAL position is never touched by Auto, even when the reading is opposite", async () => {
    const r = rig(REVERSE, { state: held("call", 600, "manual") });
    const before = await stateOf(r.desk);
    const out = await r.run();
    assert.equal(out.outcome, "no-action");
    assert.match(out.message, /MANUAL position/);
    assert.deepEqual(await stateOf(r.desk), before);
    assert.equal(r.c.held, 0);
  });
});

describe("Auto: prevention (idempotency, lock, guards)", () => {
  it("a double run does not open two positions: the second run is a silent repeat", async () => {
    const r = rig(DRIVE);
    const first = await r.run();
    const second = await r.run();
    assert.equal(first.outcome, "opened");
    assert.equal(second.repeat, true);
    assert.equal(second.status, 200);
    const st = await stateOf(r.desk);
    assert.equal(st.journal.filter((j) => j.kind === "auto-open").length, 1);
    assert.equal((await logOf(r.kv)).length, 1, "a repeat writes nothing to the log");
  });
  it("two runs at the same moment: the lock lets exactly one act, the other answers busy", async () => {
    const r = rig(DRIVE);
    const [a, b] = await Promise.all([r.run(), r.run()]);
    assert.deepEqual([a.outcome, b.outcome].sort(), ["busy", "opened"]);
    const st = await stateOf(r.desk);
    assert.equal(st.journal.length, 1);
    assert.equal(r.kv.data.has(AUTO_LOCK_KEY), false);
  });
  it("a lock held by someone else: nothing is done and the lock is not stolen", async () => {
    const r = rig(DRIVE);
    r.kv.data.set(AUTO_LOCK_KEY, { value: "other-run", expiresAt: null });
    const out = await r.run();
    assert.equal(out.outcome, "busy");
    assert.equal(out.status, 409);
    assert.equal((await stateOf(r.desk)).position, null);
    assert.equal(r.kv.data.get(AUTO_LOCK_KEY)?.value, "other-run");
    assert.equal(r.c.daily, 0);
  });
  it("an expired lock is taken over (a dead run cannot block Auto forever)", async () => {
    const r = rig(DRIVE);
    r.kv.data.set(AUTO_LOCK_KEY, { value: "dead-run", expiresAt: Date.now() - 1 });
    assert.equal((await r.run()).outcome, "opened");
  });
  it("if the lock is lost mid-run, the run stops before saving", async () => {
    const r = rig(DRIVE);
    const real = r.kv;
    const stolen = { ...real, get: async (k: string) => (k === AUTO_LOCK_KEY ? { ok: true as const, value: "someone-else" } : real.get(k)) };
    const out = await runAutoCycle(r.deps, CFG, { desk: r.desk, kv: stolen }, {});
    assert.equal(out.outcome, "error");
    assert.match(out.message, /lock was lost/);
    assert.equal((await stateOf(r.desk)).position, null);
  });
  it("you acted by hand today: Auto stands aside for the session", async () => {
    for (const kind of ["manual-open", "manual-close"] as const) {
      const r = rig(DRIVE, { state: { version: 1, position: null, journal: [journalEntry(kind)] } });
      const out = await r.run();
      assert.equal(out.outcome, "no-action");
      assert.match(out.message, /acted by hand today/);
      assert.equal((await stateOf(r.desk)).position, null);
    }
    const yesterday = rig(DRIVE, { state: { version: 1, position: null, journal: [journalEntry("manual-close", "2026-11-02T20:00:00.000Z")] } });
    assert.equal((await yesterday.run()).outcome, "opened");
  });
  it("Auto already opened today and it was closed since: no re-entry in the same session; no flip-flop either", async () => {
    const reentry = rig(DRIVE, { state: { version: 1, position: null, journal: [journalEntry("auto-open")] } });
    const a = await reentry.run();
    assert.equal(a.outcome, "no-action");
    assert.equal((await stateOf(reentry.desk)).position, null);
    const flip = rig(REVERSE, { state: held("call", 600, "auto", [journalEntry("auto-open")]) });
    const b = await flip.run();
    assert.equal(b.outcome, "no-action");
    assert.match(b.message, /does not reverse within one session/);
    assert.equal((await stateOf(flip.desk)).position?.type, "call");
  });
  it("if the audit entry cannot be saved after a trade, the trade still stands and the run says so; a rerun holds, never reopens", async () => {
    const r = rig(DRIVE);
    const real = r.kv;
    const noLog = { ...real, set: async (k: string, v: string) => (k === AUTO_LOG_KEY ? { ok: false as const, error: "log write refused" } : real.set(k, v)) };
    const out = await runAutoCycle(r.deps, CFG, { desk: r.desk, kv: noLog }, {});
    assert.equal(out.outcome, "opened");
    assert.equal(out.logged, false);
    assert.match(out.message, /audit entry could not be saved/);
    const again = await r.run();
    assert.equal(again.outcome, "hold");
    assert.equal((await stateOf(r.desk)).journal.filter((j) => j.kind === "auto-open").length, 1);
  });
  it("refused and off runs do not settle the session, so the retry run can still act", async () => {
    const r = rig(DRIVE, { opts: { dailyFails: true } });
    assert.equal((await r.run()).outcome, "refused");
    const fixed = makeDeps(DRIVE, { calls: r.c });
    const retry = await runAutoCycle(fixed, CFG, { desk: r.desk, kv: r.kv }, {});
    assert.equal(retry.outcome, "opened");
  });
  it("the audit log is capped", async () => {
    const r = rig(NEUTRAL);
    const filler: AutoLogEntry[] = Array.from({ length: AUTO_LOG_MAX + 20 }, (_, i) => ({ id: `f${i}`, at: "2026-10-01T00:00:00.000Z", session: "2026-10-01", outcome: "off", message: "x", reading: null, symbol: null, bid: null, ask: null, pnlUsd: null }));
    r.kv.data.set(AUTO_LOG_KEY, { value: JSON.stringify(filler.slice(-AUTO_LOG_MAX)), expiresAt: null });
    await r.run();
    assert.equal((await logOf(r.kv)).length, AUTO_LOG_MAX);
  });
});

describe("Auto: ?dry=1 changes nothing", () => {
  it("open and flip are computed and reported, but the desk record, the log and the lock are untouched", async () => {
    const open = rig(DRIVE);
    const o = await open.run(true);
    assert.equal(o.outcome, "opened");
    assert.equal(o.dryRun, true);
    assert.match(o.message, /^DRY RUN, nothing saved/);
    assert.equal((await stateOf(open.desk)).position, null);
    assert.equal(open.kv.data.has(AUTO_LOG_KEY), false);
    assert.equal(open.kv.data.has(AUTO_LOCK_KEY), false);

    const start = held("call", 600);
    const flip = rig(REVERSE, { state: start });
    const f = await flip.run(true);
    assert.equal(f.outcome, "closed-and-opened");
    assert.deepEqual(await stateOf(flip.desk), start);
    assert.equal(flip.kv.data.has(AUTO_LOG_KEY), false);
  });
});

describe("Auto: the page data and validation", () => {
  it("the snapshot carries the Auto view, newest log entry first, and passes the browser-side shape check", async () => {
    const r = rig(DRIVE);
    await r.run();
    const view = await buildAutoView(r.kv);
    assert.equal(view.available, true);
    assert.equal(view.on, true);
    assert.equal(view.log[0].outcome, "opened");
    const snap = await buildDeskSnapshot(makeDeps(DRIVE), CFG, r.desk, view);
    assert.equal(snap.auto.on, true);
    assert.equal(snap.position.status, "held");
    if (snap.position.status === "held") assert.equal(snap.position.source, "auto");
    const parsed = parseDeskSnapshot(JSON.parse(JSON.stringify(snap)));
    assert.ok(parsed.ok);
    const broken = JSON.parse(JSON.stringify(snap));
    broken.auto.log = [{ id: 1 }];
    assert.equal(parseDeskSnapshot(broken).ok, false);
    const noAuto = JSON.parse(JSON.stringify(snap));
    delete noAuto.auto;
    assert.equal(parseDeskSnapshot(noAuto).ok, false);
  });
  it("no store: Auto is shown as unavailable and OFF", async () => {
    assert.deepEqual(await buildAutoView(null), AUTO_UNAVAILABLE);
    assert.equal(isAutoView(AUTO_UNAVAILABLE), true);
    assert.equal(AUTO_UNAVAILABLE.on, false);
    const kv = createMemorySpyKv();
    kv.failReads = true;
    const v = await buildAutoView(kv);
    assert.equal(v.on, false);
    assert.match(v.reason, /OFF/);
    assert.ok(v.logError);
  });
  it("the log parser refuses a malformed entry instead of repairing it", () => {
    assert.equal(parseAutoLog("x").ok, false);
    assert.equal(parseAutoLog([{ id: "a", at: "t", session: "s", outcome: "nonsense", message: "m", reading: null, symbol: null, bid: null, ask: null, pnlUsd: null }]).ok, false);
  });
});

describe("Auto: key-value client", () => {
  it("memory client honours NX and expiry; the real client sends GET/SET/DEL as one command array", async () => {
    let now = 1_000;
    const mem = createMemorySpyKv(() => now);
    assert.deepEqual(await mem.setNx("k", "a", 10), { ok: true, value: true });
    assert.deepEqual(await mem.setNx("k", "b", 10), { ok: true, value: false });
    now += 11_000;
    assert.deepEqual(await mem.setNx("k", "b", 10), { ok: true, value: true });
    const sent: string[][] = [];
    const answers: unknown[] = ["OK", null, "v", 1];
    const kv = createKvSpyKv({ KV_REST_API_URL: "https://kv.example.com", KV_REST_API_TOKEN: "t" }, async (_u, init) => {
      sent.push(JSON.parse(init.body) as string[]);
      return { ok: true, status: 200, json: async () => ({ result: answers.shift() }) };
    });
    assert.ok(kv);
    assert.deepEqual(await kv.setNx("lock", "tok", 120), { ok: true, value: true });
    assert.deepEqual(await kv.setNx("lock", "tok2", 120), { ok: true, value: false });
    assert.deepEqual(await kv.get("k"), { ok: true, value: "v" });
    assert.deepEqual(await kv.del("k"), { ok: true, value: true });
    assert.deepEqual(sent[0], ["SET", "lock", "tok", "NX", "EX", "120"]);
    assert.deepEqual(sent[2], ["GET", "k"]);
    const down = createKvSpyKv({ KV_REST_API_URL: "https://kv.example.com", KV_REST_API_TOKEN: "t" }, async () => { throw new Error("net"); });
    assert.equal((await down!.get("k")).ok, false);
    assert.equal((await down!.setNx("k", "v", 5)).ok, false);
  });
  it("no credentials: no client; memory only outside production", () => {
    assert.equal(createKvSpyKv({}), null);
    assert.equal(createSpyKv({}), null);
    assert.equal(createSpyKv({ SPY_DESK_STORE: "memory", NODE_ENV: "production" }), null);
    assert.ok(createSpyKv({ SPY_DESK_STORE: "memory", NODE_ENV: "development" }));
  });
});

describe("Auto: scheduler route", () => {
  const SECRET = "s".repeat(CRON_SECRET_MIN_LENGTH);
  const BASE = "https://www.polarito.com";
  const mk = (over: Partial<AutoRouteContext> & { sc?: Scenario } = {}): AutoRouteContext & { kv: ReturnType<typeof createMemorySpyKv>; desk: ReturnType<typeof createMemoryDeskStore> } => {
    const kv = createMemorySpyKv();
    kv.data.set(AUTO_SWITCH_KEY, { value: SWITCH_ON, expiresAt: null });
    const desk = createMemoryDeskStore();
    const sc = over.sc ?? DRIVE;
    return { env: { POLARITO_SPY_DESK: "1", CRON_SECRET: SECRET }, makeLive: async () => ({ ok: true as const, deps: makeDeps(sc), config: CFG }), ...over, desk, kv } as never;
  };
  const get = (auth: string | null, path = "/api/spy/auto-run") => new Request(`${BASE}${path}`, { headers: auth === null ? {} : { authorization: auth } });

  it("constant-time bearer check; unset or short secrets never authorize", () => {
    assert.equal(cronAuthorized(`Bearer ${SECRET}`, SECRET), true);
    assert.equal(cronAuthorized(`Bearer ${SECRET}x`, SECRET), false);
    assert.equal(cronAuthorized(SECRET, SECRET), false);
    assert.equal(cronAuthorized(null, SECRET), false);
    assert.equal(cronAuthorized("Bearer short", "short"), false);
    assert.equal(cronAuthorized(`Bearer ${SECRET}`, undefined), false);
    assert.equal(cronAuthorized("Bearer ", SECRET), false);
  });
  it("flag off 404; no secret or a short secret 503; no or wrong bearer 401; nothing is touched in any of them", async () => {
    const boom = { makeLive: async () => { throw new Error("must not be called"); } };
    assert.equal((await handleAutoRun(get(`Bearer ${SECRET}`), { ...mk(boom), env: { CRON_SECRET: SECRET } })).status, 404);
    assert.equal((await handleAutoRun(get(`Bearer ${SECRET}`), { ...mk(boom), env: { POLARITO_SPY_DESK: "1" } })).status, 503);
    assert.equal((await handleAutoRun(get(`Bearer ${SECRET}`), { ...mk(boom), env: { POLARITO_SPY_DESK: "1", CRON_SECRET: "short" } })).status, 503);
    assert.equal((await handleAutoRun(get(null), mk(boom))).status, 401);
    assert.equal((await handleAutoRun(get("Bearer wrong-wrong-wrong-wrong-wrong-wrong-1"), mk(boom))).status, 401);
  });
  it("a correct bearer runs the cycle: Drive and flat opens a call; the same call again is a repeat", async () => {
    const c = mk({ now: () => T0 });
    const res = await handleAutoRun(get(`Bearer ${SECRET}`), c);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { ok: boolean; outcome: string; repeat: boolean };
    assert.equal(body.outcome, "opened");
    assert.equal((await stateOf(c.desk)).position?.source, "auto");
    const again = (await (await handleAutoRun(get(`Bearer ${SECRET}`, "/api/spy/auto-run?retry=1"), c)).json()) as { repeat: boolean };
    assert.equal(again.repeat, true);
  });
  it("?dry=1 reports without saving", async () => {
    const c = mk();
    const body = (await (await handleAutoRun(get(`Bearer ${SECRET}`, "/api/spy/auto-run?dry=1"), c)).json()) as { dryRun: boolean; outcome: string };
    assert.equal(body.dryRun, true);
    assert.equal(body.outcome, "opened");
    assert.equal((await stateOf(c.desk)).position, null);
  });
  it("missing Alpaca keys: refused and logged like any other bad data (503), nothing traded", async () => {
    const c = mk({ now: () => T0, makeLive: async () => ({ ok: false as const, code: "NO_KEYS" as const, error: "no keys" }) });
    const res = await handleAutoRun(get(`Bearer ${SECRET}`), c);
    assert.equal(res.status, 503);
    assert.equal((await stateOf(c.desk)).position, null);
    const log = await logOf(c.kv);
    assert.equal(log[0].outcome, "refused");
    assert.match(log[0].message, /no keys/);
  });
  it("a thrown error becomes a 500 without detail", async () => {
    const c = mk({ makeLive: async () => { throw new Error("secret detail"); } });
    const res = await handleAutoRun(get(`Bearer ${SECRET}`), c);
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(await res.json()), /secret detail/);
  });
  it("the cookie gate lets only the exact scheduler path through; the route itself then demands the bearer", () => {
    assert.notEqual(proxy(new NextRequest(`${BASE}/api/spy/auto-run`)).status, 401);
    assert.equal(proxy(new NextRequest(`${BASE}/api/spy/auto-run/extra`)).status, 401);
    assert.equal(proxy(new NextRequest(`${BASE}/api/spy/auto`, { method: "POST" })).status, 401);
    assert.equal(proxy(new NextRequest(`${BASE}/api/spy/desk`)).status, 401);
    assert.equal(proxy(new NextRequest(`${BASE}/api/spy/ticket`, { method: "POST" })).status, 401);
  });
});

describe("Auto: on/off route", () => {
  const BASE = "https://www.polarito.com";
  const post = (body: unknown, headers: Record<string, string> = { origin: BASE, host: "www.polarito.com" }) =>
    new Request(`${BASE}/api/spy/auto`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const ctx = (over: Partial<AutoRouteContext> = {}): AutoRouteContext => ({ env: { POLARITO_SPY_DESK: "1" }, makeLive: async () => { throw new Error("not needed"); }, desk: null, kv: createMemorySpyKv(), now: () => T0, ...over });

  it("flag off 404, cross-site 403, bad body 400, no store 503; a valid body switches it", async () => {
    assert.equal((await handleAutoSwitch(post({ on: true, acknowledgeDryRun: true }), ctx({ env: {} }))).status, 404);
    assert.equal((await handleAutoSwitch(post({ on: true, acknowledgeDryRun: true }, { origin: "https://evil.example", host: "www.polarito.com" }), ctx())).status, 403);
    assert.equal((await handleAutoSwitch(post("nope"), ctx())).status, 400);
    assert.equal((await handleAutoSwitch(post({ on: true }), ctx())).status, 400);
    assert.equal((await handleAutoSwitch(post({ on: "yes", acknowledgeDryRun: true }), ctx())).status, 400);
    assert.equal((await handleAutoSwitch(post({ on: true, acknowledgeDryRun: true, extra: 1 }), ctx())).status, 400);
    assert.equal((await handleAutoSwitch(post({ on: true, acknowledgeDryRun: true }), ctx({ kv: null }))).status, 503);
    const c = ctx();
    const res = await handleAutoSwitch(post({ on: true, acknowledgeDryRun: true }), c);
    assert.equal(res.status, 200);
    const sw = await readSwitch(c.kv as ReturnType<typeof createMemorySpyKv>);
    assert.ok(sw.ok && sw.on);
    assert.deepEqual(parseSwitchRequest({ on: false, acknowledgeDryRun: true }), { ok: true, on: false });
  });
});

describe("Auto: safety rails in the source", () => {
  const files = ["src/lib/spyAuto.ts", "src/lib/spyAutoTypes.ts", "src/lib/spyAutoRoutes.ts", "src/lib/spyKv.ts", "src/app/api/spy/auto/route.node.ts", "src/app/api/spy/auto-run/route.node.ts"];
  it("no order endpoint, order function, broker module or live-trading switch in the Auto files", () => {
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(src, /\/v2\/orders|\/v2\/positions|POLARITO_LIVE_TRADING_ENABLED|api\/broker\//, f);
      assert.doesNotMatch(src, /from ["']@\/lib\/broker\/(alpacaLive|alpacaPaper|liveConfig|execute)/, f);
      assert.doesNotMatch(src, /liveBuy|liveClose|orderGuard|liveAutoGuard|createLiveBroker|submitOrder|placeOrder|createOrder|closePosition|alpaca\.markets/, f);
      assert.doesNotMatch(src, /process\.env\.POLARITO_/, f);
    }
  });
  it("only spyKv.ts talks to the store; the logic files never call fetch", () => {
    for (const f of files.filter((x) => x !== "src/lib/spyKv.ts")) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /fetch\(|method:\s*["']POST/, f);
  });
  it("the scheduler route exports GET only, is computed per request, and is behind the flag", () => {
    const route = fs.readFileSync("src/app/api/spy/auto-run/route.node.ts", "utf8");
    assert.match(route, /export async function GET/);
    assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.match(route, /await connection\(\)/);
    assert.match(fs.readFileSync("src/lib/spyAutoRoutes.ts", "utf8"), /if \(!deskEnabled\(ctx\.env\)\) return off\(\)/);
  });
  it("vercel.json schedules weekdays only, always after 16:15 ET in both winter and summer time, on the guarded path", () => {
    const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    assert.equal(cfg.crons.length, 4, "two per desk: the monthly desk and the WWV desk");
    for (const base of ["/api/spy/auto-run", "/api/spy-wwv/auto-run"]) assert.deepEqual(cfg.crons.filter((c) => c.path === base || c.path === `${base}?retry=1`).length, 2, base);
    for (const c of cfg.crons) {
      assert.match(c.path, /^\/api\/spy(-wwv)?\/auto-run(\?retry=1)?$/);
      const [min, hour, dom, mon, dow] = c.schedule.split(" ");
      assert.deepEqual([dom, mon, dow], ["*", "*", "1-5"]);
      for (const day of ["2026-01-14", "2026-07-15"]) {
        const et = etClock(new Date(`${day}T${hour.padStart(2, "0")}:${min.padStart(2, "0")}:00Z`));
        assert.ok(et.minutes >= 16 * 60 + 15, `${c.schedule} on ${day} is ${et.minutes} ET minutes`);
      }
    }
  });
  it(".env.example documents CRON_SECRET with no value", () => {
    const env = fs.readFileSync(".env.example", "utf8");
    assert.match(env, /^# ?CRON_SECRET=\s*$/m);
    assert.doesNotMatch(env, /^CRON_SECRET=\S/m);
  });
});
