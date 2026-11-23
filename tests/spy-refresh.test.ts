import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type CloseUi, type DeskViewProps, type TicketUi } from "../src/components/spy/SpyDeskView";
import type { AnalyzerState } from "../src/lib/spyAnalyzer";
import { buildAnalysis } from "../src/lib/spyAnalysis";
import { buildDeskSnapshot, type DeskDeps, type DeskPosition, type DeskSnapshot, type DeskState } from "../src/lib/spyDesk";
import { createDeskData, STALE_AFTER_MS, type DeskData, type DeskDataState } from "../src/lib/spyDeskData";
import { getJson } from "../src/lib/spyDeskClient";
import { handleLive, type DeskContext } from "../src/lib/spyDeskRoutes";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { buildLiveSnapshot, mergeLive, parseLiveSnapshot } from "../src/lib/spyLive";
import { memoAsync } from "../src/lib/spyTtlCache";
import { DRIVE, NEUTRAL, T0, makeDeps, row, type Calls, type Scenario } from "./helpers/spyDeskFixtures";
import { createFakeClock } from "./helpers/fakeClock";

const CFG = { timeframe: "M" as const, liveBudget: 1000 };
const PUT_850 = "SPY271105P00850000";
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const wire = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

function heldState(): DeskState {
  const r = row("put", "2027-11-05", 850);
  const position: DeskPosition = { type: "put", symbol: r.symbol, expiration: "2027-11-05", strike: 850, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "fallback", fallbackReason: "chosen by hand", decisionTimeframe: "M", maxLossUsd: r.ask * 100, source: "manual" };
  return { version: 1, position, journal: [] };
}
const withBid = (deps: DeskDeps, bid: number): DeskDeps => ({ ...deps, readHeld: async (p) => ({ ...row(p.type, p.expiration, p.strike), bid }) });

/* --------------------------------------------------------- the light view */

