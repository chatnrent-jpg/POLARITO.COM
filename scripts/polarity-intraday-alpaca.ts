/**
 * READ-ONLY same-day check of the polarity gear on real Alpaca history (5-minute SIP bars by default).
 *
 *   npx tsx --env-file=<file with ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY> scripts/polarity-intraday-alpaca.ts \
 *     [--feed=sip|iex] [--start-year=2016] [--tickers=SPY,AAPL] [--out-dir=intraday-study-out]
 *
 * Question: if the live runner enters on TODAY's partial-day gear at 10:00 / 10:30 / 11:30 / 13:00 ET and is flat the
 * same day, does the gear beat buying the same stock at the same minute regardless of gear?
 *
 * Method (identical to scripts/polarity-intraday-check.ts, which used Yahoo):
 *  - Gear at entry time T = the app's own computePolaritySeries on the prior daily bars plus today's PARTIAL daily
 *    candle (open = first regular-session print, running high/low, close = last completed 5-minute bar, volume =
 *    cumulative). Only bars completed by T are used; nothing later leaks into the decision.
 *  - The engine's Noise Floor looks only at the last 20 daily bars, so the series is run on the last 19 prior bars plus
 *    the partial bar; a self-test at start-up proves this equals running the full history.
 *  - Entry price = close of the last completed bar at T. Exits: the 15:55 ET flatten price (the runner's default) and
 *    the 16:00 close. Nothing is held overnight.
 *  - Baselines: (1) every stock bought at that same T regardless of gear; (2) the same-day average of all stocks at T
 *    (strips out whole-market days). Standard errors are clustered by date.
 *  - Costs: 0 (gross), 4 and 10 basis points per round trip.
 *  - Breakdowns by calendar year and by regime (SPY above/below its 200-day average, SPY 20-day realised volatility),
 *    all labelled from information known before the session.
 *  - Also simulates the runner's own rule: first Drive from 10:00, sold when the gear leaves Drive, else at 15:55.
 *
 * Data access: Alpaca Market Data GET /v2/stocks/bars only (daily + 5Min). Credentials leave this process only as
 * request headers to data.alpaca.markets and are never printed. No broker/trading endpoint is called. --data-url exists
 * solely for local tests against a mock server and is refused unless it is http://127.0.0.1.
 */
import fs from "node:fs";
import path from "node:path";
import { computePolaritySeries, validateBars, type Bar } from "../src/lib/polarity";

const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const FEED = arg("feed", "sip").toLowerCase();
const START_YEAR = Number(arg("start-year", "2016"));
const OUT_DIR = arg("out-dir", "intraday-study-out");
const DATA_URL = arg("data-url", "https://data.alpaca.markets");
const END_OVERRIDE = arg("end", "");
const MIN_SESSIONS = Number(arg("min-sessions", "100"));
const DEFAULT_TICKERS =
  "SPY,QQQ,IWM,DIA,XLF,XLE,XLK,AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,AVGO,JPM,BAC,XOM,CVX,WMT,COST,HD,UNH,LLY,V,MA,KO,PEP,DIS,INTC,CSCO,ORCL,CRM,NFLX,PFE,ABBV,MRK";
const TICKERS = arg("tickers", DEFAULT_TICKERS).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);

const TIMES = [600, 630, 690, 780]; // 10:00, 10:30, 11:30, 13:00 ET
const FLAT_MIN = 955; // 15:55 ET: price = close of the 15:50 bar
const COSTS_BPS = [4, 10];
const STEP = 5;
const SESSION_START = 570;

