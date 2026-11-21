/**
 * SPY options contract rules and selection (pure, no network, no orders).
 *
 * HARD rules, enforced here and again by `assertContractRules` before anything is ever reported
 * as "would buy":
 *   1. At least 365 calendar days to expiration (never less). The nearest LISTED expiry that is
 *      at least 365 days out is the only expiry considered; no later expiry is substituted.
 *   2. Delta, in two tiers (DELTA_THRESHOLDS, the one place the numbers live): |delta| >= 0.80 first (deep in the
 *      money): a CALL on Drive, a PUT on Reverse. Only if NO contract at that expiry reaches 0.80 with a usable
 *      quote, the FALLBACK takes the CHEAPEST contract (ask x 100) that is still >= 0.60 (a hard floor, never
 *      below it), marked "FALLBACK DELTA (below 0.80)" everywhere it is shown. If nothing reaches 0.60, no contract.
 *
 * Delta comes from Alpaca's greeks when they are present and agree with Black-Scholes; otherwise it is
 * computed with Black-Scholes from the quote (implied volatility solved from the mid price). Each row
 * records which one was used. A crossed, empty, stale or wide quote is never selected (Justice).
 */
import { CONTRACT_MULTIPLIER, MAX_SPREAD_PCT, addDays, checkQuote, daysBetween, parseOccSymbol, type OptionType } from "@/lib/broker/options";

/** Never less. Deliberately NOT imported from the broker module, so that changing that value cannot weaken this rule. */
export const MIN_DAYS_TO_EXPIRY = 365;
/** The one place the delta thresholds live. `primary` is the target; `floor` is the hard minimum for the fallback. */
export const DELTA_THRESHOLDS = Object.freeze({ primary: 0.8, floor: 0.6 });
export const MIN_ABS_DELTA = DELTA_THRESHOLDS.primary;
export const MIN_ABS_DELTA_FALLBACK = DELTA_THRESHOLDS.floor;
/** Alpaca delta and Black-Scholes delta may differ by at most this much before the row is rejected as unreliable. */
export const MAX_DELTA_DISAGREEMENT = 0.1;
export const DEFAULT_RISK_FREE_RATE = 0.043;
export const DEFAULT_DIVIDEND_YIELD = 0.012;

export type PricingModel = { rate: number; dividendYield: number };
export const DEFAULT_MODEL: PricingModel = Object.freeze({ rate: DEFAULT_RISK_FREE_RATE, dividendYield: DEFAULT_DIVIDEND_YIELD });

export type DeltaSource = "alpaca" | "black-scholes";
export type IvSource = "alpaca" | "solved";

export type RawOptionSnapshot = {
  symbol: string;
  bid: number | null;
  ask: number | null;
  quoteAt: string | null;
  /** Alpaca's greeks.delta, when sent. */
  delta: number | null;
  /** Alpaca's impliedVolatility, when sent. */
  iv: number | null;
};

