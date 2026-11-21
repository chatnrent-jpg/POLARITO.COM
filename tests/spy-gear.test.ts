import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps, type TicketUi } from "../src/components/spy/SpyDeskView";
import { NO_ANALYSIS, createAnalyzer, gearPermit, sidePermit, type AnalyzerState, type PermitInput } from "../src/lib/spyAnalyzer";
import { buildAnalysis, checkTicker, parseAnalysis, type Analysis } from "../src/lib/spyAnalysis";
import { buildDeskSnapshot, openManual, parseTicketRequest, type DeskPosition, type DeskState } from "../src/lib/spyDesk";
import { handleAnalyze, handleClose, handleTicket, type DeskContext } from "../src/lib/spyDeskRoutes";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { LOADING_FRESHNESS, type Freshness } from "../src/lib/spyDeskData";
import { GEARS, GEAR_NAMES, checkSide, gearFromAction, type Gear } from "../src/lib/spyGear";
import type { PollResult } from "../src/lib/spyPoller";
import { DRIVE, NEUTRAL, REVERSE, T0, makeDeps, row, type Calls, type Scenario } from "./helpers/spyDeskFixtures";
import { createFakeClock } from "./helpers/fakeClock";

const CFG = { timeframe: "M" as const, liveBudget: 1000 };
const CALL_600 = "SPY271105C00600000";
const PUT_850 = "SPY271105P00850000";
const SCENARIOS: Record<Gear, Scenario> = { DRIVE, NEUTRAL, REVERSE };
const SIDES = ["call", "put"] as const;
const SYMBOL = { call: CALL_600, put: PUT_850 } as const;
const allowedBy = (gear: Gear, side: "call" | "put"): boolean => gear === "NEUTRAL" || (gear === "DRIVE") === (side === "call");

/* ------------------------------------------------------------ the rule */

describe("gear rule (pure)", () => {
  it("maps the engine action to Drive / Neutral / Reverse, and anything else to no gear", () => {
    assert.equal(gearFromAction("CALL"), "DRIVE");
    assert.equal(gearFromAction("PUT"), "REVERSE");
    assert.equal(gearFromAction("STAND_ASIDE"), "NEUTRAL");
    for (const a of ["DATA_UNAVAILABLE", "UNKNOWN", "", null, undefined, 1]) assert.equal(gearFromAction(a), null);
  });
  for (const gear of GEARS) {
    for (const side of SIDES) {
      it(`${GEAR_NAMES[gear]} x ${side}: ${allowedBy(gear, side) ? "allowed" : "blocked, with a clear message"}`, () => {
        const c = checkSide(gear, side);
        assert.equal(c.allowed, allowedBy(gear, side));
        if (c.allowed) assert.match(c.message, /is allowed/);
        else assert.match(c.message, new RegExp(`${side === "call" ? "Call" : "Put"} is blocked: the gear is ${GEAR_NAMES[gear]}, so only a ${side === "call" ? "Put" : "Call"} can be opened`));
      });
    }
  }
});

/* -------------------------------------------------------- Analyze, server */

const BASE = "https://www.polarito.com";
const live = (sc: Scenario = NEUTRAL, o = {}) => async () => ({ ok: true as const, deps: makeDeps(sc, o), config: CFG });
const ctx = (over: Partial<DeskContext> = {}): DeskContext => ({ env: { POLARITO_SPY_DESK: "1" }, makeLive: live(), store: createMemoryDeskStore(), ...over });
const get = (qs = "?ticker=SPY") => new Request(`${BASE}/api/spy/analyze${qs}`, { method: "GET" });
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "www.polarito.com" }, body: JSON.stringify(body) });
const calls = (): Calls => ({ daily: 0, spot: 0, sides: [], held: 0 });

