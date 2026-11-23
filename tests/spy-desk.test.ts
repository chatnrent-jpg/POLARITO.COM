import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { DELTA_THRESHOLDS, FALLBACK_LABEL, MIN_DAYS_TO_EXPIRY, eligibleContracts } from "../src/lib/optionsSelect";
import { daysBetween } from "../src/lib/broker/options";
import {
  CANDIDATES_MAX,
  EMPTY_DESK,
  JOURNAL_MAX,
  MANUAL_BELOW_TARGET_LABEL,
  buildDeskSnapshot,
  closeManual,
  deskDecision,
  deskEnabled,
  openManual,
  parseCloseRequest,
  parseDeskSnapshot,
  parseDeskState,
  parseTicketRequest,
  ticketGate,
  type DeskConfig,
  type DeskPosition,
  type DeskState,
} from "../src/lib/spyDesk";
import { createDeskStore, createKvDeskStore, createMemoryDeskStore, DESK_STORE_KEY } from "../src/lib/spyDeskStore";
import { handleClose, handleSnapshot, handleTicket, type DeskContext } from "../src/lib/spyDeskRoutes";
import { EMPTY_STATE, runEngine } from "../src/lib/spyEngine";
import { DRIVE, LISTED, NEUTRAL, PUT_STRIKES, REVERSE, SPOT, T0, TODAY, makeDeps, row, side, type Calls } from "./helpers/spyDeskFixtures";

const CFG: DeskConfig = { timeframe: "M", liveBudget: 1000 };
const NEAREST = "2027-11-05";
const PUT_850 = "SPY271105P00850000";
const PUT_800 = "SPY271105P00800000";
const CALL_600 = "SPY271105C00600000";
const CALL_550 = "SPY271105C00550000";

const calls = (): Calls => ({ daily: 0, spot: 0, sides: [], held: 0 });

function heldState(over: Partial<DeskPosition> = {}): DeskState {
  const r = row("put", NEAREST, 850);
  const position: DeskPosition = {
    type: "put", symbol: r.symbol, expiration: NEAREST, strike: 850, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta,
    deltaTier: "fallback", fallbackReason: "chosen by hand", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual", ...over,
  };
  return { version: 1, position, journal: [] };
}

describe("flag", () => {
  it("is off unless POLARITO_SPY_DESK is exactly 1", () => {
    assert.equal(deskEnabled({}), false);
    assert.equal(deskEnabled({ POLARITO_SPY_DESK: "" }), false);
    assert.equal(deskEnabled({ POLARITO_SPY_DESK: "true" }), false);
    assert.equal(deskEnabled({ POLARITO_SPY_DESK: "0" }), false);
    assert.equal(deskEnabled({ POLARITO_SPY_DESK: "1" }), true);
  });
});

describe("eligibleContracts: the rules-filtered chain the ticket draws from", () => {
  it("nearest expiry of at least 365 days only, |delta| >= 0.60 only, cheapest first", () => {
    const rows = [...LISTED.flatMap((e) => PUT_STRIKES.map((k) => row("put", e, k)))];
    const out = eligibleContracts(rows, LISTED, "put", TODAY);
    assert.equal(out.expiration, NEAREST);
    assert.ok(out.rows.length >= 3);
    for (const r of out.rows) {
      assert.equal(r.expiration, NEAREST);
      assert.ok(Math.abs(r.delta) >= DELTA_THRESHOLDS.floor);
      assert.ok(daysBetween(TODAY, r.expiration) >= MIN_DAYS_TO_EXPIRY);
    }
    const costs = out.rows.map((r) => r.costAtAsk);
    assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
    assert.ok(!out.rows.some((r) => r.strike === 690), "690 put is under the floor");
  });
  it("no listed expiry of 365 days: nothing", () => {
    assert.deepEqual(eligibleContracts([row("put", "2027-06-17", 850)], ["2027-06-17"], "put", TODAY), { expiration: null, rows: [] });
  });
  it("a wide spread is excluded", () => {
    const r = { ...row("put", NEAREST, 850), spreadPct: 0.4 };
    assert.equal(eligibleContracts([r], [NEAREST], "put", TODAY).rows.length, 0);
  });
});