export type ChainRow = {
  symbol: string;
  type: OptionType;
  strike: number;
  expiration: string;
  bid: number;
  ask: number;
  mid: number;
  spreadPct: number;
  quoteAt: string;
  delta: number;
  deltaSource: DeltaSource;
  iv: number | null;
  ivSource: IvSource | null;
  /** US dollars to buy one contract at the ask / at the mid. */
  costAtAsk: number;
  costAtMid: number;
  intrinsicPerShare: number;
  extrinsicPerShare: number;
};

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal CDF (Hart / West double-precision approximation, error below 1e-14). */
export function normCdf(x: number): number {
  const ax = Math.abs(x);
  let c: number;
  if (ax > 37) {
    c = 0;
  } else {
    const e = Math.exp((-ax * ax) / 2);
    if (ax < 7.07106781186547) {
      let b = 3.52624965998911e-2 * ax + 0.700383064443688;
      b = b * ax + 6.37396220353165;
      b = b * ax + 33.912866078383;
      b = b * ax + 112.079291497871;
      b = b * ax + 221.213596169931;
      b = b * ax + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * ax + 1.75566716318264;
      b = b * ax + 16.064177579207;
      b = b * ax + 86.7807322029461;
      b = b * ax + 296.564248779674;
      b = b * ax + 637.333633378831;
      b = b * ax + 793.826512519948;
      b = b * ax + 440.413735824752;
      c = c / b;
    } else {
      let b = ax + 0.65;
      b = ax + 4 / b;
      b = ax + 3 / b;
      b = ax + 2 / b;
      b = ax + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

function d1d2(spot: number, strike: number, years: number, sigma: number, m: PricingModel): { d1: number; d2: number } {
  const v = sigma * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (m.rate - m.dividendYield + (sigma * sigma) / 2) * years) / v;
  return { d1, d2: d1 - v };
}

export function bsPrice(type: OptionType, spot: number, strike: number, years: number, sigma: number, m: PricingModel = DEFAULT_MODEL): number {
  const { d1, d2 } = d1d2(spot, strike, years, sigma, m);
  const dfq = Math.exp(-m.dividendYield * years);
  const dfr = Math.exp(-m.rate * years);
  return type === "call" ? spot * dfq * normCdf(d1) - strike * dfr * normCdf(d2) : strike * dfr * normCdf(-d2) - spot * dfq * normCdf(-d1);
}

export function bsDelta(type: OptionType, spot: number, strike: number, years: number, sigma: number, m: PricingModel = DEFAULT_MODEL): number {
  const { d1 } = d1d2(spot, strike, years, sigma, m);
  const dfq = Math.exp(-m.dividendYield * years);
  return type === "call" ? dfq * normCdf(d1) : -dfq * normCdf(-d1);
}

/** Implied volatility from a price by bisection. Null when the price is outside what any volatility can produce. */
export function impliedVol(type: OptionType, price: number, spot: number, strike: number, years: number, m: PricingModel = DEFAULT_MODEL): number | null {
  if (!(price > 0) || !(spot > 0) || !(strike > 0) || !(years > 0)) return null;
  let lo = 0.01;
  let hi = 5;
  if (price < bsPrice(type, spot, strike, years, lo, m) - 1e-9 || price > bsPrice(type, spot, strike, years, hi, m) + 1e-9) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(type, spot, strike, years, mid, m) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export type RowResult = { ok: true; row: ChainRow } | { ok: false; symbol: string; reason: string };

/** Turn one raw snapshot into a validated row, or say exactly why it cannot be used. */
export function buildRow(raw: RawOptionSnapshot, spot: number, today: string, now: Date, model: PricingModel = DEFAULT_MODEL): RowResult {
  const symbol = raw.symbol;
  const occ = parseOccSymbol(symbol);
  if (!occ) return { ok: false, symbol, reason: "not a valid option symbol" };
  if (!(spot > 0)) return { ok: false, symbol, reason: "no valid underlying price" };
  if (raw.bid === null || raw.ask === null || raw.quoteAt === null) return { ok: false, symbol, reason: "no quote" };
  const q = checkQuote({ symbol, bid: raw.bid, ask: raw.ask, at: raw.quoteAt }, now);
  if (!q.ok) return { ok: false, symbol, reason: q.error };
  const days = daysBetween(today, occ.expiration);
  if (days <= 0) return { ok: false, symbol, reason: "already expired" };
  const years = days / 365;

  const ivSolved = impliedVol(occ.type, q.mid, spot, occ.strike, years, model);
  const ivAlpaca = finite(raw.iv) && raw.iv > 0 && raw.iv < 5 ? raw.iv : null;
  const ivForDelta = ivAlpaca ?? ivSolved;
  const bs = ivForDelta === null ? null : bsDelta(occ.type, spot, occ.strike, years, ivForDelta, model);

  const signOk = (d: number) => (occ.type === "call" ? d > 0 && d <= 1 : d < 0 && d >= -1);
  let delta: number;
  let deltaSource: DeltaSource;
  if (finite(raw.delta) && signOk(raw.delta)) {
    if (bs !== null && Math.abs(raw.delta - bs) > MAX_DELTA_DISAGREEMENT) {
      return { ok: false, symbol, reason: `Alpaca delta ${raw.delta.toFixed(3)} disagrees with Black-Scholes ${bs.toFixed(3)}` };
    }
    delta = raw.delta;
    deltaSource = "alpaca";
  } else if (bs !== null && signOk(bs)) {
    delta = bs;
    deltaSource = "black-scholes";
  } else {
    return { ok: false, symbol, reason: "no usable delta" };
  }

  const intrinsic = Math.max(occ.type === "call" ? spot - occ.strike : occ.strike - spot, 0);
  return {
    ok: true,
    row: {
      symbol,
      type: occ.type,
      strike: occ.strike,
      expiration: occ.expiration,
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      spreadPct: q.spreadPct,
      quoteAt: raw.quoteAt,
      delta,
      deltaSource,
      iv: ivAlpaca ?? ivSolved,
      ivSource: ivAlpaca !== null ? "alpaca" : ivSolved !== null ? "solved" : null,
      costAtAsk: q.ask * CONTRACT_MULTIPLIER,
      costAtMid: q.mid * CONTRACT_MULTIPLIER,
      intrinsicPerShare: intrinsic,
      extrinsicPerShare: q.mid - intrinsic,
    },
  };
}

/** The earliest date an entry may expire on. */
export const earliestExpiry = (today: string): string => addDays(today, MIN_DAYS_TO_EXPIRY);

/** Nearest listed expiry that is at least 365 days away. Null when none is listed. */
export function nearestQualifyingExpiry(listed: readonly string[], today: string): string | null {
  const min = earliestExpiry(today);
  let best: string | null = null;
  for (const e of listed) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e) || e < min) continue;
    if (best === null || e < best) best = e;
  }
  return best;
}

