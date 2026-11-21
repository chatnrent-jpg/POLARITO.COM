/**
 * READ-ONLY intraday check: if the app enters on today's partial-day gear and is flat by the close, how does that go?
 *
 *   npx tsx scripts/polarity-intraday-check.ts [--out=/tmp/polarity-intraday.json]
 *
 * No secrets, no orders, no repo writes. Bars come from Yahoo Finance's public chart endpoint (5-minute bars cover only
 * about the last 60 days, 1-hour bars about 2.9 years). The gear is computed with the app's own engine
 * (src/lib/polarity.ts computePolaritySeries) on EXACTLY what the live runner feeds it at that moment:
 * prior full daily bars + today's partial daily bar (open = first print of the day, high/low so far, close = last price,
 * volume = cumulative). Nothing after the entry time is used to decide. Entry price = last completed bar's close.
 * Exit: 15:55 ET flatten (the runner's default POLARITO_LIVE_FLATTEN_AT) for 5-minute data, the 16:00 close for hourly data.
 *
 * Baseline for each entry time = buy every ticker at that same time regardless of gear.
 * Standard errors are clustered by date (all stocks move together on a day).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computePolaritySeries, type Bar } from "../src/lib/polarity";

const TICKERS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AMD", "JPM", "XOM", "AVGO", "WMT"];
const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const OUT = arg("out", "");
/** Yahoo intraday volumes sum to ~80% of its daily volume; scale partial volume so it is comparable with the daily history (default on). */
const VOL_SCALE = arg("volscale", "1") !== "0";
const CACHE = path.join(os.tmpdir(), "polarito-intraday-bars");
const COSTS_BPS_ROUND_TRIP = [4, 10];

type IBar = { date: string; start: number; end: number; open: number; high: number; low: number; close: number; volume: number };
type Day = { date: string; bars: IBar[] };

