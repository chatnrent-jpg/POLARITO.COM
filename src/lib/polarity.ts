/**
 * Polarity engine (frontend) — Net Volume formula.
 *
 *   Net Volume
 *     Green candle (close > open): +Volume   (all buying)
 *     Red candle   (close < open): -Volume   (all selling)
 *     Flat candle  (close = open): CLV * Volume, where
 *         CLV = ((Close - Low) - (High - Close)) / (High - Low)
 *         (a zero-range bar has CLV = 0, so Net Volume = 0)
 *
 *   Noise Floor = 20-day average volume * 0.10
 *     The 20-day average is the trailing 20 bars INCLUDING the current day.
 *
 *   Polarity gate (strict inequalities)
 *     +1 Drive   : Net Volume >  +Noise Floor
 *     -1 Reverse : Net Volume <  -Noise Floor
 *      0 Neutral : otherwise (inside the boundaries, or not enough history)
 *
 * Justice: malformed bars are rejected with `InvalidBarsError`; this module
 * never produces a Drive/Reverse state from data it cannot trust.
 */

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

export type Polarity = 1 | 0 | -1;

export type Bar = {
  /** ISO date, YYYY-MM-DD. Bars must be strictly ascending by date. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandleKind = "green" | "red" | "flat";

export type DayResult = {
  date: string;
  kind: CandleKind;
  /** That day's closing price (used for simulated order pricing). */
  close: number;
  volume: number;
  netVolume: number;
  /** Trailing 20-bar average volume, or null while history is < 20 bars. */
  avgVolume: number | null;
  /** avgVolume * 0.10, or null while history is < 20 bars. */
  noiseFloor: number | null;
  polarity: Polarity;
  /** false while fewer than 20 bars of history exist (polarity forced to 0). */
  ready: boolean;
};

export const VOLUME_MA_WINDOW = 20;
export const NOISE_FLOOR_RATIO = 0.1;

/**
 * Hard application boundary for the chart time-series selector.
 * This is the ONLY set of views the chart can ever show. Frozen at runtime and
 * narrowed at compile time, so no other view can be added by a caller.
 */
export const TIMEFRAMES = Object.freeze(["1D", "1W", "1M", "3M", "1Y"] as const);

export type Timeframe = (typeof TIMEFRAMES)[number];

export const DEFAULT_TIMEFRAME: Timeframe = "1D";

/**
 * Trading days shown per view. The engine works on daily bars, so "1D" is the
 * latest single session, "1W" = 5, "1M" = 21, "3M" = 63, "1Y" = 252.
 */
export const TIMEFRAME_DAYS: Readonly<Record<Timeframe, number>> = Object.freeze({
  "1D": 1,
  "1W": 5,
  "1M": 21,
  "3M": 63,
  "1Y": 252,
});

export function isTimeframe(value: unknown): value is Timeframe {
  return (
    typeof value === "string" &&
    (TIMEFRAMES as readonly string[]).includes(value)
  );
}

/** Runtime guard: anything outside the five allowed views falls back to the default. */
export function coerceTimeframe(value: unknown): Timeframe {
  return isTimeframe(value) ? value : DEFAULT_TIMEFRAME;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export class InvalidBarsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBarsError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws InvalidBarsError unless `bars` is a clean, chronological OHLCV array. */
export function validateBars(bars: readonly Bar[]): void {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new InvalidBarsError("No bars provided.");
  }
  let prevDate = "";
  bars.forEach((b, i) => {
    const where = `Bar ${i}${b && typeof b.date === "string" ? ` (${b.date})` : ""}`;
    if (!b || typeof b.date !== "string" || !ISO_DATE.test(b.date)) {
      throw new InvalidBarsError(`${where}: date must be YYYY-MM-DD.`);
    }
    for (const k of ["open", "high", "low", "close", "volume"] as const) {
      if (typeof b[k] !== "number" || !Number.isFinite(b[k])) {
        throw new InvalidBarsError(`${where}: ${k} is not a finite number.`);
      }
    }
    if (b.volume < 0) throw new InvalidBarsError(`${where}: negative volume.`);
    if (b.low <= 0) throw new InvalidBarsError(`${where}: non-positive price.`);
    if (b.high < b.low) throw new InvalidBarsError(`${where}: high < low.`);
    if (b.open < b.low || b.open > b.high || b.close < b.low || b.close > b.high) {
      throw new InvalidBarsError(`${where}: open/close outside the high-low range.`);
    }
    if (b.date <= prevDate) {
      throw new InvalidBarsError(`${where}: bars must be strictly chronological.`);
    }
    prevDate = b.date;
  });
}

