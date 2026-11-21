/**
 * Settings for the live stock pick and the manual live buy, read from the server environment.
 * Split out of broker/liveConfig.ts so the live switches there (opt-in, trading-enabled, kill switch,
 * keys) do not depend on the stock-runner code. This file goes away with the pick runner.
 */
import type { BrokerEnv } from "@/lib/broker/config";
import { LIVE_LIMITS } from "@/lib/liveLimits";
import { normalizeTicker } from "@/lib/ticker";

const MAX_WATCHLIST = 10;

/** Alpaca allows margin and short selling only from $2,000 of equity. */
export const LIVE_SHORT_MIN_EQUITY = 2_000;
export const DEFAULT_LIVE_QTY = 1;
export const DEFAULT_LIVE_MAX_POSITION_PCT = LIVE_LIMITS.perPositionCapPct;
export const DEFAULT_LIVE_DAILY_LOSS_PCT = LIVE_LIMITS.dailyStopPct;
export const DEFAULT_LIVE_PICK_START = "10:00";
export const DEFAULT_LIVE_FLATTEN_AT = "15:55";

export type LongOnlyFallback = "aside" | "next";

export type LiveSettings = {
  watchlist: string[];
  /** Shares per entry, before the position cap and cash reduce it. */
  quantity: number;
  /** Max notional of one position as a percent of equity (the live cap, never above LIVE_LIMITS.perPositionCapPct). */
  maxPositionPct: number;
  /** Max held positions plus working orders at once (LIVE_LIMITS.maxPositions). */
  maxPositions: number;
  /** Flatten and stand aside once the account is down this percent on the day. */
  dailyLossPct: number;
  /** Minutes after midnight New York before the first entry of the day may be picked. */
  pickStartMinutes: number;
  /** Minutes after midnight New York at which the position is flattened and entries stop; null = hold overnight. */
  flattenAtMinutes: number | null;
  /**
   * What to do when a Reverse candidate ranks above a Drive one but shorting is not allowed:
   * "aside" stands aside for the day, "next" takes the next eligible Drive stock.
   */
  longOnlyFallback: LongOnlyFallback;
};

function parseClock(raw: string, name: string, min: number, max: number): number | { error: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return { error: `${name} must look like HH:MM (New York time).` };
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 23 || Number(m[2]) > 59 || minutes < min || minutes > max) {
    return { error: `${name} must be between ${fmt(min)} and ${fmt(max)} New York.` };
  }
  return minutes;
}
const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function liveSettings(env: BrokerEnv): { ok: true; settings: LiveSettings } | { ok: false; error: string } {
  const rawList = (env.POLARITO_LIVE_WATCHLIST ?? "").trim();
  if (rawList === "") return { ok: false, error: "POLARITO_LIVE_WATCHLIST is empty. Nothing to trade." };
  const watchlist: string[] = [];
  for (const part of rawList.split(/[\s,]+/).filter(Boolean)) {
    const t = normalizeTicker(part);
    if (!t) return { ok: false, error: `POLARITO_LIVE_WATCHLIST has an invalid ticker: "${part.slice(0, 12)}".` };
    if (!watchlist.includes(t)) watchlist.push(t);
  }
  if (watchlist.length > MAX_WATCHLIST) {
    return { ok: false, error: `POLARITO_LIVE_WATCHLIST allows at most ${MAX_WATCHLIST} tickers.` };
  }

  const quantity = Number((env.POLARITO_LIVE_QTY ?? String(DEFAULT_LIVE_QTY)).trim());
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000) {
    return { ok: false, error: "POLARITO_LIVE_QTY must be a whole number from 1 to 1000." };
  }
  const cap = Number((env.POLARITO_LIVE_MAX_POSITION_PCT ?? String(DEFAULT_LIVE_MAX_POSITION_PCT)).trim());
  if (!Number.isFinite(cap) || cap < 5 || cap > LIVE_LIMITS.perPositionCapPct) {
    return { ok: false, error: `POLARITO_LIVE_MAX_POSITION_PCT must be between 5 and ${LIVE_LIMITS.perPositionCapPct} (it can only lower the ${LIVE_LIMITS.perPositionCapPct}% per-position limit).` };
  }
  // A bad stop value falls back to the strict 1% rather than loosening the stop.
  const lossRaw = Number((env.POLARITO_LIVE_DAILY_LOSS_PCT ?? "").trim());
  const dailyLossPct =
    env.POLARITO_LIVE_DAILY_LOSS_PCT !== undefined &&
    env.POLARITO_LIVE_DAILY_LOSS_PCT.trim() !== "" &&
    Number.isFinite(lossRaw) &&
    lossRaw >= 0.25 &&
    lossRaw <= 10
      ? lossRaw
      : DEFAULT_LIVE_DAILY_LOSS_PCT;

  const start = parseClock(env.POLARITO_LIVE_PICK_START ?? DEFAULT_LIVE_PICK_START, "POLARITO_LIVE_PICK_START", 9 * 60 + 30, 15 * 60 + 30);
  if (typeof start !== "number") return { ok: false, error: start.error };

  const flattenRaw = (env.POLARITO_LIVE_FLATTEN_AT ?? DEFAULT_LIVE_FLATTEN_AT).trim();
  let flattenAtMinutes: number | null = null;
  if (flattenRaw.toLowerCase() !== "off") {
    const f = parseClock(flattenRaw, "POLARITO_LIVE_FLATTEN_AT", 12 * 60, 15 * 60 + 59);
    if (typeof f !== "number") return { ok: false, error: f.error };
    flattenAtMinutes = f;
  }

  const fallback = (env.POLARITO_LIVE_LONG_ONLY_FALLBACK ?? "aside").trim().toLowerCase();
  if (fallback !== "aside" && fallback !== "next") {
    return { ok: false, error: 'POLARITO_LIVE_LONG_ONLY_FALLBACK must be "aside" or "next".' };
  }

  return {
    ok: true,
    settings: {
      watchlist,
      quantity,
      maxPositionPct: cap,
      maxPositions: LIVE_LIMITS.maxPositions,
      dailyLossPct,
      pickStartMinutes: start,
      flattenAtMinutes,
      longOnlyFallback: fallback,
    },
  };
}
