import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { DEFAULT_SPY_DECISION_TIMEFRAME, TIMEFRAME_NAMES, computeDeskReadings, deskReadingKeys, isDeskTimeframe, isSelectableDeskTimeframe, readingKeys } from "../src/lib/deskReadings";
import { DAILY_NV_TIMEFRAME, LONG_TIMEFRAMES, computeDailyNetVolume, computeLongReadings, isLongTimeframe } from "../src/lib/longPolarity";
import { tradingDaysBetween } from "../src/lib/marketCalendar";
import type { Bar } from "../src/lib/polarity";
import { buildAnalysis } from "../src/lib/spyAnalysis";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { AUTO_LOG_KEY, AUTO_SWITCH_KEY, readLog, runAutoCycle } from "../src/lib/spyAuto";
import { AUTO_SCHEDULE_TEXT } from "../src/lib/spyAutoTypes";
import { buildDeskSnapshot, deskDecision, type DeskConfig, type DeskPosition, type DeskState } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { handleAnalyze, handleTicket, type DeskContext } from "../src/lib/spyDeskRoutes";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { parseEngineConfig, runEngine, EMPTY_STATE, type EngineDeps } from "../src/lib/spyEngine";
import { createMemorySpyKv } from "../src/lib/spyKv";
import { WWV_PROFILE } from "../src/lib/spyProfile";
import { DRIVE, REVERSE, T0, makeDeps, row, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE } from "./helpers/wwvFixtures";

const DAILY: DeskConfig = { timeframe: "1D", liveBudget: 1000 };
const MONTHLY: DeskConfig = { timeframe: "M", liveBudget: 1000 };
const utc = (iso: string) => new Date(iso);