if (!Number.isInteger(START_YEAR) || START_YEAR < 2016 || START_YEAR > 2100) throw new Error("--start-year must be 2016 or later");
if (FEED !== "sip" && FEED !== "iex") throw new Error("--feed must be sip or iex");
if (!/^https:\/\/data\.alpaca\.markets$/.test(DATA_URL) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(DATA_URL)) throw new Error("--data-url refused: only data.alpaca.markets or a local mock is allowed");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const fmtNy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function ny(iso: string): { date: string; minute: number } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(fmtNy.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/* --------------------------------- Alpaca ---------------------------------- */
type Raw = { t: string; o: number; h: number; l: number; c: number; v: number };
const isRaw = (r: unknown): r is Raw => {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Record<string, unknown>;
  return typeof x.t === "string" && [x.o, x.h, x.l, x.c, x.v].every((n) => typeof n === "number" && Number.isFinite(n));
};

async function fetchBars(symbol: string, timeframe: "1Day" | "5Min", start: string, end: string): Promise<Raw[]> {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) throw new Error("ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set.");
  const out: Raw[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 400; page++) {
    const url = new URL(`${DATA_URL}/v2/stocks/bars`);
    url.searchParams.set("symbols", symbol);
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("adjustment", "split");
    url.searchParams.set("feed", FEED);
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", "10000");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    type Page = { bars?: Record<string, unknown[]>; next_page_token?: string | null };
    let body = null as Page | null;
    for (let attempt = 0; attempt < 6 && body === null; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      } catch {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`${symbol}: Alpaca rejected the credentials or the "${FEED}" feed (HTTP ${res.status}). Try --feed=iex if the plan has no SIP history.`);
      if (!res.ok) throw new Error(`${symbol}: Alpaca returned HTTP ${res.status}.`);
      try {
        body = (await res.json()) as Page;
      } catch {
        throw new Error(`${symbol}: Alpaca returned invalid JSON.`);
      }
    }
    if (body === null) throw new Error(`${symbol}: no usable answer from Alpaca after 6 attempts.`);
    const rows = body.bars?.[symbol];
    if (Array.isArray(rows)) {
      for (const r of rows) {
        if (!isRaw(r)) throw new Error(`${symbol}: malformed bar from Alpaca; refusing to use the data.`);
        out.push(r);
      }
    }
    pageToken = body.next_page_token ?? null;
    if (!pageToken) return out;
    await sleep(350);
  }
  throw new Error(`${symbol}: too many pages; refusing to use partial history.`);
}

function toDaily(raw: Raw[]): Bar[] {
  const bars: Bar[] = [];
  let prev = "";
  for (const r of raw) {
    const n = ny(r.t);
    if (!n || n.date <= prev || r.v <= 0) continue;
    bars.push({ date: n.date, open: r.o, high: Math.max(r.h, r.o, r.c), low: Math.min(r.l, r.o, r.c), close: r.c, volume: r.v });
    prev = n.date;
  }
  validateBars(bars);
  return bars;
}

type IBar = { start: number; end: number; open: number; high: number; low: number; close: number; volume: number };
type Day = { date: string; bars: IBar[] };
function toDays(raw: Raw[]): Day[] {
  const byDate = new Map<string, IBar[]>();
  for (const r of raw) {
    const n = ny(r.t);
    if (!n || n.minute < SESSION_START || n.minute >= 960) continue;
    const b: IBar = { start: n.minute, end: n.minute + STEP, open: r.o, high: Math.max(r.h, r.o, r.c), low: Math.min(r.l, r.o, r.c), close: r.c, volume: Math.max(0, r.v) };
    const list = byDate.get(n.date);
    if (list) list.push(b);
    else byDate.set(n.date, [b]);
  }
  return [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, bars]) => ({ date, bars: bars.sort((x, y) => x.start - y.start) }));
}

const fullDay = (d: Day) => d.bars.length >= 70 && d.bars[0].start === SESSION_START && d.bars[d.bars.length - 1].start >= 950;

/* ---------------------------------- gear ----------------------------------- */
function partialAt(day: Day, atMinute: number, volScale: number): { bar: Bar; price: number } | null {
  const done = day.bars.filter((b) => b.end <= atMinute);
  if (done.length === 0 || done[0].start !== SESSION_START) return null;
  let high = -Infinity;
  let low = Infinity;
  let vol = 0;
  for (const b of done) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    vol += b.volume;
  }
  const last = done[done.length - 1];
  return { price: last.close, bar: { date: day.date, open: done[0].open, high, low, close: last.close, volume: vol * volScale } };
}

function gearOf(history19: readonly Bar[], p: Bar): { polarity: number; ready: boolean } {
  const s = computePolaritySeries([...history19, p]);
  const last = s[s.length - 1];
  return { polarity: last.polarity, ready: last.ready };
}