describe("Analyze (server)", () => {
  for (const gear of GEARS) {
    it(`${GEAR_NAMES[gear]}: the answer carries the gear, the allowed sides, the monthly net volume and the as-of time`, async () => {
      const c = calls();
      const res = await handleAnalyze(get(), ctx({ makeLive: live(SCENARIOS[gear], { calls: c }) }));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const parsed = parseAnalysis(await res.json());
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
      const a = parsed.analysis;
      assert.equal(a.gear, gear);
      assert.deepEqual(a.allowed, { call: allowedBy(gear, "call"), put: allowedBy(gear, "put") });
      assert.equal(a.ticker, "SPY");
      assert.equal(a.timeframe, "M");
      assert.equal(a.reading.timeframe, "M");
      assert.equal(typeof a.reading.netVolume, "number");
      assert.ok(a.reading.asOf);
      assert.equal(a.generatedAt, T0.toISOString());
      assert.equal(c.daily, 1, "one bars call");
      assert.equal(c.spot + c.held, 0);
      assert.deepEqual(c.sides, [], "the option chain is never read");
    });
  }
  it("SPY only: no ticker or spy (any case) works, anything else is refused before any data is read", async () => {
    for (const qs of ["", "?ticker=spy", "?ticker=SPY"]) assert.equal((await handleAnalyze(get(qs), ctx())).status, 200);
    const c = calls();
    for (const qs of ["?ticker=AAPL", "?ticker=", "?ticker=SPY%20X"]) {
      const res = await handleAnalyze(get(qs), ctx({ makeLive: live(DRIVE, { calls: c }) }));
      assert.equal(res.status, 400, qs);
    }
    assert.equal(c.daily, 0);
    assert.equal(checkTicker("QQQ") !== null, true);
  });
  it("flag off: 404 and nothing is read", async () => {
    const res = await handleAnalyze(get(), ctx({ env: {}, makeLive: async () => { throw new Error("must not be called"); } }));
    assert.equal(res.status, 404);
  });
  it("missing bars, stale bars and missing keys are errors with no gear (Justice), never a guess", async () => {
    const missing = await handleAnalyze(get(), ctx({ makeLive: live(DRIVE, { dailyFails: true }) }));
    assert.equal(missing.status, 503);
    const mj = (await missing.json()) as { ok: boolean; error: string; gear?: unknown };
    assert.equal(mj.ok, false);
    assert.equal(mj.gear, undefined);
    assert.match(mj.error, /Data unavailable/);
    const stale = await handleAnalyze(get(), ctx({ makeLive: live(DRIVE, { now: new Date("2026-11-12T21:30:00Z") }) }));
    assert.equal(stale.status, 503);
    assert.match(((await stale.json()) as { error: string }).error, /Data unavailable/);
    const noKeys = await handleAnalyze(get(), ctx({ makeLive: async () => ({ ok: false, code: "NO_KEYS", error: "none" }) }));
    assert.equal(noKeys.status, 503);
    const boom = await handleAnalyze(get(), ctx({ makeLive: async () => { throw new Error("secret detail"); } }));
    assert.equal(boom.status, 500);
    assert.doesNotMatch(await boom.text(), /secret detail/);
  });
  it("buildAnalysis never throws", async () => {
    const deps = { ...makeDeps(DRIVE), loadDaily: async () => { throw new Error("x"); } };
    const out = await buildAnalysis(deps, CFG);
    assert.equal(out.ok, false);
  });
});

describe("Analyze payload check (browser side)", () => {
  const good = async (gear: Gear = "DRIVE"): Promise<Record<string, unknown>> => JSON.parse(JSON.stringify(await buildAnalysis(makeDeps(SCENARIOS[gear]), CFG)));
  it("accepts a real answer", async () => assert.ok(parseAnalysis(await good()).ok));
  it("rejects malformed answers", async () => {
    const g = await good();
    const cases: unknown[] = [
      null, [], "x", {},
      { ...g, ok: false }, { ...g, kind: "live" }, { ...g, dryRun: false },
      { ...g, ticker: "AAPL" }, { ...g, generatedAt: "not a time" }, { ...g, generatedAt: 5 },
      { ...g, timeframe: "X" }, { ...g, gear: "SIDEWAYS" }, { ...g, gear: null },
      { ...g, allowed: { call: true, put: true } },
      { ...g, allowed: null }, { ...g, allowed: { call: "yes", put: false } },
      { ...g, reading: null }, { ...g, reading: { ...(g.reading as object), status: "unavailable" } }, { ...g, reading: { ...(g.reading as object), timeframe: "Q" } },
      { ...g, bars: 0 }, { ...g, bars: "many" },
    ];
    for (const c of cases) assert.equal(parseAnalysis(c).ok, false, JSON.stringify(c)?.slice(0, 80));
  });
  it("a gear that disagrees with its own allowed sides is refused for every gear", async () => {
    for (const gear of GEARS) {
      const g = await good(gear);
      const flipped = { call: !allowedBy(gear, "call"), put: allowedBy(gear, "put") };
      assert.equal(parseAnalysis({ ...g, allowed: flipped }).ok, false);
    }
  });
});