type Day = { open: number; close: number; volume: number };
/** Calm history (close 100, volume 100) to 2026-10-30, then 2026-11-02, 2026-11-03 (and more) as given. */
function scen(days: Array<[string, Day]>): Scenario {
  const daily: Bar[] = tradingDaysBetween("2025-11-03", "2026-10-30").map((date) => ({ date, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  for (const [date, d] of days) daily.push({ date, open: d.open, close: d.close, volume: d.volume, high: Math.max(d.open, d.close) + 0.1, low: Math.min(d.open, d.close) - 0.1 });
  return { daily };
}
const N2: Day = { open: 100, close: 101, volume: 100 };
/** Daily Neutral (green candle but the close is below the previous close) while Monthly is Drive. */
const D_NEUTRAL_M_DRIVE = scen([["2026-11-02", N2], ["2026-11-03", { open: 99, close: 100.5, volume: 100 }]]);
/** Daily Reverse while Monthly is Drive. */
const D_REVERSE_M_DRIVE = scen([["2026-11-02", N2], ["2026-11-03", { open: 102, close: 100.5, volume: 100 }]]);

/** One calm valid history through `end`, with the last bar as given (previous trading day closes at `prevClose`). */
function hist(end: string, last: Day, prevClose = 100): Bar[] {
  const dates = tradingDaysBetween("2025-10-01", end);
  return dates.map((date, i) => {
    if (i === dates.length - 1) return { date, open: last.open, close: last.close, volume: last.volume, high: Math.max(last.open, last.close) + 1, low: Math.min(last.open, last.close) - 1 };
    const close = i === dates.length - 2 ? prevClose : 100;
    return { date, open: close, close, volume: 1000 + i, high: close + 1, low: close - 1 };
  });
}
const GREEN_UP: Day = { open: 99, close: 101, volume: 5000 };
const RED_DOWN: Day = { open: 101, close: 99, volume: 5000 };

describe("Daily net volume reading (same chart definition on one day)", () => {
  const after = utc("2026-11-23T21:30:00Z");
  it("period = the trading day, candle = today's open to latest close, previous close = previous day's close, net = today's volume only, signed", () => {
    const r = computeDailyNetVolume({ daily: hist("2026-11-23", GREEN_UP), now: after });
    assert.equal(r.timeframe, "1D");
    assert.equal(r.status, "ok");
    assert.equal(r.periodStart, "2026-11-23");
    assert.equal(r.throughDate, "2026-11-23");
    assert.equal(r.sessions, 1);
    assert.equal(r.open, 99);
    assert.equal(r.close, 101);
    assert.equal(r.previousClose, 100);
    assert.equal(r.kind, "green");
    assert.equal(r.netVolume, 5000);
    assert.equal(r.totalVolume, 5000);
    assert.equal(r.agreement, "agree");
    assert.equal(r.inProgress, false);
  });
  it("Drive: green candle and positive net volume", () => {
    const r = computeDailyNetVolume({ daily: hist("2026-11-23", GREEN_UP), now: after });
    assert.deepEqual([r.polarity, r.label], [1, "Drive"]);
  });
  it("Reverse: red candle and negative net volume (net volume is minus today's volume)", () => {
    const r = computeDailyNetVolume({ daily: hist("2026-11-23", RED_DOWN), now: after });
    assert.deepEqual([r.polarity, r.label, r.netVolume, r.kind], [-1, "Reverse", -5000, "red"]);
  });
  it("Neutral: candle and net volume disagree (green candle, close below the previous close)", () => {
    const r = computeDailyNetVolume({ daily: hist("2026-11-23", { open: 98, close: 99, volume: 5000 }), now: after });
    assert.deepEqual([r.polarity, r.label, r.kind, r.netVolume, r.agreement], [0, "Neutral", "green", -5000, "disagree"]);
    const red = computeDailyNetVolume({ daily: hist("2026-11-23", { open: 103, close: 102, volume: 5000 }), now: after });
    assert.deepEqual([red.polarity, red.kind, red.netVolume], [0, "red", 5000]);
  });
  it("Neutral with an explicit flag when the close equals the previous close (net volume zero, no sign guessed) and when the candle is flat", () => {
    const zero = computeDailyNetVolume({ daily: hist("2026-11-23", { open: 99, close: 100, volume: 5000 }), now: after });
    assert.deepEqual([zero.polarity, zero.netFlag, zero.netVolume], [0, "zero", 0]);
    const flat = computeDailyNetVolume({ daily: hist("2026-11-23", { open: 101, close: 101, volume: 5000 }), now: after });
    assert.deepEqual([flat.polarity, flat.kind], [0, "flat"]);
  });
  it("in-progress bar (Mon 09:45 ET, today's partial bar) is accepted and labelled; after the close it is final", () => {
    const early = computeDailyNetVolume({ daily: hist("2026-11-23", GREEN_UP), now: utc("2026-11-23T14:45:00Z") });
    assert.equal(early.status, "ok");
    assert.equal(early.inProgress, true);
    assert.equal(early.label, "Drive");
    for (const t of ["2026-11-23T14:30:00Z", "2026-11-23T20:59:00Z"]) assert.equal(computeDailyNetVolume({ daily: hist("2026-11-23", GREEN_UP), now: utc(t) }).inProgress, true, t);
    for (const t of ["2026-11-23T21:00:00Z", "2026-11-23T21:30:00Z"]) assert.equal(computeDailyNetVolume({ daily: hist("2026-11-23", GREEN_UP), now: utc(t) }).inProgress, false, t);
  });
  it("before the open the reading is the previous session's final bar", () => {
    const r = computeDailyNetVolume({ daily: hist("2026-11-20", GREEN_UP), now: utc("2026-11-23T13:00:00Z") });
    assert.equal(r.status, "ok");
    assert.equal(r.throughDate, "2026-11-20");
    assert.equal(r.inProgress, false);
  });
  it("weekend (Sat, Sun) and a holiday Monday: Friday's final bar, not stale; a bar dated on the weekend is future-dated", () => {
    for (const now of ["2026-11-21T17:00:00Z", "2026-11-22T17:00:00Z"]) {
      const r = computeDailyNetVolume({ daily: hist("2026-11-20", GREEN_UP), now: utc(now) });
      assert.deepEqual([r.status, r.throughDate, r.inProgress, r.label], ["ok", "2026-11-20", false, "Drive"], now);
    }
    const bad = computeDailyNetVolume({ daily: [...hist("2026-11-20", GREEN_UP), { date: "2026-11-21", open: 100, high: 102, low: 99, close: 101, volume: 5000 }], now: utc("2026-11-21T17:00:00Z") });
    assert.equal(bad.status, "unavailable");
    assert.match(bad.reason ?? "", /future-dated/);
    const thanksgivingWeek = computeDailyNetVolume({ daily: hist("2026-11-25", GREEN_UP), now: utc("2026-11-26T17:00:00Z") });
    assert.deepEqual([thanksgivingWeek.status, thanksgivingWeek.throughDate], ["ok", "2026-11-25"]);
  });
  it("stale: an older bar than the session needs is unavailable, never a guess", () => {
    const mon10 = computeDailyNetVolume({ daily: hist("2026-11-20", GREEN_UP), now: utc("2026-11-23T15:00:00Z") });
    assert.equal(mon10.status, "unavailable");
    assert.equal(mon10.polarity, null);
    assert.equal(mon10.label, "Data unavailable");
    assert.match(mon10.reason ?? "", /stale data: the newest daily bar is 2026-11-20 but the current session needs 2026-11-23/);
    const thu = computeDailyNetVolume({ daily: hist("2026-11-19", GREEN_UP), now: utc("2026-11-23T13:00:00Z") });
    assert.match(thu.reason ?? "", /stale data/);
    assert.equal(computeDailyNetVolume({ daily: [], now: after }).status, "unavailable");
  });
  it("unavailable, never a guess: previous trading day missing, zero volume today, malformed bars", () => {
    const noPrev = hist("2026-11-23", GREEN_UP).filter((b) => b.date !== "2026-11-20");
    assert.match(computeDailyNetVolume({ daily: noPrev, now: after }).reason ?? "", /no daily bar for the previous period's last session \(2026-11-20\)/);
    assert.match(computeDailyNetVolume({ daily: hist("2026-11-23", { ...GREEN_UP, volume: 0 }), now: after }).reason ?? "", /volume missing or zero on 2026-11-23/);
    const malformed = hist("2026-11-23", GREEN_UP);
    malformed[malformed.length - 1] = { ...malformed[malformed.length - 1], high: 1, low: 500 };
    assert.match(computeDailyNetVolume({ daily: malformed, now: after }).reason ?? "", /daily bars rejected/);
  });
  it("the four period readings are untouched (still computed, same keys, same numbers) next to it", () => {
    const daily = hist("2026-11-23", GREEN_UP);
    const four = computeLongReadings({ daily, now: after });
    assert.deepEqual(Object.keys(four), ["M", "Q", "H", "Y"]);
    const all = computeDeskReadings(daily, after, "1D");
    assert.deepEqual(Object.keys(all).sort(), ["1D", "H", "M", "Q", "Y"]);
    for (const tf of LONG_TIMEFRAMES) assert.deepEqual(all[tf], four[tf], tf);
    assert.equal(all["1D"]?.netVolume, 5000);
    assert.ok((all.M?.netVolume ?? 0) > 5000, "monthly net volume is the month-to-date total, not one day");
  });
});

describe("keys: Daily net volume is 1D, the WWV desk is D, and the two never mix", () => {
  it("1D is a desk timeframe and selectable; D is a desk timeframe but not selectable by setting; 1D is still not a long (period) timeframe", () => {
    assert.equal(isDeskTimeframe("1D"), true);
    assert.equal(isSelectableDeskTimeframe("1D"), true);
    assert.equal(isSelectableDeskTimeframe("D"), false);
    assert.equal(isLongTimeframe("1D"), false);
    assert.deepEqual([...LONG_TIMEFRAMES], ["M", "Q", "H", "Y"]);
    assert.equal(DAILY_NV_TIMEFRAME, "1D");
    assert.equal(TIMEFRAME_NAMES["1D"], "Daily");
    assert.equal(TIMEFRAME_NAMES.D, "Daily, WWV");
  });
  it("the WWV desk's readings and keys are exactly as before: one reading, key D, no 1D", async () => {
    assert.deepEqual(readingKeys("D"), ["D"]);
    assert.deepEqual(deskReadingKeys("D"), ["D"]);
    assert.deepEqual(readingKeys("M"), ["M", "Q", "H", "Y"]);
    assert.deepEqual(Object.keys(computeDeskReadings(WWV_DRIVE.daily, T0, "D")), ["D"]);
    const snap = await buildDeskSnapshot(makeDeps(WWV_DRIVE), { timeframe: "D", liveBudget: 1000 }, createMemoryDeskStore());
    assert.deepEqual(snap.readings.map((r) => r.timeframe), ["D"]);
    assert.equal(snap.decision.action, "CALL");
  });
  it("the WWV desk ignores SPY_DECISION_TIMEFRAME entirely (fixed D), whatever it says", () => {
    for (const v of ["1D", "M", "nonsense"]) {
      const c = parseEngineConfig({ SPY_DECISION_TIMEFRAME: v }, WWV_PROFILE.fixedTimeframe);
      assert.ok(c.ok && c.config.timeframe === "D", v);
    }
  });
  it("the WWV page has no Daily reading section and no 1D card", async () => {
    const snap = await buildDeskSnapshot(makeDeps(WWV_DRIVE), { timeframe: "D", liveBudget: 1000 }, createMemoryDeskStore());
    const out = html(props(snap, { profile: WWV_PROFILE }));
    assert.doesNotMatch(out, /data-testid="daily-reading"|reading-1D|Daily reading \(today/);
    assert.match(out, /data-testid="wwv-table"/);
  });
});

describe("the decider: Daily by default, Monthly still selectable", () => {
  it("default is Daily (one line to change back, or SPY_DECISION_TIMEFRAME=M)", () => {
    assert.equal(DEFAULT_SPY_DECISION_TIMEFRAME, "1D");
    const c = parseEngineConfig({});
    assert.ok(c.ok && c.config.timeframe === "1D");
    for (const [v, tf] of [["M", "M"], ["m", "M"], ["Q", "Q"], ["H", "H"], ["Y", "Y"], ["1D", "1D"], ["1d", "1D"]] as const) {
      const r = parseEngineConfig({ SPY_DECISION_TIMEFRAME: v });
      assert.ok(r.ok && r.config.timeframe === tf, v);
    }
    for (const bad of ["D", "W", "1W", "daily", ""]) assert.equal(parseEngineConfig({ SPY_DECISION_TIMEFRAME: bad }).ok, false, bad);
  });
  it("the decision follows the chosen timeframe: Daily Neutral/Reverse while Monthly says Drive, and back on Monthly", () => {
    const daily = D_NEUTRAL_M_DRIVE.daily;
    assert.equal((deskDecision(daily, T0, "1D") as { action: string }).action, "STAND_ASIDE");
    assert.equal((deskDecision(daily, T0, "M") as { action: string }).action, "CALL");
    const rev = D_REVERSE_M_DRIVE.daily;
    assert.equal((deskDecision(rev, T0, "1D") as { action: string }).action, "PUT");
    assert.equal((deskDecision(rev, T0, "M") as { action: string }).action, "CALL");
    assert.equal((deskDecision(DRIVE.daily, T0, "1D") as { action: string }).action, "CALL");
    assert.equal((deskDecision(REVERSE.daily, T0, "1D") as { action: string }).action, "PUT");
  });
  it("snapshot: Daily is shown first and decides; Monthly, Quarterly, 6-month and Yearly are still shown and not deciding (and the other way round on Monthly)", async () => {
    const d = await buildDeskSnapshot(makeDeps(D_REVERSE_M_DRIVE), DAILY, createMemoryDeskStore());
    assert.deepEqual(d.readings.map((r) => [r.timeframe, r.isDecision]), [["1D", true], ["M", false], ["Q", false], ["H", false], ["Y", false]]);
    assert.equal(d.decision.action, "PUT");
    assert.match(d.decision.reason, /^Daily session 2026-11-03: candle red, net volume -100, they agree, so the reading is Reverse/);
    const m = await buildDeskSnapshot(makeDeps(D_REVERSE_M_DRIVE), MONTHLY, createMemoryDeskStore());
    assert.deepEqual(m.readings.map((r) => [r.timeframe, r.isDecision]), [["1D", false], ["M", true], ["Q", false], ["H", false], ["Y", false]]);
    assert.equal(m.decision.action, "CALL");
  });
  it("the engine log says Daily and the chart definition on one day; a flip is logged as a Daily reading change", async () => {
    const mk = (sc: Scenario): EngineDeps => ({ ...makeDeps(sc), now: () => T0 }) as unknown as EngineDeps;
    const first = await runEngine(mk(DRIVE), DAILY, EMPTY_STATE);
    assert.ok(first.ok);
    assert.equal(first.decision?.action, "CALL");
    assert.ok(first.events.some((e) => /Decision timeframe Daily, net volume = today's total volume signed by the latest close vs the previous trading day's close/.test(e.message)));
    assert.ok(first.events.some((e) => e.kind === "would-buy" && /WOULD BUY 1 CALL/.test(e.message)));
    const second = await runEngine(mk(D_REVERSE_M_DRIVE), DAILY, first.state);
    const change = second.events.find((e) => e.kind === "reading-change" && /^Daily reading changed Drive -> Reverse/.test(e.message));
    assert.ok(change, "the Daily flip is logged");
    assert.ok(second.events.some((e) => e.kind === "would-sell" && /because the Daily reading flipped to Reverse/.test(e.message)));
    assert.equal(second.state.position?.type, "put");
    assert.equal(second.state.position?.decisionTimeframe, "1D");
  });
});

/* ---------------------------------------------------------------- page */

const noop = () => undefined;
const props = (snapshot: Awaited<ReturnType<typeof buildDeskSnapshot>>, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

describe("the page with Daily as the decider", () => {
  it("title 'Decision (Daily timeframe)', Daily card highlighted and labelled, gear and contract pick follow the Daily reading", async () => {
    const out = html(props(await buildDeskSnapshot(makeDeps(DRIVE), DAILY, createMemoryDeskStore())));
    assert.match(text(out), /Decision \(Daily timeframe\)/);
    assert.match(tag(out, "decision-card"), /data-action="CALL"/);
    assert.match(out, /data-testid="decision-badge">CALL</);
    assert.match(text(out.match(/data-testid="decision-why">([\s\S]*?)<\/p>/)?.[1] ?? ""), /^The Daily candle is green \(101\.00 to 103\.00\) and its net volume is \+100 \(positive\): they agree, so the reading is Drive\.$/);
    assert.match(out, /data-testid="engine-pick"/);
    assert.match(tag(out, "reading-1D"), /data-decides="true"/);
    assert.match(out, /data-testid="decides-1D">decides</);
    assert.equal(out.match(/>decides</g)?.length, 1);
  });
  it("the Daily row sits in its own 'Daily reading' section and 'Four readings' (Monthly, Quarterly, 6-month, Yearly) stays as it was, muted and not deciding", async () => {
    const out = html(props(await buildDeskSnapshot(makeDeps(DRIVE), DAILY, createMemoryDeskStore())));
    assert.ok(out.indexOf('data-testid="daily-reading"') > out.indexOf('data-testid="decision-card"'));
    assert.ok(out.indexOf('data-testid="daily-reading"') < out.indexOf('id="readings-h"'));
    assert.match(text(out), /Daily reading \(today, SPY\)/);
    assert.match(text(out), /Four readings \(period to date, SPY\)/);
    for (const tf of ["M", "Q", "H", "Y"]) {
      assert.match(tag(out, `reading-${tf}`), /data-decides="false"/);
      assert.ok(out.indexOf(`data-testid="reading-${tf}"`) > out.indexOf('id="readings-h"'), `${tf} stays in the four readings`);
    }
    assert.match(text(out), /session 2026-11-03, as of 2026-11-03 21:30 UTC/);
    assert.match(text(out), /Raw net volume \+100 \(positive\)/);
  });
  it("Neutral Daily: NEUTRAL badge and 'no new position' even though Monthly says Drive", async () => {
    const out = html(props(await buildDeskSnapshot(makeDeps(D_NEUTRAL_M_DRIVE), DAILY, createMemoryDeskStore())));
    assert.match(out, /data-testid="decision-badge">NEUTRAL</);
    assert.match(text(out), /No new position on Neutral; Close still works\./);
    const monthly = out.match(/<li[^>]*data-testid="reading-M"[\s\S]*?<\/li>/)?.[0] ?? "";
    assert.match(monthly, /data-gear="Drive"/);
  });
  it("in-progress Daily bar: labelled 'session in progress' on the Daily card and in the decision card", async () => {
    const live = makeDeps({ daily: hist("2026-11-23", GREEN_UP) }, { now: utc("2026-11-23T14:45:00Z") });
    const out = html(props(await buildDeskSnapshot(live, DAILY, createMemoryDeskStore())));
    assert.match(out, /data-testid="in-progress-1D"/);
    assert.match(out, /data-testid="decision-in-progress"/);
    assert.doesNotMatch(out, /data-testid="data-unavailable"/);
    const stale = html(props(await buildDeskSnapshot(makeDeps({ daily: hist("2026-11-20", GREEN_UP) }, { now: utc("2026-11-23T15:00:00Z") }), DAILY, createMemoryDeskStore())));
    assert.match(stale, /data-testid="data-unavailable"/);
    assert.match(stale, /stale data/);
  });
  it("Monthly as decider still draws exactly as before (title Monthly, Monthly highlighted) with the Daily card as plain context", async () => {
    const out = html(props(await buildDeskSnapshot(makeDeps(DRIVE), MONTHLY, createMemoryDeskStore())));
    assert.match(text(out), /Decision \(Monthly timeframe\)/);
    assert.match(tag(out, "reading-M"), /data-decides="true"/);
    assert.match(tag(out, "reading-1D"), /data-decides="false"/);
    assert.equal(out.match(/>decides</g)?.length, 1);
  });
  it("the Auto text says what a Daily decider means", () => {
    assert.match(AUTO_SCHEDULE_TEXT, /Monthly polarity moves slowly, so one look per day is enough\./);
    assert.match(AUTO_SCHEDULE_TEXT, /default Daily decider[\s\S]*close and reopen on consecutive days[\s\S]*once per session[\s\S]*16:15 ET/);
  });
});

/* ----------------------------------------------------- Analyze and ticket */

const BASE = "https://www.polarito.com";
const live = (sc: Scenario, config: DeskConfig = DAILY, o = {}) => async () => ({ ok: true as const, deps: makeDeps(sc, o), config });
const ctx = (sc: Scenario, config: DeskConfig = DAILY): DeskContext => ({ env: { POLARITO_SPY_DESK: "1" }, makeLive: live(sc, config), store: createMemoryDeskStore() });
const post = (body: unknown) => new Request(`${BASE}/api/spy/ticket`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "www.polarito.com" }, body: JSON.stringify(body) });
const CALL_600 = "SPY271105C00600000";
const PUT_850 = "SPY271105P00850000";

describe("Analyze and the manual ticket follow the Daily gear", () => {
  it("Drive only Call, Reverse only Put, Neutral neither; the answer names the Daily timeframe", async () => {
    for (const [sc, gear, call, put] of [[DRIVE, "DRIVE", true, false], [REVERSE, "REVERSE", false, true], [D_NEUTRAL_M_DRIVE, "NEUTRAL", false, false]] as const) {
      const a = await buildAnalysis(makeDeps(sc), DAILY);
      assert.ok(a.ok);
      assert.equal(a.timeframe, "1D");
      assert.equal(a.timeframeName, "Daily");
      assert.equal(a.gear, gear);
      assert.deepEqual(a.allowed, { call, put });
      assert.equal(a.reading.timeframe, "1D");
      assert.equal(a.reading.isDecision, true);
    }
    const res = await handleAnalyze(new Request(`${BASE}/api/spy/analyze?ticker=SPY`), ctx(D_REVERSE_M_DRIVE));
    const j = (await res.json()) as { gear: string; timeframeName: string };
    assert.deepEqual([res.status, j.gear, j.timeframeName], [200, "REVERSE", "Daily"]);
  });
  it("server re-check: a Call against a Daily Reverse is refused COUNTER_POLARITY (it would pass on Monthly), nothing saved; the allowed side is recorded", async () => {
    const c = ctx(D_REVERSE_M_DRIVE);
    const bad = await handleTicket(post({ type: "call", symbol: CALL_600, acknowledgeDryRun: true, analyzedGear: "REVERSE" }), c);
    assert.equal(bad.status, 409);
    assert.equal(((await bad.json()) as { code: string }).code, "COUNTER_POLARITY");
    const saved = await c.store!.read();
    assert.ok(saved.ok && saved.state.position === null);
    const onMonthly = await handleTicket(post({ type: "call", symbol: CALL_600, acknowledgeDryRun: true, analyzedGear: "DRIVE" }), ctx(D_REVERSE_M_DRIVE, MONTHLY));
    assert.equal(onMonthly.status, 200);
    const ok = await handleTicket(post({ type: "put", symbol: PUT_850, acknowledgeDryRun: true, analyzedGear: "REVERSE" }), c);
    assert.equal(ok.status, 200);
    const after = await c.store!.read();
    assert.ok(after.ok && after.state.position?.type === "put" && after.state.position.decisionTimeframe === "1D");
  });
  it("a gear that moved since Analyze is refused GEAR_CHANGED", async () => {
    const res = await handleTicket(post({ type: "put", symbol: PUT_850, acknowledgeDryRun: true, analyzedGear: "NEUTRAL" }), ctx(D_REVERSE_M_DRIVE));
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "GEAR_CHANGED");
  });
  it("a Neutral Daily reading refuses a new buy on either side, NEUTRAL_NO_TRADE, nothing saved (even though Monthly says Drive)", async () => {
    for (const type of ["call", "put"] as const) {
      const c = ctx(D_NEUTRAL_M_DRIVE);
      const res = await handleTicket(post({ type, symbol: type === "call" ? CALL_600 : PUT_850, acknowledgeDryRun: true, analyzedGear: "NEUTRAL" }), c);
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { code: string }).code, "NEUTRAL_NO_TRADE");
      const saved = await c.store!.read();
      assert.ok(saved.ok && saved.state.position === null && saved.state.journal.length === 0);
    }
  });
  it("stale Daily data refuses the ticket (Justice)", async () => {
    const c = ctx({ daily: hist("2026-11-20", GREEN_UP) });
    c.makeLive = live({ daily: hist("2026-11-20", GREEN_UP) }, DAILY, { now: utc("2026-11-23T15:00:00Z") });
    const res = await handleTicket(post({ type: "call", symbol: CALL_600, acknowledgeDryRun: true }), c);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "DATA_UNAVAILABLE");
  });
});

