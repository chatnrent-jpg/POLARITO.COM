import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SpyDeskView, { type DeskViewProps } from "../src/components/spy/SpyDeskView";
import { TIMEFRAME_NAMES, computeContextReadings, computeDeskReadings, contextReadingKeys, isSelectableDeskTimeframe, wwvWindow } from "../src/lib/deskReadings";
import { LONG_TIMEFRAMES } from "../src/lib/longPolarity";
import { addCalendarDays, tradingDaysBetween } from "../src/lib/marketCalendar";
import type { Bar } from "../src/lib/polarity";
import { AUTO_SWITCH_KEY, runAutoCycle } from "../src/lib/spyAuto";
import { buildDeskSnapshot, deskDecision, parseDeskSnapshot, type DeskConfig } from "../src/lib/spyDesk";
import { LOADING_FRESHNESS } from "../src/lib/spyDeskData";
import { handleAnalyze, handleTicket, type DeskContext } from "../src/lib/spyDeskRoutes";
import { dailyStartFor } from "../src/lib/spyDeskLive";
import { createMemoryDeskStore } from "../src/lib/spyDeskStore";
import { NO_ANALYSIS } from "../src/lib/spyAnalyzer";
import { buildLiveSnapshot, mergeLive, parseLiveSnapshot } from "../src/lib/spyLive";
import { createMemorySpyKv } from "../src/lib/spyKv";
import { MONTHLY_PROFILE, WWV_PROFILE } from "../src/lib/spyProfile";
import { WWV_HISTORY_CALENDAR_DAYS } from "../src/lib/wwv";
import { T0, makeDeps, type Scenario } from "./helpers/spyDeskFixtures";
import { WWV_DRIVE } from "./helpers/wwvFixtures";

const WWV: DeskConfig = { timeframe: "D", liveBudget: 1000 };
const DAILY: DeskConfig = { timeframe: "1D", liveBudget: 1000 };
const utc = (iso: string) => new Date(iso);