describe("payload validation (server side)", () => {
  it("ticket: exact keys, acknowledgement, OCC symbol that matches call/put", () => {
    const ok = parseTicketRequest({ type: "put", symbol: PUT_850, acknowledgeDryRun: true });
    assert.ok(ok.ok && ok.value.symbol === PUT_850 && ok.value.type === "put");
    const bad: unknown[] = [
      null, "x", [], {},
      { type: "put", symbol: PUT_850 },
      { type: "put", symbol: PUT_850, acknowledgeDryRun: "true" },
      { type: "buy", symbol: PUT_850, acknowledgeDryRun: true },
      { type: "call", symbol: PUT_850, acknowledgeDryRun: true },
      { type: "put", symbol: "AAPL271105P00850000", acknowledgeDryRun: true },
      { type: "put", symbol: "SPY271105P850", acknowledgeDryRun: true },
      { type: "put", symbol: PUT_850, acknowledgeDryRun: true, quantity: 5 },
      { type: "put", symbol: PUT_850, acknowledgeDryRun: true, side: "sell" },
    ];
    for (const b of bad) assert.equal(parseTicketRequest(b).ok, false, JSON.stringify(b));
  });
  it("close: acknowledgement required, only unpriced allowed besides it", () => {
    const a = parseCloseRequest({ acknowledgeDryRun: true });
    assert.ok(a.ok && a.value.unpriced === false);
    const b = parseCloseRequest({ acknowledgeDryRun: true, unpriced: true });
    assert.ok(b.ok && b.value.unpriced === true);
    for (const bad of [null, {}, { acknowledgeDryRun: false }, { acknowledgeDryRun: true, unpriced: "yes" }, { acknowledgeDryRun: true, symbol: "x" }]) assert.equal(parseCloseRequest(bad).ok, false);
  });
});

describe("saved desk state", () => {
  it("round-trips, and a bad shape is refused instead of repaired", () => {
    const s = heldState();
    const parsed = parseDeskState(JSON.parse(JSON.stringify(s)));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.state, s);
    assert.equal(parseDeskState({ version: 2, journal: [] }).ok, false);
    assert.equal(parseDeskState({ version: 1, journal: "x" }).ok, false);
    assert.equal(parseDeskState({ version: 1, journal: [], position: { type: "call" } }).ok, false);
    assert.equal(parseDeskState({ version: 1, journal: [{ id: 1 }] }).ok, false);
    assert.equal(parseDeskState({ version: 1, journal: [], position: { ...s.position, source: "engine" } }).ok, false);
    assert.equal(parseDeskState({ version: 1, journal: [], position: { ...s.position, quantity: 5 } }).ok, false);
  });
  it("the journal is bounded", () => {
    const e = { id: "x", at: "a", kind: "manual-open", symbol: "s", type: "put", strike: 1, expiration: "e", delta: -0.7, costUsd: 1, exitBid: null, pnlUsd: null, note: "n" };
    const parsed = parseDeskState({ version: 1, position: null, journal: Array.from({ length: JOURNAL_MAX + 30 }, () => e) });
    assert.ok(parsed.ok);
    assert.equal(parsed.state.journal.length, JOURNAL_MAX);
  });
});

describe("decision matches the engine", () => {
  for (const [name, sc, action] of [["Drive", DRIVE, "CALL"], ["Reverse", REVERSE, "PUT"], ["Neutral", NEUTRAL, "STAND_ASIDE"]] as const) {
    it(`${name}: ${action}`, async () => {
      const d = deskDecision(sc.daily, T0, "M");
      assert.ok(d.status === "ok" && d.action === action);
      const r = await runEngine(makeDeps(sc), { timeframe: "M", liveBudget: 1000 }, EMPTY_STATE);
      assert.equal(r.decision?.action, action);
    });
  }
  it("stale or missing bars are unavailable, never a guess", () => {
    const late = deskDecision(DRIVE.daily, new Date("2026-11-12T21:30:00Z"), "M");
    assert.equal(late.status, "unavailable");
    assert.equal(deskDecision([], T0, "M").status, "unavailable");
  });
});

describe("ticket gate", () => {
  const neutral = { action: "STAND_ASIDE" as const, reason: "r" };
  it("opens at ANY reading with good data, no position, working store", () => {
    assert.deepEqual(ticketGate(neutral, "none", true), { open: true, reason: null });
    assert.deepEqual(ticketGate({ action: "CALL", reason: "r" }, "none", true), { open: true, reason: null });
    assert.deepEqual(ticketGate({ action: "PUT", reason: "r" }, "none", true), { open: true, reason: null });
    assert.equal(ticketGate({ action: "CALL", reason: "r" }, "held", true).open, false);
    assert.equal(ticketGate({ action: "DATA_UNAVAILABLE", reason: "stale" }, "none", true).open, false);
    assert.match(ticketGate({ action: "DATA_UNAVAILABLE", reason: "stale" }, "none", true).reason ?? "", /Data unavailable \(stale\)/);
    assert.equal(ticketGate(null, "none", true).open, false);
    assert.equal(ticketGate(neutral, "held", true).open, false);
    assert.equal(ticketGate(neutral, "unknown", true).open, false);
    assert.equal(ticketGate(neutral, "none", false).open, false);
  });
});

