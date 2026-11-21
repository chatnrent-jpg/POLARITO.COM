/**
 * READ-ONLY study: does the long-timeframe polarity of SPY (month / quarter / 6 months / year) mirror and predict the
 * market, and what would a 1-year option riding it have done (Black-Scholes MODEL, not real quotes)?
 *
 *   npx tsx scripts/spy-monthly-study.ts [--symbol=SPY|^GSPC] [--out-dir=/tmp/spy-study]
 *
 * Keyless: Yahoo Finance public chart endpoint (daily bars, ^VIX, ^IRX). No secrets, no orders, nothing written to the repo.
 *
 * HOW THE READING IS COMPUTED (same as the app's chart, src/lib/chartBuckets.ts):
 *   - daily Noise Floor per day from the repo's computePolaritySeries (10% of the trailing 20-day average volume);
 *   - a period candle = open of its first day, close of its last day, high/low extremes, summed volume
 *     (src/lib/periodCandles.ts aggregatePeriods for month / quarter / year);
 *   - period Net Volume = the engine's netVolume(candle), period floor = SUM of its days' daily floors;
 *   - reading = gate(net, floor): Drive +1 / Reverse -1 / Neutral 0 (the engine's own functions).
 *   The 6-month candle is not in the app: it is built the same way (Jan-Jun, Jul-Dec). Start-up self-checks prove that
 *   this script's month / quarter / year readings equal the app's periodBucketsFor for many dates.
 *
 * NO LOOK-AHEAD: the state at a month end uses only data up to that day's close; the position is taken at the NEXT
 * trading day's open. Two modes: "completed" (state = the latest FINISHED candle of that timeframe) and "to-date" (state =
 * the still-forming candle of that timeframe as the live app would show it that day).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computePolaritySeries, gate, netVolume, type Bar, type DayResult } from "../src/lib/polarity";
import { aggregatePeriods, COVERAGE_SLACK_DAYS, addDays, type Period } from "../src/lib/periodCandles";
import { periodBucketsFor } from "../src/lib/chartBuckets";

const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const SYMBOL = arg("symbol", "SPY");
const OUT_DIR = arg("out-dir", "/tmp/spy-study");
const CACHE = path.join(os.tmpdir(), "polarito-spy-bars");
const TFS = ["M", "Q", "H", "Y"] as const;
type TF = (typeof TFS)[number];
const HORIZONS = [1, 3, 6, 12];
type Mode = "completed" | "todate";

/* -------------------------------- data -------------------------------- */

async function yahoo(symbol: string): Promise<{ ts: number[]; q: Record<string, (number | null)[]>; div?: Record<string, { amount: number; date: number }> }> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${symbol.replace(/\W/g, "_")}-${new Date().toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=-631152000&period2=1900000000&interval=1d&events=div`;
  let body: unknown = null;
  for (let attempt = 0; attempt < 4 && body === null; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      if (attempt === 3) throw new Error(`${symbol}: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }
  const r = (body as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, (number | null)[]>> }; events?: { dividends?: Record<string, { amount: number; date: number }> } }> } }).chart?.result?.[0];
  if (!r?.timestamp || !r.indicators?.quote?.[0]) throw new Error(`${symbol}: unexpected response shape`);
  const out = { ts: r.timestamp, q: r.indicators.quote[0], div: r.events?.dividends };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

const utcDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

