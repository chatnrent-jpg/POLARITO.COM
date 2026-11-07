/**
 * Chart bars. 1D / 1W / 1M show one bar per trading day. 3M groups days into
 * weekly bars and 1Y into monthly bars, so those views stay readable.
 *
 * A grouped bar uses the SAME rule as a day: the period's Net Volume (sum of the
 * daily Net Volumes) is gated against the period's Noise Floor (sum of the daily
 * floors). That is equivalent to gating the average day. A period with any day
 * that lacks 20 bars of history stays Neutral, exactly as a single day would.
 * Single-day bars pass the engine's own numbers through untouched.
 */
import { gate, type DayResult, type Polarity, type Timeframe } from "@/lib/polarity";
import {
  classifySentiment,
  type SentimentByDate,
} from "@/lib/sentimentEngine";

export type BucketMode = "day" | "week" | "month";

export const BUCKET_MODE: Readonly<Record<Timeframe, BucketMode>> = Object.freeze({
  "1D": "day",
  "1W": "day",
  "1M": "day",
  "3M": "week",
  "1Y": "month",
});

export type Bucket = {
  key: string;
  mode: BucketMode;
  /** Human label: a date, a date range, or a month. */
  label: string;
  /** Trading days (ISO dates) inside this bar. */
  dates: string[];
  netVolume: number;
  noiseFloor: number | null;
  polarity: Polarity;
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

/** Monday of the week containing this ISO date (UTC). */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function labelFor(mode: BucketMode, dates: string[]): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (mode === "day") {
    return fmtDate(first, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  if (mode === "week") {
    const a = fmtDate(first, { month: "short", day: "numeric" });
    const b = fmtDate(last, { month: "short", day: "numeric", year: "numeric" });
    return first === last ? b : `${a} – ${b}`;
  }
  return `${fmtDate(first, { month: "long", year: "numeric" })}`;
}

function groupKey(mode: BucketMode, date: string): string {
  if (mode === "week") return weekStart(date);
  if (mode === "month") return date.slice(0, 7);
  return date;
}

/** Group a window of daily results into chart bars for the given timeframe. */
export function bucketsFor(view: readonly DayResult[], timeframe: Timeframe): Bucket[] {
  const mode = BUCKET_MODE[timeframe] ?? "day";
  const groups = new Map<string, DayResult[]>();
  for (const d of view) {
    const k = groupKey(mode, d.date);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }

  return [...groups.entries()].map(([key, days]) => {
    const dates = days.map((d) => d.date);
    if (days.length === 1) {
      const d = days[0];
      return {
        key,
        mode,
        label: labelFor(mode, dates),
        dates,
        netVolume: d.netVolume,
        noiseFloor: d.noiseFloor,
        polarity: d.polarity,
      };
    }
    const netVolume = days.reduce((s, d) => s + d.netVolume, 0);
    const allReady = days.every((d) => d.noiseFloor !== null);
    const noiseFloor = allReady ? days.reduce((s, d) => s + (d.noiseFloor as number), 0) : null;
    return {
      key,
      mode,
      label: labelFor(mode, dates),
      dates,
      netVolume,
      noiseFloor,
      polarity: noiseFloor === null ? 0 : gate(netVolume, noiseFloor),
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