describe("manual ticket (openManual): dry-run position only", () => {
  it("Reverse + a contract from the rules-filtered chain: records a MANUAL dry-run position, read back from the store", async () => {
    const store = createMemoryDeskStore();
    const res = await openManual(makeDeps(REVERSE), CFG, store, { type: "put", symbol: PUT_850 });
    assert.ok(res.ok, res.ok ? "" : res.error);
    const saved = await store.read();
    assert.ok(saved.ok && saved.state.position);
    const p = saved.state.position;
    assert.equal(p.source, "manual");
    assert.equal(p.symbol, PUT_850);
    assert.equal(p.quantity, 1);
    assert.equal(p.expiration, NEAREST);
    assert.ok(Math.abs(p.entryDelta) >= DELTA_THRESHOLDS.floor);
    assert.equal(p.deltaTier, "fallback"); // 850 put is below 0.80
    assert.match(p.fallbackReason ?? "", /chosen by hand/);
    assert.equal(p.maxLossUsd, p.entryAsk * 100);
    assert.equal(saved.state.journal.length, 1);
    assert.match(saved.state.journal[0].note, /MANUAL dry-run buy/);
    assert.match(saved.state.journal[0].note, /No order sent/);
    assert.match(saved.state.journal[0].note, new RegExp(MANUAL_BELOW_TARGET_LABEL.replace(/[()]/g, "\\$&")));
  });
  it("a call works the same, and a >= 0.80 contract is primary", async () => {
    const store = createMemoryDeskStore();
    const res = await openManual(makeDeps(DRIVE), CFG, store, { type: "call", symbol: CALL_550 });
    assert.ok(res.ok);
    const s = await store.read();
    assert.ok(s.ok && s.state.position?.type === "call");
    assert.equal(s.state.position?.deltaTier, "primary");
    assert.equal(s.state.position?.fallbackReason, null);
  });
  it("opens on the gear's own side (Drive call, Reverse put); always MANUAL (Neutral opens nothing: see the NEUTRAL_NO_TRADE tests)", async () => {
    const cases = [
      [DRIVE, "call", CALL_600, /Drive reading, same side, trader decided/],
      [REVERSE, "put", PUT_850, /Reverse reading, same side, trader decided/],
    ] as const;
    for (const [sc, type, symbol, note] of cases) {
      const store = createMemoryDeskStore();
      const res = await openManual(makeDeps(sc), CFG, store, { type, symbol });
      assert.ok(res.ok, res.ok ? "" : res.error);
      const s = await store.read();
      assert.ok(s.ok && s.state.position?.source === "manual");
      assert.equal(s.state.journal[0].kind, "manual-open");
      assert.match(s.state.journal[0].note, note);
      assert.match(s.state.journal[0].note, /^MANUAL /);
    }
  });
  it("still needs good data and no existing position at any reading (Drive here)", async () => {
    const stale = await openManual(makeDeps(DRIVE, { dailyFails: true }), CFG, createMemoryDeskStore(), { type: "call", symbol: CALL_600 });
    assert.ok(!stale.ok && stale.code === "DATA_UNAVAILABLE");
    const store = createMemoryDeskStore(heldState());
    const dup = await openManual(makeDeps(DRIVE), CFG, store, { type: "call", symbol: CALL_600 });
    assert.ok(!dup.ok && dup.code === "POSITION_OPEN" && dup.status === 409);
  });
  it("refuses on data unavailable (bars failing, stale bars) and never reads the chain", async () => {
    const c = calls();
    const s1 = createMemoryDeskStore();
    const r1 = await openManual(makeDeps(REVERSE, { dailyFails: true, calls: c }), CFG, s1, { type: "put", symbol: PUT_850 });
    assert.ok(!r1.ok && r1.code === "DATA_UNAVAILABLE");
    assert.deepEqual(c.sides, []);
    const r2 = await openManual(makeDeps(REVERSE, { now: new Date("2026-11-12T21:30:00Z"), calls: c }), CFG, s1, { type: "put", symbol: PUT_850 });
    assert.ok(!r2.ok && r2.code === "DATA_UNAVAILABLE");
    assert.deepEqual(c.sides, []);
  });
  it("refuses when the SPY price cannot be read", async () => {
    const res = await openManual(makeDeps(REVERSE, { spotFails: true }), CFG, createMemoryDeskStore(), { type: "put", symbol: PUT_850 });
    assert.ok(!res.ok && res.code === "NO_SPOT");
  });
  it("one position at a time", async () => {
    const store = createMemoryDeskStore(heldState());
    const res = await openManual(makeDeps(REVERSE), CFG, store, { type: "put", symbol: PUT_800 });
    assert.ok(!res.ok && res.code === "POSITION_OPEN");
    const s = await store.read();
    assert.ok(s.ok && s.state.position?.symbol === PUT_850 && s.state.journal.length === 0);
  });
  it("refuses a contract outside the rules: under the 0.60 floor, a later expiry, an unknown symbol", async () => {
    const deps = makeDeps(REVERSE);
    for (const symbol of ["SPY271105P00690000", "SPY271119P00850000", "SPY280121P00850000", "SPY271105P00851000", "SPY270617P00850000"]) {
      const store = createMemoryDeskStore();
      const res = await openManual(deps, CFG, store, { type: "put", symbol });
      assert.ok(!res.ok && res.code === "NOT_ELIGIBLE", symbol);
      assert.match(res.ok ? "" : res.error, /Nothing was recorded/);
      const s = await store.read();
      assert.ok(s.ok && s.state.position === null);
    }
  });
  it("re-checks every rule on the server even if the chain read hands back a bad row", async () => {
    const base = makeDeps(REVERSE);
    const bad = { ...row("put", NEAREST, 690), spreadPct: 0.01 }; // delta about -0.40, far under the floor
    const deps = { ...base, readSide: async () => ({ ...side("put"), eligible: [bad] }) };
    const store = createMemoryDeskStore();
    const res = await openManual(deps, CFG, store, { type: "put", symbol: bad.symbol });
    assert.ok(!res.ok && res.code === "NOT_ELIGIBLE");
    assert.match(res.ok ? "" : res.error, /below 0\.6/);
  });
  it("chain unreadable: refuses", async () => {
    const res = await openManual(makeDeps(REVERSE, { putStrikes: [], sideError: "chain down" }), CFG, createMemoryDeskStore(), { type: "put", symbol: PUT_850 });
    assert.ok(!res.ok && res.code === "CHAIN");
  });
  it("no store: refuses with an honest message; store read/write failures leave nothing changed", async () => {
    const r0 = await openManual(makeDeps(REVERSE), CFG, null, { type: "put", symbol: PUT_850 });
    assert.ok(!r0.ok && r0.code === "NO_STORE" && r0.status === 503);
    const s1 = createMemoryDeskStore();
    s1.failReads = true;
    const r1 = await openManual(makeDeps(REVERSE), CFG, s1, { type: "put", symbol: PUT_850 });
    assert.ok(!r1.ok && r1.code === "STORE");
    const s2 = createMemoryDeskStore();
    s2.failWrites = true;
    const r2 = await openManual(makeDeps(REVERSE), CFG, s2, { type: "put", symbol: PUT_850 });
    assert.ok(!r2.ok && r2.code === "STORE");
    s2.failWrites = false;
    const after = await s2.read();
    assert.ok(after.ok && after.state.position === null);
  });
  it("a store that acknowledges but does not keep the write is reported, never as success", async () => {
    const s = createMemoryDeskStore();
    s.dropWrites = true;
    const res = await openManual(makeDeps(REVERSE), CFG, s, { type: "put", symbol: PUT_850 });
    assert.ok(!res.ok && res.code === "STORE");
    assert.match(res.ok ? "" : res.error, /did not keep the change/);
  });
});