/* ------------------------------------------------------------ ticket, server */

describe("manual ticket: the server recomputes the gear (every gear x side)", () => {
  for (const gear of GEARS) {
    for (const side of SIDES) {
      const ok = allowedBy(gear, side);
      it(`openManual, ${GEAR_NAMES[gear]} x ${side}: ${ok ? "recorded" : "refused COUNTER_POLARITY, nothing saved, no chain read"}`, async () => {
        const store = createMemoryDeskStore();
        const c = calls();
        const res = await openManual(makeDeps(SCENARIOS[gear], { calls: c }), CFG, store, { type: side, symbol: SYMBOL[side] });
        const saved = await store.read();
        assert.ok(saved.ok);
        if (ok) {
          assert.ok(res.ok, res.ok ? "" : res.error);
          assert.equal(saved.state.position?.type, side);
        } else {
          assert.ok(!res.ok && res.code === "COUNTER_POLARITY" && res.status === 409);
          assert.match(res.error, new RegExp(`is blocked: the gear is ${GEAR_NAMES[gear]}`));
          assert.match(res.error, /Nothing was recorded/);
          assert.equal(saved.state.position, null);
          assert.equal(saved.state.journal.length, 0);
          assert.deepEqual(c.sides, [], "refused before the option chain was read");
        }
      });
      it(`HTTP ticket, ${GEAR_NAMES[gear]} x ${side}: ${ok ? "200" : "409 with the clear error"}`, async () => {
        const c = ctx({ makeLive: live(SCENARIOS[gear]) });
        const res = await handleTicket(post("/api/spy/ticket", { type: side, symbol: SYMBOL[side], acknowledgeDryRun: true, analyzedGear: gear }), c);
        const body = (await res.json()) as { ok: boolean; code?: string; error?: string };
        const saved = await c.store!.read();
        assert.ok(saved.ok);
        if (ok) {
          assert.equal(res.status, 200);
          assert.equal(body.ok, true);
          assert.equal(saved.state.position?.type, side);
        } else {
          assert.equal(res.status, 409);
          assert.equal(body.code, "COUNTER_POLARITY");
          assert.match(body.error ?? "", /is blocked: the gear is/);
          assert.equal(saved.state.position, null);
        }
      });
    }
  }
  it("never trusts the client: a ticket that claims another gear (or sends none) is still checked against the server's gear", async () => {
    for (const claim of [undefined, "NEUTRAL", "REVERSE", "DRIVE"] as const) {
      const c = ctx({ makeLive: live(DRIVE) });
      const body = { type: "put", symbol: PUT_850, acknowledgeDryRun: true, ...(claim ? { analyzedGear: claim } : {}) };
      const res = await handleTicket(post("/api/spy/ticket", body), c);
      assert.equal(res.status, 409, String(claim));
      assert.equal(((await res.json()) as { code: string }).code, "COUNTER_POLARITY");
      const saved = await c.store!.read();
      assert.ok(saved.ok && saved.state.position === null);
    }
  });
  it("a gear that moved since Analyze is refused with GEAR_CHANGED (even on an allowed side); the matching gear passes", async () => {
    const moved = ctx({ makeLive: live(NEUTRAL) });
    const res = await handleTicket(post("/api/spy/ticket", { type: "call", symbol: CALL_600, acknowledgeDryRun: true, analyzedGear: "DRIVE" }), moved);
    assert.equal(res.status, 409);
    const j = (await res.json()) as { code: string; error: string };
    assert.equal(j.code, "GEAR_CHANGED");
    assert.match(j.error, /changed from Drive \(when you analyzed\) to Neutral/);
    assert.ok((await moved.store!.read()).ok && ((await moved.store!.read()) as { state: DeskState }).state.position === null);
    const fine = await handleTicket(post("/api/spy/ticket", { type: "call", symbol: CALL_600, acknowledgeDryRun: true, analyzedGear: "NEUTRAL" }), ctx({ makeLive: live(NEUTRAL) }));
    assert.equal(fine.status, 200);
  });
  it("stale or missing gear data is refused and nothing is recorded (Justice)", async () => {
    for (const o of [{ dailyFails: true }, { now: new Date("2026-11-12T21:30:00Z") }]) {
      const c = ctx({ makeLive: live(DRIVE, o) });
      const res = await handleTicket(post("/api/spy/ticket", { type: "call", symbol: CALL_600, acknowledgeDryRun: true }), c);
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { code: string }).code, "DATA_UNAVAILABLE");
      const saved = await c.store!.read();
      assert.ok(saved.ok && saved.state.position === null);
    }
  });
  it("analyzedGear is validated: only DRIVE, NEUTRAL or REVERSE", () => {
    for (const g of GEARS) assert.ok(parseTicketRequest({ type: "put", symbol: PUT_850, acknowledgeDryRun: true, analyzedGear: g }).ok);
    for (const bad of ["drive", "CALL", 1, null, true]) assert.equal(parseTicketRequest({ type: "put", symbol: PUT_850, acknowledgeDryRun: true, analyzedGear: bad }).ok, false);
    assert.ok(parseTicketRequest({ type: "put", symbol: PUT_850, acknowledgeDryRun: true }).ok);
  });
  it("manual Close is never gated by the gear: a held position of the 'wrong' side closes under every gear", async () => {
    for (const gear of GEARS) {
      for (const side of SIDES) {
        const r = row(side, "2027-11-05", side === "put" ? 850 : 600);
        const position: DeskPosition = { type: side, symbol: r.symbol, expiration: "2027-11-05", strike: r.strike, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "x", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual" };
        const c = ctx({ makeLive: live(SCENARIOS[gear]), store: createMemoryDeskStore({ version: 1, position, journal: [] }) });
        const res = await handleClose(post("/api/spy/close", { acknowledgeDryRun: true }), c);
        assert.equal(res.status, 200, `${gear} ${side}`);
      }
    }
  });
});