function selfTest(daily: Bar[]) {
  const picks = [40, 120, 300, 700, 1100, daily.length - 1].filter((i) => i > 40 && i < daily.length);
  for (const i of picks) {
    const full = computePolaritySeries(daily.slice(0, i + 1));
    const cut = computePolaritySeries(daily.slice(i - 19, i + 1));
    const a = full[full.length - 1];
    const b = cut[cut.length - 1];
    if (a.polarity !== b.polarity || a.ready !== b.ready || Math.abs((a.noiseFloor ?? 0) - (b.noiseFloor ?? 0)) > 1e-6 * Math.max(1, a.noiseFloor ?? 1)) {
      throw new Error("Self-test failed: a 20-bar slice does not reproduce the full-history gear. Refusing to continue.");
    }
  }
  return picks.length;
}

/* -------------------------------- statistics -------------------------------- */
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function clusterSe(vals: number[], dates: string[]): number {
  const n = vals.length;
  if (n < 2) return NaN;
  const m = mean(vals);
  const by = new Map<string, number>();
  for (let i = 0; i < n; i++) by.set(dates[i], (by.get(dates[i]) ?? 0) + (vals[i] - m));
  let ss = 0;
  for (const s of by.values()) ss += s * s;
  return Math.sqrt(ss) / n;
}

type Row = { date: string; r: number; baseAll: number; baseDay: number };
type Stat = {
  n: number; days: number; hit: number; meanPct: number; sePct: number;
  edgeAllPct: number; edgeAllT: number; edgeDayPct: number; edgeDayT: number;
  net4Pct: number; net10Pct: number; netHit4: number; netHit10: number;
};
function stat(rows: Row[]): Stat | null {
  const n = rows.length;
  if (n === 0) return null;
  const dates = rows.map((x) => x.date);
  const r = rows.map((x) => x.r);
  const m = mean(r);
  const se = clusterSe(r, dates);
  const eAll = r.map((x, i) => x - rows[i].baseAll);
  const eDay = r.map((x, i) => x - rows[i].baseDay);
  const seAll = clusterSe(eAll, dates);
  const seDay = clusterSe(eDay, dates);
  const c4 = COSTS_BPS[0] / 1e4;
  const c10 = COSTS_BPS[1] / 1e4;
  return {
    n, days: new Set(dates).size, hit: r.filter((x) => x > 0).length / n, meanPct: m * 100, sePct: se * 100,
    edgeAllPct: mean(eAll) * 100, edgeAllT: seAll > 0 ? mean(eAll) / seAll : NaN,
    edgeDayPct: mean(eDay) * 100, edgeDayT: seDay > 0 ? mean(eDay) / seDay : NaN,
    net4Pct: (m - c4) * 100, net10Pct: (m - c10) * 100,
    netHit4: r.filter((x) => x - c4 > 0).length / n, netHit10: r.filter((x) => x - c10 > 0).length / n,
  };
}

/* --------------------------------- the study -------------------------------- */
type Ev = { date: string; year: string; trend: string; vol: string; ticker: string; t: number; polarity: number; ready: boolean; rFlat: number; rClose: number; baseDayFlat: number; baseDayClose: number };
type Trade = { date: string; year: string; trend: string; vol: string; ticker: string; entry: number; exit: number; bySignal: boolean; rApp: number; rHold: number };