describe("manual Close (closeManual): dry-run position only", () => {
  it("closes at the current bid, records the result, and clears the position", async () => {
    const store = createMemoryDeskStore(heldState());
    const res = await closeManual(makeDeps(NEUTRAL), store, { unpriced: false });
    assert.ok(res.ok, res.ok ? "" : res.error);
    const s = await store.read();
    assert.ok(s.ok && s.state.position === null);
    const e = s.ok ? s.state.journal[0] : null;
    assert.ok(e && e.kind === "manual-close");
    const q = row("put", NEAREST, 850);
    assert.equal(e.exitBid, q.bid);
    assert.equal(e.pnlUsd, (q.bid - q.ask) * 100);
    assert.match(e.note, /No order sent/);
    assert.match(e.note, /result -\$\d/);
    assert.doesNotMatch(e.note, /\$-/);
  });
  it("works on any reading, including Drive and data problems with the chain, since it only needs the held contract's quote", async () => {
    const res = await closeManual(makeDeps(DRIVE), createMemoryDeskStore(heldState()), { unpriced: false });
    assert.ok(res.ok);
  });
  it("nothing to close", async () => {
    const res = await closeManual(makeDeps(NEUTRAL), createMemoryDeskStore(), { unpriced: false });
    assert.ok(!res.ok && res.code === "NO_POSITION");
  });
  it("no usable quote: refuses and keeps the position; closing without a price records the result as unknown", async () => {
    const store = createMemoryDeskStore(heldState());
    const refused = await closeManual(makeDeps(NEUTRAL, { heldQuote: false }), store, { unpriced: false });
    assert.ok(!refused.ok && refused.code === "NO_QUOTE");
    const still = await store.read();
    assert.ok(still.ok && still.state.position !== null);
    const forced = await closeManual(makeDeps(NEUTRAL, { heldQuote: false }), store, { unpriced: true });
    assert.ok(forced.ok);
    const gone = await store.read();
    assert.ok(gone.ok && gone.state.position === null);
    const e = gone.ok ? gone.state.journal[0] : null;
    assert.equal(e?.pnlUsd, null);
    assert.equal(e?.exitBid, null);
    assert.match(e?.note ?? "", /WITHOUT a price, result unknown/);
  });
  it("store failures keep the position and say so", async () => {
    const s = createMemoryDeskStore(heldState());
    s.failWrites = true;
    const res = await closeManual(makeDeps(NEUTRAL), s, { unpriced: false });
    assert.ok(!res.ok && res.code === "STORE");
    s.failWrites = false;
    const after = await s.read();
    assert.ok(after.ok && after.state.position !== null);
    const none = await closeManual(makeDeps(NEUTRAL), null, { unpriced: false });
    assert.ok(!none.ok && none.code === "NO_STORE");
  });
});