/* ------------------------------------------------------------------ */
/* Core formula                                                        */
/* ------------------------------------------------------------------ */

export function candleKind(bar: Bar): CandleKind {
  if (bar.close > bar.open) return "green";
  if (bar.close < bar.open) return "red";
  return "flat";
}

/** Close Location Value in [-1, 1]; 0 for a zero-range bar. */
export function closeLocationValue(bar: Bar): number {
  const range = bar.high - bar.low;
  if (range === 0) return 0;
  return (bar.close - bar.low - (bar.high - bar.close)) / range;
}

export function netVolume(bar: Bar): number {
  switch (candleKind(bar)) {
    case "green":
      return bar.volume;
    case "red":
      return -bar.volume;
    case "flat":
      return closeLocationValue(bar) * bar.volume;
  }
}

/** The polarity gate. Strict inequalities: sitting exactly on the floor is Neutral. */
export function gate(net: number, noiseFloor: number): Polarity {
  if (net > noiseFloor) return 1;
  if (net < -noiseFloor) return -1;
  return 0;
}

/**
 * Run the engine over a chronological bar array. Returns one DayResult per bar.
 * Throws InvalidBarsError on malformed input.
 */
export function computePolaritySeries(bars: readonly Bar[]): DayResult[] {
  validateBars(bars);

  const results: DayResult[] = [];
  let windowSum = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    windowSum += bar.volume;
    if (i >= VOLUME_MA_WINDOW) windowSum -= bars[i - VOLUME_MA_WINDOW].volume;

    const net = netVolume(bar);
    const ready = i >= VOLUME_MA_WINDOW - 1;
    const avgVolume = ready ? windowSum / VOLUME_MA_WINDOW : null;
    const noiseFloor = avgVolume === null ? null : avgVolume * NOISE_FLOOR_RATIO;

    results.push({
      date: bar.date,
      kind: candleKind(bar),
      close: bar.close,
      volume: bar.volume,
      netVolume: net,
      avgVolume,
      noiseFloor,
      polarity: noiseFloor === null ? 0 : gate(net, noiseFloor),
      ready,
    });
  }
  return results;
}

/** Latest day's result (what drives the Transmission). */
export function latestResult(results: readonly DayResult[]): DayResult {
  if (results.length === 0) throw new InvalidBarsError("No results.");
  return results[results.length - 1];
}

/** The slice of results the chart shows for a timeframe (always <= 252 days). */
export function windowFor(
  results: readonly DayResult[],
  timeframe: Timeframe,
): DayResult[] {
  const days = TIMEFRAME_DAYS[coerceTimeframe(timeframe)];
  return results.slice(-days);
}

/* ------------------------------------------------------------------ */
/* Presentation metadata                                               */
/* ------------------------------------------------------------------ */

export type PolarityMeta = {
  value: Polarity;
  label: "Drive" | "Neutral" | "Reverse";
  gear: "D" | "N" | "R";
  display: "+1" | "0" | "-1";
  /** hex used for SVG strokes/fills */
  hex: string;
  /** Tailwind class bundles (full literals so Tailwind can detect them) */
  text: string;
  bg: string;
  border: string;
  glow: string;
};

export const POLARITY_META: Readonly<Record<"1" | "0" | "-1", PolarityMeta>> =
  Object.freeze({
    "1": {
      value: 1,
      label: "Drive",
      gear: "D",
      display: "+1",
      hex: "#22c55e",
      text: "text-green-400",
      bg: "bg-green-500",
      border: "border-green-500",
      glow: "shadow-[0_0_40px_rgba(34,197,94,0.45)]",
    },
    "0": {
      value: 0,
      label: "Neutral",
      gear: "N",
      display: "0",
      hex: "#71717a",
      text: "text-zinc-400",
      bg: "bg-zinc-500",
      border: "border-zinc-500",
      glow: "shadow-[0_0_30px_rgba(113,113,122,0.35)]",
    },
    "-1": {
      value: -1,
      label: "Reverse",
      gear: "R",
      display: "-1",
      hex: "#ef4444",
      text: "text-red-400",
      bg: "bg-red-500",
      border: "border-red-500",
      glow: "shadow-[0_0_40px_rgba(239,68,68,0.45)]",
    },
  });

export function metaFor(polarity: Polarity): PolarityMeta {
  return POLARITY_META[String(polarity) as "1" | "0" | "-1"];
}