function regimeFor(spy: Bar[]): Map<string, { trend: string; vol: string }> {
  const out = new Map<string, { trend: string; vol: string }>();
  for (let i = 200; i < spy.length; i++) {
    let sum = 0;
    for (let k = i - 200; k < i; k++) sum += spy[k].close;
    const trend = spy[i - 1].close > sum / 200 ? "SPY above 200d avg" : "SPY below 200d avg";
    const rets: number[] = [];
    for (let k = i - 20; k < i; k++) rets.push(Math.log(spy[k].close / spy[k - 1].close));
    const mu = mean(rets);
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252);
    out.set(spy[i].date, { trend, vol: sd < 0.12 ? "calm (<12% vol)" : sd < 0.2 ? "normal (12-20%)" : "stormy (>20%)" });
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const end = END_OVERRIDE || new Date(Date.now() - 36 * 3600_000).toISOString();
  const dailyStart = `${START_YEAR - 1}-01-01T00:00:00Z`;
  const intraStart = `${START_YEAR}-01-01T00:00:00Z`;
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] ${m}`);

  log(`feed=${FEED} start-year=${START_YEAR} tickers=${TICKERS.length} data=${DATA_URL}`);
  const spyDaily = toDaily(await fetchBars("SPY", "1Day", `${START_YEAR - 2}-01-01T00:00:00Z`, end));
  const regimes = regimeFor(spyDaily);
  log(`SPY daily: ${spyDaily.length} bars, self-test points: ${selfTest(spyDaily)}`);

  const events: Ev[] = [];
  const trades: Trade[] = [];
  const ok: string[] = [];
  const failed: string[] = [];
  const volRatios: number[] = [];
  const perTicker: Array<{ ticker: string; sessions: number; first: string; last: string }> = [];
  const dateSet = new Set<string>();

  const tickerData: Array<{ ticker: string; daily: Bar[]; days: Day[] }> = [];
  for (const ticker of TICKERS) {
    try {
      const daily = ticker === "SPY" ? spyDaily : toDaily(await fetchBars(ticker, "1Day", dailyStart, end));
      const days = toDays(await fetchBars(ticker, "5Min", intraStart, end)).filter(fullDay);
      if (days.length < MIN_SESSIONS) throw new Error(`${ticker}: only ${days.length} usable sessions`);
      const idx = new Map(daily.map((b, i) => [b.date, i] as const));
      for (const d of days) {
        const i = idx.get(d.date);
        if (i !== undefined && daily[i].volume > 0) volRatios.push(d.bars.reduce((s, b) => s + b.volume, 0) / daily[i].volume);
      }
      tickerData.push({ ticker, daily, days });
      ok.push(ticker);
      perTicker.push({ ticker, sessions: days.length, first: days[0].date, last: days[days.length - 1].date });
      log(`${ticker}: ${days.length} sessions ${days[0].date}..${days[days.length - 1].date}`);
    } catch (e) {
      failed.push(e instanceof Error ? e.message.slice(0, 200) : `${ticker}: failed`);
      log(`SKIPPED ${ticker}: ${failed[failed.length - 1]}`);
    }
  }
  if (tickerData.length === 0) throw new Error("No ticker could be loaded. Nothing to report.");
  const medRatio = median(volRatios);
  const volScale = medRatio > 0.2 && medRatio < 5 ? 1 / medRatio : 1;
  log(`median (regular-session 5-min volume / daily volume) = ${medRatio.toFixed(3)}; partial volume scaled by ${volScale.toFixed(3)}`);

  for (const { ticker, daily, days } of tickerData) {
    const idx = new Map(daily.map((b, i) => [b.date, i] as const));
    for (const day of days) {
      const i = idx.get(day.date);
      const reg = regimes.get(day.date);
      if (i === undefined || i < 20 || !reg) continue;
      const history19 = daily.slice(i - 19, i);
      const flat = partialAt(day, FLAT_MIN, volScale);
      if (!flat) continue;
      const close = day.bars[day.bars.length - 1].close;
      dateSet.add(day.date);
      const year = day.date.slice(0, 4);
      for (const T of TIMES) {
        const p = partialAt(day, T, volScale);
        if (!p) continue;
        const g = gearOf(history19, p.bar);
        events.push({ date: day.date, year, trend: reg.trend, vol: reg.vol, ticker, t: T, polarity: g.polarity, ready: g.ready, rFlat: flat.price / p.price - 1, rClose: close / p.price - 1, baseDayFlat: 0, baseDayClose: 0 });
      }
      let entered: { minute: number; price: number } | null = null;
      for (let T = TIMES[0]; T < FLAT_MIN; T += STEP) {
        const p = partialAt(day, T, volScale);
        if (!p) continue;
        const g = gearOf(history19, p.bar);
        if (!entered) {
          if (g.ready && g.polarity === 1) entered = { minute: T, price: p.price };
          continue;
        }
        if (g.polarity !== 1) {
          trades.push({ date: day.date, year, trend: reg.trend, vol: reg.vol, ticker, entry: entered.minute, exit: T, bySignal: true, rApp: p.price / entered.price - 1, rHold: flat.price / entered.price - 1 });
          entered = null;
          break;
        }
      }
      if (entered) trades.push({ date: day.date, year, trend: reg.trend, vol: reg.vol, ticker, entry: entered.minute, exit: FLAT_MIN, bySignal: false, rApp: flat.price / entered.price - 1, rHold: flat.price / entered.price - 1 });
    }
    log(`${ticker}: processed`);
  }

  // Baselines per (time) overall and per (date, time) cross-section.
  const dayAgg = new Map<string, { f: number; c: number; n: number }>();
  const allAgg = new Map<number, { f: number; c: number; n: number }>();
  for (const e of events) {
    const k = `${e.date}|${e.t}`;
    const a = dayAgg.get(k) ?? { f: 0, c: 0, n: 0 };
    a.f += e.rFlat; a.c += e.rClose; a.n++;
    dayAgg.set(k, a);
    const b = allAgg.get(e.t) ?? { f: 0, c: 0, n: 0 };
    b.f += e.rFlat; b.c += e.rClose; b.n++;
    allAgg.set(e.t, b);
  }
  for (const e of events) {
    const a = dayAgg.get(`${e.date}|${e.t}`)!;
    e.baseDayFlat = a.f / a.n;
    e.baseDayClose = a.c / a.n;
  }
  const baseAll = (t: number, exit: "flat" | "close") => {
    const b = allAgg.get(t)!;
    return (exit === "flat" ? b.f : b.c) / b.n;
  };

  const rowsFor = (evs: Ev[], exit: "flat" | "close", t: number): Row[] =>
    evs.map((e) => ({ date: e.date, r: exit === "flat" ? e.rFlat : e.rClose, baseAll: baseAll(t, exit), baseDay: exit === "flat" ? e.baseDayFlat : e.baseDayClose }));

  const GEARS: Array<[string, (e: Ev) => boolean]> = [
    ["Drive", (e) => e.ready && e.polarity === 1],
    ["Reverse", (e) => e.ready && e.polarity === -1],
    ["Neutral", (e) => e.ready && e.polarity === 0],
    ["Baseline (any gear)", () => true],
  ];
  const byTime: Record<string, Record<string, Stat | null>> = {};
  for (const exit of ["flat", "close"] as const) {
    for (const T of TIMES) {
      const evs = events.filter((e) => e.t === T);
      byTime[`${exit}|${hhmm(T)}`] = Object.fromEntries(GEARS.map(([name, f]) => [name, stat(rowsFor(evs.filter(f), exit, T))]));
    }
  }
  const shareOf = (T: number, f: (e: Ev) => boolean) => {
    const evs = events.filter((e) => e.t === T);
    return evs.filter(f).length / Math.max(1, evs.length);
  };

  const years = [...new Set(events.map((e) => e.year))].sort();
  const trends = [...new Set(events.map((e) => e.trend))].sort();
  const vols = ["calm (<12% vol)", "normal (12-20%)", "stormy (>20%)"];
  type Slice = { label: string; pick: (e: Ev) => boolean };
  const yearSlices: Slice[] = years.map((y) => ({ label: y, pick: (e) => e.year === y }));
  const regimeSlices: Slice[] = [...trends.map((t) => ({ label: t, pick: (e: Ev) => e.trend === t })), ...vols.map((v) => ({ label: v, pick: (e: Ev) => e.vol === v }))];
  const sliceTable = (slices: Slice[]) =>
    Object.fromEntries(
      TIMES.map((T) => [
        hhmm(T),
        slices.map((s) => {
          const evs = events.filter((e) => e.t === T && s.pick(e));
          return { label: s.label, tickerDays: evs.length, Drive: stat(rowsFor(evs.filter(GEARS[0][1]), "flat", T)), Reverse: stat(rowsFor(evs.filter(GEARS[1][1]), "flat", T)), Baseline: stat(rowsFor(evs, "flat", T)) };
        }),
      ]),
    );

  const tradeStat = (ts: Trade[]) => {
    if (ts.length === 0) return null;
    const mk = (f: (t: Trade) => number): Row[] => ts.map((t) => ({ date: t.date, r: f(t), baseAll: 0, baseDay: 0 }));
    return {
      trades: ts.length,
      signalExitShare: ts.filter((t) => t.bySignal).length / ts.length,
      medianHoldMin: median(ts.map((t) => t.exit - t.entry)),
      appRule: stat(mk((t) => t.rApp)),
      sameEntryHoldTo1555: stat(mk((t) => t.rHold)),
    };
  };
  const appRule = { all: tradeStat(trades), byYear: Object.fromEntries(years.map((y) => [y, tradeStat(trades.filter((t) => t.year === y))])), byRegime: Object.fromEntries([...trends, ...vols].map((r) => [r, tradeStat(trades.filter((t) => t.trend === r || t.vol === r))])) };

  const sessions = [...dateSet].sort();
  const result = {
    generatedAt: new Date().toISOString(),
    feed: FEED,
    startYear: START_YEAR,
    tickersRequested: TICKERS,
    tickersLoaded: ok,
    tickersFailed: failed,
    sessions: sessions.length,
    firstSession: sessions[0],
    lastSession: sessions[sessions.length - 1],
    tickerDays: events.length / TIMES.length,
    medianRegularVolumeVsDailyVolume: medRatio,
    volumeScaleApplied: volScale,
    costsRoundTripBps: COSTS_BPS,
    shares: Object.fromEntries(TIMES.map((T) => [hhmm(T), Object.fromEntries(GEARS.slice(0, 3).map(([n, f]) => [n, shareOf(T, f)]))])),
    byTime,
    byYear: sliceTable(yearSlices),
    byRegime: sliceTable(regimeSlices),
    appRule,
    perTicker,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "polarity-intraday-alpaca.json"), JSON.stringify(result, null, 2));
  const md = render(result as unknown as Res);
  fs.writeFileSync(path.join(OUT_DIR, "polarity-intraday-alpaca.md"), md);
  console.log("\n" + md);
  log("done");
}

/* --------------------------------- rendering -------------------------------- */
type TradeShape = { trades: number; signalExitShare: number; medianHoldMin: number; appRule: Stat | null; sameEntryHoldTo1555: Stat | null } | null;
type SliceRow = { label: string; tickerDays: number; Drive: Stat | null; Reverse: Stat | null; Baseline: Stat | null };
type Res = {
  generatedAt: string; feed: string; tickersLoaded: string[]; tickersFailed: string[]; sessions: number; firstSession: string; lastSession: string; tickerDays: number;
  medianRegularVolumeVsDailyVolume: number; volumeScaleApplied: number;
  shares: Record<string, Record<string, number>>;
  byTime: Record<string, Record<string, Stat | null>>;
  byYear: Record<string, SliceRow[]>;
  byRegime: Record<string, SliceRow[]>;
  appRule: { all: TradeShape; byYear: Record<string, TradeShape>; byRegime: Record<string, TradeShape> };
};

const f = (x: number | undefined | null, d = 3) => (x === undefined || x === null || !Number.isFinite(x) ? "-" : x.toFixed(d));
const tt = (s: Stat | null | undefined, which: "edgeAllPct" | "edgeDayPct") => (!s || s.n < 30 ? "-" : `${f(s[which])} (t ${f(which === "edgeAllPct" ? s.edgeAllT : s.edgeDayT, 1)})`);
const pc = (x: number | undefined | null, d = 1) => (x === undefined || x === null || !Number.isFinite(x) ? "-" : `${(x * 100).toFixed(d)}%`);
const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function render(r: Res): string {
  const L: string[] = [];
  L.push(`# Polarity same-day check on Alpaca ${r.feed.toUpperCase()} 5-minute history`);
  L.push("");
  L.push(`Generated ${r.generatedAt}. READ-ONLY: market-data endpoint only, no orders, no secrets printed.`);
  L.push("");
  L.push(`- Sessions: ${r.sessions} (${r.firstSession} to ${r.lastSession}); stock-days: ${Math.round(r.tickerDays)}; tickers loaded: ${r.tickersLoaded.length} (${r.tickersLoaded.join(", ")})`);
  if (r.tickersFailed.length) L.push(`- Tickers skipped: ${r.tickersFailed.join("; ")}`);
  L.push(`- Partial-candle volume scale: ${f(r.volumeScaleApplied)} (median regular-session 5-min volume / daily volume = ${f(r.medianRegularVolumeVsDailyVolume)})`);
  L.push("- Gear = repo computePolaritySeries on prior daily bars + today's partial candle at the entry time. Entry price = last completed 5-min bar close. Exits: 15:55 ET flatten price and the 16:00 close. Costs: 0 / 4 / 10 bps round trip.");
  L.push("- Edge(all) = mean minus the same-time all-stocks mean. Edge(day) = mean minus the same-day all-stocks mean at that time (removes whole-market days). t = clustered by date. |t| below 2 is noise; \"-\" means fewer than 30 observations.");
  L.push("");
  for (const exit of ["flat", "close"] as const) {
    L.push(`## Entry time to ${exit === "flat" ? "15:55 ET flatten" : "16:00 close"}`);
    for (const key of Object.keys(r.byTime).filter((k) => k.startsWith(`${exit}|`))) {
      const T = key.split("|")[1];
      L.push("", `### Entry ${T} ET`);
      const rows = Object.entries(r.byTime[key]).map(([gear, s]) => {
        const sh = r.shares[T]?.[gear];
        return [gear, sh === undefined ? "" : pc(sh), s ? String(s.n) : "0", s ? pc(s.hit) : "-", s ? f(s.meanPct) : "-", gear.startsWith("Baseline") ? "-" : tt(s, "edgeAllPct"), gear.startsWith("Baseline") ? "-" : tt(s, "edgeDayPct"), s ? f(s.net4Pct) : "-", s ? f(s.net10Pct) : "-", s ? pc(s.netHit10) : "-"];
      });
      L.push(table(["Gear", "Share", "n", "Hit", "Mean %", "Edge(all) %", "Edge(day) %", "Net 4bps %", "Net 10bps %", "Hit net 10bps"], rows));
    }
    L.push("");
  }
  const sliceMd = (title: string, data: Res["byYear"]) => {
    L.push(`## ${title} (exit 15:55 ET; Drive long, Reverse for information)`);
    for (const [T, rows] of Object.entries(data)) {
      L.push("", `### Entry ${T} ET`);
      L.push(table(["Slice", "Stock-days", "Drive n", "Drive hit", "Drive mean %", "Drive edge(day) % (t)", "Drive net 4bps %", "Reverse n", "Reverse mean %", "Reverse edge(day) % (t)", "Baseline mean %"], rows.map((x) => [x.label, String(x.tickerDays), x.Drive ? String(x.Drive.n) : "0", pc(x.Drive?.hit), f(x.Drive?.meanPct), tt(x.Drive, "edgeDayPct"), f(x.Drive?.net4Pct), x.Reverse ? String(x.Reverse.n) : "0", f(x.Reverse?.meanPct), tt(x.Reverse, "edgeDayPct"), f(x.Baseline?.meanPct)])));
    }
    L.push("");
  };
  sliceMd("By year", r.byYear);
  sliceMd("By regime (known before the session)", r.byRegime);
  L.push("## The runner's own rule: first Drive from 10:00, sold when the gear leaves Drive, else 15:55 flatten");
  const ruleRows = (label: string, a: TradeShape) => [label, a ? String(a.trades) : "0", pc(a?.signalExitShare, 0), f(a?.medianHoldMin, 0), pc(a?.appRule?.hit), f(a?.appRule?.meanPct), f(a?.appRule?.net4Pct), f(a?.appRule?.net10Pct), f(a?.sameEntryHoldTo1555?.meanPct), a?.appRule && a.appRule.n >= 30 ? f(a.appRule.meanPct / a.appRule.sePct, 1) : "-"];
  L.push(table(["Slice", "Trades", "Sold by signal", "Median hold (min)", "Hit", "Mean %", "Net 4bps %", "Net 10bps %", "Same entries held to 15:55 mean %", "t (mean)"], [ruleRows("All", r.appRule.all), ...Object.entries(r.appRule.byYear).map(([k, v]) => ruleRows(k, v)), ...Object.entries(r.appRule.byRegime).map(([k, v]) => ruleRows(k, v))]));
  L.push("", "## Caveats", "- Survivorship: the tickers are liquid names that exist today. Entry at the last completed 5-minute bar's close ignores latency and spread; costs are a flat allowance.", "- The live app reads Alpaca's daily bar (default IEX feed unless ALPACA_DATA_FEED=sip); this study rebuilds the partial candle from regular-session 5-minute bars, so pre-market prints are not in it.", "- Many cells (time x gear x slice) are shown; a single |t| near 2 among dozens is expected by chance.");
  return L.join("\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