/* ------------------------------------------------------------------ auto */

const SWITCH_ON = JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" });
const NEAREST = "2027-11-05";
function autoRig(sc: Scenario, o: { state?: DeskState; now?: Date; config?: DeskConfig } = {}) {
  const kv = createMemorySpyKv();
  kv.data.set(AUTO_SWITCH_KEY, { value: SWITCH_ON, expiresAt: null });
  const desk = createMemoryDeskStore(o.state);
  const deps = makeDeps(sc, o.now ? { now: o.now } : {});
  return { kv, desk, run: () => runAutoCycle(deps, o.config ?? DAILY, { desk, kv }) };
}
function heldState(type: "call" | "put", source: DeskPosition["source"], tf: DeskPosition["decisionTimeframe"], journalKinds: Array<{ kind: "auto-open" | "manual-open"; at: string }> = []): DeskState {
  const r = row(type, NEAREST, type === "call" ? 600 : 850);
  const position: DeskPosition = { type, symbol: r.symbol, expiration: NEAREST, strike: r.strike, quantity: 1, entryAt: "2026-11-02T20:00:00.000Z", entryAsk: r.ask, entryMid: r.mid, entryDelta: r.delta, deltaTier: "primary", fallbackReason: null, decisionTimeframe: tf, maxLossUsd: r.ask * 100, source };
  return { version: 1, position, journal: journalKinds.map((j) => ({ id: `${j.kind}-${j.at}`, at: j.at, kind: j.kind, symbol: r.symbol, type, strike: r.strike, expiration: NEAREST, delta: r.delta, costUsd: r.ask * 100, exitBid: null, pnlUsd: null, note: "earlier" })) };
}
const stateOf = async (desk: ReturnType<typeof createMemoryDeskStore>) => {
  const r = await desk.read();
  assert.ok(r.ok);
  return r.state;
};

