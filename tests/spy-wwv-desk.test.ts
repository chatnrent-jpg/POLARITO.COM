import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { proxy } from "../src/proxy";
import { TIMEFRAME_NAMES } from "../src/lib/deskReadings";
import { buildAnalysis, parseAnalysis } from "../src/lib/spyAnalysis";
import { AUTO_LOCK_KEY, AUTO_LOG_KEY, AUTO_SWITCH_KEY, buildAutoView, readLog, readSwitch, runAutoCycle, setAutoSwitch } from "../src/lib/spyAuto";
import { handleAutoRun, handleAutoSwitch, type AutoRouteContext } from "../src/lib/spyAutoRoutes";
import { buildDeskSnapshot, deskDecision, isReadingView, openManual, parseDeskSnapshot, type DeskConfig } from "../src/lib/spyDesk";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { deskPaths } from "../src/lib/spyDeskClient";
import { dailyStartFor, lightCacheFor } from "../src/lib/spyDeskLive";
import { handleAnalyze, handleLive, handleSnapshot, handleTicket, type DeskContext } from "../src/lib/spyDeskRoutes";
import { createDeskStore, createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { buildLiveSnapshot, parseLiveSnapshot } from "../src/lib/spyLive";
import { createMemorySpyKv, createSpyKv, scopeKv } from "../src/lib/spyKv";
import { GEARS, GEAR_NAMES, checkSide, type Gear } from "../src/lib/spyGear";
import { MONTHLY_PROFILE, PROFILES, WWV_PROFILE, apiPath, scopeKey } from "../src/lib/spyProfile";
import { DRIVE, T0, makeDeps, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE, WWV_NEUTRAL, WWV_REVERSE, wwvBars } from "./helpers/wwvFixtures";

const CFG: DeskConfig = { timeframe: "D", liveBudget: 1000 };
const SCENARIOS: Record<Gear, Scenario> = { DRIVE: WWV_DRIVE, NEUTRAL: WWV_NEUTRAL, REVERSE: WWV_REVERSE };
const SIDES = ["call", "put"] as const;
const SYMBOL = { call: "SPY271105C00600000", put: "SPY271105P00850000" } as const;
const SWITCH_ON = JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" });
const BASE = "https://www.polarito.com";
const read = (p: string) => fs.readFileSync(p, "utf8");
const memEnv = { SPY_DESK_STORE: "memory", NODE_ENV: "test" } as const;

describe("WWV desk: the decision (Drive CALL, Reverse PUT, Neutral STAND ASIDE)", () => {
  it("maps the daily WWV reading to the same three actions", () => {
    assert.equal((deskDecision(WWV_DRIVE.daily, T0, "D") as { action: string }).action, "CALL");
    assert.equal((deskDecision(WWV_REVERSE.daily, T0, "D") as { action: string }).action, "PUT");
    assert.equal((deskDecision(WWV_NEUTRAL.daily, T0, "D") as { action: string }).action, "STAND_ASIDE");
  });
  it("stale, failing or empty data is unavailable, never an action", () => {
    const stale = deskDecision(WWV_DRIVE.daily.slice(0, -1), T0, "D");
    assert.equal(stale.status, "unavailable");
    assert.equal(deskDecision([], T0, "D").status, "unavailable");
  });
  it("the snapshot carries one reading (keyed D) with the wave numbers, and passes the browser-side shape check", async () => {
    const s = await buildDeskSnapshot(makeDeps(WWV_DRIVE), CFG, createMemoryDeskStore());
    assert.equal(s.timeframe, "D");
    assert.equal(s.readings.length, 1);
    const r = s.readings[0];
    assert.equal(r.timeframe, "D");
    assert.equal(r.name, "Daily, WWV");
    assert.equal(r.isDecision, true);
    assert.equal(r.label, "Drive");
    assert.equal(r.wwv?.waveVolume, 700);
    assert.equal(r.wwv?.previous?.volume, 400);
    assert.equal(s.decision.action, "CALL");
    assert.match(s.decision.reason, /Daily, WWV/);
    assert.match(s.decision.reason, /up-wave since/);
    assert.equal(s.enginePick.status, "contract");
    const wire = JSON.parse(JSON.stringify(s)) as unknown;
    assert.ok(parseDeskSnapshot(wire).ok);
  });
  it("an OK Daily WWV reading without its wave detail, or with a malformed one, is refused by the browser check", async () => {
    const s = JSON.parse(JSON.stringify(await buildDeskSnapshot(makeDeps(WWV_DRIVE), CFG, createMemoryDeskStore()))) as { readings: Array<Record<string, unknown>> };
    const good = s.readings[0];
    assert.equal(isReadingView(good), true);
    assert.equal(isReadingView({ ...good, wwv: null }), false);
    assert.equal(isReadingView({ ...good, wwv: undefined }), false);
    const w = good.wwv as Record<string, unknown>;
    for (const bad of [{ ...w, direction: "sideways" }, { ...w, waveVolume: -1 }, { ...w, waveVolume: "700" }, { ...w, previous: { direction: "up" } }, { ...w, inProgress: "no" }, { ...w, barDate: 5 }]) {
      assert.equal(isReadingView({ ...good, wwv: bad }), false, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal(isReadingView({ ...good, timeframe: "W" }), false);
  });
  it("with unavailable data the snapshot shows the reason and no decision", async () => {
    const s = await buildDeskSnapshot(makeDeps({ daily: WWV_DRIVE.daily.slice(0, -1) }), CFG, createMemoryDeskStore());
    assert.equal(s.decision.action, "DATA_UNAVAILABLE");
    assert.equal(s.readings[0].status, "unavailable");
    assert.equal(s.readings[0].wwv, null);
    assert.equal(s.ticket.open, false);
    assert.equal(s.enginePick.status, "not-applicable");
  });
  it("the light snapshot has the same reading and passes its own shape check", async () => {
    const live = await buildLiveSnapshot(makeDeps(WWV_REVERSE), CFG, createMemoryDeskStore());
    assert.equal(live.readings.length, 1);
    assert.equal(live.decision.action, "PUT");
    assert.ok(parseLiveSnapshot(JSON.parse(JSON.stringify(live))).ok);
  });
});

describe("WWV desk: the gear guard (Analyze and the server re-check)", () => {
  it("Analyze returns the gear, the wave numbers and the Daily, WWV name; the browser check accepts it", async () => {
    const a = await buildAnalysis(makeDeps(WWV_REVERSE), CFG);
    assert.ok(a.ok);
    assert.equal(a.gear, "REVERSE");
    assert.equal(a.timeframe, "D");
    assert.equal(a.timeframeName, "Daily, WWV");
    assert.deepEqual(a.allowed, { call: false, put: true });
    assert.equal(a.reading.wwv?.direction, "down");
    assert.ok(parseAnalysis(JSON.parse(JSON.stringify(a))).ok);
  });
  for (const gear of GEARS) {
    for (const side of SIDES) {
      const allowed = gear === "NEUTRAL" || (gear === "DRIVE") === (side === "call");
      it(`${GEAR_NAMES[gear]} x ${side}: the server ${allowed ? "records the practice buy" : "refuses it (COUNTER_POLARITY) and records nothing"}`, async () => {
        const store = createMemoryDeskStore();
        const res = await openManual(makeDeps(SCENARIOS[gear]), CFG, store, { type: side, symbol: SYMBOL[side], analyzedGear: gear });
        assert.equal(res.ok, allowed);
        const st = await store.read();
        assert.ok(st.ok);
        assert.equal(st.state.position !== null, allowed);
        if (!res.ok) {
          assert.equal(res.code, "COUNTER_POLARITY");
          assert.match(res.error, /Daily, WWV gear/);
        } else {
          assert.equal(st.state.position?.decisionTimeframe, "D");
        }
        assert.equal(checkSide(gear, side).allowed, allowed);
      });
    }
  }
  it("a gear that changed since Analyze is refused (GEAR_CHANGED)", async () => {
    const store = createMemoryDeskStore();
    const res = await openManual(makeDeps(WWV_NEUTRAL), CFG, store, { type: "call", symbol: SYMBOL.call, analyzedGear: "DRIVE" });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.code, "GEAR_CHANGED");
  });
});

describe("WWV desk: auto trader (own switch, default OFF, idempotent)", () => {
  const rig = (sc: Scenario, on = true) => {
    const base = createMemorySpyKv();
    const kv = scopeKv(base, WWV_PROFILE);
    if (on) base.data.set(scopeKey(WWV_PROFILE, AUTO_SWITCH_KEY), { value: SWITCH_ON, expiresAt: null });
    const desk = createMemoryDeskStore();
    return { base, kv, desk, run: (dry = false) => runAutoCycle(makeDeps(sc), CFG, { desk, kv }, { dryRun: dry }) };
  };
  it("is OFF by default: nothing is read or traded and the decision is logged", async () => {
    const r = rig(WWV_DRIVE, false);
    const out = await r.run();
    assert.equal(out.outcome, "off");
    const st = await r.desk.read();
    assert.ok(st.ok);
    assert.equal(st.state.position, null);
    const view = await buildAutoView(r.kv, WWV_PROFILE.scheduleText);
    assert.equal(view.on, false);
    assert.match(view.schedule, /Daily WWV/);
  });
  it("Drive opens a call, Reverse a put, Neutral does nothing; the position is labelled AUTO and Daily, WWV", async () => {
    const d = rig(WWV_DRIVE);
    assert.equal((await d.run()).outcome, "opened");
    const ds = await d.desk.read();
    assert.ok(ds.ok && ds.state.position);
    assert.equal(ds.state.position.type, "call");
    assert.equal(ds.state.position.source, "auto");
    assert.equal(ds.state.position.decisionTimeframe, "D");
    assert.match(ds.state.journal[0].note, /Daily, WWV/);
    const log = await readLog(d.kv);
    assert.ok(log.ok);
    assert.equal(log.log[0].reading, "Drive");

    const r = rig(WWV_REVERSE);
    assert.equal((await r.run()).outcome, "opened");
    const rs = await r.desk.read();
    assert.ok(rs.ok);
    assert.equal(rs.state.position?.type, "put");

    const n = rig(WWV_NEUTRAL);
    const out = await n.run();
    assert.notEqual(out.outcome, "opened");
    const ns = await n.desk.read();
    assert.ok(ns.ok);
    assert.equal(ns.state.position, null);
  });
  it("a second run of the same session is a silent repeat, not a second position", async () => {
    const r = rig(WWV_DRIVE);
    await r.run();
    const again = await r.run();
    assert.equal(again.repeat, true);
    const st = await r.desk.read();
    assert.ok(st.ok);
    assert.equal(st.state.journal.length, 1);
  });
  it("stale bars: refused and logged, nothing traded; before 16:15 ET it does not act", async () => {
    const stale = rig({ daily: WWV_DRIVE.daily.slice(0, -1) });
    assert.equal((await stale.run()).outcome, "refused");
    const early = rig(WWV_DRIVE);
    const out = await runAutoCycle(makeDeps(WWV_DRIVE, { now: new Date("2026-11-03T20:30:00Z") }), CFG, { desk: early.desk, kv: early.kv });
    assert.notEqual(out.outcome, "opened");
  });
  it("a bad (monthly-style) reading source cannot leak in: the WWV config never reads the four period readings", async () => {
    const s = await buildDeskSnapshot(makeDeps(WWV_DRIVE), CFG, null);
    assert.deepEqual(s.readings.map((r) => r.timeframe), ["D"]);
  });
});

describe("two desks are fully isolated", () => {
  it("scopeKey moves the shared names under the desk's own prefix and refuses foreign keys", () => {
    assert.equal(scopeKey(MONTHLY_PROFILE, AUTO_SWITCH_KEY), AUTO_SWITCH_KEY);
    assert.equal(scopeKey(WWV_PROFILE, AUTO_SWITCH_KEY), "polarito:spy-wwv:auto-switch:v1");
    assert.equal(scopeKey(WWV_PROFILE, AUTO_LOG_KEY), "polarito:spy-wwv:auto-log:v1");
    assert.equal(scopeKey(WWV_PROFILE, AUTO_LOCK_KEY), "polarito:spy-wwv:auto-lock:v1");
    assert.throws(() => scopeKey(WWV_PROFILE, "polarito:live:something"));
    assert.throws(() => scopeKey(WWV_PROFILE, "other"));
    const keys = [AUTO_SWITCH_KEY, AUTO_LOG_KEY, AUTO_LOCK_KEY, "polarito:spy:desk:v1"];
    const a = new Set(keys.map((k) => scopeKey(MONTHLY_PROFILE, k)));
    const b = new Set(keys.map((k) => scopeKey(WWV_PROFILE, k)));
    assert.equal([...a].filter((k) => b.has(k)).length, 0, "no key in common");
    assert.equal(a.size + b.size, 8);
  });
  it("switch, audit log and lock of one desk are invisible to the other, on the same store", async () => {
    const store = createMemorySpyKv();
    const monthly = scopeKv(store, MONTHLY_PROFILE);
    const wwv = scopeKv(store, WWV_PROFILE);
    const on = await setAutoSwitch(wwv, true, T0);
    assert.ok(on.ok);
    const m = await readSwitch(monthly);
    assert.ok(m.ok);
    assert.equal(m.on, false, "turning WWV Auto on does not turn the monthly Auto on");
    const w = await readSwitch(wwv);
    assert.ok(w.ok && w.on);
    const mLog = await readLog(monthly);
    const wLog = await readLog(wwv);
    assert.ok(mLog.ok && wLog.ok);
    assert.equal(mLog.log.length, 0);
    assert.equal(wLog.log.length, 1);
    assert.deepEqual([...store.data.keys()].sort(), ["polarito:spy-wwv:auto-log:v1", "polarito:spy-wwv:auto-switch:v1"]);
    // one desk holding its run lock does not block the other
    assert.equal((await wwv.setNx(AUTO_LOCK_KEY, "x", 60)).ok, true);
    const other = await monthly.setNx(AUTO_LOCK_KEY, "y", 60);
    assert.ok(other.ok && other.value, "the monthly desk can still take its own lock");
    const again = await wwv.setNx(AUTO_LOCK_KEY, "z", 60);
    assert.ok(again.ok && !again.value, "but the WWV lock is held");
  });
  it("a full auto run writes only under the WWV prefix, and none of the monthly keys", async () => {
    const base = createMemorySpyKv();
    base.data.set(scopeKey(WWV_PROFILE, AUTO_SWITCH_KEY), { value: SWITCH_ON, expiresAt: null });
    const kv = scopeKv(base, WWV_PROFILE);
    const out = await runAutoCycle(makeDeps(WWV_DRIVE), CFG, { desk: createMemoryDeskStore(), kv });
    assert.equal(out.outcome, "opened");
    for (const k of base.data.keys()) assert.ok(k.startsWith("polarito:spy-wwv:"), k);
    assert.equal(base.data.has(AUTO_SWITCH_KEY), false);
  });
  it("each desk has its own practice record (own position and journal), including the memory stores", async () => {
    const a = createDeskStore(memEnv, MONTHLY_PROFILE);
    const b = createDeskStore(memEnv, WWV_PROFILE);
    assert.ok(a && b);
    assert.notEqual(a, b);
    const open = await openManual(makeDeps(WWV_DRIVE), CFG, b, { type: "call", symbol: SYMBOL.call, analyzedGear: "DRIVE" });
    assert.ok(open.ok);
    const sa = await a.read();
    const sb = await b.read();
    assert.ok(sa.ok && sb.ok);
    assert.equal(sa.state.position, null, "the monthly practice record is untouched");
    assert.ok(sb.state.position);
    assert.equal(createDeskStore(memEnv, WWV_PROFILE), b, "the same desk gets the same record on the next request");
    const ka = createSpyKv(memEnv, MONTHLY_PROFILE);
    const kb = createSpyKv(memEnv, WWV_PROFILE);
    assert.ok(ka && kb);
    await setAutoSwitch(kb, true, T0);
    const ra = await readSwitch(ka);
    assert.ok(ra.ok);
    assert.equal(ra.on, false);
  });
  it("the real key-value client uses the desk's own key for the practice record", async () => {
    const seen: string[] = [];
    const { createKvDeskStore } = await import("../src/lib/spyDeskStore");
    const fakeFetch = async (_u: string, init: { body: string }) => {
      seen.push((JSON.parse(init.body) as string[])[1]);
      return { ok: true, status: 200, json: async () => ({ result: null }) };
    };
    const env = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t".repeat(20) };
    await createKvDeskStore(env, fakeFetch, WWV_PROFILE)?.read();
    await createKvDeskStore(env, fakeFetch, MONTHLY_PROFILE)?.read();
    assert.deepEqual(seen, ["polarito:spy-wwv:desk:v1", "polarito:spy:desk:v1"]);
  });
  it("profiles: distinct pages, API bases, prefixes; every route path is the desk's own", () => {
    assert.equal(new Set(PROFILES.map((p) => p.keyPrefix)).size, 2);
    assert.equal(WWV_PROFILE.pagePath, "/spy-wwv");
    assert.equal(WWV_PROFILE.title, "SPY DESK WWV");
    assert.equal(WWV_PROFILE.timeframeLabel, "Daily, WWV");
    assert.equal(WWV_PROFILE.fixedTimeframe, "D");
    assert.equal(MONTHLY_PROFILE.fixedTimeframe, null);
    assert.equal(apiPath(WWV_PROFILE, "ticket"), "/api/spy-wwv/ticket");
    assert.deepEqual(deskPaths(WWV_PROFILE), { live: "/api/spy-wwv/live", desk: "/api/spy-wwv/desk", analyze: "/api/spy-wwv/analyze?ticker=SPY" });
    assert.deepEqual(deskPaths(MONTHLY_PROFILE), { live: "/api/spy/live", desk: "/api/spy/desk", analyze: "/api/spy/analyze?ticker=SPY" });
    assert.equal(TIMEFRAME_NAMES.D, "Daily, WWV");
  });
});

describe("WWV desk: routes", () => {
  const ctx = (over: Partial<DeskContext> = {}): DeskContext & { store: ReturnType<typeof createMemoryDeskStore> } => {
    const store = createMemoryDeskStore();
    return { env: { POLARITO_SPY_DESK: "1" }, profile: WWV_PROFILE, makeLive: async () => ({ ok: true as const, deps: makeDeps(WWV_DRIVE), config: CFG }), kv: scopeKv(createMemorySpyKv(), WWV_PROFILE), ...over, store: (over.store ?? store) as never } as never;
  };
  const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "www.polarito.com", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });

  it("desk, live and analyze answer 404 when the flag is off and 200 with no-store when on", async () => {
    for (const h of [() => handleSnapshot(ctx({ env: {} })), () => handleLive(ctx({ env: {} })), () => handleAnalyze(new Request(`${BASE}/api/spy-wwv/analyze?ticker=SPY`), ctx({ env: {} }))]) assert.equal((await h()).status, 404);
    const desk = await handleSnapshot(ctx());
    assert.equal(desk.status, 200);
    assert.equal(desk.headers.get("cache-control"), "no-store");
    const snap = await desk.json();
    assert.ok(parseDeskSnapshot(snap).ok);
    assert.match((snap as { auto: { schedule: string } }).auto.schedule, /Daily WWV/);
    assert.equal((snap as { auto: { on: boolean } }).auto.on, false, "Auto defaults to OFF");
    const live = await handleLive(ctx());
    assert.equal(live.status, 200);
    assert.ok(parseLiveSnapshot(await live.json()).ok);
    const an = await handleAnalyze(new Request(`${BASE}/api/spy-wwv/analyze?ticker=SPY`), ctx());
    assert.equal(an.status, 200);
    assert.equal(((await an.json()) as { timeframe: string }).timeframe, "D");
    assert.equal((await handleAnalyze(new Request(`${BASE}/api/spy-wwv/analyze?ticker=QQQ`), ctx())).status, 400);
  });
  for (const gear of GEARS) {
    for (const side of SIDES) {
      const allowed = gear === "NEUTRAL" || (gear === "DRIVE") === (side === "call");
      it(`ticket route, ${GEAR_NAMES[gear]} x ${side}: ${allowed ? "200" : "409 COUNTER_POLARITY"}`, async () => {
        const c = ctx({ makeLive: async () => ({ ok: true as const, deps: makeDeps(SCENARIOS[gear]), config: CFG }) });
        const res = await handleTicket(post("/api/spy-wwv/ticket", { type: side, symbol: SYMBOL[side], acknowledgeDryRun: true, analyzedGear: gear }), c);
        assert.equal(res.status, allowed ? 200 : 409);
        if (!allowed) assert.equal(((await res.json()) as { code: string }).code, "COUNTER_POLARITY");
        const st = await c.store.read();
        assert.ok(st.ok);
        assert.equal(st.state.position !== null, allowed);
      });
    }
  }
  it("the Auto switch route turns only the WWV switch on", async () => {
    const base = createMemorySpyKv();
    const c: AutoRouteContext = { env: { POLARITO_SPY_DESK: "1" }, profile: WWV_PROFILE, makeLive: async () => ({ ok: true, deps: makeDeps(WWV_DRIVE), config: CFG }), desk: createMemoryDeskStore(), kv: scopeKv(base, WWV_PROFILE) };
    const res = await handleAutoSwitch(post("/api/spy-wwv/auto", { on: true, acknowledgeDryRun: true }), c);
    assert.equal(res.status, 200);
    assert.equal(base.data.has("polarito:spy-wwv:auto-switch:v1"), true);
    assert.equal(base.data.has(AUTO_SWITCH_KEY), false);
  });
  describe("the scheduler route", () => {
    const SECRET = "s".repeat(32);
    const get = (auth: string | null, path = "/api/spy-wwv/auto-run") => new Request(`${BASE}${path}`, { headers: auth === null ? {} : { authorization: auth } });
    const mk = (over: Partial<AutoRouteContext> = {}) => {
      const base = createMemorySpyKv();
      base.data.set(scopeKey(WWV_PROFILE, AUTO_SWITCH_KEY), { value: SWITCH_ON, expiresAt: null });
      const desk = createMemoryDeskStore();
      const c: AutoRouteContext = { env: { POLARITO_SPY_DESK: "1", CRON_SECRET: SECRET }, profile: WWV_PROFILE, now: () => T0, makeLive: async () => ({ ok: true, deps: makeDeps(WWV_DRIVE), config: CFG }), desk, kv: scopeKv(base, WWV_PROFILE), ...over };
      return { c, base, desk };
    };
    it("Bearer CRON_SECRET only: no or wrong bearer is 401, flag off 404, no secret 503", async () => {
      const { c } = mk({ makeLive: async () => { throw new Error("must not be called"); } });
      assert.equal((await handleAutoRun(get(null), c)).status, 401);
      assert.equal((await handleAutoRun(get("Bearer wrong-wrong-wrong-wrong-wrong-wrong-1"), c)).status, 401);
      assert.equal((await handleAutoRun(get(`Bearer ${SECRET}`), { ...c, env: { CRON_SECRET: SECRET } })).status, 404);
      assert.equal((await handleAutoRun(get(`Bearer ${SECRET}`), { ...c, env: { POLARITO_SPY_DESK: "1" } })).status, 503);
    });
    it("a correct bearer runs the WWV cycle: opens a call on Drive, the retry is a repeat, ?dry=1 saves nothing", async () => {
      const { c, desk, base } = mk();
      const body = (await (await handleAutoRun(get(`Bearer ${SECRET}`), c)).json()) as { outcome: string };
      assert.equal(body.outcome, "opened");
      const st = await desk.read();
      assert.ok(st.ok);
      assert.equal(st.state.position?.type, "call");
      assert.ok([...base.data.keys()].every((k) => k.startsWith("polarito:spy-wwv:")));
      const again = (await (await handleAutoRun(get(`Bearer ${SECRET}`, "/api/spy-wwv/auto-run?retry=1"), c)).json()) as { repeat: boolean };
      assert.equal(again.repeat, true);
      const dry = mk();
      const d = (await (await handleAutoRun(get(`Bearer ${SECRET}`, "/api/spy-wwv/auto-run?dry=1"), dry.c)).json()) as { dryRun: boolean; outcome: string };
      assert.equal(d.dryRun, true);
      assert.equal(d.outcome, "opened");
      const ds = await dry.desk.read();
      assert.ok(ds.ok);
      assert.equal(ds.state.position, null);
    });
    it("missing Alpaca keys: refused and logged with the Daily, WWV timeframe, nothing traded, Auto not turned off", async () => {
      const { c, desk, base } = mk({ makeLive: async () => ({ ok: false as const, code: "NO_KEYS" as const, error: "no keys" }) });
      const res = await handleAutoRun(get(`Bearer ${SECRET}`), c);
      assert.equal(res.status, 503);
      const st = await desk.read();
      assert.ok(st.ok);
      assert.equal(st.state.position, null);
      const log = await readLog(scopeKv(base, WWV_PROFILE));
      assert.ok(log.ok);
      assert.equal(log.log[0].outcome, "refused");
    });
  });
});