type Day = { open: number; close: number; volume: number };
/** A full year of calm history (every close 100) to 2026-10-30, then the given sessions. */
function year(days: Array<[string, Day]>, calmEnd = "2026-10-30"): Bar[] {
  const daily: Bar[] = tradingDaysBetween("2025-11-03", calmEnd).map((date) => ({ date, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  for (const [date, d] of days) daily.push({ date, open: d.open, close: d.close, volume: d.volume, high: Math.max(d.open, d.close) + 0.1, low: Math.min(d.open, d.close) - 0.1 });
  return daily;
}
/** WWV says Reverse (red candle in a down wave) while Monthly/Quarterly/6-month/Yearly all say Drive. */
const WWV_REVERSE_PERIODS_DRIVE: Scenario = { daily: year([["2026-11-02", { open: 100, close: 102, volume: 100 }], ["2026-11-03", { open: 102, close: 101, volume: 100 }]]) };

const noop = () => undefined;
const props = (snapshot: Awaited<ReturnType<typeof buildDeskSnapshot>>, over: Partial<DeskViewProps> = {}): DeskViewProps => ({ profile: WWV_PROFILE, load: { status: "ready", snapshot }, busy: false, notice: null, ticket: { type: "call", symbol: null, ack: false }, close: { stage: "idle", ack: false, offerUnpriced: false }, autoUi: { ack: false }, fresh: { ...LOADING_FRESHNESS, state: "live", updatedAt: "2026-11-03T21:30:05.000Z", chainAt: "2026-11-03T21:30:00.000Z" }, analyzer: NO_ANALYSIS, onAnalyze: noop, onRefresh: noop, onAutoChange: noop, onSubmitAuto: noop, onTicketChange: noop, onSubmitTicket: noop, onCloseChange: noop, onSubmitClose: noop, ...over });
const html = (p: DeskViewProps) => renderToStaticMarkup(createElement(SpyDeskView, p)).replace(/<!-- -->/g, "");
const text = (out: string) => out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const tag = (out: string, id: string): string => out.match(new RegExp(`<[a-z0-9]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const KEYS = ["M", "Q", "H", "Y"];

describe("WWV desk: the four period readings are shown as context", () => {
  it("the snapshot carries M, Q, H, Y (none deciding) next to the one decision reading D", async () => {
    const s = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore());
    assert.deepEqual(s.readings.map((r) => [r.timeframe, r.isDecision]), [["D", true]]);
    assert.deepEqual(s.contextReadings?.map((r) => [r.timeframe, r.isDecision, r.status, r.label]), KEYS.map((k) => [k, false, "ok", "Drive"]));
    assert.equal(s.decision.action, "PUT");
    assert.match(s.decision.reason, /Daily, WWV/);
  });
  it("it is the same computation as /spy: identical readings for the same bars", async () => {
    const wwv = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore());
    const spy = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), DAILY, createMemoryDeskStore());
    assert.deepEqual(wwv.contextReadings, spy.readings.filter((r) => KEYS.includes(r.timeframe)));
    const c = wwv.contextReadings?.find((r) => r.timeframe === "M");
    assert.deepEqual([c?.open, c?.close, c?.previousClose, c?.netVolume, c?.match, c?.periodStart], [100, 101, 100, 200, "agree", "2026-11-01"]);
  });
  it("the /spy desk is unchanged: no context section data, five readings, Daily decides", async () => {
    const spy = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), DAILY, createMemoryDeskStore());
    assert.equal(spy.contextReadings, undefined);
    assert.deepEqual(spy.readings.map((r) => [r.timeframe, r.isDecision]), [["1D", true], ["M", false], ["Q", false], ["H", false], ["Y", false]]);
    assert.deepEqual(contextReadingKeys("1D"), []);
    assert.deepEqual(contextReadingKeys("M"), []);
    assert.equal(html(props(spy, { profile: MONTHLY_PROFILE })).includes('data-testid="context-readings"'), false);
  });
  it("the key D stays reserved for WWV: context keys are exactly M, Q, H, Y; D is not selectable; 1D is not shown on the WWV desk", async () => {
    assert.deepEqual([...contextReadingKeys("D")], KEYS);
    assert.deepEqual([...LONG_TIMEFRAMES], KEYS);
    assert.equal(isSelectableDeskTimeframe("D"), false);
    assert.equal(TIMEFRAME_NAMES.D, "Daily, WWV");
    const ctx = computeContextReadings(WWV_REVERSE_PERIODS_DRIVE.daily, T0, "D");
    assert.deepEqual(Object.keys(ctx), KEYS);
    assert.deepEqual(Object.keys(computeDeskReadings(WWV_REVERSE_PERIODS_DRIVE.daily, T0, "D")), ["D"]);
    const s = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore());
    assert.ok([...s.readings, ...(s.contextReadings ?? [])].every((r) => r.timeframe !== "1D"));
  });
});

describe("the context readings never change the WWV decision", () => {
  it("WWV decides on its own wave: Reverse -> PUT while all four period readings say Drive, and the decision equals the one made without them", async () => {
    const d = deskDecision(WWV_REVERSE_PERIODS_DRIVE.daily, T0, "D");
    assert.equal(d.status === "ok" && d.action, "PUT");
    const s = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore());
    assert.equal(s.decision.action, "PUT");
    assert.equal(s.enginePick.status === "contract" ? s.enginePick.contract.type : null, "put");
  });
  it("the WWV reading is identical on a year of history and on its own 200-day window (the longer history is only for the context)", () => {
    const full = WWV_REVERSE_PERIODS_DRIVE.daily;
    const window = full.filter((b) => b.date >= addCalendarDays("2026-11-03", -WWV_HISTORY_CALENDAR_DAYS));
    assert.ok(window.length < full.length);
    assert.deepEqual(computeDeskReadings(full, T0, "D"), computeDeskReadings(window, T0, "D"));
    assert.deepEqual(computeDeskReadings(WWV_DRIVE.daily, T0, "D"), computeDeskReadings(WWV_DRIVE.daily.filter(() => true), T0, "D"));
    assert.equal(wwvWindow(full, T0).length, window.length);
  });
  it("a bad old bar (outside the WWV window) makes the context unavailable but cannot touch the WWV decision", async () => {
    const bars = year([["2026-11-02", { open: 100, close: 102, volume: 100 }], ["2026-11-03", { open: 102, close: 101, volume: 100 }]]);
    bars[3] = { ...bars[3], high: 1, low: 500 };
    const s = await buildDeskSnapshot(makeDeps({ daily: bars }), WWV, createMemoryDeskStore());
    assert.equal(s.decision.action, "PUT");
    assert.ok(s.contextReadings?.every((r) => r.status === "unavailable" && /daily bars rejected/.test(r.reason ?? "")));
  });
  it("Auto on the WWV desk follows WWV only: it opens the WWV side (put) although the four context readings say Drive", async () => {
    const kv = createMemorySpyKv();
    kv.data.set(AUTO_SWITCH_KEY, { value: JSON.stringify({ auto: true, at: "2026-11-01T00:00:00.000Z" }), expiresAt: null });
    const desk = createMemoryDeskStore();
    const out = await runAutoCycle(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, { desk, kv });
    assert.equal(out.outcome, "opened");
    const st = await desk.read();
    assert.ok(st.ok && st.state.position?.type === "put" && st.state.position.decisionTimeframe === "D");
  });
  it("the ticket gate follows WWV only: Analyze says Reverse and a Call is refused COUNTER_POLARITY; the Put is allowed", async () => {
    const BASE = "https://www.polarito.com";
    const ctx: DeskContext = { env: { POLARITO_SPY_DESK: "1" }, makeLive: async () => ({ ok: true as const, deps: makeDeps(WWV_REVERSE_PERIODS_DRIVE), config: WWV }), store: createMemoryDeskStore() };
    const a = (await (await handleAnalyze(new Request(`${BASE}/api/spy-wwv/analyze?ticker=SPY`), ctx)).json()) as { gear: string; timeframe: string };
    assert.deepEqual([a.gear, a.timeframe], ["REVERSE", "D"]);
    const post = (type: string, symbol: string, gear: string) => new Request(`${BASE}/api/spy-wwv/ticket`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "www.polarito.com" }, body: JSON.stringify({ type, symbol, acknowledgeDryRun: true, analyzedGear: gear }) });
    const bad = await handleTicket(post("call", "SPY271105C00600000", "REVERSE"), ctx);
    assert.equal(bad.status, 409);
    assert.equal(((await bad.json()) as { code: string }).code, "COUNTER_POLARITY");
    assert.equal((await handleTicket(post("put", "SPY271105P00850000", "REVERSE"), ctx)).status, 200);
  });
});

describe("same stale-bar rules, same 5 s live refresh", () => {
  it("in-progress bar (Mon 09:45 ET): the context readings use the partial day and are labelled; after the close they are final", async () => {
    const bars = year([["2026-11-20", { open: 100, close: 102, volume: 100 }], ["2026-11-23", { open: 102, close: 101, volume: 100 }]], "2026-11-19");
    const early = await buildDeskSnapshot(makeDeps({ daily: bars }, { now: utc("2026-11-23T14:45:00Z") }), WWV, createMemoryDeskStore());
    assert.ok(early.contextReadings?.every((r) => r.status === "ok" && r.inProgress));
    const out = html(props(early));
    for (const k of KEYS) assert.match(out, new RegExp(`data-testid="in-progress-${k}"`));
    const closed = await buildDeskSnapshot(makeDeps({ daily: bars }, { now: utc("2026-11-23T21:30:00Z") }), WWV, createMemoryDeskStore());
    assert.ok(closed.contextReadings?.every((r) => r.status === "ok" && !r.inProgress));
  });
  it("stale bar (Mon 10:00 with Friday's bar as newest): WWV and all four context readings are unavailable with the stale reason", async () => {
    const bars = year([["2026-11-19", { open: 100, close: 102, volume: 100 }], ["2026-11-20", { open: 102, close: 101, volume: 100 }]], "2026-11-18");
    const s = await buildDeskSnapshot(makeDeps({ daily: bars }, { now: utc("2026-11-23T15:00:00Z") }), WWV, createMemoryDeskStore());
    assert.equal(s.decision.action, "DATA_UNAVAILABLE");
    assert.ok(s.contextReadings?.every((r) => r.status === "unavailable" && /stale data/.test(r.reason ?? "")));
    const out = html(props(s));
    assert.match(out, /data-testid="data-unavailable"/);
    assert.match(text(out), /Data unavailable/);
  });
  it("the light (5 s) snapshot carries them, passes its shape check, and the merge keeps the fresh ones", async () => {
    const live = await buildLiveSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore());
    assert.deepEqual(live.contextReadings?.map((r) => r.timeframe), KEYS);
    assert.deepEqual(live.readings.map((r) => r.timeframe), ["D"]);
    const parsed = parseLiveSnapshot(JSON.parse(JSON.stringify(live)));
    assert.ok(parsed.ok);
    const heavy = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore());
    const merged = mergeLive(heavy, parsed.snapshot);
    assert.deepEqual(merged.snapshot.contextReadings, heavy.contextReadings);
    const newer = { ...parsed.snapshot, contextReadings: parsed.snapshot.contextReadings?.map((r) => ({ ...r, close: 123 })) };
    assert.ok(mergeLive(heavy, newer).snapshot.contextReadings?.every((r) => r.close === 123));
    const monthly = await buildLiveSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), DAILY, createMemoryDeskStore());
    assert.equal(monthly.contextReadings, undefined);
  });
  it("shape checks: a malformed context reading is rejected, an absent one is accepted (older payloads)", async () => {
    const live = JSON.parse(JSON.stringify(await buildLiveSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore())));
    assert.ok(parseLiveSnapshot({ ...live, contextReadings: undefined }).ok);
    assert.equal(parseLiveSnapshot({ ...live, contextReadings: [{ timeframe: "M" }] }).ok, false);
    assert.equal(parseLiveSnapshot({ ...live, contextReadings: "x" }).ok, false);
    const heavy = JSON.parse(JSON.stringify(await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore())));
    assert.ok(parseDeskSnapshot(heavy).ok);
    assert.equal(parseDeskSnapshot({ ...heavy, contextReadings: [{ timeframe: "M" }] }).ok, false);
  });
  it("loading: WWV loads as far back as the period readings need (the monthly desk's window is unchanged)", () => {
    assert.equal(dailyStartFor(WWV_PROFILE, "2026-11-03"), dailyStartFor(MONTHLY_PROFILE, "2026-11-03"));
    assert.equal(dailyStartFor(WWV_PROFILE, "2026-01-05"), "2025-06-19");
    assert.equal(dailyStartFor(MONTHLY_PROFILE, "2026-11-03"), "2025-11-17");
  });
});

describe("the WWV page", () => {
  it("shows 'Four readings (period to date, SPY)' with Monthly, Quarterly, 6-month and Yearly cards like /spy, muted, below the WWV section, with the context-only note", async () => {
    const s = await buildDeskSnapshot(makeDeps(WWV_REVERSE_PERIODS_DRIVE), WWV, createMemoryDeskStore());
    const out = html(props(s));
    assert.match(text(out), /Decision \(Daily, WWV timeframe\)/);
    assert.match(tag(out, "decision-card"), /data-action="PUT"/);
    assert.ok(out.indexOf('data-testid="context-readings"') > out.indexOf('data-testid="wwv-table"'));
    assert.match(text(out), /Four readings \(period to date, SPY\)/);
    for (const [k, name] of [["M", "Monthly"], ["Q", "Quarterly"], ["H", "6-month"], ["Y", "Yearly"]]) {
      assert.match(tag(out, `reading-${k}`), /data-decides="false"/);
      const card = out.match(new RegExp(`<li[^>]*data-testid="reading-${k}"[\\s\\S]*?</li>`))?.[0] ?? "";
      const t = text(card);
      assert.match(t, new RegExp(`^ ?${name}`));
      assert.match(t, /Candle \(open to close\)\s*green \(100\.00 to 101\.00\)/i);
      assert.match(t, /Previous period close\s*100\.00/i);
      assert.match(t, /Raw net volume\s*\+[\d,]+ \(positive\)/i);
      assert.match(t, /Match\s*agree/i);
      assert.match(card, /data-gear="Drive"/);
      assert.match(t, /since 2026-\d\d-\d\d, as of/);
    }
    assert.doesNotMatch(out, /data-testid="decides-[MQHY]"/);
    assert.match(text(out), /Context only: on this desk the decision is the daily Weis Wave Volume above/);
    assert.match(out, /data-testid="wwv-direction"/);
  });
  it("existing WWV page parts are all still there", async () => {
    const s = await buildDeskSnapshot(makeDeps(WWV_DRIVE), WWV, createMemoryDeskStore());
    const out = html(props(s));
    assert.match(text(out), /SPY DESK WWV/);
    assert.match(text(out), /Daily Weis Wave Volume \(WWV, setting 1, SPY\)/);
    assert.match(out, /data-testid="wwv-volume"[^>]*>700</);
  });
});