describe("light view (server): never reads the option chain", () => {
  it("builds readings, decision, SPY price and the held quote with one bars call, one price call, one contract call, zero chain calls", async () => {
    const c: Calls = { daily: 0, spot: 0, sides: [], held: 0 };
    const snap = await buildLiveSnapshot(makeDeps(DRIVE, { calls: c }), CFG, createMemoryDeskStore(heldState()));
    assert.equal(snap.kind, "live");
    assert.equal(snap.decision.action, "CALL");
    assert.equal(snap.readings.length, 5, "the Daily reading plus the four period readings");
    assert.equal(snap.position.status, "held");
    assert.deepEqual({ daily: c.daily, spot: c.spot, held: c.held, sides: c.sides }, { daily: 1, spot: 1, held: 1, sides: [] });
    if (snap.position.status === "held") {
      assert.ok(snap.position.quote);
      assert.equal(snap.position.quote.quoteAt, "2026-11-03T20:00:00Z");
    }
  });
  it("without a position it asks for no contract at all; with a failing chain function it still answers", async () => {
    const c: Calls = { daily: 0, spot: 0, sides: [], held: 0 };
    const deps: DeskDeps = { ...makeDeps(NEUTRAL, { calls: c }), readSide: async () => { throw new Error("the chain must not be read"); } };
    const snap = await buildLiveSnapshot(deps, CFG, createMemoryDeskStore());
    assert.equal(snap.position.status, "none");
    assert.equal(c.held, 0);
    assert.equal(snap.decision.action, "STAND_ASIDE");
    assert.ok(snap.notes.every((n) => !/chain/i.test(n)));
  });
  it("failures become visible text and never throw: bars down means DATA_UNAVAILABLE, price down is a note", async () => {
    const down = await buildLiveSnapshot(makeDeps(DRIVE, { dailyFails: true, spotFails: true }), CFG, createMemoryDeskStore());
    assert.equal(down.decision.action, "DATA_UNAVAILABLE");
    assert.equal(down.spot, null);
    assert.ok(down.notes.some((n) => /SPY price could not be read/.test(n)));
    const noStore = await buildLiveSnapshot(makeDeps(DRIVE), CFG, null);
    assert.equal(noStore.store.available, false);
    assert.notEqual(noStore.position.status, "none");
  });
  it("no usable quote for the held contract is said so (quote null), never a made-up P&L", async () => {
    const snap = await buildLiveSnapshot(makeDeps(DRIVE, { heldQuote: false }), CFG, createMemoryDeskStore(heldState()));
    assert.equal(snap.position.status, "held");
    if (snap.position.status === "held") assert.equal(snap.position.quote, null);
  });
  it("live P&L is the bid against the entry ask, and follows the bid", async () => {
    const entry = row("put", "2027-11-05", 850).ask;
    for (const bid of [entry + 1, entry - 2]) {
      const snap = await buildLiveSnapshot(withBid(makeDeps(DRIVE), bid), CFG, createMemoryDeskStore(heldState()));
      assert.ok(snap.position.status === "held" && snap.position.quote);
      if (snap.position.status === "held" && snap.position.quote) assert.ok(Math.abs(snap.position.quote.pnlUsd - (bid - entry) * 100) < 0.011);
    }
  });
  it("the shape check accepts the real payload and rejects broken ones", async () => {
    const good = wire(await buildLiveSnapshot(makeDeps(DRIVE), CFG, createMemoryDeskStore(heldState())));
    assert.ok(parseLiveSnapshot(good).ok);
    const g = good as Record<string, unknown>;
    const bad: unknown[] = [null, [], "x", {}, { ...g, kind: "desk" }, { ...g, ok: false }, { ...g, generatedAt: "nope" }, { ...g, timeframe: "Z" }, { ...g, spot: { price: "690" } }, { ...g, readings: [{}] }, { ...g, decision: { action: 1 } }, { ...g, position: { status: "held" } }, { ...g, journal: [{ id: 1 }] }, { ...g, auto: null }, { ...g, notes: [1] }, { ...g, store: { available: "yes" } }];
    for (const b of bad) assert.equal(parseLiveSnapshot(b).ok, false, JSON.stringify(b)?.slice(0, 70));
  });
  it("the route: flag off 404, keys missing 503, ok 200 with no-store, a thrown error 500 without detail", async () => {
    const ctx = (over: Partial<DeskContext> = {}): DeskContext => ({ env: { POLARITO_SPY_DESK: "1" }, makeLive: async () => ({ ok: true, deps: makeDeps(DRIVE), config: CFG }), store: createMemoryDeskStore(), ...over });
    assert.equal((await handleLive(ctx({ env: {} }))).status, 404);
    assert.equal((await handleLive(ctx({ makeLive: async () => ({ ok: false, code: "NO_KEYS", error: "none" }) }))).status, 503);
    const ok = await handleLive(ctx());
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.ok(parseLiveSnapshot(await ok.json()).ok);
    const boom = await handleLive(ctx({ makeLive: async () => { throw new Error("secret"); } }));
    assert.equal(boom.status, 500);
    assert.doesNotMatch(await boom.text(), /secret/);
  });
});

describe("short-lived cache for the light view (protects Alpaca)", () => {
  const rig = () => {
    let now = 0;
    let calls = 0;
    const f = memoAsync(async (k: string) => { calls++; return k === "bad" ? { ok: false } : { ok: true, k, n: calls }; }, { ttlMs: 2_000, keyOf: (k) => k, cacheable: (v) => v.ok, clock: () => now });
    return { f, calls: () => calls, tick: (ms: number) => { now += ms; } };
  };
  it("serves repeats inside the TTL from memory and asks again after it", async () => {
    const r = rig();
    await r.f("a");
    await r.f("a");
    r.tick(1_999);
    await r.f("a");
    assert.equal(r.calls(), 1);
    r.tick(2);
    await r.f("a");
    assert.equal(r.calls(), 2);
  });
  it("overlapping identical calls share one request; different keys do not share", async () => {
    const r = rig();
    await Promise.all([r.f("a"), r.f("a"), r.f("a"), r.f("b")]);
    assert.equal(r.calls(), 2);
  });
  it("a failed answer is never kept", async () => {
    const r = rig();
    await r.f("bad");
    await r.f("bad");
    assert.equal(r.calls(), 2);
  });
  it("many open tabs polling at 5 s cost one bars call per 15 s: simulated", async () => {
    let now = 0;
    let bars = 0;
    const loadDaily = memoAsync(async () => { bars++; return { ok: true }; }, { ttlMs: 15_000, keyOf: () => "daily", cacheable: (r) => r.ok, clock: () => now });
    for (let t = 0; t < 60_000; t += 5_000) {
      now = t;
      await Promise.all([loadDaily(), loadDaily(), loadDaily()]);
    }
    assert.equal(bars, 4);
  });
});

