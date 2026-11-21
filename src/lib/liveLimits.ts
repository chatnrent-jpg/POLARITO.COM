/**
 * The live account's position limits, in ONE place. Every live path (pick runner, manual buy, status route,
 * panels) reads these constants; nothing else hard-codes "3" or "33".
 *
 *   maxPositions                 held positions plus working orders may never exceed this (distinct companies).
 *   perPositionCapPct            one position may cost at most this percent of equity (whole shares, floored).
 *                                POLARITO_LIVE_MAX_POSITION_PCT may only LOWER it, never raise it.
 *   totalExposureCapPct          all open positions together; 3 x 33% = 99% already fits under it.
 *   dailyStopPct                 whole-account stop against Alpaca's last_equity; flattens every position and
 *                                locks out entries until the next session.
 *   maxAutoEntriesPerTickerPerDay the automatic pick enters a ticker at most this many times a day. After a
 *                                signal-driven close (Neutral or Reverse) that ticker is done until the next
 *                                session and its slot goes to the next-ranked candidate. A manual buy is not
 *                                limited by this (it still obeys maxPositions and the cap).
 *   longOnly                     no short is ever opened, at any equity.
 *
 * Pure: no I/O, safe to import anywhere.
 */
import { companyKey } from "@/lib/pickRank";

export const LIVE_LIMITS = Object.freeze({
  maxPositions: 3,
  perPositionCapPct: 33,
  totalExposureCapPct: 100,
  dailyStopPct: 1,
  maxAutoEntriesPerTickerPerDay: 1,
  longOnly: true,
});

export type SlotUse = {
  /** Distinct companies that hold a position or a working order. */
  used: number;
  free: number;
  companies: Set<string>;
};

/**
 * How many of the `max` slots are taken. Every position counts (stock or option, on or off the watchlist)
 * and every working order counts, by company (GOOGL and GOOG are one). Counting by company means a
 * position and its own working close/entry order share one slot.
 */
export function slotUse(
  positions: readonly { ticker: string }[],
  workingOrders: readonly { ticker: string }[],
  max: number = LIVE_LIMITS.maxPositions,
): SlotUse {
  const companies = new Set<string>();
  for (const p of positions) companies.add(companyKey(p.ticker));
  for (const o of workingOrders) companies.add(companyKey(o.ticker));
  return { used: companies.size, free: Math.max(0, max - companies.size), companies };
}

export type LiveLimitsView = {
  maxPositions: number;
  perPositionCapPct: number;
  /** Same value as perPositionCapPct (kept for older readers). */
  maxPositionPct: number;
  totalExposureCapPct: number;
  dailyLossPct: number;
  longOnly: boolean;
  slotsUsed: number;
};

/** What the status route reports: the effective limits (settings may only lower the cap) and the slots in use. */
export function liveLimitsView(
  settings: { maxPositions: number; maxPositionPct: number; dailyLossPct: number } | null,
  slotsUsed: number,
): LiveLimitsView {
  const cap = settings ? settings.maxPositionPct : LIVE_LIMITS.perPositionCapPct;
  return {
    maxPositions: settings ? settings.maxPositions : LIVE_LIMITS.maxPositions,
    perPositionCapPct: cap,
    maxPositionPct: cap,
    totalExposureCapPct: LIVE_LIMITS.totalExposureCapPct,
    dailyLossPct: settings ? settings.dailyLossPct : LIVE_LIMITS.dailyStopPct,
    longOnly: LIVE_LIMITS.longOnly,
    slotsUsed,
  };
}
