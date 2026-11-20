/**
 * Options primitives (pure, server-safe). Polarity maps to an option type
 * and nothing else: Drive (+1) buys a CALL, Reverse (-1) buys a PUT, Neutral
 * or unready buys nothing. Options are only ever bought to open and sold to
 * close, so the loss on any one trade is limited to the premium paid.
 */
import type { Broker, BrokerErrorCode, BrokerOrder, Result } from "@/lib/broker/types";

export type OptionType = "call" | "put";

export type OptionContract = {
  /** OCC symbol, e.g. MSFT271217C00500000. */
  symbol: string;
  underlying: string;
  type: OptionType;
  strike: number;
  /** YYYY-MM-DD. */
  expiration: string;
  tradable: boolean;
};

export type OptionQuote = { symbol: string; bid: number; ask: number; at: string };

export type ContractQuery = {
  underlying: string;
  type: OptionType;
  expiresFrom: string;
  expiresTo: string;
  strikeLow: number;
  strikeHigh: number;
};

export type OptionOrderRequest = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  clientOrderId: string;
  /** Closes may fall back to a market order when no usable quote exists. */
  type: "limit" | "market";
  limitPrice?: number;
  positionIntent: "buy_to_open" | "sell_to_close";
};

export interface OptionsBroker extends Broker {
  listContracts(q: ContractQuery): Promise<Result<OptionContract[], BrokerErrorCode>>;
  /** ok(null) when the broker has no quote for the symbol. */
  getOptionQuote(symbol: string): Promise<Result<OptionQuote | null, BrokerErrorCode>>;
  submitOptionOrder(req: OptionOrderRequest): Promise<Result<BrokerOrder, BrokerErrorCode>>;
}

/** One option contract covers 100 shares. */
export const CONTRACT_MULTIPLIER = 100;
/** Entries only use expiries at least this many days away (long-dated). */
export const MIN_EXPIRY_DAYS = 365;
/** A held option this close to expiry is closed; the next session buys a fresh long-dated one. */
export const ROLL_WITHIN_DAYS = 60;
/** Refuse to enter when the bid/ask gap exceeds this share of the mid price. */
export const MAX_SPREAD_PCT = 0.15;
/** A quote older than this many calendar days is stale (covers a long weekend). */
export const MAX_QUOTE_AGE_DAYS = 4;
export const MAX_OPTION_CONTRACTS = 10;
export const OPTION_TICK = 0.05;

const OCC = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export type ParsedOcc = { underlying: string; expiration: string; type: OptionType; strike: number };

/** Strictly parse an OCC option symbol. Null when it is not a real, well-formed one. */
export function parseOccSymbol(symbol: unknown): ParsedOcc | null {
  if (typeof symbol !== "string") return null;
  const m = OCC.exec(symbol);
  if (!m) return null;
  const year = 2000 + Number(m[2]);
  const month = Number(m[3]);
  const day = Number(m[4]);
  const expiration = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${expiration}T00:00:00Z`);
  if (
    month < 1 ||
    month > 12 ||
    Number.isNaN(check.getTime()) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  const strike = Number(m[6]) / 1000;
  if (!(strike > 0)) return null;
  return { underlying: m[1], expiration, type: m[5] === "C" ? "call" : "put", strike };
}

/** The ONLY mapping from polarity to an option: +1 call, -1 put, anything else nothing. */
export function optionTypeForPolarity(signal: { polarity: number; ready: boolean }): OptionType | null {
  if (!signal.ready) return null;
  if (signal.polarity === 1) return "call";
  if (signal.polarity === -1) return "put";
  return null;
}

/**
 * Nearest expiry that is at least `minExpiry`, then the strike closest to the
 * underlying price (the lower strike on a tie). Null when nothing qualifies.
 */
export function pickContract(
  contracts: readonly OptionContract[],
  spot: number,
  type: OptionType,
  minExpiry: string,
): OptionContract | null {
  if (!(spot > 0) || !ISO_DATE.test(minExpiry)) return null;
  const ok = contracts.filter(
    (c) => c.tradable && c.type === type && c.expiration >= minExpiry && Number.isFinite(c.strike) && c.strike > 0,
  );
  if (ok.length === 0) return null;
  const first = ok.reduce((min, c) => (c.expiration < min ? c.expiration : min), ok[0].expiration);
  const sameExpiry = ok
    .filter((c) => c.expiration === first)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike);
  return sameExpiry[0];
}

export type QuoteCheck =
  | { ok: true; bid: number; ask: number; mid: number; spreadPct: number }
  | { ok: false; error: string };

/** Justice: a crossed, empty, stale or malformed quote is never traded on. */
export function checkQuote(quote: OptionQuote | null, now: Date): QuoteCheck {
  if (!quote) return { ok: false, error: "No quote available for the contract." };
  const { bid, ask } = quote;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return { ok: false, error: "Contract quote is empty or crossed." };
  }
  const at = Date.parse(quote.at);
  if (!Number.isFinite(at)) return { ok: false, error: "Contract quote has no valid timestamp." };
  const ageDays = (now.getTime() - at) / 86_400_000;
  if (ageDays > MAX_QUOTE_AGE_DAYS || ageDays < -1) {
    return { ok: false, error: "Contract quote is stale." };
  }
  const mid = (bid + ask) / 2;
  return { ok: true, bid, ask, mid, spreadPct: (ask - bid) / mid };
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** Buy limit: the ask rounded UP to the 5-cent tick, so it is marketable and always a valid tick. */
export function buyLimit(ask: number): number {
  return cents(Math.ceil(ask / OPTION_TICK - 1e-9) * OPTION_TICK);
}

/** Sell limit: the bid rounded DOWN to the tick (never below one tick). */
export function sellLimit(bid: number): number {
  return cents(Math.max(OPTION_TICK, Math.floor(bid / OPTION_TICK + 1e-9) * OPTION_TICK));
}

export function describeContract(c: Pick<ParsedOcc, "underlying" | "expiration" | "type" | "strike">): string {
  return `${c.underlying} ${c.expiration} ${c.strike} ${c.type.toUpperCase()}`;
}
