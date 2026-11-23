/**
 * The readings a SPY desk shows and decides from, for either decision source:
 *   monthly desk  the four period-to-date readings M, Q, H, Y (longPolarity.ts), the decision on one of them (default M)
 *   WWV desk      ONE reading, "D": daily Weis Wave Volume (wwv.ts)
 * `DeskTimeframe` is the key of the reading the desk decides on; "D" selects the WWV source, so the key alone says which
 * source is in use. Pure: no I/O, no clock, no orders.
 */
import {
  LONG_TIMEFRAMES,
  LONG_TIMEFRAME_NAMES,
  computeLongReadings,
  isLongTimeframe,
  type LongReading,
  type LongTimeframe,
} from "@/lib/longPolarity";
import type { Bar } from "@/lib/polarity";
import { computeWwvReading, type WwvDetail } from "@/lib/wwv";

export type DeskTimeframe = LongTimeframe | "D";

export const TIMEFRAME_NAMES: Readonly<Record<DeskTimeframe, string>> = Object.freeze({ ...LONG_TIMEFRAME_NAMES, D: "Daily, WWV" });

export function isDeskTimeframe(value: unknown): value is DeskTimeframe {
  return value === "D" || isLongTimeframe(value);
}

/** The readings shown for a desk, in display order. */
export function readingKeys(timeframe: DeskTimeframe): readonly DeskTimeframe[] {
  return timeframe === "D" ? ["D"] : LONG_TIMEFRAMES;
}

export type DeskReading = Omit<LongReading, "timeframe"> & { timeframe: DeskTimeframe; wwv?: WwvDetail | null };
export type DeskReadings = Readonly<Partial<Record<DeskTimeframe, DeskReading>>>;

/** All readings of a desk as of `now`. Never throws and never guesses (an unusable reading says why). */
export function computeDeskReadings(daily: readonly Bar[], now: Date, timeframe: DeskTimeframe): DeskReadings {
  if (timeframe === "D") return { D: computeWwvReading({ daily, now }) };
  return computeLongReadings({ daily: [...daily], now });
}