describe("snapshot (the page's data)", () => {
  it("Neutral: four readings with raw net volume, candle, match, reading; decision; ticket open with the rules-filtered chain", async () => {
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore());
    assert.equal(snap.dryRun, true);
    assert.equal(snap.readings.length, 5, "the Daily reading plus the four period readings");
    assert.deepEqual(snap.readings.map((r) => r.timeframe).sort(), ["1D", "H", "M", "Q", "Y"]);
    const m = snap.readings.find((r) => r.timeframe === "M");
    assert.ok(m && m.isDecision);
    assert.equal(m.label, "Neutral");
    assert.equal(m.candle, "green");
    assert.equal(m.match, "disagree");
    assert.equal(m.netVolume, -400);
    assert.equal(snap.decision.action, "STAND_ASIDE");
    assert.equal(snap.decision.traderDecides, true);
    assert.equal(snap.enginePick.status, "not-applicable");
    assert.equal(snap.position.status, "none");
    assert.equal(snap.ticket.open, true);
    for (const list of [snap.ticket.calls, snap.ticket.puts]) {
      assert.ok(list && list.shown.length > 0);
      assert.equal(list.expiration, NEAREST);
      for (const c of list.shown) {
        assert.ok(Math.abs(c.delta) >= DELTA_THRESHOLDS.floor);
        assert.equal(c.expiration, NEAREST);
      }
      const costs = list.shown.map((c) => c.costAtAsk);
      assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
    }
    assert.ok(parseDeskSnapshot(JSON.parse(JSON.stringify(snap))).ok);
  });
  it("Drive with a contract at 0.80 or deeper: engine pick is primary, no fallback marking; the ticket is closed", async () => {
    const snap = await buildDeskSnapshot(makeDeps(DRIVE), CFG, createMemoryDeskStore());
    assert.equal(snap.decision.action, "CALL");
    assert.equal(snap.enginePick.status, "contract");
    if (snap.enginePick.status === "contract") {
      assert.equal(snap.enginePick.tier, "primary");
      assert.equal(snap.enginePick.fallbackLabel, null);
      assert.ok(Math.abs(snap.enginePick.contract.delta) >= DELTA_THRESHOLDS.primary);
    }
    assert.equal(snap.ticket.open, true);
  });
  it("Reverse with no put at 0.80: the engine pick is the CHEAPEST at or above 0.60, marked FALLBACK DELTA (below 0.80) with the reason", async () => {
    const snap = await buildDeskSnapshot(makeDeps(REVERSE, { putStrikes: [690, 800, 850, 900] }), CFG, createMemoryDeskStore());
    assert.equal(snap.decision.action, "PUT");
    assert.equal(snap.enginePick.status, "contract");
    if (snap.enginePick.status === "contract") {
      assert.equal(snap.enginePick.tier, "fallback");
      assert.equal(snap.enginePick.fallbackLabel, FALLBACK_LABEL);
      assert.equal(snap.enginePick.fallbackLabel, "FALLBACK DELTA (below 0.80)");
      assert.equal(snap.enginePick.contract.symbol, PUT_800);
      assert.match(snap.enginePick.fallbackReason ?? "", /CHEAPEST usable contract at or above the 0\.6 floor/);
      assert.equal(snap.enginePick.affordable, false);
      assert.ok(snap.enginePick.shortfall > 0);
    }
  });
  it("Reverse with nothing at or above 0.60: no contract, nothing substituted", async () => {
    const snap = await buildDeskSnapshot(makeDeps(REVERSE, { putStrikes: [690, 700] }), CFG, createMemoryDeskStore());
    assert.equal(snap.enginePick.status, "none");
  });
  it("data unavailable (bars failing): honest decision, no readings, no pick, ticket off", async () => {
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL, { dailyFails: true }), CFG, createMemoryDeskStore());
    assert.equal(snap.decision.action, "DATA_UNAVAILABLE");
    assert.equal(snap.readings.length, 0);
    assert.equal(snap.enginePick.status, "not-applicable");
    assert.equal(snap.ticket.open, false);
    assert.match(snap.ticket.reason ?? "", /Data unavailable/);
    assert.ok(parseDeskSnapshot(JSON.parse(JSON.stringify(snap))).ok);
  });
  it("stale bars: every reading is Data unavailable and the decision is unavailable", async () => {
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL, { now: new Date("2026-11-12T21:30:00Z") }), CFG, createMemoryDeskStore());
    assert.equal(snap.decision.action, "DATA_UNAVAILABLE");
    assert.ok(snap.readings.every((r) => r.status === "unavailable" && r.label === "Data unavailable"));
    assert.equal(snap.ticket.open, false);
  });
  it("no store, or an unreadable store: the position is UNKNOWN (never 'none') and the ticket is off", async () => {
    const none = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, null);
    assert.equal(none.position.status, "unknown");
    assert.equal(none.store.available, false);
    assert.equal(none.ticket.open, false);
    const broken = createMemoryDeskStore();
    broken.failReads = true;
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, broken);
    assert.equal(snap.position.status, "unknown");
    assert.match(snap.store.error ?? "", /could not be reached/);
    assert.equal(snap.ticket.open, false);
    assert.ok(parseDeskSnapshot(JSON.parse(JSON.stringify(snap))).ok);
  });
  it("a held dry-run position is shown with a live quote and result; the ticket is off (one at a time)", async () => {
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore(heldState()));
    assert.equal(snap.position.status, "held");
    if (snap.position.status === "held") {
      assert.equal(snap.position.symbol, PUT_850);
      assert.ok(snap.position.quote);
      assert.equal(snap.position.belowTargetLabel, MANUAL_BELOW_TARGET_LABEL);
    }
    assert.equal(snap.ticket.open, false);
    assert.match(snap.ticket.reason ?? "", /already held/);
  });
  it("a held position with no quote says so instead of inventing a result", async () => {
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL, { heldQuote: false }), CFG, createMemoryDeskStore(heldState()));
    assert.ok(snap.position.status === "held" && snap.position.quote === null);
  });
  it("candidate list is capped and says how many exist", async () => {
    const many = Array.from({ length: 120 }, (_, i) => 760 + i * 3);
    const snap = await buildDeskSnapshot(makeDeps(NEUTRAL, { putStrikes: many }), CFG, createMemoryDeskStore());
    assert.ok(snap.ticket.puts);
    assert.ok(snap.ticket.puts.total > CANDIDATES_MAX);
    assert.equal(snap.ticket.puts.shown.length, CANDIDATES_MAX);
  });
  it("building the page data never writes to the store", async () => {
    const store = createMemoryDeskStore(heldState());
    let writes = 0;
    const spy = { read: () => store.read(), write: async (s: DeskState) => { writes++; return store.write(s); } };
    await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, spy);
    await buildDeskSnapshot(makeDeps(REVERSE), CFG, spy);
    assert.equal(writes, 0);
  });
  it("the client check refuses a snapshot of the wrong shape", async () => {
    const snap = JSON.parse(JSON.stringify(await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore()))) as Record<string, unknown>;
    for (const mutate of [
      (s: Record<string, unknown>) => { s.dryRun = false; },
      (s: Record<string, unknown>) => { s.readings = [{ timeframe: "D" }]; },
      (s: Record<string, unknown>) => { s.decision = null; },
      (s: Record<string, unknown>) => { s.position = { status: "held" }; },
      (s: Record<string, unknown>) => { s.ticket = { open: "yes" }; },
      (s: Record<string, unknown>) => { s.journal = [{ id: 1 }]; },
    ]) {
      const copy = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
      mutate(copy);
      assert.equal(parseDeskSnapshot(copy).ok, false);
    }
    assert.equal(parseDeskSnapshot(null).ok, false);
  });
});

