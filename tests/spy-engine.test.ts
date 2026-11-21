import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { daysBetween } from "../src/lib/broker/options";
import { tradingDaysBetween } from "../src/lib/marketCalendar";
import { MIN_ABS_DELTA, MIN_DAYS_TO_EXPIRY, bsDelta, bsPrice, pickDeepItm, type ChainRow } from "../src/lib/optionsSelect";
import type { Bar } from "../src/lib/polarity";
import { EMPTY_STATE, parseEngineConfig, parseEngineState, runEngine, type EngineConfig, type EngineDeps, type EngineState } from "../src/lib/spyEngine";
import { renderEngineReport } from "../src/lib/spyEngineReport";
import type { SideReport } from "../src/lib/spyChain";
import type { OptionType } from "../src/lib/broker/options";

const SPOT = 690;
const occ = (exp: string, type: OptionType, strike: number) => `SPY${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${type === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

function row(type: OptionType, exp: string, strike: number, today: string): ChainRow {
  const years = daysBetween(today, exp) / 365;
  const mid = bsPrice(type, SPOT, strike, years, 0.25);
  const ask = Number((mid * 1.002).toFixed(2));
  const bid = Number((mid * 0.998).toFixed(2));
  return {
    symbol: occ(exp, type, strike), type, strike, expiration: exp, bid, ask, mid, spreadPct: (ask - bid) / mid, quoteAt: `${today}T20:00:00Z`,
    delta: bsDelta(type, SPOT, strike, years, 0.25), deltaSource: "black-scholes", iv: 0.25, ivSource: "solved",
    costAtAsk: ask * 100, costAtMid: mid * 100, intrinsicPerShare: 0, extrinsicPerShare: 0,
  };
}

function side(type: OptionType, today: string, listed: string[]): SideReport {
  const rows: ChainRow[] = [];
  for (const exp of listed) for (const k of type === "call" ? [450, 500, 550, 600] : [800, 850, 900, 1000]) rows.push(row(type, exp, k, today));
  const pick = pickDeepItm(rows, listed, type, today);
  return { type, listedExpirations: listed, pick, ladder: [], rowsBuilt: rows.length, rejected: {}, error: null };
}

type Day = { open: number; close: number; volume: number };
type Scenario = { daily: Bar[] };

/** Calm daily history to 2026-10-30 (every close exactly 100: the previous month's last close), then 2026-11-02 and 2026-11-03 as given. */
function bars(nov: [Day, Day]): Scenario {
  const daily: Bar[] = tradingDaysBetween("2025-11-03", "2026-10-30").map((date) => ({ date, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  const mk = (date: string, d: Day): Bar => ({ date, open: d.open, close: d.close, volume: d.volume, high: Math.max(d.open, d.close) + 0.1, low: Math.min(d.open, d.close) - 0.1 });
  daily.push(mk("2026-11-02", nov[0]), mk("2026-11-03", nov[1]));
  return { daily };
}

const DRIVE = bars([{ open: 100, close: 101, volume: 100 }, { open: 101, close: 103, volume: 100 }]);
const REVERSE = bars([{ open: 100, close: 98, volume: 100 }, { open: 98, close: 95, volume: 100 }]);
// green candle (open 95, close 99) but the close is below the previous month's close of 100: net volume negative, they disagree
const NEUTRAL = bars([{ open: 95, close: 96, volume: 300 }, { open: 96, close: 99, volume: 100 }]);
// close exactly equals the previous close: net volume exactly zero
const ZERO = bars([{ open: 98, close: 99, volume: 300 }, { open: 99, close: 100, volume: 100 }]);

const CFG: EngineConfig = { timeframe: "M", liveBudget: 1000 };
const T0 = new Date("2026-11-03T21:30:00Z");
const LISTED = ["2027-06-17", "2027-11-05", "2027-11-19", "2028-01-21"]; // 2027-11-05 is 367 days out, 2027-06-17 is far less

type Calls = { daily: number; spot: number; sides: OptionType[]; held: number };
function makeDeps(sc: Scenario, now: Date, opts: { calls?: Calls; listed?: string[]; spotFails?: boolean } = {}): EngineDeps {
  const calls = opts.calls ?? { daily: 0, spot: 0, sides: [], held: 0 };
  const today = "2026-11-03";
  return {
    now: () => now,
    loadDaily: async () => { calls.daily++; return { ok: true, value: sc.daily }; },
    readSpot: async () => { calls.spot++; return opts.spotFails ? { ok: false, code: "NETWORK", error: "down" } : { ok: true, value: { price: SPOT, at: now.toISOString(), feed: "iex" } }; },
    readSide: async (type) => { calls.sides.push(type); return side(type, today, opts.listed ?? LISTED); },
    readHeld: async (p) => { calls.held++; return row(p.type, p.expiration, p.strike, today); },
  };
}

const kinds = (r: { events: { kind: string }[] }) => r.events.map((e) => e.kind);

describe("decision follows the aligned reading only", () => {
  it("Drive -> CALL, bought from the >= 365-day, |delta| >= 0.80 contract", async () => {
    const r = await runEngine(makeDeps(DRIVE, T0), CFG, EMPTY_STATE);
    assert.equal(r.decision?.action, "CALL");
    assert.ok(kinds(r).includes("would-buy"));
    const p = r.state.position;
    assert.ok(p);
    assert.equal(p.type, "call");
    assert.equal(p.expiration, "2027-11-05"); // nearest listed expiry >= 365 days
    assert.ok(daysBetween("2026-11-03", p.expiration) >= MIN_DAYS_TO_EXPIRY);
    assert.ok(Math.abs(p.entryDelta) >= MIN_ABS_DELTA);
    assert.equal(p.maxLossUsd, p.entryAsk * 100);
    assert.equal(p.quantity, 1);
  });
  it("Reverse -> PUT", async () => {
    const r = await runEngine(makeDeps(REVERSE, T0), CFG, EMPTY_STATE);
    assert.equal(r.decision?.action, "PUT");
    assert.equal(r.state.position?.type, "put");
    assert.ok((r.state.position?.entryDelta ?? 0) <= -MIN_ABS_DELTA);
  });
  it("candle and net volume disagree -> Neutral -> STAND ASIDE, nothing bought, chain not even read", async () => {
    const calls: Calls = { daily: 0, spot: 0, sides: [], held: 0 };
    const r = await runEngine(makeDeps(NEUTRAL, T0, { calls }), CFG, EMPTY_STATE);
    assert.equal(r.readings?.M.polarity, 0);
    assert.equal(r.decision?.action, "STAND_ASIDE");
    assert.equal(r.state.position, null);
    assert.deepEqual(calls.sides, []);
    assert.ok(!kinds(r).includes("would-buy"));
  });
  it("no contract meets the rules: nothing is substituted", async () => {
    const r = await runEngine(makeDeps(DRIVE, T0, { listed: ["2027-06-17", "2027-09-17"] }), CFG, EMPTY_STATE);
    assert.equal(r.state.position, null);
    assert.ok(kinds(r).includes("no-contract"));
    assert.ok(!kinds(r).includes("would-buy"));
  });
  it("spot unreadable: no entry", async () => {
    const r = await runEngine(makeDeps(DRIVE, T0, { spotFails: true }), CFG, EMPTY_STATE);
    assert.equal(r.state.position, null);
    assert.ok(kinds(r).includes("no-contract"));
  });
});

describe("one position, flip rolls, Neutral = trader decides", () => {
  async function held(): Promise<EngineState> {
    return (await runEngine(makeDeps(DRIVE, T0), CFG, EMPTY_STATE)).state;
  }
  it("same side again holds the same contract", async () => {
    const s = await held();
    const calls: Calls = { daily: 0, spot: 0, sides: [], held: 0 };
    const r = await runEngine(makeDeps(DRIVE, new Date("2026-11-03T22:00:00Z"), { calls }), CFG, s);
    assert.equal(r.state.position?.symbol, s.position?.symbol);
    assert.equal(r.state.position?.entryAt, s.position?.entryAt);
    assert.deepEqual(calls.sides, []);
    assert.ok(kinds(r).includes("hold"));
  });
  it("Drive -> Reverse sells the call and buys a put (one position at a time)", async () => {
    const s = await held();
    const r = await runEngine(makeDeps(REVERSE, T0), CFG, s);
    assert.ok(kinds(r).includes("would-sell"));
    assert.ok(kinds(r).includes("would-buy"));
    assert.equal(r.state.position?.type, "put");
  });
  it("Neutral with a held position: no automatic exit, no entry, flagged TRADER DECIDES with the held quote", async () => {
    const s = await held();
    const calls: Calls = { daily: 0, spot: 0, sides: [], held: 0 };
    const r = await runEngine(makeDeps(NEUTRAL, T0, { calls }), CFG, s);
    assert.equal(r.decision?.action, "STAND_ASIDE");
    assert.equal(r.decision?.traderDecides, true);
    assert.equal(r.state.position?.symbol, s.position?.symbol);
    assert.ok(kinds(r).includes("trader-decides"));
    assert.ok(!kinds(r).includes("would-sell"));
    assert.ok(!kinds(r).includes("would-buy"));
    assert.deepEqual(calls.sides, []);
    const e = r.events.find((x) => x.kind === "trader-decides");
    assert.match(e?.message ?? "", /NEUTRAL: TRADER DECIDES/);
    assert.match(e?.message ?? "", /No automatic exit/);
    assert.equal(e?.data?.automatic, false);
    assert.equal(r.state.neutralSince, T0.toISOString());
  });
  it("Neutral with no position: flagged, no automatic entry", async () => {
    const r = await runEngine(makeDeps(NEUTRAL, T0), CFG, EMPTY_STATE);
    assert.equal(r.state.position, null);
    const e = r.events.find((x) => x.kind === "trader-decides");
    assert.match(e?.message ?? "", /no automatic entry/);
  });
  it("a Neutral spell keeps its start time, and ends when a clear reading returns", async () => {
    const s = await held();
    const first = await runEngine(makeDeps(NEUTRAL, T0), CFG, s);
    const later = new Date("2026-11-03T22:30:00Z");
    const second = await runEngine(makeDeps(NEUTRAL, later), CFG, first.state);
    assert.equal(second.state.neutralSince, T0.toISOString());
    assert.match(second.events.find((x) => x.kind === "trader-decides")?.message ?? "", /Neutral since 2026-11-03T21:30:00.000Z/);
    const back = await runEngine(makeDeps(DRIVE, new Date("2026-11-03T23:00:00Z")), CFG, second.state);
    assert.equal(back.state.neutralSince, null);
    assert.equal(back.state.position?.symbol, s.position?.symbol);
    assert.ok(kinds(back).includes("hold"));
  });
  it("Neutral then Reverse still rolls on the flip (Neutral itself never trades)", async () => {
    const s = await held();
    const neutral = await runEngine(makeDeps(NEUTRAL, T0), CFG, s);
    const r = await runEngine(makeDeps(REVERSE, new Date("2026-11-03T23:00:00Z")), CFG, neutral.state);
    assert.ok(kinds(r).includes("would-sell"));
    assert.equal(r.state.position?.type, "put");
    assert.equal(r.state.neutralSince, null);
  });
  it("logs every change of reading with timestamp, and not unchanged readings", async () => {
    const first = await runEngine(makeDeps(DRIVE, T0), CFG, EMPTY_STATE);
    assert.ok(!kinds(first).includes("reading-change")); // first sighting is not a change
    const t1 = new Date("2026-11-03T22:00:00Z");
    const second = await runEngine(makeDeps(NEUTRAL, t1), CFG, first.state);
    const changes = second.events.filter((e) => e.kind === "reading-change");
    assert.ok(changes.length >= 1);
    const m = changes.find((e) => e.data?.timeframe === "M");
    assert.ok(m);
    assert.equal(m.at, t1.toISOString());
    assert.equal(m.data?.from, 1);
    assert.equal(m.data?.to, 0);
    assert.equal(m.data?.agreement, "disagree");
    const third = await runEngine(makeDeps(NEUTRAL, new Date("2026-11-03T22:30:00Z")), CFG, second.state);
    assert.equal(third.events.filter((e) => e.kind === "reading-change").length, 0);
  });
});

describe("exact zero net volume is Neutral with an explicit flag, and the raw number is shown", () => {
  it("zero net volume: Neutral, flagged, no entry, no sign guessed", async () => {
    const calls: Calls = { daily: 0, spot: 0, sides: [], held: 0 };
    const r = await runEngine(makeDeps(ZERO, T0, { calls }), CFG, EMPTY_STATE);
    assert.equal(r.readings?.M.netVolume, 0);
    assert.equal(r.readings?.M.netFlag, "zero");
    assert.equal(r.readings?.M.polarity, 0);
    assert.equal(r.decision?.action, "STAND_ASIDE");
    assert.equal(r.decision?.traderDecides, true);
    assert.equal(r.state.position, null);
    assert.deepEqual(calls.sides, []);
    assert.match(r.decision?.reason ?? "", /ZERO NET VOLUME/);
    const e = r.events.find((x) => x.kind === "trader-decides");
    assert.match(e?.message ?? "", /exactly zero \[ZERO NET VOLUME\]/);
    assert.match(renderEngineReport(r, CFG), /\*\*ZERO NET VOLUME\*\*/);
  });
  it("the raw signed net volume is in the decision text, the events and the report", async () => {
    const r = await runEngine(makeDeps(REVERSE, T0), CFG, EMPTY_STATE);
    assert.equal(r.readings?.M.netVolume, -200);
    assert.match(r.decision?.reason ?? "", /net volume -200,/);
    const d = r.events.find((x) => x.kind === "decision");
    assert.equal(d?.data?.netVolume, -200);
    assert.equal(d?.data?.totalVolume, 200);
    assert.equal(d?.data?.previousClose, 100);
    assert.match(renderEngineReport(r, CFG), /-200 \(negative\)/);
  });
  it("the engine reads no 5-minute data: the dependencies have no intraday loader", async () => {
    const deps = makeDeps(DRIVE, T0);
    assert.equal("loadIntraday" in deps, false);
  });
});

describe("stale or missing data: data unavailable, no decision, nothing changes", () => {
  it("stale newest bar", async () => {
    const stale = { ...DRIVE, daily: DRIVE.daily.slice(0, -1) };
    const r = await runEngine(makeDeps(stale, T0), CFG, EMPTY_STATE);
    assert.equal(r.decision?.action, "DATA_UNAVAILABLE");
    assert.equal(r.state.position, null);
    assert.ok(kinds(r).includes("data-unavailable"));
  });
  it("a held position is left alone while data is unavailable", async () => {
    const s = (await runEngine(makeDeps(DRIVE, T0), CFG, EMPTY_STATE)).state;
    const r = await runEngine(makeDeps({ ...DRIVE, daily: DRIVE.daily.slice(0, -1) }, T0), CFG, s);
    assert.equal(r.decision?.action, "DATA_UNAVAILABLE");
    assert.equal(r.state.position?.symbol, s.position?.symbol);
    assert.ok(!kinds(r).includes("would-sell"));
  });
  it("missing volume", async () => {
    const zero = { ...DRIVE, daily: DRIVE.daily.map((b) => (b.date === "2026-11-03" ? { ...b, volume: 0 } : b)) };
    const r = await runEngine(makeDeps(zero, T0), CFG, EMPTY_STATE);
    assert.equal(r.decision?.action, "DATA_UNAVAILABLE");
  });
  it("the previous month's last close is missing: data unavailable, no sign guessed", async () => {
    const r = await runEngine(makeDeps({ daily: DRIVE.daily.filter((b) => b.date !== "2026-10-30") }, T0), CFG, EMPTY_STATE);
    assert.equal(r.decision?.action, "DATA_UNAVAILABLE");
    assert.match(r.decision?.reason ?? "", /previous period's last session/);
  });
  it("daily bars cannot be loaded", async () => {
    const deps = { ...makeDeps(DRIVE, T0), loadDaily: async () => ({ ok: false as const, code: "NETWORK" as const, error: "boom" }) };
    const r = await runEngine(deps, CFG, EMPTY_STATE);
    assert.equal(r.decision?.action, "DATA_UNAVAILABLE");
    assert.equal(r.ok, false);
  });
  it("a thrown error becomes an error event and leaves the state unchanged", async () => {
    const deps = { ...makeDeps(DRIVE, T0), readSpot: async () => { throw new Error("kaboom"); } };
    const s: EngineState = { version: 1, readings: {}, position: null, neutralSince: null };
    const r = await runEngine(deps, CFG, s);
    assert.equal(r.ok, false);
    assert.ok(kinds(r).includes("error"));
    assert.equal(r.state, s);
  });
});

describe("config, state file and report", () => {
  it("config defaults and validation", () => {
    const c = parseEngineConfig({});
    assert.ok(c.ok);
    assert.equal(c.config.timeframe, "M");
    assert.equal("onNeutral" in c.config, false);
    assert.equal("method" in c.config, false);
    for (const bad of [{ SPY_DECISION_TIMEFRAME: "1D" }, { SPY_DECISION_TIMEFRAME: "W" }, { SPY_ON_NEUTRAL: "exit" }, { SPY_ON_NEUTRAL: "hold" }, { SPY_NET_VOLUME_METHOD: "signed-intraday" }, { SPY_NET_VOLUME_METHOD: "daily-chart" }, { SPY_LIVE_BUDGET: "-5" }]) {
      assert.equal(parseEngineConfig(bad).ok, false, JSON.stringify(bad));
    }
    const e = parseEngineConfig({ SPY_ON_NEUTRAL: "MANUAL", SPY_DECISION_TIMEFRAME: "q" });
    assert.ok(e.ok && e.config.timeframe === "Q");
  });
  it("state round trip and rejection of malformed state", async () => {
    const r = await runEngine(makeDeps(DRIVE, T0), CFG, EMPTY_STATE);
    const parsed = parseEngineState(JSON.parse(JSON.stringify(r.state)));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.state, r.state);
    assert.equal(parseEngineState({ version: 2 }).ok, false);
    assert.equal(parseEngineState({ version: 1, readings: { D: { polarity: 1, since: "x" } } }).ok, false);
    assert.equal(parseEngineState({ version: 1, readings: {}, position: { type: "call" } }).ok, false);
  });
  it("the report shows candle, net volume and reading side by side with the as-of time", async () => {
    const r = await runEngine(makeDeps(NEUTRAL, T0), CFG, EMPTY_STATE);
    const text = renderEngineReport(r, CFG);
    assert.match(text, /\| Timeframe \| Candle \(open -> close\) \| Previous period close \| Net volume \(raw\) \| Flag \| Match \| Reading \|/);
    assert.match(text, /green \(95\.00 -> 99\.00\)/);
    assert.match(text, /\| 100\.00 \| -400 \(negative\)/);
    assert.match(text, /disagree/);
    assert.match(text, /\*\*Neutral\*\*/);
    assert.match(text, /NEUTRAL: TRADER DECIDES/);
    assert.match(text, new RegExp(T0.toISOString()));
    assert.match(text, /DRY RUN/);
  });
});

describe("no order can be sent from this path", () => {
  const files = ["src/lib/spyEngine.ts", "src/lib/spyBars.ts", "src/lib/spyConnect.ts", "src/lib/spyEngineReport.ts", "scripts/spy-options-engine.ts", ".github/workflows/spy-options-engine.yml"];
  it("no order endpoint, write verb or live-trading switch is used", () => {
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(src, /\/v2\/orders/, f);
      assert.doesNotMatch(src, /method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, f);
      assert.doesNotMatch(src, /process\.env\.POLARITO_LIVE_TRADING_ENABLED/, f);
      assert.doesNotMatch(src, /from ["'](@|\.\.?)\/(src\/)?lib\/broker\/(alpacaLive|alpacaPaper|liveConfig|execute)/, f);
      assert.doesNotMatch(src, /submitOrder|placeOrder|createOrder/, f);
    }
  });
});
