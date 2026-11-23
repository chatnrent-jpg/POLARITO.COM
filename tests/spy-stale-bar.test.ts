import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { computeDeskReadings } from "../src/lib/deskReadings";
import { dailyStaleReason } from "../src/lib/longPolarity";
import { expectedLatestSession, latestPossibleSession, sessionInProgress, tradingDaysBetween } from "../src/lib/marketCalendar";
import type { Bar } from "../src/lib/polarity";
import { buildAnalysis } from "../src/lib/spyAnalysis";
import { runAutoCycle } from "../src/lib/spyAuto";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { buildDeskSnapshot, deskDecision, openManual, type DeskConfig } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { createMemorySpyKv } from "../src/lib/spyKv";
import { AUTO_SWITCH_KEY } from "../src/lib/spyAuto";
import { buildLiveSnapshot } from "../src/lib/spyLive";
import { WWV_PROFILE } from "../src/lib/spyProfile";
import { DRIVE, makeDeps } from "./helpers/spyDeskFixtures";

/** Calm, valid daily history on every trading day from 2025-10-01 through `end` (inclusive; `end` itself is added even when it is not a trading day). */
function history(end: string): Bar[] {
  const dates = tradingDaysBetween("2025-10-01", end);
  if (dates[dates.length - 1] !== end) dates.push(end); // a bad bar dated on a weekend or holiday
  return dates.map((date, i) => {
    const close = 100 + (i % 5);
    const open = close - 0.5;
    return { date, open, high: close + 1, low: open - 1, close, volume: 1000 + i };
  });
}
const utc = (iso: string) => new Date(iso);

type Case = { name: string; now: string; newest: string; ok: boolean; inProgress?: boolean; reason?: RegExp };
const OLDER = /current session needs/;
const FUTURE = /dated after the latest session that can exist now/;