describe("desk stores", () => {
  const ENV = { KV_REST_API_URL: "https://kv.example.com", KV_REST_API_TOKEN: "tok" };
  function fakeKv(initial: string | null = null) {
    let value = initial;
    const seen: Array<{ url: string; body: string[] }> = [];
    const fetchImpl = (async (url: string, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? "[]") as string[];
      seen.push({ url, body });
      if (body[0] === "GET") return { ok: true, status: 200, json: async () => ({ result: value }) };
      value = body[2];
      return { ok: true, status: 200, json: async () => ({ result: "OK" }) };
    }) as never;
    return { fetchImpl, seen, get: () => value };
  }
  it("KV store round-trips under its own key and talks only to the KV url", async () => {
    const kv = fakeKv();
    const store = createKvDeskStore(ENV, kv.fetchImpl);
    assert.ok(store);
    const first = await store.read();
    assert.ok(first.ok && first.state.position === null);
    const w = await store.write(heldState());
    assert.ok(w.ok);
    const back = await store.read();
    assert.ok(back.ok && back.state.position?.symbol === PUT_850);
    assert.ok(kv.seen.every((c) => c.url === "https://kv.example.com" && c.body[1] === DESK_STORE_KEY));
  });
  it("KV problems are errors: bad status, malformed value, bad JSON, thrown fetch, no confirmation", async () => {
    const mk = (f: unknown) => createKvDeskStore(ENV, f as never)!;
    assert.equal((await mk(async () => ({ ok: false, status: 500, json: async () => ({}) })).read()).ok, false);
    assert.equal((await mk(async () => ({ ok: true, status: 200, json: async () => ({ result: 5 }) })).read()).ok, false);
    assert.equal((await mk(async () => ({ ok: true, status: 200, json: async () => ({ result: "{not json" }) })).read()).ok, false);
    assert.equal((await mk(async () => ({ ok: true, status: 200, json: async () => ({ result: JSON.stringify({ version: 1, journal: "x" }) }) })).read()).ok, false);
    assert.equal((await mk(async () => { throw new Error("boom"); }).read()).ok, false);
    assert.equal((await mk(async () => ({ ok: true, status: 200, json: async () => ({ result: "NOPE" }) })).write(EMPTY_DESK)).ok, false);
  });
  it("no credentials: no KV store; memory store only outside production", () => {
    assert.equal(createKvDeskStore({}), null);
    assert.equal(createDeskStore({}), null);
    assert.equal(createDeskStore({ SPY_DESK_STORE: "memory", NODE_ENV: "production" }), null);
    assert.ok(createDeskStore({ SPY_DESK_STORE: "memory", NODE_ENV: "development" }));
    assert.ok(createDeskStore(ENV));
  });
});

