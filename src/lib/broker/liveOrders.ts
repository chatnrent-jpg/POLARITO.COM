/**
 * Live order ids and the day's state, derived from the broker's own order list
 * (no database). Alpaca never lets a client_order_id be reused, so every
 * order the live pick sends carries a unique, deterministic id:
 *
 *   entry number N                 pol-{YYYYMMDD}-e{NN}-{TICKER}
 *   manual buy (panel button)      pol-{YYYYMMDD}-m{NN}-{TICKER}        (shares the entry number sequence with e)
 *   close of entry N, attempt K    pol-{YYYYMMDD}-c{NN}-a{K}-{TICKER}   (auto close and manual close)
 *   stop-out flatten, attempt K    pol-{YYYYMMDD}-s{NN}-a{K}-{TICKER}   (also the "stopped today" marker)
 *
 * A retry or a parallel run computes the same id and is stopped by the broker's
 * uniqueness rule; the sequence only advances once an order with that id exists.
 */
import type { BrokerOrder } from "@/lib/broker/types";

export const MAX_CLOSE_ATTEMPTS = 3;

/** Orders in these states never filled and never will: their ids are spent but they do not count as "done". */
const FAILED_STATUSES = new Set(["canceled", "expired", "rejected", "done_for_day", "replaced"]);

export const isFailedStatus = (status: string): boolean => FAILED_STATUSES.has(status.toLowerCase());

const pad = (n: number) => String(n).padStart(2, "0");
export const compactDate = (isoDate: string): string => isoDate.replace(/-/g, "");

export const entryOrderId = (date: string, nn: number, ticker: string): string =>
  `pol-${compactDate(date)}-e${pad(nn)}-${ticker}`;
export const closeOrderId = (date: string, nn: number, attempt: number, ticker: string): string =>
  `pol-${compactDate(date)}-c${pad(nn)}-a${attempt}-${ticker}`;
export const manualOrderId = (date: string, nn: number, ticker: string): string =>
  `pol-${compactDate(date)}-m${pad(nn)}-${ticker}`;
export const stopOrderId = (date: string, nn: number, attempt: number, ticker: string): string =>
  `pol-${compactDate(date)}-s${pad(nn)}-a${attempt}-${ticker}`;

export type ParsedLiveId =
  | { kind: "e" | "m"; nn: number; ticker: string }
  | { kind: "c" | "s"; nn: number; attempt: number; ticker: string };

export function parseLiveOrderId(id: string, date: string): ParsedLiveId | null {
  const prefix = `pol-${compactDate(date)}-`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const e = /^([em])(\d{2})-([A-Z][A-Z.-]*)$/.exec(rest);
  if (e) return { kind: e[1] as "e" | "m", nn: Number(e[2]), ticker: e[3] };
  const cs = /^([cs])(\d{2})-a(\d+)-([A-Z][A-Z.-]*)$/.exec(rest);
  if (cs) return { kind: cs[1] as "c" | "s", nn: Number(cs[2]), attempt: Number(cs[3]), ticker: cs[4] };
  return null;
}

export type DayOrder = { order: BrokerOrder; id: ParsedLiveId };
export type CloseDayOrder = { order: BrokerOrder; id: Extract<ParsedLiveId, { kind: "c" | "s" }> };

export type DayState = {
  date: string;
  orders: DayOrder[];
  /** Highest entry number used today, automatic (e) or manual (m), 0 when none. The next entry of either kind is maxEntry + 1. */
  maxEntry: number;
  /** Entry orders today (automatic and manual) that did not fail (rejected / canceled ones are not counted). Informational only: nothing caps entries. */
  entryCount: number;
  /** Ticker of the day's first entry (a manual buy counts once it did not fail); later entries are for this stock only. null before the first entry. */
  lockTicker: string | null;
  /** A stop-out flatten order exists today: no entry for the rest of the day. */
  stoppedToday: boolean;
};

export function deriveDayState(orders: readonly BrokerOrder[], date: string): DayState {
  const parsed: DayOrder[] = [];
  for (const order of orders) {
    const id = parseLiveOrderId(order.clientOrderId, date);
    if (id) parsed.push({ order, id });
  }
  const entries = parsed.filter((p) => p.id.kind === "e" || p.id.kind === "m").sort((a, b) => a.id.nn - b.id.nn);
  // A manual buy that never went through (rejected, canceled) must not lock the day's stock.
  const locking = entries.filter((p) => p.id.kind === "e" || !isFailedStatus(p.order.status));
  return {
    date,
    orders: parsed,
    maxEntry: entries.reduce((m, p) => Math.max(m, p.id.nn), 0),
    entryCount: entries.filter((p) => !isFailedStatus(p.order.status)).length,
    lockTicker: locking.length > 0 ? locking[0].id.ticker : null,
    stoppedToday: parsed.some((p) => p.id.kind === "s"),
  };
}

/** Close/stop orders for one ticker and entry number, newest attempt last. */
export function closeOrdersFor(state: DayState, ticker: string, nn: number): CloseDayOrder[] {
  const out: CloseDayOrder[] = [];
  for (const p of state.orders) {
    if ((p.id.kind === "c" || p.id.kind === "s") && p.id.ticker === ticker && p.id.nn === nn) out.push({ order: p.order, id: p.id });
  }
  return out.sort((a, b) => a.id.attempt - b.id.attempt);
}

/** The entry number a position's closes are filed under: the day's highest entry for that ticker, or 0 (held overnight). */
export function entryNumberFor(state: DayState, ticker: string): number {
  return state.orders.reduce((m, p) => ((p.id.kind === "e" || p.id.kind === "m") && p.id.ticker === ticker ? Math.max(m, p.id.nn) : m), 0);
}

/** True when every allowed close attempt for this position has failed: no more automatic tries. */
export function closeBreakerTripped(state: DayState, ticker: string, nn: number): boolean {
  const closes = closeOrdersFor(state, ticker, nn);
  return closes.length >= MAX_CLOSE_ATTEMPTS && closes.every((c) => isFailedStatus(c.order.status));
}
