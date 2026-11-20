/**
 * Live-cash switches, read from the server environment. Everything here is OFF
 * unless a variable is set to exactly "1"; with none of them set the app never
 * builds a live broker, never reads the ALPACA_LIVE_* keys and never contacts
 * the live host.
 *
 *   POLARITO_LIVE_ACCOUNT=1          opt in to the live account (keys + live URL). Read-only on its own.
 *   POLARITO_LIVE_TRADING_ENABLED=1  also allow real orders. Anything else = observe only.
 *   POLARITO_BROKER_KILL             the shared kill switch; it stops live orders too.
 *
 * Live keys are separate variables (ALPACA_LIVE_KEY_ID / ALPACA_LIVE_SECRET_KEY);
 * the paper keys are never used for live and the live keys are never used for paper.
 */
import { AlpacaPaperBroker } from "@/lib/broker/alpacaPaper";
import { paperBrokerConfig, type BrokerEnv, type PaperBrokerConfig } from "@/lib/broker/config";
import type { LiveBroker } from "@/lib/broker/types";
import { MAX_WATCHLIST } from "@/lib/paperRunner";
import { normalizeTicker } from "@/lib/ticker";

/** Alpaca allows margin and short selling only from $2,000 of equity. */
export const LIVE_SHORT_MIN_EQUITY = 2_000;
export const DEFAULT_LIVE_QTY = 1;
export const DEFAULT_LIVE_MAX_POSITION_PCT = 50;
export const DEFAULT_LIVE_DAILY_LOSS_PCT = 1;
export const DEFAULT_LIVE_MAX_ENTRIES = 3;
export const DEFAULT_LIVE_PICK_START = "10:00";
export const DEFAULT_LIVE_FLATTEN_AT = "15:55";

export type LongOnlyFallback = "aside" | "next";

export type LiveSettings = {
  watchlist: string[];
  /** Shares per entry, before the position cap and cash reduce it. */
  quantity: number;
  /** Max notional of one position as a percent of equity (the live cap). */
  maxPositionPct: number;
  /** Flatten and stand aside once the account is down this percent on the day. */
  dailyLossPct: number;
  /** Max entry orders per day, rejected ones included. */
  maxEntries: number;
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

export const liveOptedIn = (env: BrokerEnv): boolean => env.POLARITO_LIVE_ACCOUNT === "1";

export function liveCredentials(env: BrokerEnv): { keyId: string; secretKey: string } | null {
  const keyId = env.ALPACA_LIVE_KEY_ID?.trim();
  const secretKey = env.ALPACA_LIVE_SECRET_KEY?.trim();
  return keyId && secretKey ? { keyId, secretKey } : null;
}

/** Same shape as the paper config so the shared executor gate works unchanged. */
export function liveBrokerConfig(env: BrokerEnv): PaperBrokerConfig {
  return {
    enabled: env.POLARITO_LIVE_TRADING_ENABLED === "1",
    killed: paperBrokerConfig(env).killed,
    configured: liveCredentials(env) !== null,
  };
}

/** null unless the live opt-in is on AND the live keys exist. */
export function createLiveBroker(env: BrokerEnv): LiveBroker | null {
  if (!liveOptedIn(env)) return null;
  const creds = liveCredentials(env);
  if (!creds) return null;
  return new AlpacaPaperBroker({ ...creds, target: "live" });
}

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
  if (!Number.isFinite(cap) || cap < 5 || cap > 100) {
    return { ok: false, error: "POLARITO_LIVE_MAX_POSITION_PCT must be between 5 and 100." };
  }
  const maxEntries = Number((env.POLARITO_LIVE_MAX_ENTRIES ?? String(DEFAULT_LIVE_MAX_ENTRIES)).trim());
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10) {
    return { ok: false, error: "POLARITO_LIVE_MAX_ENTRIES must be a whole number from 1 to 10." };
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
      dailyLossPct,
      maxEntries,
      pickStartMinutes: start,
      flattenAtMinutes,
      longOnlyFallback: fallback,
    },
  };
}
