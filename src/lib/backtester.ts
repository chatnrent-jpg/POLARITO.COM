/**
 * Polarity backtester: statistical validation of the Net Volume signal.
 *
 * PURE: no I/O, no network, no clock. Give it validated daily bars, get stats.
 * Only `Math.random`-free: the permutation test uses a seeded PRNG so every run
 * with the same inputs gives the same numbers.
 *
 * NO LOOK-AHEAD (the one rule this file exists to enforce)
 *   The signal for session `t` needs session `t`'s close, so it is KNOWN at the
 *   close of `t` and can never be filled earlier than the OPEN of `t + 1`.
 *   - Event study, entry "nextOpen" (primary): enter open[t+1], exit close[t+h].
 *   - Event study, entry "close" (optimistic ceiling): enter close[t], exit
 *     close[t+h]. Needs a market-on-close fill on the signal bar; shown only so
 *     the gap between "ideal" and "realistic" is visible.
 *   - Strategy simulation: signal-driven trades fill at the next open; fixed
 *     hold-length exits are known in advance and fill at that day's close.
 *
 * Two tests answer two different questions:
 *   1. Event study  : "does the signal predict the next h days?"  (no trading rules)
 *   2. Strategy sim : "could it be traded, after costs, vs buy & hold?"
 */
import {
  computePolaritySeries,
  VOLUME_MA_WINDOW,
  type Bar,
  type Polarity,
} from "./polarity";

/* ------------------------------------------------------------------ */
/* Constants & types                                                   */
/* ------------------------------------------------------------------ */

export const HORIZONS = [1, 5, 20] as const;
export type Horizon = (typeof HORIZONS)[number];

export type EntryMode = "nextOpen" | "close";
export const ENTRY_MODES: readonly EntryMode[] = ["nextOpen", "close"];

export const TRADING_DAYS_PER_YEAR = 252;

/** Forward return keyed by `${entry}:${horizon}`; null when history runs out. */
export type ForwardReturns = Record<string, number | null>;

export function fwdKey(entry: EntryMode, horizon: number): string {
  return `${entry}:${horizon}`;
}

export type Observation = {
  ticker: string;
  date: string;
  /** Index of the signal bar inside this ticker's bar array. */
  index: number;
  polarity: Polarity;
  fwd: ForwardReturns;
};

export class BacktestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestInputError";
  }
}

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((p, q) => p - q);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Seeded PRNG (mulberry32) so the permutation test is reproducible. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Forward returns & observations                                      */
/* ------------------------------------------------------------------ */

/**
 * Return of holding `h` sessions after a signal on bar `i`, or null if the
 * data ends first. `h` sessions means sessions i+1 .. i+h.
 */
export function forwardReturn(
  bars: readonly Bar[],
  i: number,
  h: number,
  entry: EntryMode,
): number | null {
  if (!Number.isInteger(h) || h < 1) throw new BacktestInputError("Horizon must be an integer >= 1.");
  const exit = i + h;
  if (exit >= bars.length) return null;
  const entryPrice = entry === "close" ? bars[i].close : bars[i + 1].open;
  return bars[exit].close / entryPrice - 1;
}

/**
 * One Observation per bar that has a full 20-bar volume history. Warm-up bars
 * are excluded: the engine forces them Neutral, and counting them as "Neutral
 * signals" would pollute the Neutral bucket and the baseline.
 */
