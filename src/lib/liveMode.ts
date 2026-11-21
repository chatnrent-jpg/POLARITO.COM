/**
 * What the account displays should show, decided in one place (pure, no I/O).
 *
 *   sim          POLARITO_LIVE_ACCOUNT is not on: today's simulated accounts, labeled Simulated.
 *   checking     live is on, the first answer has not arrived: no numbers at all.
 *   unavailable  live is on but the account could not be read (or the last read failed): an explicit
 *                "live data unavailable" state, never stale, zero or simulated numbers.
 *   live         live is on and Alpaca answered: every figure comes from Alpaca. `ordersAllowed` says
 *                whether real orders may be sent (live trading enabled, kill switch off, keys present).
 *
 * The simulated and live numbers are never on screen together: each display picks exactly one branch.
 */
import type { LiveLimitsView } from "@/lib/liveLimits";

export type LivePosition = {
  ticker: string;
  side: "long" | "short";
  quantity: number;
  avgEntryPrice: number;
  currentPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
};

export type LiveStatus = {
  ok: boolean;
  live?: boolean;
  enabled?: boolean;
  killed?: boolean;
  configured?: boolean;
  tradingAllowed?: boolean;
  blockedReason?: string;
  error?: string;
  account?: { equity: number; lastEquity: number; cash: number; buyingPower: number };
  positions?: LivePosition[];
  manual?: { watchlist: string[]; defaultQuantity: number; error?: string };
  limits?: LiveLimitsView;
  day?: { date: string; entries: number; lockedTicker: string | null; enteredTickers?: string[]; stoppedToday: boolean };
  auto?: { available: boolean; on: boolean; reason: string; at: string | null; openPositions: number; openOrders: number };
};

export type LiveMode =
  | { kind: "sim" }
  | { kind: "checking" }
  | { kind: "unavailable"; reason: string }
  | { kind: "live"; status: LiveStatus; account: NonNullable<LiveStatus["account"]>; positions: LivePosition[]; ordersAllowed: boolean; ordersReason: string | null };

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function deriveLiveMode(optIn: boolean, status: LiveStatus | null, loadError: string | null): LiveMode {
  if (!optIn) return { kind: "sim" };
  // A failed read after a good one is not "still fine": never keep showing the old numbers as if current.
  if (loadError) return { kind: "unavailable", reason: loadError };
  if (!status) return { kind: "checking" };
  if (status.ok !== true || status.live !== true) {
    return { kind: "unavailable", reason: status.error ?? "The live account could not be read from Alpaca." };
  }
  const a = status.account;
  if (!a || !finite(a.equity) || !finite(a.lastEquity) || !finite(a.cash) || !finite(a.buyingPower) || !(a.equity >= 0)) {
    return { kind: "unavailable", reason: "The live account is not readable (no usable balances from Alpaca)." };
  }
  if (!Array.isArray(status.positions)) {
    return { kind: "unavailable", reason: "The live positions are not readable." };
  }
  const ordersAllowed = status.tradingAllowed === true;
  return {
    kind: "live",
    status,
    account: a,
    positions: status.positions,
    ordersAllowed,
    ordersReason: ordersAllowed ? null : (status.blockedReason ?? "Live trading is not enabled (POLARITO_LIVE_TRADING_ENABLED is not 1)."),
  };
}

/** Today's P&L from Alpaca's own equity vs last close equity. */
export function liveDay(account: { equity: number; lastEquity: number }): { pnl: number; pct: number | null } {
  const pnl = account.equity - account.lastEquity;
  return { pnl, pct: account.lastEquity > 0 ? (pnl / account.lastEquity) * 100 : null };
}

/** Gross stock exposure: Alpaca's market value when it sent one, else shares x average entry. */
export function liveExposure(positions: readonly LivePosition[], equity: number): { notional: number; pct: number | null } {
  const notional = positions.reduce((s, p) => s + (finite(p.marketValue) ? p.marketValue : p.quantity * p.avgEntryPrice), 0);
  return { notional, pct: equity > 0 ? (notional / equity) * 100 : null };
}