async function loadBars(symbol: string): Promise<{ bars: Bar[]; divs: Array<{ date: string; amount: number }> }> {
  const raw = await yahoo(symbol);
  const bars: Bar[] = [];
  let prev = "";
  for (let i = 0; i < raw.ts.length; i++) {
    const [o, h, l, c, v] = [raw.q.open[i], raw.q.high[i], raw.q.low[i], raw.q.close[i], raw.q.volume[i]];
    if (o == null || h == null || l == null || c == null || v == null || v <= 0 || o <= 0) continue;
    const date = utcDate(raw.ts[i]);
    if (date <= prev) continue;
    bars.push({ date, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: v });
    prev = date;
  }
  const divs = Object.values(raw.div ?? {}).map((d) => ({ date: utcDate(d.date), amount: d.amount })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { bars, divs };
}

async function loadLevel(symbol: string): Promise<Map<string, number>> {
  const raw = await yahoo(symbol);
  const m = new Map<string, number>();
  for (let i = 0; i < raw.ts.length; i++) {
    const c = raw.q.close[i];
    if (c != null && Number.isFinite(c)) m.set(utcDate(raw.ts[i]), c);
  }
  return m;
}

/* ------------------------------ candles ------------------------------- */
type Candle = { key: string; end: string; dates: string[]; i0: number; i1: number; open: number; high: number; low: number; close: number; volume: number; floor: number | null; polarity: number; covered: boolean; kind: "green" | "red" | "flat" };

const pad2 = (n: number) => String(n).padStart(2, "0");
function keyFor(date: string, tf: TF): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  switch (tf) {
    case "M": return `${y}-${pad2(m)}-01`;
    case "Q": return `${y}-${pad2(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
    case "H": return `${y}-${m <= 6 ? "01" : "07"}-01`;
    case "Y": return `${y}-01-01`;
  }
}

function candleOf(bars: readonly Bar[], floorByDate: Map<string, number | null>, i0: number, i1: number, key: string, firstLoaded: string): Candle {
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let floorSum = 0;
  let allReady = true;
  for (let i = i0; i <= i1; i++) {
    const b = bars[i];
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
    const f = floorByDate.get(b.date) ?? null;
    if (f === null) allReady = false;
    else floorSum += f;
  }
  const bar: Bar = { date: bars[i1].date, open: bars[i0].open, high, low, close: bars[i1].close, volume };
  const floor = allReady ? floorSum : null;
  const covered = firstLoaded <= addDays(key, COVERAGE_SLACK_DAYS);
  const net = netVolume(bar);
  return {
    key, end: bars[i1].date, dates: [], i0, i1, open: bar.open, high, low, close: bar.close, volume, floor,
    polarity: floor === null ? 0 : gate(net, floor), covered,
    kind: bar.close > bar.open ? "green" : bar.close < bar.open ? "red" : "flat",
  };
}

function allCandles(bars: readonly Bar[], results: readonly DayResult[], tf: TF): Candle[] {
  const floorByDate = new Map(results.map((r) => [r.date, r.noiseFloor] as const));
  const out: Candle[] = [];
  let start = 0;
  for (let i = 1; i <= bars.length; i++) {
    if (i === bars.length || keyFor(bars[i].date, tf) !== keyFor(bars[start].date, tf)) {
      out.push(candleOf(bars, floorByDate, start, i - 1, keyFor(bars[start].date, tf), bars[0].date));
      start = i;
    }
  }
  return out;
}

/** Candle of timeframe tf that contains day index i, using only days <= i (what the live app sees at i). */
function candleToDate(bars: readonly Bar[], floorByDate: Map<string, number | null>, i: number, tf: TF): Candle {
  const key = keyFor(bars[i].date, tf);
  let s = i;
  while (s > 0 && keyFor(bars[s - 1].date, tf) === key) s--;
  return candleOf(bars, floorByDate, s, i, key, bars[0].date);
}

/* ----------------------------- self checks ---------------------------- */
function selfCheck(bars: readonly Bar[], results: readonly DayResult[]) {
  const floorByDate = new Map(results.map((r) => [r.date, r.noiseFloor] as const));
  const modes: Array<[TF, Period, "1M" | "3M" | "1Y"]> = [["M", "month", "1M"], ["Q", "quarter", "3M"], ["Y", "year", "1Y"]];
  let checked = 0;
  for (const [tf, period, frame] of modes) {
    const repo = aggregatePeriods(bars, period, bars[bars.length - 1].date);
    const mine = allCandles(bars, results, tf);
    if (repo.length !== mine.length) throw new Error(`Self-check failed: ${tf} candle count differs from the app's aggregatePeriods.`);
    for (let k = 0; k < repo.length; k++) {
      const a = repo[k];
      const b = mine[k];
      if (a.key !== b.key || a.open !== b.open || a.close !== b.close || a.high !== b.high || a.low !== b.low || a.volume !== b.volume) throw new Error(`Self-check failed: ${tf} candle ${a.key} differs from the app's.`);
    }
    const step = Math.max(1, Math.floor(bars.length / 60));
    for (let i = 300; i < bars.length; i += step) {
      const truncated = bars.slice(0, i + 1);
      const res = computePolaritySeries(truncated);
      const live = periodBucketsFor(truncated, res, frame);
      const mine2 = candleToDate(bars, floorByDate, i, tf);
      if (live.length === 0) continue;
      if (live[0].polarity !== mine2.polarity) throw new Error(`Self-check failed: ${tf} reading at ${bars[i].date} differs from the app's periodBucketsFor.`);
      checked++;
    }
  }
  return checked;
}