/* ------------------------------------------------------------- merging */

describe("light data laid over the full view", () => {
  it("same decision and position: light fields replace, the chain parts stay", async () => {
    const heavy = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore());
    const lite = await buildLiveSnapshot(makeDeps(NEUTRAL, { now: at(5_000) }), CFG, createMemoryDeskStore());
    const m = mergeLive(heavy, lite);
    assert.equal(m.chainStale, false);
    assert.equal(m.snapshot.generatedAt, at(5_000).toISOString());
    assert.deepEqual(m.snapshot.ticket, heavy.ticket);
    assert.ok(m.snapshot.ticket.open);
  });
  it("decision or position changed: the chain-based parts are marked updating, never shown as current", async () => {
    const heavy = await buildDeskSnapshot(makeDeps(NEUTRAL), CFG, createMemoryDeskStore());
    const changed = await buildLiveSnapshot(makeDeps(DRIVE, { now: at(5_000) }), CFG, createMemoryDeskStore());
    const m = mergeLive(heavy, changed);
    assert.equal(m.chainStale, true);
    assert.equal(m.snapshot.ticket.open, false);
    assert.match(m.snapshot.ticket.reason ?? "", /being refreshed/);
    assert.equal(m.snapshot.enginePick.status, "not-applicable");
    const held = await buildLiveSnapshot(makeDeps(NEUTRAL, { now: at(5_000) }), CFG, createMemoryDeskStore(heldState()));
    assert.equal(mergeLive(heavy, held).chainStale, true);
  });
});

/* ---------------------------------------------------------- data layer */

type Script = { scenario: Scenario; store: ReturnType<typeof createMemoryDeskStore>; bid: number | null; failLive: boolean; failDesk: boolean; liveHook?: (v: unknown) => unknown; liveAt?: () => Date; deskAt?: () => Date };

function dataRig(init: Partial<Script> = {}, config?: Parameters<typeof createDeskData>[0]["config"]) {
  const clock = createFakeClock(T0.getTime());
  const script: Script = { scenario: NEUTRAL, store: createMemoryDeskStore(), bid: null, failLive: false, failDesk: false, ...init };
  const methods: string[] = [];
  const counts = { live: 0, desk: 0 };
  const depsAt = (when: Date) => (script.bid === null ? makeDeps(script.scenario, { now: when }) : withBid(makeDeps(script.scenario, { now: when }), script.bid));
  const data: DeskData = createDeskData({
    env: clock.env,
    config,
    fetchLive: async () => {
      counts.live++;
      methods.push("GET");
      if (script.failLive) return { ok: false, error: "Could not reach the server." };
      const v = wire(await buildLiveSnapshot(depsAt(script.liveAt?.() ?? new Date(clock.now())), CFG, script.store));
      return { ok: true, value: script.liveHook ? script.liveHook(v) : v };
    },
    fetchDesk: async () => {
      counts.desk++;
      methods.push("GET");
      if (script.failDesk) return { ok: false, error: "Could not reach the server." };
      return { ok: true, value: wire(await buildDeskSnapshot(depsAt(script.deskAt?.() ?? new Date(clock.now())), CFG, script.store)) };
    },
  });
  const states: DeskDataState[] = [];
  data.subscribe(() => states.push(data.getState()));
  return { clock, script, data, counts, methods, states };
}

