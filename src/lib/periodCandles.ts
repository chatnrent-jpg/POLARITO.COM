/**
 * Real period candles for the chart's 1W / 1M / 3M / 1Y views.
 *
 * A period candle is built from the REAL daily bars inside one calendar period:
 *   open   = open of the first bar        high = highest high
 *   close  = close of the last bar        low  = lowest low
 *   volume = sum of the bars' volume
 *
 * Periods: ISO week (Monday start), calendar month, calendar quarter, calendar
 * year. Bar dates are the New York session dates the data feed already stamps,
 * so the boundaries are ET market days; no timezone math happens here.
 *
 * Only the CURRENT period can change (`live`): every finished period is a pure
 * function of bars that no longer change, so it never moves. A period is only
 * returned as `covered` when the loaded history reaches back to its start, so a
 * half-loaded first period is never drawn as if it were a full candle.
 *
 * Pure: no network, no clock, no storage. This module never touches the polarity
 * engine; the chart feeds the candles through the engine's own functions.
 */
import type { Bar } from "@/lib/polarity";

export type Period = "week" | "month" | "quarter" | "year";

/** Slack for a period that opens on a weekend or holiday (Jan 1 + weekend = up to 4 days). */
export const COVERAGE_SLACK_DAYS = 4;

export type PeriodCandle = {
  key: string;
  period: Period;
  /** First and last CALENDAR day of the period. */
  start: string;
  end: string;
  /** Trading days (ISO dates) inside the candle. */
  dates: string[];
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** The loaded history reaches the start of this period. */
  covered: boolean;
  /** The period has not ended yet: the only candle allowed to change. */
  live: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing this ISO date. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10); // month is 1-12 => day 0 of next
}

export function periodStart(iso: string, period: Period): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  switch (period) {
    case "week":
      return weekStart(iso);
    case "month":
      return `${y}-${pad2(m)}-01`;
    case "quarter":
      return `${y}-${pad2(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
    case "year":
      return `${y}-01-01`;
  }
}

export function periodEnd(iso: string, period: Period): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  switch (period) {
    case "week":
      return addDays(weekStart(iso), 6);
    case "month":
      return lastDayOfMonth(y, m);
    case "quarter":
      return lastDayOfMonth(y, Math.floor((m - 1) / 3) * 3 + 3);
    case "year":
      return `${y}-12-31`;
  }
}

/** Stable key: the period's first calendar day, so keys sort chronologically. */
export function periodKey(iso: string, period: Period): string {
  return periodStart(iso, period);
}

/**
 * Group chronological daily bars into period candles (oldest first), including
 * partial first periods (flagged `covered: false`). `todayEt` is the current New
 * York date; a period is `live` while it has not ended by then.
 */
export function aggregatePeriods(
  bars: readonly Bar[],
  period: Period,
  todayEt: string,
): PeriodCandle[] {
  if (bars.length === 0 || !ISO_DATE.test(todayEt)) return [];
  const firstLoaded = bars[0].date;
  const groups = new Map<string, Bar[]>();
  for (const b of bars) {
    const k = periodKey(b.date, period);
    const g = groups.get(k);
    if (g) g.push(b);
    else groups.set(k, [b]);
  }
  const out: PeriodCandle[] = [];
  for (const [key, days] of groups) {
    const start = key;
    const end = periodEnd(days[0].date, period);
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const d of days) {
      if (d.high > high) high = d.high;
      if (d.low < low) low = d.low;
      volume += d.volume;
    }
    out.push({
      key,
      period,
      start,
      end,
      dates: days.map((d) => d.date),
      open: days[0].open,
      high,
      low,
      close: days[days.length - 1].close,
      volume,
      covered: firstLoaded <= addDays(start, COVERAGE_SLACK_DAYS),
      live: end >= todayEt,
    });
  }
  return out;
}
