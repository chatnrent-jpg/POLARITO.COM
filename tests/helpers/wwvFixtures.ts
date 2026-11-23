import { tradingDaysBetween } from "../../src/lib/marketCalendar";
import type { Bar } from "../../src/lib/polarity";
import type { Scenario } from "./spyDeskFixtures";

/** One daily bar: [close, volume, open?]. The open defaults to the previous close, so the candle colour follows the direction. */
export type Row = readonly [close: number, volume: number, open?: number];

/** Bars on consecutive trading sessions, the last one on `end` (default Tue 2026-11-03, which is T0 in the shared fixtures). */
export function wwvBars(rows: readonly Row[], end = "2026-11-03"): Bar[] {
  const dates = tradingDaysBetween("2026-01-01", end).slice(-rows.length);
  if (dates.length !== rows.length) throw new Error("fixture needs more sessions");
  let prev = rows[0][0];
  return rows.map(([close, volume, open], i) => {
    const o = open ?? prev;
    prev = close;
    return { date: dates[i], open: o, close, volume, high: Math.max(o, close) + 0.5, low: Math.min(o, close) - 0.5 };
  });
}

const FLAT: Row[] = Array.from({ length: 25 }, () => [100, 100] as Row);
const UP_HISTORY: Row[] = [...FLAT, [102, 150], [103, 250]];
const DOWN_HISTORY: Row[] = [...FLAT, [98, 150], [97, 250]];

/** Down wave 400 (98, 97), then up wave 700 (99, 101), last candle green: Drive. */
export const WWV_DRIVE: Scenario = { daily: wwvBars([...DOWN_HISTORY, [99, 400], [101, 300]]) };
/** Up wave 400 (102, 103), then down wave 700 (101, 99), last candle red: Reverse. */
export const WWV_REVERSE: Scenario = { daily: wwvBars([...UP_HISTORY, [101, 400], [99, 300]]) };
/** Up wave 400, then a down wave (101, 100) whose last candle opens at 98 and closes 100: a green candle in a down wave. */
export const WWV_NEUTRAL: Scenario = { daily: wwvBars([...UP_HISTORY, [101, 400], [100, 300, 98]]) };