describe("data layer: freshness, rejection, never stale-as-fresh", () => {
  it("loading, then live with the stamp; both views asked once at the start", async () => {
    const r = dataRig();
    assert.equal(r.data.getState().fresh.state, "loading");
    r.data.start();
    await r.clock.advance(0);
    const s = r.data.getState();
    assert.equal(s.fresh.state, "live");
    assert.ok(s.snapshot);
    assert.equal(s.fresh.updatedAt, T0.toISOString());
    assert.equal(s.fresh.chainAt, T0.toISOString());
    assert.deepEqual(r.counts, { live: 1, desk: 1 });
    r.data.stop();
  });
  it("every 5 s the stamp moves and the P&L follows the bid; the chain is read only every 45 s", async () => {
    const entry = row("put", "2027-11-05", 850).ask;
    const r = dataRig({ store: createMemoryDeskStore(heldState()), bid: entry + 1 });
    r.data.start();
    await r.clock.advance(0);
    const pnl = () => {
      const p = r.data.getState().snapshot?.position;
      return p && p.status === "held" && p.quote ? p.quote.pnlUsd : null;
    };
    assert.ok(Math.abs((pnl() ?? 0) - 100) < 0.011);
    r.script.bid = entry - 0.5;
    await r.clock.advance(5_000);
    assert.ok(Math.abs((pnl() ?? 0) + 50) < 0.011);
    assert.equal(r.data.getState().fresh.updatedAt, at(5_000).toISOString());
    assert.equal(r.data.getState().fresh.chainAt, T0.toISOString());
    await r.clock.advance(40_000);
    assert.equal(r.counts.desk, 2);
    assert.equal(r.counts.live, 10);
    assert.equal(r.data.getState().fresh.chainAt, at(45_000).toISOString());
    r.data.stop();
  });
  it("a failed refresh: the data is kept but labelled STALE with the error and the retry time; recovery clears it", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    const before = r.data.getState().fresh.updatedAt;
    r.script.failLive = true;
    await r.clock.advance(5_000);
    const s = r.data.getState();
    assert.equal(s.fresh.state, "stale");
    assert.equal(s.fresh.lightError, "Could not reach the server.");
    assert.equal(s.fresh.retryInMs, 10_000);
    assert.equal(s.fresh.updatedAt, before, "the stamp does not move on a failure");
    assert.ok(s.snapshot, "what was known stays visible, but marked");
    r.script.failLive = false;
    await r.clock.advance(10_000);
    const ok = r.data.getState();
    assert.equal(ok.fresh.state, "live");
    assert.equal(ok.fresh.lightError, null);
    assert.equal(ok.fresh.updatedAt, at(15_000).toISOString());
    r.data.stop();
  });
  it("nothing to show and the first read fails: a fatal error, not an empty page", async () => {
    const r = dataRig({ failDesk: true, failLive: true });
    r.data.start();
    await r.clock.advance(0);
    const s = r.data.getState();
    assert.equal(s.snapshot, null);
    assert.equal(s.fatal, "Could not reach the server.");
    assert.equal(s.fresh.state, "loading");
    r.data.stop();
  });
  it("data older than 15 s on screen is STALE even when no request has failed yet (watchdog)", async () => {
    const r = dataRig({}, { light: { intervalMs: 60_000, maxBackoffMs: 60_000 }, heavy: { intervalMs: 60_000, maxBackoffMs: 120_000 }, maxPerMinute: 20, requestTimeoutMs: 15_000 });
    r.data.start();
    await r.clock.advance(0);
    await r.clock.advance(STALE_AFTER_MS - 1_000);
    assert.equal(r.data.getState().fresh.state, "live");
    await r.clock.advance(2_000);
    assert.equal(r.data.getState().fresh.state, "stale");
    r.data.stop();
  });
  it("answers that are malformed, too old, from the future or older than what is shown are rejected and counted as failures", async () => {
    const cases: Array<[string, (v: unknown, now: number) => unknown, RegExp]> = [
      ["malformed", () => ({ ok: true, kind: "live" }), /unexpected shape/],
      ["not an object", () => "<html>", /unexpected shape/],
      ["too old", (v, now) => ({ ...(v as object), generatedAt: new Date(now - 120_000).toISOString() }), /s old/],
      ["from the future", (v, now) => ({ ...(v as object), generatedAt: new Date(now + 120_000).toISOString() }), /in the future/],
      ["older than shown", (v, now) => ({ ...(v as object), generatedAt: new Date(now - 20_000).toISOString() }), /older than what is already shown/],
    ];
    for (const [name, hook, msg] of cases) {
      const r = dataRig();
      r.data.start();
      await r.clock.advance(0);
      const shown = r.data.getState().fresh.updatedAt;
      r.script.liveHook = (v) => hook(v, r.clock.now());
      await r.clock.advance(5_000);
      const s = r.data.getState();
      assert.match(s.fresh.lightError ?? "", msg, name);
      assert.equal(s.fresh.state, "stale", name);
      assert.equal(s.fresh.updatedAt, shown, `${name}: the rejected answer is not shown`);
      r.data.stop();
    }
  });
  it("hidden tab: paused label, no requests; showing it again refreshes at once", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    await r.clock.setHidden(true);
    assert.equal(r.data.getState().fresh.state, "paused");
    const n = r.counts.live + r.counts.desk;
    await r.clock.advance(120_000);
    assert.equal(r.counts.live + r.counts.desk, n);
    await r.clock.setHidden(false);
    await r.clock.advance(0);
    assert.equal(r.counts.live, 2);
    assert.equal(r.counts.desk, 2);
    assert.equal(r.data.getState().fresh.state, "live");
    r.data.stop();
  });
  it("the reading changes between full reads: the chain is marked updating and read once, not on every tick", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    assert.equal(r.data.getState().snapshot?.ticket.open, true);
    r.script.scenario = DRIVE;
    // Hold the full view back so the disagreement lasts a while.
    r.script.deskAt = () => T0;
    await r.clock.advance(5_000);
    assert.equal(r.counts.desk, 2, "one extra full read on the change, at once");
    const s = r.data.getState();
    assert.equal(s.snapshot?.decision.action, "CALL");
    await r.clock.advance(25_000);
    assert.equal(r.counts.desk, 2, "not once per tick while the disagreement lasts");
    r.data.stop();
  });
  it("after the chain refresh agrees with the reading, the ticket lists are current again", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    r.script.scenario = DRIVE;
    await r.clock.advance(5_000);
    const s = r.data.getState();
    assert.equal(s.fresh.chainUpdating, false);
    assert.equal(s.snapshot?.ticket.open, true);
    assert.equal(s.snapshot?.decision.action, "CALL");
    r.data.stop();
  });
  it("a user action holds the refresh: nothing is asked meanwhile, answers in flight are dropped, and releasing refreshes both views", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    const release = r.data.hold();
    const n = { live: r.counts.live, desk: r.counts.desk };
    await r.clock.advance(60_000);
    assert.deepEqual({ live: r.counts.live, desk: r.counts.desk }, n);
    release();
    await r.clock.advance(0);
    assert.deepEqual({ live: r.counts.live, desk: r.counts.desk }, { live: n.live + 1, desk: n.desk + 1 });
    r.data.stop();
  });
  it("a refresh only ever sends GET (every request is a GET; the data layer has no way to submit)", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(120_000);
    assert.ok(r.methods.length > 20);
    assert.ok(r.methods.every((m) => m === "GET"));
    r.data.stop();
  });
  it("getJson: GET only, no-store, bad JSON and HTTP errors and network errors become plain error text, never a throw", async () => {
    const seen: Array<{ method: string; cache: string }> = [];
    const ctl = new AbortController();
    const mk = (res: { ok: boolean; status: number; body?: unknown; bad?: boolean } | "throw") => async (_u: string, init: { method: "GET"; cache: "no-store" }) => {
      seen.push({ method: init.method, cache: init.cache });
      if (res === "throw") throw new Error("net");
      return { ok: res.ok, status: res.status, json: async () => { if (res.bad) throw new Error("bad json"); return res.body; } };
    };
    assert.deepEqual(await getJson("/x", ctl.signal, mk({ ok: true, status: 200, body: { a: 1 } })), { ok: true, value: { a: 1 } });
    assert.deepEqual(await getJson("/x", ctl.signal, mk({ ok: false, status: 503, body: { error: "Data unavailable: no keys" } })), { ok: false, error: "Data unavailable: no keys" });
    assert.deepEqual(await getJson("/x", ctl.signal, mk({ ok: false, status: 502, bad: true })), { ok: false, error: "The server answered 502." });
    assert.deepEqual(await getJson("/x", ctl.signal, mk("throw")), { ok: false, error: "Could not reach the server." });
    const bad = await getJson("/x", ctl.signal, mk({ ok: true, status: 200, bad: true }));
    assert.ok(bad.ok && bad.value === null, "an unreadable body is null; the caller's shape check rejects it");
    assert.ok(seen.every((s) => s.method === "GET" && s.cache === "no-store"));
  });
});