describe("WWV desk: proxy gate, cron and files", () => {
  it("only the two exact scheduler paths skip the session cookie; every other desk route stays gated", () => {
    for (const p of ["/api/spy/auto-run", "/api/spy-wwv/auto-run"]) assert.notEqual(proxy(new NextRequest(`${BASE}${p}`)).status, 401, p);
    for (const p of ["/api/spy-wwv/live", "/api/spy-wwv/desk", "/api/spy-wwv/analyze", "/api/spy-wwv/ticket", "/api/spy-wwv/close", "/api/spy-wwv/auto", "/api/spy-wwv/auto-run/x", "/api/spy-wwv/auto-run/", "/api/spy-wwv"]) {
      assert.equal(proxy(new NextRequest(`${BASE}${p}`)).status, 401, p);
    }
    const page = proxy(new NextRequest(`${BASE}/spy-wwv`));
    assert.equal(page.status, 307, "the page itself redirects to /login without a session");
    assert.match(page.headers.get("location") ?? "", /\/login\?next=%2Fspy-wwv/);
  });
  it("vercel.json has the WWV auto-run twice a weekday, the same pattern as the monthly desk", () => {
    const cfg = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
    const of = (base: string) => cfg.crons.filter((c) => c.path.startsWith(base)).map((c) => `${c.path} ${c.schedule}`).sort();
    assert.deepEqual(of("/api/spy-wwv/auto-run"), ["/api/spy-wwv/auto-run 30 21 * * 1-5", "/api/spy-wwv/auto-run?retry=1 30 22 * * 1-5"]);
    assert.deepEqual(of("/api/spy/auto-run").map((s) => s.replace("/api/spy/", "")), of("/api/spy-wwv/auto-run").map((s) => s.replace("/api/spy-wwv/", "")));
  });
  it("the WWV route files mirror the monthly ones, use only the WWV profile, and never name a monthly path or key", () => {
    for (const name of ["desk", "live", "analyze", "ticket", "close", "auto", "auto-run"]) {
      const f = `src/app/api/spy-wwv/${name}/route.node.ts`;
      const src = read(f);
      assert.match(src, /WWV_PROFILE/, f);
      assert.doesNotMatch(src, /MONTHLY_PROFILE|\/api\/spy\//, f);
      const verb = ["ticket", "close", "auto"].includes(name) ? "POST" : "GET";
      assert.match(src, new RegExp(`export async function ${verb}\\b`), f);
      assert.doesNotMatch(src, new RegExp(`export async function (${["GET", "POST", "PUT", "PATCH", "DELETE"].filter((v) => v !== verb).join("|")})\\b`), f);
      if (["desk", "live", "analyze", "auto-run"].includes(name)) assert.match(src, /await connection\(\)/, f);
      assert.ok(fs.existsSync(`src/app/api/spy/${name}/route.node.ts`), `monthly twin of ${name}`);
      assert.match(read(`src/app/api/spy/${name}/route.node.ts`), /MONTHLY_PROFILE/, name);
    }
    assert.match(read("src/app/api/spy-wwv/live/route.node.ts"), /light: true/);
    assert.match(read("src/app/api/spy-wwv/analyze/route.node.ts"), /readOnly: true/);
    assert.match(read("src/app/api/spy-wwv/auto-run/route.node.ts"), /maxDuration = 60/);
  });
  it("no order code and no write verb in the new files; the WWV files never read the live-trading switch", () => {
    for (const f of ["src/lib/wwv.ts", "src/lib/deskReadings.ts", "src/lib/spyProfile.ts", "src/lib/spyDeskServer.ts", "src/components/spy/SpyDeskPage.tsx", "src/app/spy-wwv/page.tsx", ...["desk", "live", "analyze", "ticket", "close", "auto", "auto-run"].map((n) => `src/app/api/spy-wwv/${n}/route.node.ts`)]) {
      const src = read(f);
      assert.doesNotMatch(src, /\/v2\/orders|\/v2\/positions|POLARITO_LIVE_TRADING_ENABLED|api\/broker\//, f);
      assert.doesNotMatch(src, /from ["']@\/lib\/broker\/(alpacaLive|alpacaPaper|liveConfig|execute)/, f);
      assert.doesNotMatch(src, /liveBuy|liveClose|orderGuard|liveAutoGuard|createLiveBroker|submitOrder|placeOrder|createOrder|closePosition|alpaca\.markets/, f);
      assert.doesNotMatch(src, /method:\s*["'](POST|PUT|PATCH|DELETE)["']|fetch\(/, f);
      assert.doesNotMatch(src, /process\.env\.POLARITO_/, f);
    }
  });
  it("the page is the shared shell with the WWV profile, with a title that says so", () => {
    const page = read("src/app/spy-wwv/page.tsx");
    assert.match(page, /<SpyDeskPage profile=\{WWV_PROFILE\}/);
    assert.match(page, /SPY DESK WWV/);
    assert.match(page, /Daily WWV/);
  });
});

describe("WWV desk: data loading", () => {
  it("loads about 200 calendar days of daily bars (not a year); the monthly desk keeps its longer window", () => {
    assert.equal(dailyStartFor(WWV_PROFILE, "2026-01-05"), "2025-06-19", "early in the year WWV still loads 200 calendar days");
    assert.equal(dailyStartFor(WWV_PROFILE, "2026-11-03"), dailyStartFor(MONTHLY_PROFILE, "2026-11-03"), "later in the year it loads as far back as the period readings it now also shows; its decision still reads only the last 200 days (wwvWindow)");
    assert.ok(dailyStartFor(MONTHLY_PROFILE, "2026-11-03") < "2025-12-01");
  });
  it("the light caches live at module level, one per connection and setup", () => {
    const connA = {} as never;
    const connB = {} as never;
    let made = 0;
    const make = () => {
      made++;
      return { loadDaily: async () => ({ ok: false as const, code: "NETWORK" as const, error: "x" }), readSpot: async () => ({ ok: false as const, code: "NETWORK" as const, error: "x" }), readHeld: async () => null };
    };
    const a1 = lightCacheFor(connA, "k1", make);
    const a2 = lightCacheFor(connA, "k1", make);
    assert.equal(a1, a2, "a second request gets the same cache");
    assert.notEqual(lightCacheFor(connA, "k2", make), a1);
    assert.notEqual(lightCacheFor(connB, "k1", make), a1);
    assert.equal(made, 3);
  });
});

describe("WWV desk: the page (rendering only)", () => {
  const noop = () => undefined;
  const props = (over: Partial<DeskViewProps>): DeskViewProps => ({ load: { status: "loading" }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
  const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");

  it("says SPY DESK WWV and Daily, WWV, and shows wave direction, wave volume, previous wave volume, candle colour and the bar date", async () => {
    const snapshot = await buildDeskSnapshot(makeDeps(WWV_DRIVE), CFG, createMemoryDeskStore(), await buildAutoView(null, WWV_PROFILE.scheduleText));
    const out = html(props({ profile: WWV_PROFILE, load: { status: "ready", snapshot } }));
    assert.match(out, /data-profile="wwv"/);
    assert.match(out, /SPY DESK WWV/);
    assert.match(out, /Daily, WWV/);
    assert.match(out, /Daily Weis Wave Volume/);
    assert.match(out, /data-testid="wwv-direction"[^>]*>[\s\S]*?UP wave/);
    assert.match(out, /data-testid="wwv-volume"[^>]*>700</);
    assert.match(out, /data-testid="wwv-previous"[^>]*>[\s\S]*?400[\s\S]*?down wave/);
    assert.match(out, /data-testid="wwv-candle"[^>]*>[\s\S]*?green \(99\.00 to 101\.00\)/);
    assert.match(out, /daily bar 2026-11-03 \(final\)/);
    assert.match(out, /Decision \(Daily, WWV timeframe\)/);
    assert.match(out, /Four readings \(period to date, SPY\)/, "the four net volume readings are shown as context");
  });
  it("Neutral shows the reason; unavailable data shows the reason and no wave numbers", async () => {
    const neutral = await buildDeskSnapshot(makeDeps(WWV_NEUTRAL), CFG, createMemoryDeskStore());
    const out = html(props({ profile: WWV_PROFILE, load: { status: "ready", snapshot: neutral } }));
    assert.match(out, /NEUTRAL: TRADER DECIDES|Neutral/);
    assert.match(out, /candle is green but the wave is down/);
    const down = await buildDeskSnapshot(makeDeps({ daily: WWV_DRIVE.daily.slice(0, -1) }), CFG, createMemoryDeskStore());
    const bad = html(props({ profile: WWV_PROFILE, load: { status: "ready", snapshot: down } }));
    assert.match(bad, /data-testid="data-unavailable"/);
    assert.match(bad, /stale data/);
    assert.doesNotMatch(bad, /UP wave|DOWN wave/);
  });
  it("an in-progress daily bar is labelled as such", async () => {
    const daily = wwvBars([...Array.from({ length: 20 }, () => [100, 100] as [number, number]), [98, 150], [99, 400], [101, 300]]);
    const now = new Date("2026-11-03T15:00:00Z");
    const snapshot = await buildDeskSnapshot(makeDeps({ daily }, { now }), CFG, createMemoryDeskStore());
    const out = html(props({ profile: WWV_PROFILE, load: { status: "ready", snapshot } }));
    assert.match(out, /session in progress, can still change/);
  });
  it("the monthly page is unchanged: SPY desk title, four readings, no WWV table", async () => {
    const snapshot = await buildDeskSnapshot(makeDeps(DRIVE), { timeframe: "M", liveBudget: 1000 }, createMemoryDeskStore());
    const out = html(props({ load: { status: "ready", snapshot } }));
    assert.match(out, /data-profile="monthly"/);
    assert.match(out, />SPY desk</);
    assert.doesNotMatch(out, /SPY DESK WWV|Daily, WWV|wwv-table/);
    assert.match(out, /Four readings/);
    for (const tf of ["M", "Q", "H", "Y"]) assert.match(out, new RegExp(`data-testid="reading-${tf}"`));
  });
  it("the container is wired to the desk's own routes (no path of the other desk)", () => {
    const src = read("src/components/spy/SpyDesk.tsx");
    assert.doesNotMatch(src, /"\/api\/spy/);
    assert.match(src, /apiPath\(profile, "ticket"\)/);
    assert.match(src, /deskPaths\(profile\)/);
  });
});
