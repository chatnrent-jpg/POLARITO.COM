/**
 * Option primitives (pure, server-safe, read-only): contract and quote shapes, OCC symbol parsing, date helpers
 * and the stale/crossed quote check. The SPY engine and desk build on these. Nothing here, or in the broker
 * adapter that implements OptionsBroker, can place an order.
 */
import type { Broker, BrokerErrorCode, Result } from "@/lib/broker/types";

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

export interface OptionsBroker extends Broker {
  listContracts(q: ContractQuery): Promise<Result<OptionContract[], BrokerErrorCode>>;
  /** ok(null) when the broker has no quote for the symbol. */
  getOptionQuote(symbol: string): Promise<Result<OptionQuote | null, BrokerErrorCode>>;
}

/** One option contract covers 100 shares. */
export const CONTRACT_MULTIPLIER = 100;
/** Refuse to enter when the bid/ask gap exceeds this share of the mid price. */
export const MAX_SPREAD_PCT = 0.15;
/** A quote older than this many calendar days is stale (covers a long weekend). */
export const MAX_QUOTE_AGE_DAYS = 4;

const OCC = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

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