// US Eastern is UTC-5 in November and January (EST).
const CASES: Case[] = [
  // before the open
  { name: "Mon 08:00 ET, newest is Friday", now: "2026-11-23T13:00:00Z", newest: "2026-11-20", ok: true, inProgress: false },
  { name: "Mon 08:00 ET, newest is Thursday (two sessions old)", now: "2026-11-23T13:00:00Z", newest: "2026-11-19", ok: false, reason: OLDER },
  { name: "Mon 08:00 ET, a bar already dated today (future-dated)", now: "2026-11-23T13:00:00Z", newest: "2026-11-23", ok: false, reason: FUTURE },
  { name: "Mon 09:25 ET, still before the open: today's bar is rejected", now: "2026-11-23T14:25:00Z", newest: "2026-11-23", ok: false, reason: FUTURE },
  { name: "Mon 09:25 ET, Friday is fine", now: "2026-11-23T14:25:00Z", newest: "2026-11-20", ok: true, inProgress: false },
  // the reported bug: just after the open, Alpaca already returns today's partial bar
  { name: "Mon 09:45 ET with today's partial bar (the reported bug)", now: "2026-11-23T14:45:00Z", newest: "2026-11-23", ok: true, inProgress: true },
  { name: "Mon 09:45 ET, today's bar not there yet, Friday is still accepted", now: "2026-11-23T14:45:00Z", newest: "2026-11-20", ok: true, inProgress: false },
  { name: "Mon 09:45 ET, Thursday is stale", now: "2026-11-23T14:45:00Z", newest: "2026-11-19", ok: false, reason: OLDER },
  { name: "Mon 09:45 ET, tomorrow's bar is future-dated", now: "2026-11-23T14:45:00Z", newest: "2026-11-24", ok: false, reason: FUTURE },
  { name: "Mon 09:30 ET exactly: today's bar is accepted", now: "2026-11-23T14:30:00Z", newest: "2026-11-23", ok: true, inProgress: true },
  // due time and during the session
  { name: "Mon 09:50 ET: Friday is now stale (today's bar is due)", now: "2026-11-23T14:50:00Z", newest: "2026-11-20", ok: false, reason: OLDER },
  { name: "Mon 10:00 ET with today's partial bar", now: "2026-11-23T15:00:00Z", newest: "2026-11-23", ok: true, inProgress: true },
  { name: "Mon 15:59 ET: still in progress", now: "2026-11-23T20:59:00Z", newest: "2026-11-23", ok: true, inProgress: true },
  // after the close
  { name: "Mon 16:00 ET: the bar is final", now: "2026-11-23T21:00:00Z", newest: "2026-11-23", ok: true, inProgress: false },
  { name: "Mon 16:30 ET (after the close), final bar", now: "2026-11-23T21:30:00Z", newest: "2026-11-23", ok: true, inProgress: false },
  { name: "Mon 16:30 ET, the day's bar is missing (Friday): stale", now: "2026-11-23T21:30:00Z", newest: "2026-11-20", ok: false, reason: OLDER },
  { name: "Mon 16:30 ET, tomorrow's bar: future-dated", now: "2026-11-23T21:30:00Z", newest: "2026-11-24", ok: false, reason: FUTURE },
  // one-day-old versus two-day-old
  { name: "Tue 09:45 ET, one-day-old (Monday) bar is the last completed session: fine", now: "2026-11-24T14:45:00Z", newest: "2026-11-23", ok: true, inProgress: false },
  { name: "Tue 09:45 ET, two-day-old (Friday) bar: stale", now: "2026-11-24T14:45:00Z", newest: "2026-11-20", ok: false, reason: OLDER },
  { name: "Tue 11:00 ET, one-day-old (Monday) bar: stale (today's bar is due)", now: "2026-11-24T16:00:00Z", newest: "2026-11-23", ok: false, reason: OLDER },
  { name: "Tue 11:00 ET, today's partial bar", now: "2026-11-24T16:00:00Z", newest: "2026-11-24", ok: true, inProgress: true },
  // weekend
  { name: "Sat 12:00 ET, Friday is fine", now: "2026-11-21T17:00:00Z", newest: "2026-11-20", ok: true, inProgress: false },
  { name: "Sat 12:00 ET, Thursday is stale", now: "2026-11-21T17:00:00Z", newest: "2026-11-19", ok: false, reason: OLDER },
  { name: "Sun 12:00 ET, a bar dated Monday is future-dated", now: "2026-11-22T17:00:00Z", newest: "2026-11-23", ok: false, reason: FUTURE },
  { name: "Sat 12:00 ET, a bar dated Saturday is future-dated", now: "2026-11-21T17:00:00Z", newest: "2026-11-21", ok: false, reason: FUTURE },
  // Monday holiday (MLK Day, 2027-01-18)
  { name: "MLK Monday 10:00 ET, Friday is fine and not in progress", now: "2027-01-18T15:00:00Z", newest: "2027-01-15", ok: true, inProgress: false },
  { name: "MLK Monday 10:00 ET, a bar dated the holiday is future-dated", now: "2027-01-18T15:00:00Z", newest: "2027-01-18", ok: false, reason: FUTURE },
  { name: "MLK Monday 10:00 ET, Thursday is stale", now: "2027-01-18T15:00:00Z", newest: "2027-01-14", ok: false, reason: OLDER },
  { name: "Tue after MLK 09:45 ET, Friday is the last completed session: fine", now: "2027-01-19T14:45:00Z", newest: "2027-01-15", ok: true, inProgress: false },
  { name: "Tue after MLK 09:45 ET, today's partial bar", now: "2027-01-19T14:45:00Z", newest: "2027-01-19", ok: true, inProgress: true },
  { name: "Tue after MLK 11:00 ET, Friday is stale", now: "2027-01-19T16:00:00Z", newest: "2027-01-15", ok: false, reason: OLDER },
];

const cfgOf = (tf: "M" | "D"): DeskConfig => ({ timeframe: tf, liveBudget: 1000 });

describe("calendar: oldest acceptable and newest possible session", () => {
  it("at the key moments", () => {
    const row = (iso: string) => [expectedLatestSession(utc(iso)), latestPossibleSession(utc(iso))];
    assert.deepEqual(row("2026-11-23T13:00:00Z"), ["2026-11-20", "2026-11-20"], "Mon 08:00");
    assert.deepEqual(row("2026-11-23T14:25:00Z"), ["2026-11-20", "2026-11-20"], "Mon 09:25");
    assert.deepEqual(row("2026-11-23T14:45:00Z"), ["2026-11-20", "2026-11-23"], "Mon 09:45: either Friday or today");
    assert.deepEqual(row("2026-11-23T14:50:00Z"), ["2026-11-23", "2026-11-23"], "Mon 09:50");
    assert.deepEqual(row("2026-11-23T21:30:00Z"), ["2026-11-23", "2026-11-23"], "Mon after close");
    assert.deepEqual(row("2026-11-22T17:00:00Z"), ["2026-11-20", "2026-11-20"], "Sunday");
    assert.deepEqual(row("2027-01-18T15:00:00Z"), ["2027-01-15", "2027-01-15"], "MLK Monday");
    assert.deepEqual(row("2026-11-26T17:00:00Z"), ["2026-11-25", "2026-11-25"], "Thanksgiving");
  });
  it("the session is in progress from 09:30 to 16:00 ET on a trading day, for that day's bar only", () => {
    assert.equal(sessionInProgress("2026-11-23", utc("2026-11-23T14:29:00Z")), false);
    assert.equal(sessionInProgress("2026-11-23", utc("2026-11-23T14:30:00Z")), true);
    assert.equal(sessionInProgress("2026-11-23", utc("2026-11-23T20:59:00Z")), true);
    assert.equal(sessionInProgress("2026-11-23", utc("2026-11-23T21:00:00Z")), false);
    assert.equal(sessionInProgress("2026-11-20", utc("2026-11-23T15:00:00Z")), false, "yesterday's bar is final");
    assert.equal(sessionInProgress("2027-01-18", utc("2027-01-18T15:00:00Z")), false, "a holiday has no session");
  });
});