const fmtNy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function ny(sec: number): { date: string; minute: number } {
  const p = Object.fromEntries(fmtNy.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

async function fetchYahoo(ticker: string, interval: string, range: string): Promise<{ ts: number[]; q: Record<string, (number | null)[]> }> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${ticker}-${interval}-${range}-${new Date().toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
  let body: unknown = null;
  for (let attempt = 0; attempt < 4 && body === null; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      if (attempt === 3) throw new Error(`${ticker} ${interval}: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }
  const r = (body as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, (number | null)[]>> } }> } }).chart?.result?.[0];
  if (!r?.timestamp || !r.indicators?.quote?.[0]) throw new Error(`${ticker} ${interval}: unexpected response shape`);
  const out = { ts: r.timestamp, q: r.indicators.quote[0] };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

async function loadDaily(ticker: string): Promise<Bar[]> {
  const { ts, q } = await fetchYahoo(ticker, "1d", "5y");
  const bars: Bar[] = [];
  let prev = "";
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (o == null || h == null || l == null || c == null || v == null || v <= 0) continue;
    const date = ny(ts[i]).date;
    if (date <= prev) continue;
    bars.push({ date, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: v });
    prev = date;
  }
  return bars;
}

function loadIntraday(raw: { ts: number[]; q: Record<string, (number | null)[]> }, stepMin: number): Day[] {
  const byDate = new Map<string, IBar[]>();
  for (let i = 0; i < raw.ts.length; i++) {
    const [o, h, l, c, v] = [raw.q.open[i], raw.q.high[i], raw.q.low[i], raw.q.close[i], raw.q.volume[i]];
    if (o == null || h == null || l == null || c == null || v == null) continue;
    const { date, minute } = ny(raw.ts[i]);
    if (minute < 570 || minute > 960) continue;
    const bar: IBar = { date, start: minute, end: minute === 960 ? 960 : minute + stepMin, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: Math.max(0, v) };
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(bar);
  }
  return [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, bars]) => ({ date, bars: bars.sort((x, y) => x.start - y.start) }));
}

function partial(day: Day, atMinute: number, volScale = 1): { bar: Bar; price: number } | null {
  const done = day.bars.filter((b) => b.end <= atMinute);
  if (done.length === 0 || done[0].start !== 570) return null;
  return {
    price: done[done.length - 1].close,
    bar: {
      date: day.date,
      open: done[0].open,
      high: Math.max(...done.map((b) => b.high)),
      low: Math.min(...done.map((b) => b.low)),
      close: done[done.length - 1].close,
      volume: done.reduce((s, b) => s + b.volume, 0) * volScale,
    },
  };
}

/** The gear the live runner would see: prior daily history + today's partial bar through computePolaritySeries. */
function liveGear(history: Bar[], p: Bar) {
  const series = computePolaritySeries([...history, p]);
  const last = series[series.length - 1];
  return { polarity: last.polarity, ready: last.ready, ratio: last.avgVolume ? last.volume / last.avgVolume : NaN };
}

type Ev = { date: string; ticker: string; polarity: number; ready: boolean; ratio: number; rFlat: number; rClose: number; finalGreen: boolean };
type Trade = { date: string; ticker: string; entryMinute: number; exitMinute: number; bySignal: boolean; rApp: number; rHoldToFlat: number };

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function summarize(rows: { date: string; r: number }[], baselineMean: number) {
  const n = rows.length;
  if (n === 0) return { n: 0 };
  const m = mean(rows.map((x) => x.r));
  const byDate = new Map<string, number>();
  for (const x of rows) byDate.set(x.date, (byDate.get(x.date) ?? 0) + (x.r - m));
  let ss = 0;
  for (const s of byDate.values()) ss += s * s;
  const se = Math.sqrt(ss) / n;
  const out: Record<string, number> = { n, dates: byDate.size, hitRate: rows.filter((x) => x.r > 0).length / n, meanPct: m * 100, medianPct: median(rows.map((x) => x.r)) * 100, sePct: se * 100, tStat: se > 0 ? m / se : NaN, edgeVsBaselinePct: (m - baselineMean) * 100 };
  for (const bps of COSTS_BPS_ROUND_TRIP) {
    const net = rows.map((x) => x.r - bps / 10_000);
    out[`netMeanPct_${bps}bps`] = mean(net) * 100;
    out[`netHitRate_${bps}bps`] = net.filter((x) => x > 0).length / n;
  }
  return out;
}

async function main() {
  const dailyBy = new Map<string, Bar[]>();
  const fiveBy = new Map<string, Day[]>();
  const hourBy = new Map<string, Day[]>();
  const failed: string[] = [];
  for (const t of TICKERS) {
    try {
      dailyBy.set(t, await loadDaily(t));
      fiveBy.set(t, loadIntraday(await fetchYahoo(t, "5m", "60d"), 5));
      hourBy.set(t, loadIntraday(await fetchYahoo(t, "1h", "730d"), 60));
    } catch (e) {
      failed.push(`${t}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  const run = (label: string, daysBy: Map<string, Day[]>, stepMin: number, times: number[], flatMinute: number, fullDay: (d: Day) => boolean) => {
    const evs = new Map<number, Ev[]>(times.map((t) => [t, []]));
    const trades: Trade[] = [];
    const volRatios: number[] = [];
    for (const [ticker, days] of daysBy) {
      const daily = dailyBy.get(ticker)!;
      for (const day of days) {
        const f = daily.find((b) => b.date === day.date);
        if (f && fullDay(day)) volRatios.push(day.bars.reduce((s, b) => s + b.volume, 0) / f.volume);
      }
    }
    const volScale = VOL_SCALE ? 1 / median(volRatios) : 1;
    volRatios.length = 0;
    let daysUsed = 0;
    const dateSet = new Set<string>();
    for (const [ticker, days] of daysBy) {
      const daily = dailyBy.get(ticker)!;
      for (const day of days) {
        if (!fullDay(day)) continue;
        const idx = daily.findIndex((b) => b.date === day.date);
        if (idx < 21) continue;
        const history = daily.slice(Math.max(0, idx - 300), idx);
        const finalBar = daily[idx];
        const dayVol = day.bars.reduce((s, b) => s + b.volume, 0);
        volRatios.push(dayVol / finalBar.volume);
        daysUsed++;
        dateSet.add(day.date);
        const flat = partial(day, flatMinute);
        const close = day.bars[day.bars.length - 1].close;
        if (!flat) continue;
        for (const T of times) {
          const p = partial(day, T, volScale);
          if (!p) continue;
          const g = liveGear(history, p.bar);
          evs.get(T)!.push({ date: day.date, ticker, polarity: g.polarity, ready: g.ready, ratio: g.ratio, rFlat: flat.price / p.price - 1, rClose: close / p.price - 1, finalGreen: finalBar.close > finalBar.open });
        }
        // App-like rule: first Drive from the first time on, exit when the gear leaves Drive, else flatten.
        let entered: { minute: number; price: number } | null = null;
        for (let T = times[0]; T < flatMinute; T += stepMin) {
          const p = partial(day, T, volScale);
          if (!p) continue;
          const g = liveGear(history, p.bar);
          if (!entered) {
            if (g.ready && g.polarity === 1) entered = { minute: T, price: p.price };
            continue;
          }
          if (g.polarity !== 1) {
            trades.push({ date: day.date, ticker, entryMinute: entered.minute, exitMinute: T, bySignal: true, rApp: p.price / entered.price - 1, rHoldToFlat: flat.price / entered.price - 1 });
            entered = null;
            break;
          }
        }
        if (entered) trades.push({ date: day.date, ticker, entryMinute: entered.minute, exitMinute: flatMinute, bySignal: false, rApp: flat.price / entered.price - 1, rHoldToFlat: flat.price / entered.price - 1 });
      }
    }

    const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const perTime = Object.fromEntries(
      times.map((T) => {
        const all = evs.get(T)!;
        const baseFlat = mean(all.map((e) => e.rFlat));
        const baseClose = mean(all.map((e) => e.rClose));
        const sel = (pol: number) => all.filter((e) => e.polarity === pol && e.ready);
        const share = (pol: number) => all.filter((e) => e.polarity === pol && e.ready).length / Math.max(1, all.length);
        const row = (pol: number) => {
          const s = sel(pol);
          return {
            share: share(pol),
            finalCandleSameColour: s.length ? s.filter((e) => (pol === 1 ? e.finalGreen : pol === -1 ? !e.finalGreen : false)).length / s.length : NaN,
            toFlat: summarize(s.map((e) => ({ date: e.date, r: e.rFlat })), baseFlat),
            toClose: summarize(s.map((e) => ({ date: e.date, r: e.rClose })), baseClose),
          };
        };
        return [hhmm(T), { tickerDays: all.length, Drive: row(1), Reverse: row(-1), Neutral: row(0), baseline: { toFlat: summarize(all.map((e) => ({ date: e.date, r: e.rFlat })), baseFlat), toClose: summarize(all.map((e) => ({ date: e.date, r: e.rClose })), baseClose) } }];
      }),
    );
    const tradeSummary = (sel: (t: Trade) => boolean) => {
      const ts = trades.filter(sel);
      return {
        trades: ts.length,
        bySignalExitShare: ts.filter((t) => t.bySignal).length / Math.max(1, ts.length),
        medianHoldMinutes: median(ts.map((t) => t.exitMinute - t.entryMinute)),
        appRule: summarize(ts.map((t) => ({ date: t.date, r: t.rApp })), 0),
        sameEntryHoldToFlat: summarize(ts.map((t) => ({ date: t.date, r: t.rHoldToFlat })), 0),
      };
    };
    return {
      label,
      sessions: dateSet.size,
      tickerDaysUsed: daysUsed,
      firstDate: [...dateSet].sort()[0],
      lastDate: [...dateSet].sort().at(-1),
      volumeScaleApplied: volScale,
      medianIntradayVolumeVsDailyVolume: median(volRatios),
      perEntryTime: perTime,
      appLikeRule: { all: tradeSummary(() => true) },
    };
  };

  const five = run("5-minute bars (about 60 days)", fiveBy, 5, [600, 630, 690, 780, 870], 955, (d) => d.bars.length >= 70 && d.bars.some((b) => b.start >= 950));
  const hour = run("1-hour bars (about 2.9 years)", hourBy, 60, [630, 690, 750, 810, 870], 960, (d) => d.bars.length >= 6 && d.bars.some((b) => b.start >= 930));

  const out = { generatedAt: new Date().toISOString(), tickers: [...dailyBy.keys()], failed, costsRoundTripBps: COSTS_BPS_ROUND_TRIP, five, hour };
  const json = JSON.stringify(out, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  console.log(json);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