/* ---------------------------------------------- user state survives a refresh */

const noop = () => undefined;
const gearOk = async (sc: Scenario): Promise<AnalyzerState> => {
  const a = await buildAnalysis(makeDeps(sc), CFG);
  assert.ok(a.ok);
  return { status: "ok", analysis: a, error: null, gearChange: null };
};
const view = (snapshot: DeskSnapshot, analyzer: AnalyzerState, ticket: TicketUi, close: CloseUi, fresh: DeskDataState["fresh"]): string =>
  renderToStaticMarkup(createElement(SpyDeskView, { load: { status: "ready", snapshot }, busy: false, notice: null, ticket, close, autoUi: { ack: true }, fresh, analyzer, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop } as DeskViewProps)).replace(/<!-- -->/g, "");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const checkedRadio = (out: string): string | null => out.match(/<input[^>]*type="radio"[^>]*checked=""[^>]*>/)?.[0]?.match(/value="([^"]+)"/)?.[1] ?? null;

describe("a refresh never resets what the user chose (view + data layer together)", () => {
  it("selected Call/Put, selected contract row and the ticked box survive several refreshes", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    const analyzer = await gearOk(NEUTRAL);
    const ticket: TicketUi = { type: "put", symbol: PUT_850, ack: true };
    const close: CloseUi = { stage: "idle", ack: false, offerUnpriced: false };
    const first = view(r.data.getState().snapshot!, analyzer, ticket, close, r.data.getState().fresh);
    assert.equal(checkedRadio(first), PUT_850);
    for (let i = 0; i < 4; i++) {
      await r.clock.advance(5_000);
      const s = r.data.getState();
      const out = view(s.snapshot!, analyzer, ticket, close, s.fresh);
      assert.match(tag(out, "ticket-type-put"), /aria-pressed="true"/);
      assert.match(tag(out, "ticket-type-call"), /aria-pressed="false"/);
      assert.equal(checkedRadio(out), PUT_850);
      assert.match(tag(out, "ticket-ack"), /checked=""/);
      assert.ok(!/\sdisabled=""/.test(tag(out, "ticket-submit")) && tag(out, "ticket-submit") !== "");
      assert.match(out, /updated \d\d:\d\d:\d\d/);
    }
    r.data.stop();
  });
  it("an open Close box and its ticked acknowledgement survive refreshes, while the P&L under it moves", async () => {
    const entry = row("put", "2027-11-05", 850).ask;
    const r = dataRig({ store: createMemoryDeskStore(heldState()), bid: entry + 1 });
    r.data.start();
    await r.clock.advance(0);
    const close: CloseUi = { stage: "confirm", ack: true, offerUnpriced: false };
    const ticket: TicketUi = { type: "call", symbol: null, ack: false };
    const pnls = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const s = r.data.getState();
      const out = view(s.snapshot!, await gearOk(NEUTRAL), ticket, close, s.fresh);
      const submit = tag(out, "close-submit");
      assert.ok(submit !== "" && !/\sdisabled=""/.test(submit), "the Close box is still open and armed");
      pnls.add(String(s.snapshot!.position.status === "held" && s.snapshot!.position.quote ? s.snapshot!.position.quote.pnlUsd : "none"));
      r.script.bid = entry + 1 + (i + 1) * 0.5;
      await r.clock.advance(5_000);
    }
    assert.equal(pnls.size, 3, "the P&L changed on every refresh while the Close box stayed open");
    r.data.stop();
  });
  it("a refresh failure keeps the choices too (and the page says STALE)", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    r.script.failLive = true;
    await r.clock.advance(5_000);
    const s = r.data.getState();
    const out = view(s.snapshot!, await gearOk(NEUTRAL), { type: "put", symbol: PUT_850, ack: true }, { stage: "idle", ack: false, offerUnpriced: false }, s.fresh);
    assert.match(tag(out, "freshness"), /data-state="stale"/);
    assert.match(out, /data-testid="refresh-error"/);
    assert.match(out, /NOT current/);
    r.data.stop();
  });
  it("the freshness bar: a small updated HH:MM:SS stamp when live, and the paused / stale states are never worded as live", async () => {
    const r = dataRig();
    r.data.start();
    await r.clock.advance(0);
    const s = r.data.getState();
    const live = view(s.snapshot!, await gearOk(NEUTRAL), { type: "call", symbol: null, ack: false }, { stage: "idle", ack: false, offerUnpriced: false }, s.fresh);
    assert.match(live, /data-testid="refresh-live"[^>]*>(<span[^>]*><\/span>)?Live: updated \d\d:\d\d:\d\d/);
    assert.match(tag(live, "freshness"), /data-state="live"/);
    await r.clock.setHidden(true);
    const p = r.data.getState();
    const paused = view(p.snapshot!, await gearOk(NEUTRAL), { type: "call", symbol: null, ack: false }, { stage: "idle", ack: false, offerUnpriced: false }, p.fresh);
    assert.match(paused, /data-testid="refresh-paused"/);
    assert.doesNotMatch(paused, /data-testid="refresh-live"/);
    r.data.stop();
  });
});