/* --------------------------------------------------------- the analyzer */

describe("analyzer (client logic, fake clock)", () => {
  const T = T0.getTime();
  const answer = async (sc: Scenario, at = T0): Promise<PollResult<unknown>> => ({ ok: true, value: JSON.parse(JSON.stringify(await buildAnalysis(makeDeps(sc, { now: at }), CFG))) });
  function rig(script: (n: number, signal: AbortSignal) => Promise<PollResult<unknown>>) {
    const clock = createFakeClock(T);
    const log = { n: 0, open: 0, maxOpen: 0 };
    const a = createAnalyzer({
      env: clock.env,
      fetchAnalysis: async (signal) => {
        const n = ++log.n;
        log.open++;
        log.maxOpen = Math.max(log.maxOpen, log.open);
        try {
          return await script(n, signal);
        } finally {
          log.open--;
        }
      },
    });
    const states: AnalyzerState[] = [];
    a.subscribe(() => states.push(a.getState()));
    return { clock, a, log, states };
  }
  const input = (a: AnalyzerState, liveAction: string, liveFreshness: PermitInput["liveFreshness"] = "live"): PermitInput => ({ analyzer: a, liveAction, liveFreshness });

  it("starts with nothing: the ticket is disabled and says to press Analyze", () => {
    const p = gearPermit(input(NO_ANALYSIS, "CALL"));
    assert.ok(!p.ready && p.kind === "needs-analyze");
    assert.match(p.message, /Press Analyze first/);
  });
  it("Analyze: loading, then ok with the gear; the ticket then works for the gear's side", async () => {
    const r = rig(() => answer(DRIVE));
    const p = r.a.analyze();
    assert.equal(r.a.getState().status, "loading");
    assert.ok(!gearPermit(input(r.a.getState(), "CALL")).ready);
    await p;
    const s = r.a.getState();
    assert.equal(s.status, "ok");
    assert.equal(s.analysis?.gear, "DRIVE");
    const g = gearPermit(input(s, "CALL"));
    assert.ok(g.ready && g.gear === "DRIVE");
  });
  it("a second click while one request runs does not start another", async () => {
    let release: (v: PollResult<unknown>) => void = () => undefined;
    const r = rig(() => new Promise((res) => (release = res)));
    const first = r.a.analyze();
    const second = r.a.analyze();
    await r.clock.settle();
    assert.equal(r.log.n, 1);
    release(await answer(NEUTRAL));
    await Promise.all([first, second]);
    assert.equal(r.log.maxOpen, 1);
  });
  it("a failed Analyze leaves NO gear and an error; a later good one recovers", async () => {
    let n = 0;
    const r = rig(async () => (++n === 1 ? { ok: false, error: "Data unavailable: bars down." } : answer(REVERSE)));
    await r.a.analyze();
    assert.equal(r.a.getState().status, "error");
    assert.equal(r.a.getState().analysis, null);
    const p = gearPermit(input(r.a.getState(), "PUT"));
    assert.ok(!p.ready && p.kind === "error");
    assert.match(p.message, /Data unavailable: bars down/);
    await r.a.analyze();
    assert.equal(r.a.getState().analysis?.gear, "REVERSE");
  });
  it("refuses a malformed answer, and an answer far from the computer's clock", async () => {
    const r1 = rig(async () => ({ ok: true, value: { ok: true, kind: "analysis", gear: "DRIVE" } }));
    await r1.a.analyze();
    assert.equal(r1.a.getState().status, "error");
    assert.match(r1.a.getState().error ?? "", /unexpected shape/);
    const r2 = rig(() => answer(DRIVE, new Date(T + 300_000)));
    await r2.a.analyze();
    assert.equal(r2.a.getState().status, "error");
    assert.match(r2.a.getState().error ?? "", /clock/);
    const r3 = rig(() => answer(DRIVE, new Date(T - 300_000)));
    await r3.a.analyze();
    assert.equal(r3.a.getState().analysis, null);
  });
  it("a request that never answers is cut off after 15 s, with no gear shown", async () => {
    const r = rig(() => new Promise(() => undefined));
    const p = r.a.analyze();
    await r.clock.advance(14_999);
    assert.equal(r.a.getState().status, "loading");
    await r.clock.advance(2);
    await p;
    assert.equal(r.a.getState().status, "error");
    assert.match(r.a.getState().error ?? "", /timed out/);
    assert.equal(r.clock.pendingTimers(), 0);
  });
  it("a fetch that throws is an error, not a crash", async () => {
    const r = rig(async () => {
      throw new Error("boom");
    });
    await r.a.analyze();
    assert.equal(r.a.getState().status, "error");
  });

  it("gear change under the 5 s refresh: warning, ticket re-blocked at once, gear loaded again once, side re-checked", async () => {
    let gear: Scenario = DRIVE;
    const r = rig(() => answer(gear));
    await r.a.analyze();
    assert.equal(r.log.n, 1);
    r.a.observe("CALL");
    assert.equal(r.log.n, 1, "same gear: nothing to do");
    gear = REVERSE;
    // The live data now says PUT while the analysed gear is still Drive: blocked before the new gear arrives.
    const blocked = gearPermit(input(r.a.getState(), "PUT"));
    assert.ok(!blocked.ready && blocked.kind === "gear-changed");
    assert.match(blocked.message, /changed from Drive to Reverse/);
    r.a.observe("PUT");
    assert.equal(r.a.getState().status, "loading");
    assert.deepEqual({ from: r.a.getState().gearChange?.from, to: r.a.getState().gearChange?.to }, { from: "DRIVE", to: "REVERSE" });
    const during = gearPermit(input(r.a.getState(), "PUT"));
    assert.ok(!during.ready && during.kind === "analyzing");
    await r.clock.settle();
    assert.equal(r.log.n, 2);
    const s = r.a.getState();
    assert.equal(s.status, "ok");
    assert.equal(s.analysis?.gear, "REVERSE");
    assert.equal(s.gearChange?.from, "DRIVE");
    // A Call selected under Drive is now blocked; a Put is allowed.
    assert.equal(sidePermit(input(s, "PUT"), "call").allowed, false);
    assert.match(sidePermit(input(s, "PUT"), "call").message, /Call is blocked: the gear is Reverse/);
    assert.equal(sidePermit(input(s, "PUT"), "put").allowed, true);
    r.a.observe("PUT");
    r.a.observe("PUT");
    await r.clock.settle();
    assert.equal(r.log.n, 2, "once per change");
  });
  it("if the re-analysis still disagrees with the live gear it does not loop, and the ticket stays blocked", async () => {
    const r = rig(() => answer(DRIVE));
    await r.a.analyze();
    for (let i = 0; i < 5; i++) {
      r.a.observe("PUT");
      await r.clock.settle();
    }
    assert.equal(r.log.n, 2);
    const p = gearPermit(input(r.a.getState(), "PUT"));
    assert.ok(!p.ready && p.kind === "gear-changed");
  });
  it("a failed re-analysis leaves no gear: the ticket stays blocked with the error", async () => {
    let n = 0;
    const r = rig(async () => (++n === 1 ? answer(DRIVE) : { ok: false, error: "down" }));
    await r.a.analyze();
    r.a.observe("STAND_ASIDE");
    await r.clock.settle();
    assert.equal(r.a.getState().status, "error");
    assert.equal(r.a.getState().analysis, null);
    assert.ok(!gearPermit(input(r.a.getState(), "STAND_ASIDE")).ready);
  });
  it("observe does nothing before Analyze, while loading, or when the live gear is unavailable", async () => {
    const r = rig(() => answer(DRIVE));
    r.a.observe("PUT");
    assert.equal(r.log.n, 0);
    await r.a.analyze();
    r.a.observe("DATA_UNAVAILABLE");
    r.a.observe("UNKNOWN");
    await r.clock.settle();
    assert.equal(r.log.n, 1);
    const p = gearPermit(input(r.a.getState(), "DATA_UNAVAILABLE"));
    assert.ok(!p.ready && p.kind === "gear-unavailable");
  });
  it("a manual Analyze clears the old gear-change warning", async () => {
    let sc: Scenario = DRIVE;
    const r = rig(() => answer(sc));
    await r.a.analyze();
    sc = REVERSE;
    r.a.observe("PUT");
    await r.clock.settle();
    assert.ok(r.a.getState().gearChange);
    await r.a.analyze();
    assert.equal(r.a.getState().gearChange, null);
  });
  it("a stale live refresh blocks the ticket (never act on data that may be old)", async () => {
    const r = rig(() => answer(DRIVE));
    await r.a.analyze();
    const p = gearPermit(input(r.a.getState(), "CALL", "stale"));
    assert.ok(!p.ready && p.kind === "stale");
    assert.ok(gearPermit(input(r.a.getState(), "CALL", "paused")).ready);
  });
  for (const gear of GEARS) {
    for (const side of SIDES) {
      it(`client check, ${GEAR_NAMES[gear]} x ${side}: ${allowedBy(gear, side) ? "allowed" : "blocked"} (after Analyze)`, async () => {
        const r = rig(() => answer(SCENARIOS[gear]));
        await r.a.analyze();
        const action = gear === "DRIVE" ? "CALL" : gear === "REVERSE" ? "PUT" : "STAND_ASIDE";
        const c = sidePermit(input(r.a.getState(), action), side);
        assert.equal(c.allowed, allowedBy(gear, side));
        assert.equal(c.gear, gear);
        const before = sidePermit(input(NO_ANALYSIS, action), side);
        assert.equal(before.allowed, false, "before Analyze nothing is allowed");
        assert.equal(before.gear, null);
      });
    }
  }
});