describe("Auto with the Daily decider (practice record only)", () => {
  it("opens on a Daily Drive after the close, names the Daily reading in the log and the journal, and records the Daily timeframe", async () => {
    const r = autoRig(DRIVE);
    const out = await r.run();
    assert.equal(out.outcome, "opened");
    assert.match(out.message, /Daily reading Drive/);
    const st = await stateOf(r.desk);
    assert.deepEqual([st.position?.type, st.position?.source, st.position?.decisionTimeframe], ["call", "auto", "1D"]);
    assert.equal(st.journal[st.journal.length - 1].kind, "auto-open");
    assert.match(st.journal[st.journal.length - 1].note, /AUTO dry-run buy \(Daily reading Drive\)/);
    const log = await readLog(r.kv);
    assert.ok(log.ok && log.log.some((e) => e.outcome === "opened" && /Daily reading Drive/.test(e.message) && e.reading === "Drive"));
  });
  it("idempotent: a second run in the same session does nothing and writes nothing more", async () => {
    const r = autoRig(DRIVE);
    await r.run();
    const before = await stateOf(r.desk);
    const logBefore = await r.kv.get(AUTO_LOG_KEY);
    const again = await r.run();
    assert.equal(again.repeat, true);
    assert.equal(again.outcome, "skipped");
    assert.deepEqual(await stateOf(r.desk), before);
    assert.deepEqual(await r.kv.get(AUTO_LOG_KEY), logBefore);
  });
  it("the next day the Daily reading flips: it closes at the bid and opens the other side in the same run (this is the added churn)", async () => {
    const next = scen([["2026-11-02", N2], ["2026-11-03", { open: 101, close: 103, volume: 100 }], ["2026-11-04", { open: 103, close: 100, volume: 100 }]]);
    const state = heldState("call", "auto", "1D", [{ kind: "auto-open", at: "2026-11-03T21:35:00.000Z" }]);
    const r = autoRig(next, { state, now: utc("2026-11-04T21:30:00Z") });
    const out = await r.run();
    assert.equal(out.outcome, "closed-and-opened");
    assert.match(out.message, /Closed SPY\w+ at the bid[\s\S]*Opened 1 PUT/);
    const st = await stateOf(r.desk);
    assert.equal(st.position?.type, "put");
    assert.deepEqual(st.journal.slice(-2).map((j) => j.kind), ["auto-close", "auto-open"]);
  });
  it("one action per session holds: an Auto position opened today is not reversed today even if the Daily reading is opposite", async () => {
    const state = heldState("call", "auto", "1D", [{ kind: "auto-open", at: "2026-11-03T21:00:00.000Z" }]);
    const r = autoRig(REVERSE, { state });
    const out = await r.run();
    assert.equal(out.outcome, "no-action");
    assert.match(out.message, /Daily reading Reverse is opposite[\s\S]*does not reverse within one session/);
    assert.equal((await stateOf(r.desk)).position?.type, "call");
  });
  it("a manual action today makes Auto stand aside; a MANUAL position is never touched even when the Daily reading is opposite", async () => {
    const day = autoRig(REVERSE, { state: heldState("call", "manual", "1D", [{ kind: "manual-open", at: "2026-11-03T15:00:00.000Z" }]) });
    const a = await day.run();
    assert.equal(a.outcome, "no-action");
    assert.match(a.message, /acted by hand today/);
    const old = autoRig(REVERSE, { state: heldState("call", "manual", "1D") });
    const b = await old.run();
    assert.equal(b.outcome, "no-action");
    assert.match(b.message, /A MANUAL position/);
    assert.equal((await stateOf(old.desk)).position?.type, "call");
  });
  it("Neutral Daily leaves an Auto position alone (trader decides) even though Monthly says Drive", async () => {
    const r = autoRig(D_NEUTRAL_M_DRIVE, { state: heldState("put", "auto", "M") });
    const out = await r.run();
    assert.equal(out.outcome, "neutral");
    assert.match(out.message, /NEUTRAL: TRADER DECIDES\. The Daily reading Neutral/);
    assert.equal((await stateOf(r.desk)).position?.type, "put");
  });
  it("an Auto position opened earlier under Monthly (decisionTimeframe M) of the other side is managed by the Daily reading: closed and flipped on the first run that disagrees", async () => {
    const r = autoRig(DRIVE, { state: heldState("put", "auto", "M") });
    const out = await r.run();
    assert.equal(out.outcome, "closed-and-opened");
    const st = await stateOf(r.desk);
    assert.deepEqual([st.position?.type, st.position?.decisionTimeframe], ["call", "1D"]);
  });
  it("same side as the Daily reading: holds, whatever timeframe it was opened under", async () => {
    const r = autoRig(DRIVE, { state: heldState("call", "auto", "M") });
    const out = await r.run();
    assert.equal(out.outcome, "hold");
    assert.equal((await stateOf(r.desk)).position?.decisionTimeframe, "M");
  });
  it("never during the session: before 16:15 ET (09:45 with today's partial bar, 15:59) Auto does nothing and reads no option data", async () => {
    for (const now of ["2026-11-23T14:45:00Z", "2026-11-23T20:59:00Z", "2026-11-23T21:10:00Z"]) {
      const r = autoRig({ daily: hist("2026-11-23", GREEN_UP) }, { now: utc(now) });
      const out = await r.run();
      assert.equal(out.outcome, "skipped", now);
      assert.match(out.message, /has not closed yet/);
      assert.equal((await stateOf(r.desk)).position, null);
    }
    const final = autoRig({ daily: hist("2026-11-23", GREEN_UP) }, { now: utc("2026-11-23T21:30:00Z") });
    const out = await final.run();
    assert.notEqual(out.outcome, "skipped");
    assert.match(out.message, /^The Daily reading Drive says CALL/, "after 16:15 ET the final bar is read (the fixture's option dates then decide the rest)");
  });
  it("after the close a missing or stale daily bar is refused, never traded on", async () => {
    const r = autoRig({ daily: hist("2026-11-20", GREEN_UP) }, { now: utc("2026-11-23T21:30:00Z") });
    const out = await r.run();
    assert.equal(out.outcome, "refused");
    assert.match(out.message, /Data unavailable for the Daily polarity: stale data/);
    assert.equal((await stateOf(r.desk)).position, null);
  });
  it("Monthly stays selectable for Auto: with the Monthly decider the same data opens the Monthly side", async () => {
    const r = autoRig(D_NEUTRAL_M_DRIVE, { config: MONTHLY });
    const out = await r.run();
    assert.equal(out.outcome, "opened");
    assert.match(out.message, /Monthly reading Drive/);
    assert.equal((await stateOf(r.desk)).position?.decisionTimeframe, "M");
  });
});