describe("HTTP handlers", () => {
  const BASE = "https://www.polarito.com";
  const live = (sc = NEUTRAL, o = {}) => async () => ({ ok: true as const, deps: makeDeps(sc, o), config: CFG });
  const ctx = (over: Partial<DeskContext> = {}): DeskContext => ({ env: { POLARITO_SPY_DESK: "1" }, makeLive: live(), store: createMemoryDeskStore(), ...over });
  const post = (path: string, body: unknown, headers: Record<string, string> = { origin: BASE, host: "www.polarito.com" }) =>
    new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const ticketBody = { type: "put", symbol: PUT_850, acknowledgeDryRun: true };

  it("flag off: every route answers 404 DESK_OFF and touches nothing", async () => {
    const off = ctx({ env: {}, makeLive: async () => { throw new Error("must not be called"); } });
    for (const res of [await handleSnapshot(off), await handleTicket(post("/api/spy/ticket", ticketBody), off), await handleClose(post("/api/spy/close", { acknowledgeDryRun: true }), off)]) {
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { code: string }).code, "DESK_OFF");
    }
  });
  it("snapshot: 200 with the page data; keys missing: 503 'Data unavailable', no invented data", async () => {
    const ok = await handleSnapshot(ctx());
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.ok(parseDeskSnapshot(await ok.json()).ok);
    const noKeys = await handleSnapshot(ctx({ makeLive: async () => ({ ok: false, code: "NO_KEYS", error: "No Alpaca keys found" }) }));
    assert.equal(noKeys.status, 503);
    const body = (await noKeys.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /^Data unavailable/);
  });
  it("ticket: cross-site 403, bad JSON 400, bad body 400, success 200 and the position is saved", async () => {
    const c = ctx({ makeLive: live(REVERSE) });
    assert.equal((await handleTicket(post("/api/spy/ticket", ticketBody, { origin: "https://evil.example", host: "www.polarito.com" }), c)).status, 403);
    assert.equal((await handleTicket(post("/api/spy/ticket", ticketBody, {}), c)).status, 403);
    assert.equal((await handleTicket(post("/api/spy/ticket", "{nope"), c)).status, 400);
    assert.equal((await handleTicket(post("/api/spy/ticket", { ...ticketBody, quantity: 9 }), c)).status, 400);
    assert.equal((await handleTicket(post("/api/spy/ticket", { type: "put", symbol: PUT_850 }), c)).status, 400);
    const ok = await handleTicket(post("/api/spy/ticket", ticketBody), c);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { ok: boolean; dryRun: boolean; message: string };
    assert.ok(body.ok && body.dryRun);
    assert.match(body.message, /No order sent/);
    const s = await c.store!.read();
    assert.ok(s.ok && s.state.position?.source === "manual");
    const again = await handleTicket(post("/api/spy/ticket", ticketBody), c);
    assert.equal(again.status, 409);
  });
  it("ticket on a Drive reading is recorded as MANUAL; keys missing: 503 and nothing saved", async () => {
    const c = ctx({ makeLive: live(DRIVE) });
    const res = await handleTicket(post("/api/spy/ticket", { type: "call", symbol: CALL_600, acknowledgeDryRun: true }), c);
    assert.equal(res.status, 200);
    const saved = await c.store!.read();
    assert.ok(saved.ok && saved.state.position?.source === "manual");
    const c2 = ctx({ makeLive: async () => ({ ok: false, code: "NO_KEYS", error: "none" }) });
    assert.equal((await handleTicket(post("/api/spy/ticket", ticketBody), c2)).status, 503);
  });
  it("close: cross-site 403, bad body 400, nothing to close 409, success 200", async () => {
    const c = ctx({ store: createMemoryDeskStore(heldState()) });
    assert.equal((await handleClose(post("/api/spy/close", { acknowledgeDryRun: true }, { origin: "https://evil.example", host: "www.polarito.com" }), c)).status, 403);
    assert.equal((await handleClose(post("/api/spy/close", {}), c)).status, 400);
    const ok = await handleClose(post("/api/spy/close", { acknowledgeDryRun: true }), c);
    assert.equal(ok.status, 200);
    const again = await handleClose(post("/api/spy/close", { acknowledgeDryRun: true }), c);
    assert.equal(again.status, 409);
  });
  it("a thrown error becomes a 500 with no detail", async () => {
    const boom = ctx({ makeLive: async () => { throw new Error("secret detail"); } });
    const res = await handleSnapshot(boom);
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(await res.json()), /secret detail/);
  });
});

