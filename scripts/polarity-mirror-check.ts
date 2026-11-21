/**
 * READ-ONLY mirror check: how well does the gear (Drive +1 / Neutral 0 / Reverse -1) describe the market,
 * and does it say anything about what comes next?
 *
 *   npx tsx scripts/polarity-mirror-check.ts [--years=10] [--out=/tmp/polarity-mirror.json]
 *
 * Needs NO secrets: daily bars come from Yahoo Finance's public chart endpoint (split-adjusted open/high/low/close,
 * consolidated volume). Nothing is traded, no order is placed, no repo file is written; the gear is computed with the
 * unchanged engine (src/lib/polarity.ts computePolaritySeries) on those bars. Output is one JSON document on stdout
 * (and to --out when given); bars are cached under the OS temp dir only.
 *
 * Definitions (all measured per ticker-day t, gear known at the close of t):
 *   same-session  open(t) -> close(t)       what the gear is describing
 *   gap-aware     close(t-1) -> close(t)    what most people call "the stock was up/down today"
 *   next session  open(t+1) -> close(t+1)   first session a trade could capture
 *   next close    close(t) -> close(t+1), close(t) -> close(t+5)
 * Baseline = every eligible day of the same ticker (always long / just hold). Edge = event return minus that
 * ticker's all-day mean. Standard errors are clustered by DATE (all stocks move together on a day, so pooled
 * ticker-days are NOT independent).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computePolaritySeries, type Bar, type DayResult } from "../src/lib/polarity";

const TICKERS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AMD", "JPM", "XOM", "AVGO", "WMT"];
const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const YEARS = Number(arg("years", "10"));
const OUT = arg("out", "");
const CACHE = path.join(os.tmpdir(), "polarito-mirror-bars");

const nyDate = (sec: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(sec * 1000));

async function loadBars(ticker: string): Promise<Bar[]> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${ticker}-${YEARS}y-${new Date().toISOString().slice(0, 10)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Bar[];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${YEARS}y&interval=1d`;
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
      if (attempt === 3) throw new Error(`${ticker}: ${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }
  const r = (body as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<Record<string, (number | null)[]>> } }> } }).chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!ts || !q) throw new Error(`${ticker}: unexpected response shape`);
  const bars: Bar[] = [];
  let prev = "";
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (o == null || h == null || l == null || c == null || v == null || v <= 0) continue;
    const date = nyDate(ts[i]);
    if (date <= prev) continue;
    const hi = Math.max(h, o, c);
    const lo = Math.min(l, o, c);
    bars.push({ date, open: o, high: hi, low: lo, close: c, volume: v });
    prev = date;
  }
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

type Ev = { date: string; ticker: string; polarity: number; ratio: number; ocSame: number; ccSame: number; ocNext: number | null; ccNext: number | null; cc5: number | null; regimeTrend: string; regimeVol: string };

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Mean with a date-clustered standard error. */
function stat(events: Ev[], pick: (e: Ev) => number | null, baseline: Map<string, number>) {
  const vals: { date: string; x: number; edge: number }[] = [];
  for (const e of events) {
    const x = pick(e);
    if (x === null || !Number.isFinite(x)) continue;
    vals.push({ date: e.date, x, edge: x - (baseline.get(e.ticker) ?? 0) });
  }
  const n = vals.length;
  if (n === 0) return { n: 0, mean: NaN, median: NaN, pctUp: NaN, edge: NaN, edgeSe: NaN, edgeT: NaN };
  const m = mean(vals.map((v) => v.edge));
  const byDate = new Map<string, number>();
  for (const v of vals) byDate.set(v.date, (byDate.get(v.date) ?? 0) + (v.edge - m));
  let ss = 0;
  for (const s of byDate.values()) ss += s * s;
  const se = Math.sqrt(ss) / n;
  return {
    n,
    mean: mean(vals.map((v) => v.x)),
    median: median(vals.map((v) => v.x)),
    pctUp: vals.filter((v) => v.x > 0).length / n,
    edge: m,
    edgeSe: se,
    edgeT: se > 0 ? m / se : NaN,
  };
}