for (const c of CASES) {
  describe(`${c.name}`, () => {
    const now = utc(c.now);
    const daily = history(c.newest);

    it("the freshness rule", () => {
      const r = dailyStaleReason(daily, now);
      if (c.ok) assert.equal(r, null);
      else assert.match(r ?? "", c.reason as RegExp);
    });
    it("the monthly desk readings and the WWV reading", () => {
      for (const tf of ["M", "D"] as const) {
        const readings = computeDeskReadings(daily, now, tf);
        for (const r of Object.values(readings)) {
          assert.ok(r);
          if (c.ok) {
            assert.equal(r.status, "ok", `${tf}: ${r.reason}`);
            assert.equal(r.inProgress, c.inProgress, `${tf} inProgress`);
            assert.equal(r.throughDate, c.newest);
          } else {
            assert.equal(r.status, "unavailable");
            assert.equal(r.polarity, null);
            assert.match(r.reason ?? "", /stale data/);
            assert.match(r.reason ?? "", c.reason as RegExp);
          }
        }
      }
    });
    it("decision, Analyze, desk snapshot and live refresh agree", async () => {
      for (const tf of ["M", "D"] as const) {
        const cfg = cfgOf(tf);
        const deps = makeDeps({ daily }, { now });
        const d = deskDecision(daily, now, tf);
        assert.equal(d.status === "ok", c.ok);
        const a = await buildAnalysis(deps, cfg);
        assert.equal(a.ok, c.ok, `analyze ${tf}`);
        if (!a.ok) assert.equal(a.status, 503);
        else assert.equal(a.reading.inProgress, c.inProgress);
        const desk = await buildDeskSnapshot(deps, cfg, createMemoryDeskStore());
        const live = await buildLiveSnapshot(deps, cfg, createMemoryDeskStore());
        for (const s of [desk, live]) {
          assert.equal(s.decision.action === "DATA_UNAVAILABLE", !c.ok, `${tf} ${s.decision.action}`);
          if (c.ok) assert.ok(s.readings.every((r) => r.status === "ok" && r.inProgress === c.inProgress));
          else assert.ok(s.readings.every((r) => r.status === "unavailable"));
        }
        if (!c.ok) assert.equal(desk.ticket.open, false);
      }
    });
  });
}