/* ------------------------------------------------------------- the view */

const LIVE: Freshness = { ...LOADING_FRESHNESS, state: "live", updatedAt: T0.toISOString(), chainAt: T0.toISOString() };
const noop = () => undefined;
function props(over: Partial<DeskViewProps>): DeskViewProps {
  return { load: { status: "loading" }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: LIVE, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over };
}
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const isDisabled = (t: string): boolean => /\sdisabled=""/.test(t);
const okState = async (sc: Scenario): Promise<AnalyzerState> => {
  const a = (await buildAnalysis(makeDeps(sc), CFG)) as Analysis;
  assert.ok(a.ok);
  return { status: "ok", analysis: a, error: null, gearChange: null };
};
const snapOf = (sc: Scenario, store = createMemoryDeskStore()) => buildDeskSnapshot(makeDeps(sc), CFG, store);

describe("ticket view: Ticker + Analyze", () => {
  it("before Analyze: Ticker (SPY, read-only), the Analyze button and the wording; the ticket is disabled", async () => {
    const out = html(props({ load: { status: "ready", snapshot: await snapOf(NEUTRAL) } }));
    assert.match(out, /Analyze loads the daily bars and the gear for this ticker, and the order below uses it\./);
    assert.match(out, /Select Call or Put\. It will be checked against the active gear immediately\./);
    const ticker = tag(out, "ticker-input");
    assert.match(ticker, /value="SPY"/);
    assert.match(ticker, /readOnly=""/);
    assert.ok(!isDisabled(tag(out, "analyze-button")));
    assert.match(out, /data-testid="ticket-disabled"/);
    assert.match(out, /Press Analyze first/);
    assert.ok(isDisabled(tag(out, "ticket-type-call")));
    assert.ok(isDisabled(tag(out, "ticket-type-put")));
    assert.doesNotMatch(out, /name="ticket-contract"/);
    assert.doesNotMatch(out, /data-testid="ticket-submit"/);
    assert.doesNotMatch(out, /data-testid="gear-card"/);
  });
  it("Analyze is disabled while it runs or while an action is running", async () => {
    const snapshot = await snapOf(NEUTRAL);
    const loading = html(props({ load: { status: "ready", snapshot }, analyzer: { ...NO_ANALYSIS, status: "loading" } }));
    assert.ok(isDisabled(tag(loading, "analyze-button")));
    assert.match(loading, /Analyzing/);
    assert.ok(isDisabled(tag(html(props({ load: { status: "ready", snapshot }, busy: true })), "analyze-button")));
  });
  it("after Analyze the gear card shows Drive/Neutral/Reverse, the monthly net volume and the as-of time", async () => {
    for (const gear of GEARS) {
      const out = html(props({ load: { status: "ready", snapshot: await snapOf(SCENARIOS[gear]) }, analyzer: await okState(SCENARIOS[gear]) }));
      assert.match(tag(out, "gear-card"), new RegExp(`data-gear="${gear}"`));
      assert.match(out, new RegExp(`data-testid="gear-name">${GEAR_NAMES[gear]}<`));
      assert.match(out, /Monthly net volume [+-]?[\d,]+ shares \(raw\)/);
      assert.match(out, /data-testid="gear-asof"[^>]*>as of /);
      assert.doesNotMatch(out, /data-testid="ticket-disabled"/);
    }
  });
  for (const gear of GEARS) {
    for (const side of SIDES) {
      const ok = allowedBy(gear, side);
      it(`${GEAR_NAMES[gear]} x ${side}: ${ok ? "message OK, the chain and the submit are available" : "blocked message, no chain, no submit even with a contract and the box ticked"}`, async () => {
        const ticket: TicketUi = { type: side, symbol: SYMBOL[side], ack: true };
        const out = html(props({ load: { status: "ready", snapshot: await snapOf(SCENARIOS[gear]) }, analyzer: await okState(SCENARIOS[gear]), ticket }));
        if (ok) {
          assert.match(out, /data-testid="side-ok"/);
          assert.doesNotMatch(out, /data-testid="side-blocked"/);
          assert.match(out, /name="ticket-contract"/);
          const submit = tag(out, "ticket-submit");
          assert.ok(submit !== "" && !isDisabled(submit));
        } else {
          assert.match(out, /data-testid="side-blocked"/);
          assert.match(out, new RegExp(`${side === "call" ? "Call" : "Put"} is blocked: the gear is ${GEAR_NAMES[gear]}`));
          assert.doesNotMatch(out, /data-testid="side-ok"/);
          assert.doesNotMatch(out, /name="ticket-contract"/);
          assert.doesNotMatch(out, /data-testid="ticket-submit"/);
        }
        assert.ok(!isDisabled(tag(out, "ticket-type-call")) && !isDisabled(tag(out, "ticket-type-put")), "both sides can be toggled to see the check");
      });
    }
  }
  it("gear changed under the refresh: warning, ticket re-blocked, selected side shown blocked once the new gear is loaded", async () => {
    // Analysed under Drive; the live data now says Reverse.
    const driveGear = await okState(DRIVE);
    const reverseSnap = await snapOf(REVERSE);
    const reblocked = html(props({ load: { status: "ready", snapshot: reverseSnap }, analyzer: { ...driveGear, gearChange: { from: "DRIVE", to: "REVERSE", at: T0.toISOString() } }, ticket: { type: "call", symbol: CALL_600, ack: true } }));
    assert.match(reblocked, /data-testid="gear-warning"/);
    assert.match(reblocked, /the gear changed from Drive to Reverse/);
    assert.match(reblocked, /data-testid="ticket-disabled"/);
    assert.ok(isDisabled(tag(reblocked, "ticket-type-call")));
    assert.doesNotMatch(reblocked, /name="ticket-contract"/);
    assert.doesNotMatch(reblocked, /data-testid="ticket-submit"/);
    // After the new gear is loaded the Call is blocked by name and the Put is allowed.
    const loaded = { ...(await okState(REVERSE)), gearChange: { from: "DRIVE" as const, to: "REVERSE" as const, at: T0.toISOString() } };
    const callOut = html(props({ load: { status: "ready", snapshot: reverseSnap }, analyzer: loaded, ticket: { type: "call", symbol: null, ack: false } }));
    assert.match(callOut, /data-testid="gear-warning"/);
    assert.match(callOut, /Call is blocked: the gear is Reverse/);
    const putOut = html(props({ load: { status: "ready", snapshot: reverseSnap }, analyzer: loaded, ticket: { type: "put", symbol: null, ack: false } }));
    assert.match(putOut, /data-testid="side-ok"/);
  });
  it("an Analyze error is shown and the ticket stays disabled; stale live data disables it too", async () => {
    const snapshot = await snapOf(NEUTRAL);
    const err = html(props({ load: { status: "ready", snapshot }, analyzer: { status: "error", analysis: null, error: "Data unavailable: bars down.", gearChange: null } }));
    assert.match(err, /data-testid="gear-error"/);
    assert.match(err, /Data unavailable: bars down\./);
    assert.ok(isDisabled(tag(err, "ticket-type-call")));
    const stale = html(props({ load: { status: "ready", snapshot }, analyzer: await okState(NEUTRAL), fresh: { ...LIVE, state: "stale" }, ticket: { type: "call", symbol: CALL_600, ack: true } }));
    assert.match(stale, /live data is stale/);
    assert.doesNotMatch(stale, /data-testid="ticket-submit"/);
  });
  it("Close stays available whatever the gear says (a Call held under Reverse can still be closed)", async () => {
    const r = row("call", "2027-11-05", 600);
    const position: DeskPosition = { type: "call", symbol: r.symbol, expiration: "2027-11-05", strike: 600, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "x", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual" };
    const out = html(props({ load: { status: "ready", snapshot: await snapOf(REVERSE, createMemoryDeskStore({ version: 1, position, journal: [] })) }, analyzer: NO_ANALYSIS }));
    assert.match(out, /data-testid="close-start"/);
    assert.ok(!isDisabled(tag(out, "close-start")));
  });
});