/* ------------------------------------------------------------ source rails */

describe("rails: GET-only refresh, no order code", () => {
  const files = ["src/lib/spyPoller.ts", "src/lib/spyDeskData.ts", "src/lib/spyDeskClient.ts", "src/lib/spyAnalyzer.ts", "src/lib/spyLive.ts", "src/lib/spyAnalysis.ts", "src/lib/spyGear.ts", "src/lib/spyTtlCache.ts", "src/app/api/spy/live/route.node.ts", "src/app/api/spy/analyze/route.node.ts"];
  it("the refresh and Analyze files contain no write verb, no order endpoint and no broker module", () => {
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(src, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, f);
      assert.doesNotMatch(src, /\/v2\/orders|\/v2\/positions|submitOrder|placeOrder|createOrder|POLARITO_LIVE_TRADING_ENABLED|api\/broker\//, f);
    }
    assert.match(fs.readFileSync("src/lib/spyDeskClient.ts", "utf8"), /method: "GET"/);
  });
  it("the light and analyze routes are per-request, behind the same gate, and the light route cannot read the chain", () => {
    for (const f of ["src/app/api/spy/live/route.node.ts", "src/app/api/spy/analyze/route.node.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      assert.match(src, /await connection\(\)/);
      assert.match(src, /export async function GET/);
      assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/);
    }
    assert.match(fs.readFileSync("src/app/api/spy/live/route.node.ts", "utf8"), /light: true/);
    assert.match(fs.readFileSync("src/lib/spyDeskLive.ts", "utf8"), /The option chain is not read by the light refresh/);
    assert.match(fs.readFileSync("src/lib/spyDeskRoutes.ts", "utf8"), /export async function handleLive[\s\S]*?if \(!deskEnabled\(ctx\.env\)\) return off\(\)/);
    assert.match(fs.readFileSync("src/lib/spyDeskRoutes.ts", "utf8"), /export async function handleAnalyze[\s\S]*?if \(!deskEnabled\(ctx\.env\)\) return off\(\)/);
    const proxy = fs.readFileSync("src/proxy.ts", "utf8");
    assert.match(proxy, /SCHEDULER_PATHS: readonly string\[\] = \["\/api\/spy\/auto-run", "\/api\/spy-wwv\/auto-run"\]/);
    assert.doesNotMatch(proxy.replace(/SCHEDULER_PATHS: readonly string\[\] = .*\n/, ""), /api\/spy/, "everything else stays behind the session gate");
  });
  it("the container sends the refresh through the GET helper only; its POSTs are the three user actions", () => {
    const src = fs.readFileSync("src/components/spy/SpyDesk.tsx", "utf8");
    assert.match(src, /getJson\(paths\.live/);
    assert.match(src, /getJson\(paths\.desk/);
    assert.match(src, /getJson\(paths\.analyze/);
    assert.equal([...src.matchAll(/method: "POST"/g)].length, 1);
    const acts = [...src.matchAll(/act\(\s*apiPath\(profile, "([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(acts.sort(), ["auto", "close", "ticket"]);
    assert.equal([...src.matchAll(/\bact\(\s*[^a)\s]/g)].length, 0, "every act() goes through the desk's own apiPath");
  });
});