describe("what the page says about the in-progress bar", () => {
  const noop = () => undefined;
  const props = (over: Partial<DeskViewProps>): DeskViewProps => ({ load: { status: "loading" }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-23T14:45:05.000Z", chainAt: "2026-11-23T14:45:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
  const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
  const now = utc("2026-11-23T14:45:00Z");
  const deps = () => makeDeps({ daily: history("2026-11-23") }, { now });

  it("monthly desk at 09:45 with today's partial bar: readings shown, labelled session in progress, no Data unavailable", async () => {
    const snapshot = await buildDeskSnapshot(deps(), cfgOf("M"), createMemoryDeskStore());
    const out = html(props({ load: { status: "ready", snapshot } }));
    assert.doesNotMatch(out, /data-testid="data-unavailable"/);
    assert.doesNotMatch(out, /stale data/);
    for (const tf of ["M", "Q", "H", "Y"]) assert.match(out, new RegExp(`data-testid="in-progress-${tf}"`));
    assert.match(out, /session in progress: includes today&#x27;s partial day/);
    assert.match(snapshot.decision.reason, /today's session is still in progress/);
  });
  it("WWV desk at 09:45 with today's partial bar: wave table labelled, no Data unavailable", async () => {
    const snapshot = await buildDeskSnapshot(deps(), cfgOf("D"), createMemoryDeskStore());
    const out = html(props({ profile: WWV_PROFILE, load: { status: "ready", snapshot } }));
    assert.doesNotMatch(out, /data-testid="data-unavailable"/);
    assert.match(out, /daily bar 2026-11-23 \(session in progress, can still change\)/);
    assert.match(snapshot.decision.reason, /session still in progress/);
  });
  it("after the close the label is gone", async () => {
    const after = utc("2026-11-23T21:30:00Z");
    const snapshot = await buildDeskSnapshot(makeDeps({ daily: history("2026-11-23") }, { now: after }), cfgOf("M"), createMemoryDeskStore());
    const out = html(props({ load: { status: "ready", snapshot } }));
    assert.doesNotMatch(out, /in-progress-/);
    assert.doesNotMatch(snapshot.decision.reason, /still in progress/);
  });
  it("a bad inProgress flag on the wire is refused by the browser check", async () => {
    const { isReadingView } = await import("../src/lib/spyDesk");
    const snapshot = JSON.parse(JSON.stringify(await buildDeskSnapshot(deps(), cfgOf("M"), null))) as { readings: Array<Record<string, unknown>> };
    assert.equal(isReadingView(snapshot.readings[0]), true);
    assert.equal(isReadingView({ ...snapshot.readings[0], inProgress: "yes" }), false);
    const without = { ...snapshot.readings[0] };
    delete without.inProgress;
    assert.equal(isReadingView(without), false);
  });
});

describe("manual ticket and auto with the in-progress bar", () => {
  // The shared option-chain fixtures are built for 2026-11-03 (a Tuesday); the same moments of that day are used here.
  const day = (hhmmUtc: string) => utc(`2026-11-03T${hhmmUtc}:00Z`);
  const partial = { daily: DRIVE.daily };
  const CFG_M = cfgOf("M");

  it("the ticket route logic accepts a Drive reading on today's in-progress bar (15:30 ET) and records the practice buy", async () => {
    const store = createMemoryDeskStore();
    const res = await openManual(makeDeps(partial, { now: day("20:30") }), CFG_M, store, { type: "call", symbol: "SPY271105C00600000", analyzedGear: "DRIVE" });
    assert.ok(res.ok, res.ok ? "" : res.error);
    const st = await store.read();
    assert.ok(st.ok && st.state.position);
  });
  it("at 09:45 ET with today's partial bar the ticket sees the same gear as Analyze (no stale refusal)", async () => {
    const deps = makeDeps(partial, { now: day("14:45") });
    const a = await buildAnalysis(deps, CFG_M);
    assert.ok(a.ok);
    assert.equal(a.gear, "DRIVE");
    assert.equal(a.reading.inProgress, true);
    const res = await openManual(deps, CFG_M, createMemoryDeskStore(), { type: "put", symbol: "SPY271105P00850000", analyzedGear: "DRIVE" });
    assert.ok(!res.ok);
    assert.equal(res.code, "COUNTER_POLARITY", "refused for the gear, not for staleness");
  });
  it("Auto never acts on an in-progress bar: at 09:45 and 15:59 ET it stands aside, and after 16:15 ET it reads the final bar", async () => {
    const mk = () => {
      const kv = createMemorySpyKv();
      kv.data.set(AUTO_SWITCH_KEY, { value: JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" }), expiresAt: null });
      return { kv, desk: createMemoryDeskStore() };
    };
    for (const t of ["14:45", "20:59"]) {
      const r = mk();
      const out = await runAutoCycle(makeDeps(partial, { now: day(t) }), CFG_M, r, {});
      assert.equal(out.outcome, "skipped", t);
      assert.match(out.message, /has not closed yet/);
      const st = await r.desk.read();
      assert.ok(st.ok);
      assert.equal(st.state.position, null);
    }
    const after = mk();
    const out = await runAutoCycle(makeDeps(partial, { now: day("21:30") }), CFG_M, after, {});
    assert.equal(out.outcome, "opened");
    const st = await after.desk.read();
    assert.ok(st.ok && st.state.position);
    assert.equal(st.state.position.source, "auto");
  });
  it("Auto after the close still refuses a stale or future-dated newest bar", async () => {
    for (const newest of ["2026-11-02", "2026-11-04"]) {
      const kv = createMemorySpyKv();
      kv.data.set(AUTO_SWITCH_KEY, { value: JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" }), expiresAt: null });
      const desk = createMemoryDeskStore();
      const out = await runAutoCycle(makeDeps({ daily: history(newest) }, { now: day("21:30") }), CFG_M, { kv, desk }, {});
      assert.equal(out.outcome, "refused", newest);
      assert.match(out.message, /stale data/);
      const st = await desk.read();
      assert.ok(st.ok);
      assert.equal(st.state.position, null);
    }
  });
});