export function collectObservations(
  ticker: string,
  bars: readonly Bar[],
  opts: { noiseFloorRatio?: number } = {},
): Observation[] {
  const series = computePolaritySeries(bars, opts); // validates bars (throws on bad data)
  const out: Observation[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (!series[i].ready) continue;
    const fwd: ForwardReturns = {};
    for (const entry of ENTRY_MODES) {
      for (const h of HORIZONS) fwd[fwdKey(entry, h)] = forwardReturn(bars, i, h, entry);
    }
    out.push({ ticker, date: bars[i].date, index: i, polarity: series[i].polarity, fwd });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Event study                                                         */
/* ------------------------------------------------------------------ */

export type EventStats = {
  polarity: Polarity;
  horizon: number;
  entry: EntryMode;
  /** Signals with a complete forward window. */
  n: number;
  /** Mean raw return (not direction-adjusted). */
  meanRaw: number;
  /** Mean return in the signal's direction (Reverse is traded short: sign * r). */
  meanDirectional: number;
  medianDirectional: number;
  /** Share of signals whose directional return > 0. */
  hitRate: number;
  stdevDirectional: number;
  /** t-stat of meanDirectional vs 0. Overstated for h > 1 (windows overlap). */
  tStat: number;
  /**
   * Directional return minus what the same ticker earned on an average day
   * (sign * (r - ticker baseline)). Strips out market drift so a rising market
   * cannot make Drive look smart. This is the number that matters.
   */
  edge: number;
  /**
   * Two-sided permutation p-value: chance of an |edge| this large from random
   * days. Read the sign of `edge` for direction (null if not run).
   */
  pValue: number | null;
};

const signOf = (p: Polarity): number => (p === -1 ? -1 : 1);

/** Per-ticker unconditional mean raw return for each forward key. */
function baselines(obs: readonly Observation[]): Map<string, Record<string, number>> {
  const sums = new Map<string, Record<string, { s: number; n: number }>>();
  for (const o of obs) {
    let rec = sums.get(o.ticker);
    if (!rec) sums.set(o.ticker, (rec = {}));
    for (const [k, r] of Object.entries(o.fwd)) {
      if (r === null || r === undefined) continue;
      const cell = (rec[k] ??= { s: 0, n: 0 });
      cell.s += r;
      cell.n += 1;
    }
  }
  const out = new Map<string, Record<string, number>>();
  for (const [t, rec] of sums) {
    const flat: Record<string, number> = {};
    for (const [k, c] of Object.entries(rec)) flat[k] = c.s / c.n;
    out.set(t, flat);
  }
  return out;
}

export type EventStudyOptions = {
  /** Permutation iterations; 0 disables the p-value. Only run for "nextOpen". */
  permutations?: number;
  seed?: number;
};

/**
 * Pooled event study across every observation passed in (one or many tickers).
 * Returns one EventStats per (polarity x entry x horizon).
 */
export function eventStudy(
  obs: readonly Observation[],
  opts: EventStudyOptions = {},
): EventStats[] {
  const permutations = opts.permutations ?? 0;
  const rng = makeRng(opts.seed ?? 1);
  const base = baselines(obs);
  const polarities: Polarity[] = [1, 0, -1];
  const stats: EventStats[] = [];

  for (const entry of ENTRY_MODES) {
    for (const h of HORIZONS) {
      const key = fwdKey(entry, h);

      // Per-ticker pools of excess-over-baseline returns (raw sign, no direction)
      const pool = new Map<string, number[]>();
      for (const o of obs) {
        const r = o.fwd[key];
        if (r === null || r === undefined) continue;
        const b = base.get(o.ticker)?.[key] ?? 0;
        let arr = pool.get(o.ticker);
        if (!arr) pool.set(o.ticker, (arr = []));
        arr.push(r - b);
      }

      for (const p of polarities) {
        const sign = signOf(p);
        const raw: number[] = [];
        const dir: number[] = [];
        const excess: number[] = [];
        const perTicker = new Map<string, number>();
        for (const o of obs) {
          if (o.polarity !== p) continue;
          const r = o.fwd[key];
          if (r === null || r === undefined) continue;
          const b = base.get(o.ticker)?.[key] ?? 0;
          raw.push(r);
          dir.push(sign * r);
          excess.push(sign * (r - b));
          perTicker.set(o.ticker, (perTicker.get(o.ticker) ?? 0) + 1);
        }
        const n = dir.length;
        const edge = mean(excess);
        const sd = stdev(dir);

        // Permutation test: draw the same number of random days per ticker,
        // apply the same sign, compare mean excess to the observed edge.
        let pValue: number | null = null;
        if (permutations > 0 && entry === "nextOpen" && p !== 0 && n > 0) {
          let atLeast = 0;
          for (let it = 0; it < permutations; it++) {
            let s = 0;
            for (const [t, cnt] of perTicker) {
              const arr = pool.get(t);
              if (!arr || arr.length === 0) continue;
              for (let j = 0; j < cnt; j++) s += arr[Math.floor(rng() * arr.length)];
            }
            // Two-sided: a strongly NEGATIVE edge (an inverse / contrarian
            // signal) is just as non-random as a positive one.
            if (Math.abs(s / n) >= Math.abs(edge)) atLeast++;
          }
          // +1 smoothing: a permutation p-value is never exactly 0.
          pValue = (atLeast + 1) / (permutations + 1);
        }

        stats.push({
          polarity: p,
          horizon: h,
          entry,
          n,
          meanRaw: mean(raw),
          meanDirectional: mean(dir),
          medianDirectional: median(dir),
          hitRate: n === 0 ? NaN : dir.filter((x) => x > 0).length / n,
          stdevDirectional: sd,
          tStat: n > 1 && sd > 0 ? mean(dir) / (sd / Math.sqrt(n)) : NaN,
          edge,
          pValue,
        });
      }
    }
  }
  return stats;
}

/** Same pooled study, split by calendar year of the signal bar. */
export function eventStudyByYear(
  obs: readonly Observation[],
): Record<string, EventStats[]> {
  const years = [...new Set(obs.map((o) => o.date.slice(0, 4)))].sort();
  const out: Record<string, EventStats[]> = {};
  for (const y of years) {
    out[y] = eventStudy(obs.filter((o) => o.date.startsWith(y)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Strategy simulation                                                 */
/* ------------------------------------------------------------------ */

export type StrategyConfig = {
  name: string;
  /** Sessions to hold after a signal; null = hold until an opposite signal. */
  holdDays: number | null;
  /** false: Reverse only exits longs; true: Reverse opens a short. */
  allowShort: boolean;
  /** One-way cost per unit of position change, in basis points. */
  costBps: number;
  /** Noise Floor as a multiple of the 20-day average volume (default 0.10). */
  noiseFloorRatio?: number;
  /** Fade the signal: Drive opens a short, Reverse opens a long. */
  invert?: boolean;
  /** Which raw signals to act on (default "both"). */
  sides?: "both" | "drive" | "reverse";
};

export type Trade = {
  direction: 1 | -1;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  sessionsHeld: number;
  /** Net of round-trip costs. */
  returnPct: number;
};

export type PerfMetrics = {
  days: number;
  totalReturn: number;
  cagr: number;
  annVol: number;
  sharpe: number;
  maxDrawdown: number;
};

export type TradeMetrics = {
  trades: number;
  winRate: number;
  /** Mean net return per trade. */
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  /** Gross wins / gross losses; null when there are no losses. */
  profitFactor: number | null;
  avgSessionsHeld: number;
};

export type StrategyResult = {
  config: StrategyConfig;
  /** Dates and daily net returns from the first tradable session onward. */
  dates: string[];
  returns: number[];
  perf: PerfMetrics;
  tradeMetrics: TradeMetrics;
  trades: Trade[];
  /** Per-session flag (aligned with dates/returns): was any position held. */
  exposedByDay: boolean[];
  /** Share of sessions with any position. */
  exposure: number;
  /** One-way position change per year (1 = fully turning over once a year). */
  turnoverPerYear: number;
  buyHold: PerfMetrics;
};

/** Metrics for a daily return series (rf = 0, 252-day year). */
export function perfMetrics(returns: readonly number[]): PerfMetrics {
  const days = returns.length;
  if (days === 0) {
    return { days: 0, totalReturn: 0, cagr: 0, annVol: 0, sharpe: 0, maxDrawdown: 0 };
  }
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = equity / peak - 1;
    if (dd < maxDd) maxDd = dd;
  }
  const sd = stdev(returns);
  const m = mean(returns);
  const years = days / TRADING_DAYS_PER_YEAR;
  return {
    days,
    totalReturn: equity - 1,
    cagr: equity > 0 && years > 0 ? Math.pow(equity, 1 / years) - 1 : -1,
    annVol: Number.isFinite(sd) ? sd * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0,
    maxDrawdown: maxDd,
  };
}

export function tradeMetrics(trades: readonly Trade[]): TradeMetrics {
  const n = trades.length;
  if (n === 0) {
    return {
      trades: 0,
      winRate: NaN,
      expectancy: NaN,
      avgWin: NaN,
      avgLoss: NaN,
      profitFactor: null,
      avgSessionsHeld: NaN,
    };
  }
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);
  const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
  return {
    trades: n,
    winRate: wins.length / n,
    expectancy: mean(trades.map((t) => t.returnPct)),
    avgWin: wins.length ? grossWin / wins.length : NaN,
    avgLoss: losses.length ? -grossLoss / losses.length : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgSessionsHeld: mean(trades.map((t) => t.sessionsHeld)),
  };
}

/**
 * Simulate the signal on one ticker. 1x notional, no leverage, no borrow cost.
 *
 * Per session i:
 *   overnight  close[i-1] -> open[i]   earns the position held overnight
 *   at the open: act on the signal from bar i-1 (next-open fill, with costs)
 *   intraday   open[i] -> close[i]     earns the (possibly new) position
 *   at the close: fixed-length holds expire here (known in advance, with costs)
 */
export function runStrategy(
  bars: readonly Bar[],
  cfg: StrategyConfig,
): StrategyResult {
  if (cfg.holdDays !== null && (!Number.isInteger(cfg.holdDays) || cfg.holdDays < 1)) {
    throw new BacktestInputError("holdDays must be null or an integer >= 1.");
  }
  if (!Number.isFinite(cfg.costBps) || cfg.costBps < 0) {
    throw new BacktestInputError("costBps must be a finite number >= 0.");
  }
  const series = computePolaritySeries(bars, { noiseFloorRatio: cfg.noiseFloorRatio });
  const cost = cfg.costBps / 10_000;
  const sides = cfg.sides ?? "both";
  const n = bars.length;
  const start = VOLUME_MA_WINDOW; // first session a signal could be filled on

  let pos: -1 | 0 | 1 = 0;
  let entryDay = -1;
  type OpenTrade = { dir: 1 | -1; date: string; price: number; day: number };
  // `as` keeps TS from narrowing this to `null`: it is reassigned in closures.
  let open = null as OpenTrade | null;
  const trades: Trade[] = [];
  const dates: string[] = [];
  const returns: number[] = [];
  const exposedByDay: boolean[] = [];
  let absTraded = 0;

  const closeTrade = (price: number, date: string, day: number) => {
    if (!open) return;
    trades.push({
      direction: open.dir,
      entryDate: open.date,
      exitDate: date,
      entryPrice: open.price,
      exitPrice: price,
      sessionsHeld: day - open.day,
      returnPct: open.dir * (price / open.price - 1) - 2 * cost,
    });
    open = null;
  };

  for (let i = 0; i < n; i++) {
    let f = 1;
    const startedFlat = pos === 0;

    // overnight leg
    if (i > 0) f *= 1 + pos * (bars[i].open / bars[i - 1].close - 1);

    // act on the signal known at the close of the previous bar
    if (i >= 1) {
      const raw = series[i - 1].polarity;
      const acted: Polarity =
        (sides === "drive" && raw === -1) || (sides === "reverse" && raw === 1) ? 0 : raw;
      const sig: Polarity = cfg.invert ? ((acted === 0 ? 0 : -acted) as Polarity) : acted;
      if (sig !== 0) {
        const desired: -1 | 0 | 1 = sig < 0 && !cfg.allowShort ? 0 : sig;
        if (desired !== pos) {
          const delta = Math.abs(desired - pos);
          f *= 1 - delta * cost;
          absTraded += delta;
          if (pos !== 0) closeTrade(bars[i].open, bars[i].date, i);
          pos = desired;
          if (pos !== 0) {
            open = { dir: pos, date: bars[i].date, price: bars[i].open, day: i };
            entryDay = i;
          }
        } else if (pos !== 0) {
          entryDay = i; // same-direction signal re-confirms and restarts the clock
        }
      }
    }

    // intraday leg
    f *= 1 + pos * (bars[i].close / bars[i].open - 1);
    const exposed = !startedFlat || pos !== 0;

    // fixed-length hold expires at this close
    if (pos !== 0 && cfg.holdDays !== null && i - entryDay + 1 >= cfg.holdDays) {
      f *= 1 - Math.abs(pos) * cost;
      absTraded += 1;
      closeTrade(bars[i].close, bars[i].date, i + 1);
      pos = 0;
    }

    if (i >= start) {
      dates.push(bars[i].date);
      returns.push(f - 1);
      exposedByDay.push(exposed);
    }
  }

  // Mark any still-open trade to the final close (no extra cost: not realised).
  if (open) {
    const o: OpenTrade = open;
    trades.push({
      direction: o.dir,
      entryDate: o.date,
      exitDate: bars[n - 1].date,
      entryPrice: o.price,
      exitPrice: bars[n - 1].close,
      sessionsHeld: n - 1 - o.day + 1,
      returnPct: o.dir * (bars[n - 1].close / o.price - 1) - cost,
    });
  }

  const bh: number[] = [];
  for (let i = start; i < n; i++) bh.push(bars[i].close / bars[i - 1].close - 1);

  const days = returns.length;
  return {
    config: cfg,
    dates,
    returns,
    perf: perfMetrics(returns),
    tradeMetrics: tradeMetrics(trades),
    trades,
    exposedByDay,
    exposure: days ? exposedByDay.filter(Boolean).length / days : 0,
    turnoverPerYear: days ? absTraded / (days / TRADING_DAYS_PER_YEAR) : 0,
    buyHold: perfMetrics(bh),
  };
}

/* ------------------------------------------------------------------ */
/* Portfolio roll-up                                                   */
/* ------------------------------------------------------------------ */

/**
 * Equal-weight, daily-rebalanced blend of several return series, aligned by
 * date. On each date the mean is taken over the tickers that traded that day.
 */
export function equalWeightPortfolio(
  series: ReadonlyArray<{ dates: readonly string[]; returns: readonly number[] }>,
): { dates: string[]; returns: number[] } {
  const acc = new Map<string, { s: number; n: number }>();
  for (const s of series) {
    s.dates.forEach((d, i) => {
      const cell = acc.get(d) ?? { s: 0, n: 0 };
      cell.s += s.returns[i];
      cell.n += 1;
      acc.set(d, cell);
    });
  }
  const dates = [...acc.keys()].sort();
  return { dates, returns: dates.map((d) => acc.get(d)!.s / acc.get(d)!.n) };
}

/** Buy & hold daily returns from the first tradable session, per bar array. */
export function buyHoldSeries(bars: readonly Bar[]): { dates: string[]; returns: number[] } {
  const dates: string[] = [];
  const returns: number[] = [];
  for (let i = VOLUME_MA_WINDOW; i < bars.length; i++) {
    dates.push(bars[i].date);
    returns.push(bars[i].close / bars[i - 1].close - 1);
  }
  return { dates, returns };
}

/**
 * Re-score a finished strategy on a sub-window of dates (inclusive bounds,
 * ISO strings). Positions carry in from before `from` exactly as they would
 * have live, so this is the honest "what happened in the hold-out" number.
 */
export function windowResult(
  r: StrategyResult,
  from: string,
  to = "9999-12-31",
): { perf: PerfMetrics; trade: TradeMetrics; exposure: number; days: number } {
  const idx: number[] = [];
  r.dates.forEach((d, i) => {
    if (d >= from && d <= to) idx.push(i);
  });
  const rets = idx.map((i) => r.returns[i]);
  const trades = r.trades.filter((t) => t.entryDate >= from && t.entryDate <= to);
  return {
    perf: perfMetrics(rets),
    trade: tradeMetrics(trades),
    exposure: idx.length ? idx.filter((i) => r.exposedByDay[i]).length / idx.length : 0,
    days: idx.length,
  };
}

/** A dated return series restricted to a date window. */
export function windowSeries(
  s: { dates: readonly string[]; returns: readonly number[] },
  from: string,
  to = "9999-12-31",
): { dates: string[]; returns: number[] } {
  const dates: string[] = [];
  const returns: number[] = [];
  s.dates.forEach((d, i) => {
    if (d >= from && d <= to) {
      dates.push(d);
      returns.push(s.returns[i]);
    }
  });
  return { dates, returns };
}