/**
 * The final check on a contract before anything may be reported as "would buy".
 * Returns null when every hard rule holds, else the first broken rule.
 */
export function assertContractRules(row: ChainRow, wanted: OptionType, today: string, minAbsDelta: number = DELTA_THRESHOLDS.primary): string | null {
  const minDelta = Math.max(minAbsDelta, DELTA_THRESHOLDS.floor); // never below the hard floor, whatever the caller passes
  if (row.type !== wanted) return `contract is a ${row.type}, wanted a ${wanted}`;
  const occ = parseOccSymbol(row.symbol);
  if (!occ || occ.type !== row.type || occ.expiration !== row.expiration || occ.strike !== row.strike) return "contract fields do not match its symbol";
  const days = daysBetween(today, row.expiration);
  if (!(days >= MIN_DAYS_TO_EXPIRY)) return `expires in ${days} days, minimum is ${MIN_DAYS_TO_EXPIRY}`;
  if (!finite(row.delta) || !(Math.abs(row.delta) >= minDelta)) return `|delta| ${finite(row.delta) ? Math.abs(row.delta).toFixed(3) : "n/a"} is below ${minDelta}`;
  if (wanted === "call" ? !(row.delta > 0) : !(row.delta < 0)) return "delta has the wrong sign for this option type";
  if (!(row.spreadPct <= MAX_SPREAD_PCT)) return `bid/ask spread ${(row.spreadPct * 100).toFixed(1)}% is above ${MAX_SPREAD_PCT * 100}%`;
  return null;
}

export type PickResult =
  | { ok: true; row: ChainRow; expiration: string; daysToExpiry: number; qualifying: number; tier: "primary" | "fallback"; fallbackReason: string | null }
  | { ok: false; reason: string; expiration: string | null };

/** The marker shown wherever a fallback contract appears (report, events, decision text). */
export const FALLBACK_LABEL = `FALLBACK DELTA (below ${DELTA_THRESHOLDS.primary.toFixed(2)})`;

/**
 * Pick the contract for `type`: the nearest listed expiry that is at least 365 days out, then among
 * its contracts with |delta| >= 0.80 the one with the smallest |delta| (the cheapest that still obeys the rule;
 * ties go to the lower ask). If none reaches 0.80 with a usable quote, the FALLBACK: among the same expiry's usable
 * contracts with |delta| >= 0.60 the CHEAPEST by ask x 100 (ties: the tighter spread, then the higher |delta|). If
 * not even 0.60 is reached the answer is "none": nothing else is substituted and no later expiry is used.
 */