async function main() {
  const perTicker = new Map<string, DayResult[]>();
  const barsBy = new Map<string, Bar[]>();
  const failed: string[] = [];
  for (const t of TICKERS) {
    try {
      const bars = await loadBars(t);
      barsBy.set(t, bars);
      perTicker.set(t, computePolaritySeries(bars));
    } catch (e) {
      failed.push(`${t}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }
  const spy = barsBy.get("SPY");
  if (!spy) throw new Error("SPY bars are required for the regime split.");

  const trend = new Map<string, string>();
  const vol = new Map<string, number>();
  for (let i = 0; i < spy.length; i++) {
    if (i >= 199) trend.set(spy[i].date, spy[i].close >= mean(spy.slice(i - 199, i + 1).map((b) => b.close)) ? "SPY above 200-day average" : "SPY below 200-day average");
    if (i >= 20) {
      const r = spy.slice(i - 19, i + 1).map((b, k, a) => (k === 0 ? Math.log(b.close / spy[i - 20].close) : Math.log(b.close / a[k - 1].close)));
      const m = mean(r);
      vol.set(spy[i].date, Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / 19) * Math.sqrt(252));
    }
  }
  const sortedVol = [...vol.values()].sort((a, b) => a - b);
  const q1 = sortedVol[Math.floor(sortedVol.length / 3)];
  const q2 = sortedVol[Math.floor((2 * sortedVol.length) / 3)];

  const events: Ev[] = [];
  for (const [ticker, res] of perTicker) {
    const bars = barsBy.get(ticker)!;
    for (let i = 20; i < res.length - 0; i++) {
      const d = res[i];
      if (!d.ready || d.avgVolume === null) continue;
      const v = vol.get(d.date);
      const nextOk = i + 1 < res.length;
      events.push({
        date: d.date,
        ticker,
        polarity: d.polarity,
        ratio: d.volume / d.avgVolume,
        ocSame: d.close / d.open - 1,
        ccSame: d.close / bars[i - 1].close - 1,
        ocNext: nextOk ? res[i + 1].close / res[i + 1].open - 1 : null,
        ccNext: nextOk ? res[i + 1].close / d.close - 1 : null,
        cc5: i + 5 < res.length ? res[i + 5].close / d.close - 1 : null,
        regimeTrend: trend.get(d.date) ?? "n/a",
        regimeVol: v === undefined ? "n/a" : v <= q1 ? "calm" : v <= q2 ? "normal" : "stormy",
      });
    }
  }

  const baseline = (pick: (e: Ev) => number | null) => {
    const sums = new Map<string, number[]>();
    for (const e of events) {
      const x = pick(e);
      if (x === null) continue;
      if (!sums.has(e.ticker)) sums.set(e.ticker, []);
      sums.get(e.ticker)!.push(x);
    }
    return new Map([...sums].map(([k, v]) => [k, mean(v)]));
  };
  const picks = {
    ocSame: (e: Ev) => e.ocSame,
    ccSame: (e: Ev) => e.ccSame,
    ocNext: (e: Ev) => e.ocNext,
    ccNext: (e: Ev) => e.ccNext,
    cc5: (e: Ev) => e.cc5,
  } as const;
  const bases = Object.fromEntries(Object.entries(picks).map(([k, f]) => [k, baseline(f)])) as Record<keyof typeof picks, Map<string, number>>;
  const zero = new Map<string, number>();

  const gears = [1, 0, -1] as const;
  const gearName = (g: number) => (g === 1 ? "Drive" : g === -1 ? "Reverse" : "Neutral");
  const table = (sel: (e: Ev) => boolean) =>
    Object.fromEntries(
      gears.map((g) => {
        const ev = events.filter((e) => e.polarity === g && sel(e));
        return [
          gearName(g),
          {
            days: ev.length,
            sameSession: stat(ev, picks.ocSame, zero),
            gapAware: stat(ev, picks.ccSame, zero),
            nextSessionOpenToClose: stat(ev, picks.ocNext, bases.ocNext),
            nextCloseToClose: stat(ev, picks.ccNext, bases.ccNext),
            fiveDay: stat(ev, picks.cc5, bases.cc5),
          },
        ];
      }),
    );

  const all = events.filter(() => true);
  const baselineAll = {
    days: all.length,
    ocNext: stat(all, picks.ocNext, zero),
    ccNext: stat(all, picks.ccNext, zero),
    cc5: stat(all, picks.cc5, zero),
    sameSession: stat(all, picks.ocSame, zero),
  };

  // Mirror accuracy: does the gear match the same-session candle, and the gap-aware up/down?
  const mirror = (sel: (e: Ev) => boolean) => {
    const ev = events.filter(sel);
    const drive = ev.filter((e) => e.polarity === 1);
    const rev = ev.filter((e) => e.polarity === -1);
    const neu = ev.filter((e) => e.polarity === 0);
    const decided = [...drive, ...rev];
    return {
      days: ev.length,
      driveDays: drive.length,
      reverseDays: rev.length,
      neutralDays: neu.length,
      driveCandleGreen: drive.filter((e) => e.ocSame > 0).length / Math.max(1, drive.length),
      reverseCandleRed: rev.filter((e) => e.ocSame < 0).length / Math.max(1, rev.length),
      driveClosedUpVsPriorClose: drive.filter((e) => e.ccSame > 0).length / Math.max(1, drive.length),
      reverseClosedDownVsPriorClose: rev.filter((e) => e.ccSame < 0).length / Math.max(1, rev.length),
      agreeWithPriorCloseDirection: decided.filter((e) => (e.polarity === 1 && e.ccSame > 0) || (e.polarity === -1 && e.ccSame < 0)).length / Math.max(1, decided.length),
      driveMeanSameSession: mean(drive.map((e) => e.ocSame)),
      reverseMeanSameSession: mean(rev.map((e) => e.ocSame)),
      neutralMeanAbsSameSession: mean(neu.map((e) => Math.abs(e.ocSame))),
      allDaysMeanAbsSameSession: mean(ev.map((e) => Math.abs(e.ocSame))),
    };
  };

  // Persistence: how often does tomorrow's gear equal today's (a lagging mirror repeats itself)?
  let same = 0, pairs = 0, flips = 0;
  for (const [, res] of perTicker) {
    for (let i = 21; i < res.length; i++) {
      if (res[i].polarity === 0 || res[i - 1].polarity === 0) continue;
      pairs++;
      if (res[i].polarity === res[i - 1].polarity) same++;
      else flips++;
    }
  }
  const greenShare = mean(events.map((e) => (e.ocSame > 0 ? 1 : 0)));

  const byTicker = Object.fromEntries(
    [...perTicker.keys()].map((t) => {
      const ev = events.filter((e) => e.ticker === t);
      const b = (pick: (e: Ev) => number | null) => baseline(pick).get(t) ?? 0;
      const d = ev.filter((e) => e.polarity === 1);
      const r = ev.filter((e) => e.polarity === -1);
      const s = (sel: Ev[], pick: (e: Ev) => number | null) => stat(sel, pick, new Map([[t, b(pick)]]));
      return [t, { days: ev.length, mirror: mirror((e) => e.ticker === t), driveNextEdge: s(d, picks.ccNext), reverseNextEdge: s(r, picks.ccNext), drive5Edge: s(d, picks.cc5), reverse5Edge: s(r, picks.cc5) }];
    }),
  );

  const regimes = (key: "regimeTrend" | "regimeVol") =>
    Object.fromEntries(
      [...new Set(events.map((e) => e[key]))]
        .filter((k) => k !== "n/a")
        .sort()
        .map((k) => [k, { mirror: mirror((e) => e[key] === k), table: table((e) => e[key] === k) }]),
    );

  const byYear = Object.fromEntries(
    [...new Set(events.map((e) => e.date.slice(0, 4)))].sort().map((y) => [y, { mirror: mirror((e) => e.date.startsWith(y)), table: table((e) => e.date.startsWith(y)) }]),
  );

  // Conviction: does a heavier-volume Drive/Reverse mirror or predict differently?
  const bucket = (r: number) => (r < 0.8 ? "<0.8x avg volume" : r < 1.2 ? "0.8-1.2x" : r < 1.5 ? "1.2-1.5x" : ">=1.5x");
  const byConviction = Object.fromEntries(
    ["<0.8x avg volume", "0.8-1.2x", "1.2-1.5x", ">=1.5x"].map((k) => [k, { mirror: mirror((e) => bucket(e.ratio) === k), table: table((e) => bucket(e.ratio) === k) }]),
  );

  // Split halves to expose instability.
  const mid = "2021-07-01";
  const halves = {
    "first half": { to: mid, table: table((e) => e.date < mid), mirror: mirror((e) => e.date < mid) },
    "second half": { from: mid, table: table((e) => e.date >= mid), mirror: mirror((e) => e.date >= mid) },
  };

  // Naive "follow the gear" vs always-long on next-session open->close, per day, equal weight across tickers.
  const byDate = new Map<string, Ev[]>();
  for (const e of events) if (e.ocNext !== null) (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push(e);
  const dates = [...byDate.keys()].sort();
  const follow: number[] = [], hold: number[] = [], fade: number[] = [];
  for (const d of dates) {
    const ev = byDate.get(d)!;
    hold.push(mean(ev.map((e) => e.ocNext!)));
    follow.push(mean(ev.map((e) => (e.polarity === 0 ? 0 : e.polarity * e.ocNext!))));
    fade.push(mean(ev.map((e) => (e.polarity === 0 ? 0 : -e.polarity * e.ocNext!))));
  }
  const summarize = (a: number[]) => ({ days: a.length, meanPerDayPct: mean(a) * 100, pctDaysPositive: a.filter((x) => x > 0).length / a.length, growthOfOneDollar: a.reduce((p, x) => p * (1 + x), 1) });

  const out = {
    generatedAt: new Date().toISOString(),
    source: "Yahoo Finance public daily bars (split-adjusted OHLC, consolidated volume); gear from src/lib/polarity.ts computePolaritySeries, unchanged",
    tickers: [...perTicker.keys()],
    failed,
    window: { first: events.reduce((m, e) => (e.date < m ? e.date : m), "9999"), last: events.reduce((m, e) => (e.date > m ? e.date : m), "0000") },
    totals: { tickerDays: events.length, distinctDates: new Set(events.map((e) => e.date)).size, driveShare: events.filter((e) => e.polarity === 1).length / events.length, reverseShare: events.filter((e) => e.polarity === -1).length / events.length, neutralShare: events.filter((e) => e.polarity === 0).length / events.length, greenCandleShare: greenShare },
    mirror: mirror(() => true),
    baselineAll,
    afterGear: table(() => true),
    persistence: { pairs, sameGearNextDay: same / pairs, flipNextDay: flips / pairs },
    byTicker,
    regimeTrend: regimes("regimeTrend"),
    regimeVol: regimes("regimeVol"),
    byYear,
    byConviction,
    halves,
    simpleRules: { hold: summarize(hold), followGear: summarize(follow), fadeGear: summarize(fade), note: "next-session open->close, equal weight across tickers each day, no costs" },
    volTerciles: { calmBelow: q1, stormyAbove: q2 },
  };
  const json = JSON.stringify(out, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  console.log(json);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
