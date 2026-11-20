/**
 * Chart bars.
 *
 *   1D  one bar: the latest session (unchanged).
 *   1W  one real WEEKLY candle per ISO week      1M  one per calendar month
 *   3M  one per calendar quarter                 1Y  one per calendar year
 *
 * A period bar is built from the real daily bars of its period (periodCandles.ts):
 * open of the first, high of the max, low of the min, close of the last, volume
 * summed. It is then read with the SAME engine rule a single day uses: the
 * engine's own `netVolume` of that candle (green = +volume, red = -volume, flat =
 * close-location x volume) gated by `gate` against a Noise Floor. The period's
 * floor is the sum of its days' floors (each is 10% of the trailing 20-day
 * average volume), the same number scaled to the period. A period with any day
 * that lacks 20 bars of history stays Neutral with no floor, exactly as a single
 * day would. Only the current period's bar is live; finished periods never move.
 */
import { gate, netVolume, type DayResult, type Polarity, type Timeframe } from "@/lib/polarity";
import {
  aggregatePeriods,
  MAX_PERIODS,
  weekStart,
  type Period,
} from "@/lib/periodCandles";
import {
  classifySentiment,
  type SentimentByDate,
} from "@/lib/sentimentEngine";
import type { Bar } from "@/lib/polarity";

export { weekStart };

export type BucketMode = "day" | Period;

export const BUCKET_MODE: Readonly<Record<Timeframe, BucketMode>> = Object.freeze({
  "1D": "day",
  "1W": "week",
  "1M": "month",
  "3M": "quarter",
  "1Y": "year",
});

export type BucketCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Bucket = {
  key: string;
  mode: BucketMode;
  /** Human label: a date, a date range, a month, a quarter or a year. */
  label: string;
  /** Trading days (ISO dates) inside this bar. */
  dates: string[];
  netVolume: number;
  noiseFloor: number | null;
  polarity: Polarity;
  /** Real OHLC + summed volume of a period bar. Absent on single-day bars. */
  candle?: BucketCandle;
  /** Period bars only: true while the period is still running (the only bar that changes). */
  live?: boolean;
};

export type BucketSentiment = {
  polarity: Polarity;
  velocity: number;
  /** false when no day in the bar has a real reading from the live feed. */
  live: boolean;
  positiveHits: number;
  negativeHits: number;
  articles: number;
};

const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

function labelFor(mode: BucketMode, dates: string[], key: string): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  switch (mode) {
    case "day":
      return fmtDate(first, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    case "week": {
      const a = fmtDate(first, { month: "short", day: "numeric" });
      const b = fmtDate(last, { month: "short", day: "numeric", year: "numeric" });
      return first === last ? b : `${a} – ${b}`;
    }
    case "month":
      return fmtDate(first, { month: "long", year: "numeric" });
    case "quarter": {
      const q = Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1;
      return `Q${q} ${key.slice(0, 4)}`;
    }
    case "year":
      return key.slice(0, 4);
  }
}

/** One bar per trading day, carrying the engine's own numbers untouched. */
export function bucketsFor(view: readonly DayResult[]): Bucket[] {
  return view.map((d) => ({
    key: d.date,
    mode: "day" as const,
    label: labelFor("day", [d.date], d.date),
    dates: [d.date],
    netVolume: d.netVolume,
    noiseFloor: d.noiseFloor,
    polarity: d.polarity,
  }));
}

/**
 * Real period candles for 1W / 1M / 3M / 1Y. `bars` are the real daily bars (recent
 * live bars merged over older history) and `results` is the engine's series over
 * those same bars (for each day's Noise Floor). Only periods the loaded history
 * fully covers are returned, newest `MAX_PERIODS` of them.
 */
export function periodBucketsFor(
  bars: readonly Bar[],
  results: readonly DayResult[],
  timeframe: Timeframe,
  todayEt: string,
): Bucket[] {
  const mode = BUCKET_MODE[timeframe];
  if (mode === "day") return [];
  const floorByDate = new Map<string, number | null>();
  for (const r of results) floorByDate.set(r.date, r.noiseFloor);

  return aggregatePeriods(bars, mode, todayEt)
    .filter((c) => c.covered)
    .slice(-MAX_PERIODS[mode])
    .map((c) => {
      const floors = c.dates.map((d) => floorByDate.get(d) ?? null);
      const allReady = floors.every((f) => f !== null);
      const noiseFloor = allReady ? floors.reduce<number>((s, f) => s + (f as number), 0) : null;
      const net = netVolume({
        date: c.dates[c.dates.length - 1],
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
      return {
        key: c.key,
        mode,
        label: labelFor(mode, c.dates, c.key),
        dates: c.dates,
        netVolume: net,
        noiseFloor,
        polarity: noiseFloor === null ? 0 : gate(net, noiseFloor),
        candle: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
        live: c.live,
      };
    });
}

/**
 * News sentiment for one bar. A single day uses that day's stored reading; a
 * grouped bar pools the keyword hits of its live days and applies the same
 * rule (thin evidence or a balanced tone is Neutral). No live day => Neutral,
 * flagged `live: false`.
 */
export function sentimentForBucket(
  bucket: Bucket,
  byDate: SentimentByDate | undefined,
): BucketSentiment {
  let positiveHits = 0;
  let negativeHits = 0;
  let articles = 0;
  let live = false;
  for (const date of bucket.dates) {
    const day = byDate?.[date];
    if (day && day.source === "news") {
      live = true;
      positiveHits += day.positiveHits;
      negativeHits += day.negativeHits;
      articles += day.articles;
    }
  }
  if (bucket.dates.length === 1) {
    const day = byDate?.[bucket.dates[0]];
    return {
      polarity: day?.polarity ?? 0,
      velocity: day?.velocity ?? 0,
      live,
      positiveHits,
      negativeHits,
      articles,
    };
  }
  if (!live) return { polarity: 0, velocity: 0, live, positiveHits, negativeHits, articles };
  const { polarity, velocity } = classifySentiment(positiveHits, negativeHits);
  return { polarity, velocity, live, positiveHits, negativeHits, articles };
}
