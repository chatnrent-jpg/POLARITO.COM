/**
 * The readings a SPY desk shows and decides from, for either decision source:
 *   monthly desk  the four period-to-date readings M, Q, H, Y (longPolarity.ts), the decision on one of them (default M)
 *   WWV desk      ONE reading, "D": daily Weis Wave Volume (wwv.ts)
 * The monthly desk also shows (and by default DECIDES on) the DAILY net volume reading, key "1D" (longPolarity.computeDailyNetVolume),
 * next to the four period readings; the key "1D" is distinct from "D" so the two daily sources can never be mixed up.
 * `DeskTimeframe` is the key of the reading the desk decides on; "D" selects the WWV source, so the key alone says which
 * source is in use. Pure: no I/O, no clock, no orders.
 */
import {
  DAILY_NV_TIMEFRAME,
  LONG_TIMEFRAMES,
  LONG_TIMEFRAME_NAMES,
  computeDailyNetVolume,
  computeLongReadings,
  isLongTimeframe,
  type LongReading,
  type LongTimeframe,
} from "@/lib/longPolarity";
import { addCalendarDays, etClock } from "@/lib/marketCalendar";
import type { Bar } from "@/lib/polarity";
import { WWV_HISTORY_CALENDAR_DAYS, computeWwvReading, type WwvDetail } from "@/lib/wwv";

export type DeskTimeframe = LongTimeframe | typeof DAILY_NV_TIMEFRAME | "D";

/**
 * The decision timeframe the monthly desk (/spy) uses when SPY_DECISION_TIMEFRAME is not set: the daily net volume reading.
 * To go back to Monthly as the default, change this one line to "M" (or set SPY_DECISION_TIMEFRAME=M, no code change).
 */
export const DEFAULT_SPY_DECISION_TIMEFRAME: DeskTimeframe = "1D";

export const TIMEFRAME_NAMES: Readonly<Record<DeskTimeframe, string>> = Object.freeze({ ...LONG_TIMEFRAME_NAMES, "1D": "Daily", D: "Daily, WWV" });

export function isDeskTimeframe(value: unknown): value is DeskTimeframe {
  return value === "D" || value === DAILY_NV_TIMEFRAME || isLongTimeframe(value);
}

/** The values SPY_DECISION_TIMEFRAME accepts on the monthly desk: the daily net volume reading and the four period readings (never "D": that is the WWV desk's fixed source). */
export function isSelectableDeskTimeframe(value: unknown): value is DeskTimeframe {
  return value === DAILY_NV_TIMEFRAME || isLongTimeframe(value);
}

/** The readings shown for a desk, in display order. */
export function readingKeys(timeframe: DeskTimeframe): readonly DeskTimeframe[] {
  return timeframe === "D" ? ["D"] : LONG_TIMEFRAMES;
}

/**
 * Every reading a desk SHOWS, in display order: for the monthly desk the daily net volume reading first and then the four
 * period readings, whichever of them decides; for the WWV desk only "D". (`readingKeys` above keeps its original meaning.)
 */
export function deskReadingKeys(timeframe: DeskTimeframe): readonly DeskTimeframe[] {
  return timeframe === "D" ? ["D"] : [DAILY_NV_TIMEFRAME, ...LONG_TIMEFRAMES];
}

export type DeskReading = Omit<LongReading, "timeframe"> & { timeframe: DeskTimeframe; wwv?: WwvDetail | null };
export type DeskReadings = Readonly<Partial<Record<DeskTimeframe, DeskReading>>>;

/**
 * The WWV desk also SHOWS the four period readings (M, Q, H, Y) as context. They need a longer bar history than WWV, but the WWV
 * reading must not change because of it (wave starts, the "first loaded bar" note and the bar checks all depend on where the
 * history begins), so WWV always reads exactly the window it always did: the last WWV_HISTORY_CALENDAR_DAYS calendar days.
 */
export function wwvWindow(daily: readonly Bar[], now: Date): readonly Bar[] {
  const from = addCalendarDays(etClock(now).date, -WWV_HISTORY_CALENDAR_DAYS);
  return daily.filter((b) => b.date >= from);
}

/** The context readings a desk shows next to (never instead of) its decision reading: M, Q, H, Y on the WWV desk, none on the monthly desk (it already shows them as its readings). */
export function contextReadingKeys(timeframe: DeskTimeframe): readonly LongTimeframe[] {
  return timeframe === "D" ? LONG_TIMEFRAMES : [];
}

/** Same computation and stale-bar rules as the monthly desk (computeLongReadings). Context only: nothing decides from these. */
export function computeContextReadings(daily: readonly Bar[], now: Date, timeframe: DeskTimeframe): DeskReadings {
  return timeframe === "D" ? computeLongReadings({ daily: [...daily], now }) : {};
}

/** All readings of a desk as of `now`. Never throws and never guesses (an unusable reading says why). */
export function computeDeskReadings(daily: readonly Bar[], now: Date, timeframe: DeskTimeframe): DeskReadings {
  if (timeframe === "D") return { D: computeWwvReading({ daily: wwvWindow(daily, now), now }) };
  const input = { daily: [...daily], now };
  return { ...computeLongReadings(input), [DAILY_NV_TIMEFRAME]: computeDailyNetVolume(input) };
}