export function pickDeepItm(rows: readonly ChainRow[], listedExpirations: readonly string[], type: OptionType, today: string): PickResult {
  const expiration = nearestQualifyingExpiry(listedExpirations, today);
  if (expiration === null) return { ok: false, reason: `no listed expiry is at least ${MIN_DAYS_TO_EXPIRY} days out`, expiration: null };
  const sameExpiry = rows.filter((r) => r.type === type && r.expiration === expiration);
  if (sameExpiry.length === 0) return { ok: false, reason: `no usable quotes for the ${expiration} ${type}s`, expiration };
  const ok = sameExpiry.filter((r) => assertContractRules(r, type, today) === null);
  if (ok.length > 0) {
    ok.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || a.ask - b.ask);
    return { ok: true, row: ok[0], expiration, daysToExpiry: daysBetween(today, expiration), qualifying: ok.length, tier: "primary", fallbackReason: null };
  }
  const floor = sameExpiry.filter((r) => assertContractRules(r, type, today, DELTA_THRESHOLDS.floor) === null);
  if (floor.length === 0) return { ok: false, reason: `no ${expiration} ${type} has |delta| >= ${DELTA_THRESHOLDS.floor} (the floor; ${DELTA_THRESHOLDS.primary} is the target) with a usable quote`, expiration };
  floor.sort((a, b) => a.ask - b.ask || a.spreadPct - b.spreadPct || Math.abs(b.delta) - Math.abs(a.delta));
  const best = floor[0];
  const top = sameExpiry.reduce((m, r) => (Math.abs(r.delta) > Math.abs(m.delta) ? r : m), sameExpiry[0]);
  const why = `no ${expiration} ${type} reaches |delta| ${DELTA_THRESHOLDS.primary} with a usable quote (${sameExpiry.length} usable quotes; the highest |delta| of any is ${Math.abs(top.delta).toFixed(3)} at strike ${top.strike}); picked the CHEAPEST usable contract at or above the ${DELTA_THRESHOLDS.floor} floor (${floor.length} qualify): strike ${best.strike}, |delta| ${Math.abs(best.delta).toFixed(3)}, ask ${usd(best.ask * 100)}`;
  return { ok: true, row: best, expiration, daysToExpiry: daysBetween(today, expiration), qualifying: floor.length, tier: "fallback", fallbackReason: why };
}

/**
 * Every contract a trader may choose BY HAND for `type`: the same nearest listed expiry of at least 365 days, usable
 * quotes only, |delta| at or above the hard 0.60 floor (the 0.80 target is not required, because a trader decides by hand
 * only when the reading is Neutral). Cheapest first (ask x 100), then tighter spread, then higher |delta|.
 * Never contains a later expiry and never anything under the floor.
 */
export function eligibleContracts(rows: readonly ChainRow[], listedExpirations: readonly string[], type: OptionType, today: string): { expiration: string | null; rows: ChainRow[] } {
  const expiration = nearestQualifyingExpiry(listedExpirations, today);
  if (expiration === null) return { expiration: null, rows: [] };
  const eligible = rows.filter((r) => r.type === type && r.expiration === expiration && assertContractRules(r, type, today, DELTA_THRESHOLDS.floor) === null);
  eligible.sort((a, b) => a.costAtAsk - b.costAtAsk || a.spreadPct - b.spreadPct || Math.abs(b.delta) - Math.abs(a.delta));
  return { expiration, rows: eligible };
}

export type Affordability = {
  costPerContract: number;
  budget: number;
  shortfall: number;
  /** Whole contracts the budget buys. */
  contracts: number;
  affordable: boolean;
};

export function affordability(costPerContract: number, budget: number): Affordability {
  const contracts = costPerContract > 0 && budget > 0 ? Math.floor(budget / costPerContract) : 0;
  return { costPerContract, budget, shortfall: Math.max(0, costPerContract - budget), contracts, affordable: contracts >= 1 };
}

export const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