describe("no order can be sent from the SPY desk", () => {
  const logic = ["src/lib/spyDesk.ts", "src/lib/spyDeskFormat.ts", "src/lib/spyDeskLive.ts", "src/lib/spyDeskRoutes.ts", "src/lib/spyAuto.ts", "src/lib/spyAutoTypes.ts", "src/lib/spyAutoRoutes.ts", "src/app/api/spy/auto/route.node.ts", "src/app/api/spy/auto-run/route.node.ts", "src/app/api/spy/desk/route.node.ts", "src/app/api/spy/ticket/route.node.ts", "src/app/api/spy/close/route.node.ts", "src/app/spy/page.tsx", "src/components/spy/SpyDeskView.tsx", "src/lib/spyLive.ts", "src/lib/spyPoller.ts", "src/lib/spyDeskData.ts", "src/lib/spyDeskClient.ts", "src/lib/spyTtlCache.ts", "src/lib/spyGear.ts", "src/lib/spyAnalysis.ts", "src/lib/spyAnalyzer.ts", "src/app/api/spy/live/route.node.ts", "src/app/api/spy/analyze/route.node.ts"];
  const withOwnWrites = ["src/lib/spyDeskStore.ts", "src/lib/spyKv.ts", "src/components/spy/SpyDesk.tsx"];
  const all = [...logic, ...withOwnWrites];

  it("no order endpoint, order function, broker execution module or live-trading switch anywhere in the desk files", () => {
    for (const f of all) {
      const src = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(src, /\/v2\/orders/, f);
      assert.doesNotMatch(src, /\/v2\/positions/, f);
      assert.doesNotMatch(src, /process\.env\.POLARITO_LIVE_TRADING_ENABLED|POLARITO_LIVE_TRADING_ENABLED/, f);
      assert.doesNotMatch(src, /from ["'](@|\.\.?)\/(src\/)?lib\/broker\/(alpacaLive|alpacaPaper|liveConfig|execute)/, f);
      assert.doesNotMatch(src, /liveBuy|liveClose|orderGuard|liveAutoGuard|createLiveBroker|submitOrder|placeOrder|createOrder|closePosition/, f);
      assert.doesNotMatch(src, /api\/broker\//, f);
    }
  });
  it("the only broker modules the desk imports are types and the option-symbol parser", () => {
    for (const f of all) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/from ["']@\/lib\/broker\/([A-Za-z]+)["']/g)) {
        assert.ok(["options", "types"].includes(m[1]), `${f} imports broker/${m[1]}`);
      }
    }
  });
  it("no write verb in the logic, data, route or view files; the files that POST do so only to the KV store and to /api/spy/*", () => {
    for (const f of logic) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, f);
    const client = fs.readFileSync("src/components/spy/SpyDesk.tsx", "utf8");
    for (const m of client.matchAll(/fetch\(\s*([^,)]+)/g)) assert.match(m[1].trim(), /^("\/api\/spy\/|path$)/, `unexpected fetch target ${m[1]}`);
    for (const m of client.matchAll(/post\(\s*"([^"]+)"/g)) assert.match(m[1], /^\/api\/spy\/(ticket|close|auto)$/);
    const store = fs.readFileSync("src/lib/spyDeskStore.ts", "utf8");
    assert.doesNotMatch(store, /alpaca\.markets/i);
    assert.equal([...store.matchAll(/fetchImpl\(/g)].length, 1);
  });
  it("the data the page reads comes only through the GET-only Alpaca client", () => {
    const live = fs.readFileSync("src/lib/spyDeskLive.ts", "utf8");
    assert.match(live, /connectAlpaca/);
    assert.doesNotMatch(live, /fetch\(/);
    for (const f of ["src/lib/spyChain.ts", "src/lib/spyBars.ts", "src/lib/spyConnect.ts"]) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, f);
  });
  it("the snapshot route is computed per request (never prerendered at build time)", () => {
    assert.match(fs.readFileSync("src/app/api/spy/desk/route.node.ts", "utf8"), /await connection\(\)/);
  });
  it("the desk is off by default in the page and the three routes", () => {
    assert.match(fs.readFileSync("src/components/spy/SpyDeskPage.tsx", "utf8"), /deskEnabled\(process\.env\)/);
    for (const p of ["src/app/spy/page.tsx", "src/app/spy-wwv/page.tsx"]) assert.match(fs.readFileSync(p, "utf8"), /SpyDeskPage profile=/, p);
    assert.match(fs.readFileSync("src/lib/spyDeskRoutes.ts", "utf8"), /if \(!deskEnabled\(ctx\.env\)\) return off\(\)/);
    assert.equal(SPOT, 690);
  });
});