/* ------------------------------- stats -------------------------------- */
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** OLS slope of y on a 0/1 dummy with Newey-West (Bartlett) standard error, lag L. Returns {diff, t}. */
function nwDiff(y: number[], d: number[], lag: number): { diff: number; t: number } {
  const n = y.length;
  const my = mean(y);
  const md = mean(d);
  let sdd = 0;
  let sdy = 0;
  for (let i = 0; i < n; i++) {
    sdd += (d[i] - md) ** 2;
    sdy += (d[i] - md) * (y[i] - my);
  }
  if (sdd === 0) return { diff: NaN, t: NaN };
  const b = sdy / sdd;
  const a = my - b * md;
  const u = y.map((yy, i) => (d[i] - md) * (yy - a - b * d[i]));
  let s = u.reduce((acc, x) => acc + x * x, 0);
  for (let l = 1; l <= lag; l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += u[i] * u[i - l];
    s += 2 * (1 - l / (lag + 1)) * g;
  }
  const se = Math.sqrt(Math.max(s, 0)) / sdd;
  return { diff: b, t: se > 0 ? b / se : NaN };
}

/* ------------------------- Black-Scholes (model) ----------------------- */
const N = (x: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
export function bs(type: "call" | "put", S: number, K: number, T: number, r: number, q: number, sigma: number): number {
  if (T <= 0) return Math.max(type === "call" ? S - K : K - S, 0);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / v;
  const d2 = d1 - v;
  return type === "call" ? S * Math.exp(-q * T) * N(d1) - K * Math.exp(-r * T) * N(d2) : K * Math.exp(-r * T) * N(-d2) - S * Math.exp(-q * T) * N(-d1);
}

/* ------------------------------- the study ----------------------------- */
type State = number | null; // 1 Drive, -1 Reverse, 0 Neutral, null not available
const ch = (s: State) => (s === 1 ? "D" : s === -1 ? "R" : s === 0 ? "N" : "-");

async function main() {
  const { bars, divs } = await loadBars(SYMBOL);
  const vix = await loadLevel("^VIX");
  const irx = await loadLevel("^IRX");
  const results = computePolaritySeries(bars);
  const floorByDate = new Map(results.map((r) => [r.date, r.noiseFloor] as const));
  const checked = selfCheck(bars, results);
  console.log(`${SYMBOL}: ${bars.length} daily bars ${bars[0].date}..${bars[bars.length - 1].date}; self-check points: ${checked}`);

  // Month grid.
  const monthStartIdx: number[] = [];
  const monthEndIdx: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0 || bars[i].date.slice(0, 7) !== bars[i - 1].date.slice(0, 7)) monthStartIdx.push(i);
    if (i === bars.length - 1 || bars[i].date.slice(0, 7) !== bars[i + 1].date.slice(0, 7)) monthEndIdx.push(i);
  }
  const M = monthEndIdx.length;

  // State series on the month-end grid. completed: latest finished candle; todate: forming candle.
  const candles: Record<TF, Candle[]> = { M: [], Q: [], H: [], Y: [] };
  for (const tf of TFS) candles[tf] = allCandles(bars, results, tf);
  const state: Record<Mode, Record<TF, State[]>> = { completed: { M: [], Q: [], H: [], Y: [] }, todate: { M: [], Q: [], H: [], Y: [] } };
  for (let k = 0; k < M; k++) {
    const i = monthEndIdx[k];
    for (const tf of TFS) {
      const td = candleToDate(bars, floorByDate, i, tf);
      state.todate[tf][k] = td.covered && td.floor !== null ? td.polarity : null;
      // completed: the candle containing i is finished iff i is the last day of its period (the candle's last day).
      const idxInList = candles[tf].findIndex((c) => c.key === td.key);
      const finished = candles[tf][idxInList].i1 === i && (tf === "M" || keyFor(bars[Math.min(i + 1, bars.length - 1)].date, tf) !== td.key) && i < bars.length - 1;
      let j = finished ? idxInList : idxInList - 1;
      // the latest completed candle must also be covered with a full floor
      while (j >= 0 && !(candles[tf][j].covered && candles[tf][j].floor !== null)) j--;
      state.completed[tf][k] = j >= 0 && (candles[tf][j].covered && candles[tf][j].floor !== null) ? candles[tf][j].polarity : null;
    }
  }

  const open = (k: number) => bars[monthStartIdx[k]].open; // open of month k (first trading day)
  const common = (() => {
    let k0 = 0;
    for (let k = 0; k < M; k++) {
      if (TFS.every((tf) => state.completed[tf][k] !== null)) {
        k0 = k;
        break;
      }
    }
    return k0;
  })();

  // Forward-return statistics.
  type Cell = { n: number; mean: number; hit: number; median: number };
  const cellOf = (v: number[]): Cell => ({ n: v.length, mean: mean(v), hit: v.filter((x) => x > 0).length / Math.max(1, v.length), median: median(v) });
  const fwd = (k: number, h: number): number | null => {
    const e = k + 1;
    const x = e + h;
    if (x >= M) return null; // exit open must be the open of a month that exists (the running month's open is known)
    return open(x) / open(e) - 1;
  };
  const stats: Record<string, unknown> = {};
  for (const mode of ["completed", "todate"] as Mode[]) {
    for (const tf of TFS) {
      for (const h of HORIZONS) {
        const ys: number[] = [];
        const gs: State[] = [];
        for (let k = common; k < M - 1; k++) {
          const r = fwd(k, h);
          const g = state[mode][tf][k];
          if (r === null || g === null) continue;
          ys.push(r);
          gs.push(g);
        }
        const pick = (p: number) => ys.filter((_, i) => gs[i] === p);
        const dr = ys.map((y, i) => ({ y, g: gs[i] })).filter((x) => x.g === 1 || x.g === -1);
        const nw = nwDiff(dr.map((x) => x.y), dr.map((x) => (x.g === 1 ? 1 : 0)), h);
        stats[`${mode}|${tf}|${h}`] = { all: cellOf(ys), drive: cellOf(pick(1)), reverse: cellOf(pick(-1)), neutral: cellOf(pick(0)), driveMinusReverse: nw.diff, t: nw.t };
      }
    }
  }

  // Flips and spells (state changes on the month-end grid).
  type Spell = { tf: TF; mode: Mode; state: number; signalDate: string; enterDate: string; exitDate: string | null; months: number; spyReturn: number; enterIdx: number; exitIdx: number };
  const spells: Spell[] = [];
  const flipCounts: Record<string, { flips: number; years: number; driveShare: number; reverseShare: number; neutralShare: number; medianSpellMonths: number }> = {};
  for (const mode of ["completed", "todate"] as Mode[]) {
    for (const tf of TFS) {
      const s = state[mode][tf];
      let cur: number | null = null;
      const mine: Spell[] = [];
      for (let k = common; k < M; k++) {
        const g = s[k];
        if (g === null) continue;
        if (g !== cur) {
          if (cur !== null) {
            const sp = mine[mine.length - 1];
            sp.exitIdx = monthStartIdx[k + 1] ?? bars.length - 1;
            sp.exitDate = k + 1 < M ? bars[monthStartIdx[k + 1]].date : null;
          }
          const enterIdx = monthStartIdx[k + 1] ?? bars.length - 1;
          mine.push({ tf, mode, state: g, signalDate: bars[monthEndIdx[k]].date, enterDate: k + 1 < M ? bars[monthStartIdx[k + 1]].date : "pending", exitDate: null, months: 0, spyReturn: NaN, enterIdx, exitIdx: -1 });
          cur = g;
        }
      }
      for (const sp of mine) {
        const exitIdx = sp.exitIdx === -1 ? bars.length - 1 : sp.exitIdx;
        const exitPrice = sp.exitIdx === -1 ? bars[bars.length - 1].close : bars[exitIdx].open;
        sp.spyReturn = sp.enterDate === "pending" ? NaN : exitPrice / bars[sp.enterIdx].open - 1;
        sp.months = sp.enterDate === "pending" ? 0 : (exitIdx - sp.enterIdx) / 21;
        sp.exitIdx = exitIdx;
        spells.push(sp);
      }
      const vals = s.slice(common).filter((x): x is number => x !== null);
      const years = vals.length / 12;
      const flips = Math.max(0, mine.length - 1);
      const done = mine.filter((x) => x.exitDate !== null);
      flipCounts[`${mode}|${tf}`] = {
        flips, years,
        driveShare: vals.filter((x) => x === 1).length / vals.length,
        reverseShare: vals.filter((x) => x === -1).length / vals.length,
        neutralShare: vals.filter((x) => x === 0).length / vals.length,
        medianSpellMonths: median(done.map((x) => x.months)),
      };
    }
  }

  // Strategies on the monthly grid (price returns, open to open, no dividends, no costs).
  const strat = (mode: Mode, tf: TF, rev: "cash" | "short") => {
    let eq = 1;
    let peak = 1;
    let mdd = 0;
    let inMkt = 0;
    let months = 0;
    let switches = 0;
    let prevPos = 0;
    let bh = 1;
    let bhPeak = 1;
    let bhMdd = 0;
    for (let k = common; k < M - 2; k++) {
      const g = state[mode][tf][k];
      const r = open(k + 2) / open(k + 1) - 1;
      const pos = g === 1 ? 1 : g === -1 ? (rev === "short" ? -1 : 0) : 0;
      if (pos !== prevPos) switches++;
      prevPos = pos;
      eq *= 1 + pos * r;
      peak = Math.max(peak, eq);
      mdd = Math.min(mdd, eq / peak - 1);
      bh *= 1 + r;
      bhPeak = Math.max(bhPeak, bh);
      bhMdd = Math.min(bhMdd, bh / bhPeak - 1);
      if (pos !== 0) inMkt++;
      months++;
    }
    const years = months / 12;
    return { cagr: Math.pow(eq, 1 / years) - 1, total: eq - 1, maxDD: mdd, timeInMarket: inMkt / months, switches, bhCagr: Math.pow(bh, 1 / years) - 1, bhTotal: bh - 1, bhMaxDD: bhMdd, years };
  };
  const strategies: Record<string, ReturnType<typeof strat>> = {};
  for (const mode of ["completed", "todate"] as Mode[]) for (const tf of TFS) for (const rev of ["cash", "short"] as const) strategies[`${mode}|${tf}|${rev}`] = strat(mode, tf, rev);

  // Modelled 1-year option along each spell (calls on Drive, puts on Reverse), rolled when 6 months remain.
  const rateAt = (date: string) => {
    for (let d = date, n = 0; n < 10; n++, d = addDays(d, -1)) {
      const v = irx.get(d);
      if (v !== undefined) return v / 100;
    }
    return 0.03;
  };
  const volAt = (date: string) => {
    for (let d = date, n = 0; n < 10; n++, d = addDays(d, -1)) {
      const v = vix.get(d);
      if (v !== undefined) return v / 100;
    }
    return 0.2;
  };
  const divYield = (i: number) => {
    const to = bars[i].date;
    const from = addDays(to, -365);
    const sum = divs.filter((d) => d.date > from && d.date <= to).reduce((s, d) => s + d.amount, 0);
    return sum > 0 ? sum / bars[i].close : SYMBOL === "SPY" ? 0.018 : 0.018;
  };
  const SPREAD_HAIRCUT = 0.02; // 2% of premium lost to bid/ask per round trip (rough for SPY LEAPS)
  const optionLeg = (type: "call" | "put", moneyness: number, i0: number, i1: number) => {
    // one leg: buy 1y option at open of i0, sell at open of i1 (<= ~6 months later)
    const S0 = bars[i0].open;
    const K = type === "call" ? S0 * (1 + moneyness) : S0 * (1 - moneyness);
    const sig0 = volAt(bars[i0 - 1]?.date ?? bars[i0].date);
    const r0 = rateAt(bars[i0].date);
    const q0 = divYield(Math.max(0, i0 - 1));
    const prem = bs(type, S0, K, 1, r0, q0, sig0);
    const S1 = bars[i1].open;
    const T1 = Math.max(0, 1 - (i1 - i0) / 252);
    const sig1 = volAt(bars[i1 - 1]?.date ?? bars[i1].date);
    const val = bs(type, S1, K, T1, rateAt(bars[i1].date), divYield(Math.max(0, i1 - 1)), sig1);
    return { prem, ret: (val * (1 - SPREAD_HAIRCUT)) / prem - 1, premPctOfSpot: prem / S0 };
  };
  const optionSpell = (sp: Spell, moneyness: number) => {
    if (sp.state === 0 || sp.enterDate === "pending") return null;
    const type = sp.state === 1 ? "call" : "put";
    const legs: number[] = [];
    let i = sp.enterIdx;
    while (i < sp.exitIdx) {
      const j = Math.min(sp.exitIdx, i + 126);
      legs.push(optionLeg(type, moneyness, i, j).ret);
      i = j;
    }
    return { legs, avgLeg: mean(legs), sum: legs.reduce((a, b) => a + b, 0) };
  };
  const spellRows = spells.map((sp) => ({ ...sp, atm: optionSpell(sp, 0), otm10: optionSpell(sp, 0.1), otm20: optionSpell(sp, 0.2) }));

  // One position at a time, sizing = a fixed fraction of current equity spent on premium at each leg (rest in cash, 0%).
  const MONEY = [["atm", 0], ["otm10", 0.1], ["otm20", 0.2]] as const;
  const equitySim: Record<string, { final: number; cagr: number; maxDD: number; legs: number; worstLeg: number; winRate: number }> = {};
  for (const mode of ["completed", "todate"] as Mode[]) {
    for (const tf of TFS) {
      const seq = spellRows.filter((x) => x.mode === mode && x.tf === tf && x.state !== 0 && x.enterDate !== "pending").sort((x, y) => x.enterIdx - y.enterIdx);
      if (seq.length === 0) continue;
      const years = (bars[seq[seq.length - 1].exitIdx].date > bars[seq[0].enterIdx].date ? (seq[seq.length - 1].exitIdx - seq[0].enterIdx) / 252 : 1) || 1;
      for (const [name] of MONEY) {
        const legsAll = seq.flatMap((x) => (x[name]?.legs ?? []));
        for (const f of [1, 0.5, 0.2, 0.1]) {
          let eq = 1;
          let peak = 1;
          let mdd = 0;
          for (const r of legsAll) {
            eq *= 1 + f * r;
            peak = Math.max(peak, eq);
            mdd = Math.min(mdd, eq / peak - 1);
          }
          equitySim[`${mode}|${tf}|${name}|${f}`] = { final: eq, cagr: eq > 0 ? Math.pow(eq, 1 / years) - 1 : -1, maxDD: mdd, legs: legsAll.length, worstLeg: Math.min(...legsAll), winRate: legsAll.filter((x) => x > 0).length / legsAll.length };
        }
      }
    }
  }

  // Windows: month-by-month readings.
  const windows: Record<string, string> = { "2000-2002": "2000-01..2002-12", "2007-2009": "2007-01..2009-12", "2020": "2020-01..2020-12", "2022": "2021-11..2022-12", "2026 fall": "2026-06..2026-12" };
  const winRows: Record<string, Array<Record<string, unknown>>> = {};
  for (const [name, rng] of Object.entries(windows)) {
    const [a, b] = rng.split("..");
    const rows: Array<Record<string, unknown>> = [];
    for (let k = 0; k < M; k++) {
      const ym = bars[monthEndIdx[k]].date.slice(0, 7);
      if (ym < a || ym > b) continue;
      const i = monthEndIdx[k];
      const prevClose = k > 0 ? bars[monthEndIdx[k - 1]].close : bars[monthStartIdx[k]].open;
      rows.push({
        date: bars[i].date, close: bars[i].close, monthRet: bars[i].close / prevClose - 1,
        completed: TFS.map((tf) => ch(state.completed[tf][k])).join(""),
        todate: TFS.map((tf) => ch(state.todate[tf][k])).join(""),
        running: i === bars.length - 1 && bars[i].date !== bars[monthEndIdx[k]].date,
      });
    }
    winRows[name] = rows;
  }

  // Daily gear in the 2026 fall (is the fall "invisible" to daily polarity?).
  const dayRows = results.filter((r) => r.date >= "2026-01-01");
  const share = (from: string, to: string) => {
    const x = dayRows.filter((r) => r.date >= from && r.date <= to);
    return { days: x.length, reverse: x.filter((r) => r.polarity === -1).length / Math.max(1, x.length), drive: x.filter((r) => r.polarity === 1).length / Math.max(1, x.length) };
  };
  const longestRun = (from: string, to: string, p: number) => {
    let best = 0;
    let run = 0;
    for (const r of results) {
      if (r.date < from || r.date > to) continue;
      if (r.polarity === p) {
        run++;
        best = Math.max(best, run);
      } else run = 0;
    }
    return best;
  };
  const lastIdx = bars.length - 1;
  let peakIdx = 0;
  for (let i = 0; i < bars.length; i++) if (bars[i].date >= "2026-01-01" && bars[i].close > bars[peakIdx].close) peakIdx = i;
  const dailyFall = {
    peakDate: bars[peakIdx].date, peakClose: bars[peakIdx].close, lastDate: bars[lastIdx].date, lastClose: bars[lastIdx].close,
    fromPeakPct: bars[lastIdx].close / bars[peakIdx].close - 1,
    closeOnSep1: bars.find((b) => b.date >= "2026-09-01")!.close,
    sinceSep1Pct: bars[lastIdx].close / bars.find((b) => b.date >= "2026-09-01")!.close - 1,
    before: share("2026-01-01", "2026-08-31"), sinceSep1: share("2026-09-01", bars[lastIdx].date), sincePeak: share(bars[peakIdx].date, bars[lastIdx].date),
    longestReverseRunSinceSep1: longestRun("2026-09-01", "9999", -1), longestDriveRunSinceSep1: longestRun("2026-09-01", "9999", 1),
    vix: vix.get(bars[lastIdx].date) ?? null,
  };

  // Day-by-day readings since the end of August 2026: to-date (forming candle) and completed (latest finished candle).
  const recent: Array<Record<string, unknown>> = [];
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date < "2026-08-25") continue;
    const row: Record<string, unknown> = { date: bars[i].date, close: bars[i].close };
    for (const tf of TFS) {
      const td = candleToDate(bars, floorByDate, i, tf);
      const net = netVolume({ date: bars[i].date, open: td.open, high: td.high, low: td.low, close: td.close, volume: td.volume });
      const finished = i < bars.length - 1 && keyFor(bars[i + 1].date, tf) !== td.key;
      let j = candles[tf].findIndex((c) => c.key === td.key);
      if (!finished) j--;
      row[`${tf}_todate`] = td.polarity;
      row[`${tf}_todateOpen`] = td.open;
      row[`${tf}_netOverFloor`] = td.floor ? net / td.floor : null;
      row[`${tf}_completed`] = j >= 0 ? candles[tf][j].polarity : null;
      row[`${tf}_completedKey`] = j >= 0 ? candles[tf][j].key : null;
    }
    recent.push(row);
  }
  const recentFlips: Array<{ tf: TF; kind: string; date: string; to: number }> = [];
  for (const tf of TFS) {
    for (const kind of ["todate", "completed"]) {
      let prev: unknown = undefined;
      for (const r of recent) {
        const v = r[`${tf}_${kind}`];
        if (prev !== undefined && v !== prev && v !== null) recentFlips.push({ tf, kind, date: r.date as string, to: v as number });
        prev = v;
      }
    }
  }

  // Flip tables for Q, H, Y (completed) and counts for M.
  const flipTable = spellRows.filter((s) => s.mode === "completed" && (s.tf === "Q" || s.tf === "H" || s.tf === "Y")).map((s) => ({
    tf: s.tf, state: s.state === 1 ? "Drive" : s.state === -1 ? "Reverse" : "Neutral", signalDate: s.signalDate, enterDate: s.enterDate, exitDate: s.exitDate, months: s.months, spyReturn: s.spyReturn,
    legs: s.atm?.legs.length ?? 0, atm: s.atm?.avgLeg ?? null, otm10: s.otm10?.avgLeg ?? null, otm20: s.otm20?.avgLeg ?? null, atmSum: s.atm?.sum ?? null,
  }));

  // Spell-level summaries of modelled options and the underlying, per tf/mode.
  const spellSummary: Record<string, unknown> = {};
  for (const mode of ["completed", "todate"] as Mode[]) {
    for (const tf of TFS) {
      const rows = spellRows.filter((s) => s.mode === mode && s.tf === tf && s.state !== 0 && s.exitDate !== null);
      const sum = (f: (s: (typeof rows)[number]) => number | null | undefined) => {
        const v = rows.map(f).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
        return { n: v.length, mean: mean(v), median: median(v), win: v.filter((x) => x > 0).length / Math.max(1, v.length), worst: Math.min(...v), best: Math.max(...v) };
      };
      spellSummary[`${mode}|${tf}`] = {
        driveUnderlying: sum((s) => (s.state === 1 ? s.spyReturn : null)),
        reverseUnderlying: sum((s) => (s.state === -1 ? -s.spyReturn : null)),
        callAtm: sum((s) => (s.state === 1 ? s.atm?.avgLeg : null)),
        putAtm: sum((s) => (s.state === -1 ? s.atm?.avgLeg : null)),
        call10: sum((s) => (s.state === 1 ? s.otm10?.avgLeg : null)),
        put10: sum((s) => (s.state === -1 ? s.otm10?.avgLeg : null)),
      };
    }
  }

  const out = {
    generatedAt: new Date().toISOString(), symbol: SYMBOL, first: bars[0].date, last: bars[lastIdx].date, months: M, commonStart: bars[monthEndIdx[common]].date, selfCheckPoints: checked,
    flipCounts, stats, strategies, equitySim, windows: winRows, dailyFall, recent, recentFlips, flipTable, spellSummary,
    current: Object.fromEntries((["completed", "todate"] as Mode[]).map((m) => [m, Object.fromEntries(TFS.map((tf) => [tf, state[m][tf][M - 1]]))])),
    spells: spellRows,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `spy-monthly-study-${SYMBOL.replace(/\W/g, "")}.json`), JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
